# Deployment Guide (DevOps)

A small Node.js (Express) service that runs a WhatsApp AI "setter" conversation.
Inbound WhatsApp messages hit a webhook, get debounced/batched, are answered by an
LLM (Gemini with a Groq fallback), and sent back via the **Meta WhatsApp Cloud API**.
A password-protected web control panel shows live activity and per-lead transcripts.

This document is everything you need to deploy it on AWS. **Read "Architecture
constraints" first — they change how you size and scale this.**

---

## TL;DR

- **Runtime:** Node.js 20, single container. `Dockerfile` at repo root builds it.
- **Start:** `node server.js` (the container CMD).
- **Port:** reads `PORT` from env (default `3000`). Listens on `0.0.0.0`.
- **Health check:** `GET /health` → `200 {"ok":true}` (unauthenticated).
- **Must be publicly reachable over HTTPS** — Meta's webhook calls it.
- **Run exactly ONE instance** (see constraints). No horizontal autoscaling as-is.
- **Secrets** are injected as env vars — never committed. See the env table below.
- **State** is a local JSON file (`leads.json`) — ephemeral in a container. See "Persistence".

---

## Architecture constraints (important)

This service was built as a single-instance app. Two things make it **not
horizontally scalable without code changes**:

1. **In-memory debounce/dedup state.** Incoming messages are buffered in a
   per-lead in-process `Map` (`src/conversation.js`) and answered after a quiet
   window. Two instances would each hold half the buffer and could double-reply
   or split a burst. Webhook deliveries must all land on the same process.

2. **File-based store.** Leads + full conversation history are read/written to
   `leads.json` on local disk (`src/store.js`). Two instances = divergent files.

**Recommended deployment:** a single always-on task/instance (desired count = 1,
no autoscaling). This comfortably handles the expected volume (tens of leads).

To scale out later you'd move (a) the store to a database and (b) the debounce
buffer to a shared store (e.g. Redis) or a queue with a single consumer.

---

## Persistence (`leads.json`)

`leads.json` holds **lead PII and full conversation transcripts**. On a container
filesystem it is **wiped on every redeploy/restart**. Pick one:

- **Accept ephemerality** — fine for demos; history resets on redeploy.
- **Attach a volume** — mount **EFS** (ECS/Fargate) or an EBS volume (EC2) at the
  app's working directory so `leads.json` persists. Single-writer only.
- **Move to a database (recommended for prod)** — replace `loadLeads()`/`saveLeads()`
  and the write points in `src/store.js` with RDS/Aurora Postgres or DynamoDB.
  ~1 file to change; ask the app owner and we can provide a DB adapter.

---

## Environment variables (the contract)

Authoritative template: **`.env.example`**. Set these on the platform (plain vars
for config, **Secrets Manager / SSM** for anything marked 🔒). Do **not** put
secrets in the image or repo.

| Variable | Secret | Example / value | Purpose |
|---|:---:|---|---|
| `CHANNEL` | | `cloud` | Messaging channel. Use `cloud` (Meta WhatsApp Cloud API). |
| `AI_PROVIDER` | | `gemini` | Primary LLM provider. |
| `GEMINI_API_KEY` | 🔒 | *(from app owner)* | Google Gemini key. |
| `GEMINI_MODEL` | | `gemini-2.5-flash` | Gemini model id. |
| `GROQ_API_KEY` | 🔒 | *(from app owner)* | Groq key — automatic fallback if Gemini errors/quota. |
| `GROQ_MODEL` | | `llama-3.3-70b-versatile` | Groq model id. |
| `WHATSAPP_TOKEN` | 🔒 | *(from app owner)* | Meta permanent System-User access token. |
| `WHATSAPP_PHONE_NUMBER_ID` | | *(from app owner)* | Sender's "Phone number ID". |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | | *(from app owner)* | WABA id (reference / templates). |
| `WHATSAPP_VERIFY_TOKEN` | | `samar-demo-123` | Webhook verify string; must match Meta config. |
| `WHATSAPP_OPENER_TEMPLATE` | | `acme_default` | Approved template that opens a chat. |
| `WHATSAPP_OPENER_LANG` | | `en` | Template language. |
| `WHATSAPP_OPENER_VARS` | | `name,brand` | Template variable order. |
| `WHATSAPP_BRAND` | | `Samar` | Brand/sender name used in the opener. |
| `WHATSAPP_OPENER_TEXT` | | *(see `.env.example`)* | Opener text shown in the panel log. |
| `ADMIN_EMAIL` | | `admin@example.com` | Control-panel login (HTTP Basic). |
| `ADMIN_PASSWORD` | 🔒 | *(from app owner)* | Control-panel password. If unset, panel is locked. |
| `PORT` | | set by platform | Listen port. App Runner/ECS inject this. |

Optional tuning (have sane defaults): `DEBOUNCE_MS`, `SPLIT_MESSAGES`,
`TYPING_MIN_MS`, `TYPING_PER_CHAR_MS`, `TYPING_MAX_MS`.

> **Secrets are delivered separately** by the app owner (not in this repo). Load
> them into AWS Secrets Manager / SSM Parameter Store and reference them from the
> task definition / service config.

---

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Health probe → `200`. Point ALB/App Runner health check here. |
| `GET /webhook/whatsapp` | none | Meta webhook verification handshake. |
| `POST /webhook/whatsapp` | none | Inbound WhatsApp messages from Meta. |
| `GET /` and `/api/*`, `/events` | Basic auth | Control panel + live feed (uses `ADMIN_EMAIL`/`ADMIN_PASSWORD`). |

Only `/health` and `/webhook/*` are public; everything else requires Basic auth.
**Terminate TLS at the load balancer** (ACM cert) — Basic auth must never travel
over plain HTTP.

---

## Deploy options on AWS

All three build the provided `Dockerfile`. Pick per your standards.

### Option A — AWS App Runner (simplest, recommended)
1. Push the image to **ECR** (or connect the GitHub repo and let App Runner build).
2. Create an App Runner service from the image/repo.
3. **Port:** 3000 (or set `PORT` and match). **Health check path:** `/health`.
4. Add env vars; bind 🔒 ones from **Secrets Manager**.
5. Deploy → App Runner gives an HTTPS URL. Autoscaling: set **min = max = 1**.

### Option B — ECS Fargate + ALB (standard)
1. Build & push image to **ECR**.
2. Task definition: 1 container, `PORT=3000`, `256 CPU / 512 MB` is plenty.
   Inject 🔒 vars via `secrets` (Secrets Manager ARNs).
3. Service: **desired count = 1**, no autoscaling.
4. **ALB** with an **ACM** cert (HTTPS:443 → target group :3000). Target group
   health check path `/health`.
5. (Optional) Mount **EFS** for `leads.json` persistence.
6. Public URL = ALB DNS (or a Route 53 record).

### Option C — Elastic Beanstalk (Docker platform)
1. `eb init` (Docker), `eb create` with **min = max = 1** instance.
2. Set env vars in the EB console (secrets via SSM).
3. EB provisions the ALB + HTTPS (attach ACM cert). Health check → `/health`.

---

## Post-deploy: wire the Meta webhook

Once the service has a public HTTPS URL (`https://<your-domain>`):

1. Meta app → **WhatsApp → Configuration → Webhooks → Edit**.
2. **Callback URL:** `https://<your-domain>/webhook/whatsapp`
3. **Verify token:** the value of `WHATSAPP_VERIFY_TOKEN`.
4. Save (Meta calls `GET /webhook/whatsapp` to verify) → subscribe the **`messages`** field.

Verify end-to-end: send a WhatsApp to the business number → it appears in the
panel log and the AI replies.

---

## Security notes (please review)

- **Webhook signature is NOT verified.** The `POST /webhook/whatsapp` handler does
  not currently validate Meta's `X-Hub-Signature-256`. For production, restrict
  the route (e.g. WAF / verify the signature — needs the App Secret). Flag to app owner.
- **Rotate credentials before go-live.** The WhatsApp token and admin password were
  shared during development; regenerate them and store only in Secrets Manager.
- **`leads.json` is PII.** Keep any mounted volume/DB encrypted (EFS/EBS/RDS at rest + TLS).
- **Basic auth over HTTPS only** — never expose the panel on plain HTTP.
- The repo contains **no secrets**; `.env` and `leads.json` are gitignored and
  excluded from the image via `.dockerignore`.

---

## Local build & run (sanity check)

```bash
docker build -t setter .
docker run --rm -p 3000:3000 --env-file .env setter
# → http://localhost:3000/health returns {"ok":true}
```

Questions about app behavior, the DB adapter, or webhook signature verification —
contact the app owner.
