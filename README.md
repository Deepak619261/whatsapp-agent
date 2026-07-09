# 1prompt Setter Demo

A local demo that recreates the **AI-setter conversation experience** from
[`genokadzin/1prompt-os`](https://github.com/genokadzin/1prompt-os) — but running
entirely on your machine, over **real WhatsApp** (via Twilio), with an AI brain you
can swap between **Claude, OpenAI, and Gemini** by changing a single `.env` line.

The actual conversation happens in real WhatsApp on the lead's phone. The local web
page is just a **control panel**: it starts conversations, streams a live log, and
lets you tune the "humanization" behavior while you present.

- **What it copies from 1prompt-os** and where their logic lives → see [`NOTES.md`](NOTES.md).
- **The setter's personality/voice** is an editable prompt → [`prompt.txt`](prompt.txt).

---

## What it does

1. You fill in a **lead form** (name, WhatsApp number, interest) in the control panel.
2. The AI setter sends that person a **first WhatsApp message**.
3. They reply in WhatsApp. If they fire off several messages quickly, the app
   **debounces** them — waits for a quiet gap, groups the burst, and answers once.
4. Before each reply it adds a **length-scaled typing delay**, and can **split** a
   longer reply into 2 short messages — so it feels human, not instant/robotic.
5. Everything shows up live in the control panel.

---

## Prerequisites

- **Node.js 18+**
- A **Twilio account** (free trial is fine) — for real WhatsApp.
- An API key for **one** AI provider: Anthropic **or** OpenAI **or** Google Gemini.
- **ngrok** (or any tunnel) — so Twilio can reach your local webhook.

---

## Setup — do these in order

### 1) Install

```bash
npm install
```

### 2) Configure `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in:

- **`AI_PROVIDER`** — `claude`, `openai`, or `gemini`.
- The **API key + model** for that provider (only the selected one is required;
  the app fails loudly at startup if the selected provider's key is missing).
- The **Twilio** section (filled in during step 4).

Swapping the AI later = change **only** `AI_PROVIDER` and restart.

### 3) Activate the Twilio WhatsApp Sandbox

You don't need business verification — Twilio's **sandbox** works immediately.

1. Twilio Console → **Messaging → Try it out → Send a WhatsApp message**
   (direct link: <https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn>).
2. You'll see a sandbox number (**+1 415 523 8886**) and a **join code** like
   `join lucky-tiger`.
3. **From the phone you want to test with**, send that exact message
   (`join lucky-tiger`) as a WhatsApp message to **+1 415 523 8886**.
   Twilio replies confirming you've joined. **Every tester must do this opt-in**,
   or Twilio won't deliver messages to them.
4. Copy your **Account SID** and **Auth Token** from the Console dashboard into `.env`:

   ```env
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
   ```

### 4) Run the app

```bash
npm run dev
```

It prints the local URL (`http://localhost:3000`), the active AI provider, and a
reminder to start ngrok.

### 5) Expose the webhook with ngrok

In a **second terminal**:

```bash
ngrok http 3000
```

ngrok prints a public HTTPS URL, e.g. `https://a1b2c3d4.ngrok-free.app`.

### 6) Point Twilio at your webhook

Back in the Twilio Console → **WhatsApp Sandbox → Sandbox settings**:

- In **"When a message comes in"**, paste your ngrok URL **+ `/webhook/whatsapp`**:

  ```
  https://a1b2c3d4.ngrok-free.app/webhook/whatsapp
  ```
- Method: **HTTP POST**. Save.

> Re-running ngrok gives a new URL each time (on the free plan) — update this field
> whenever the ngrok URL changes.

### 7) Demo it

1. Open **http://localhost:3000**.
2. In **New lead**, enter your name, **the WhatsApp number that joined the sandbox**
   (E.164, e.g. `+15551234567`), and an interest. Click **Start conversation**.
3. Check WhatsApp on that phone — the setter's first message arrives.
4. Reply. To show off the debounce, fire **3–4 quick messages** — watch the control
   panel group them and answer once, with a typing delay.
5. Tune the **debounce window** (try the `8s` vs `60s` presets) and toggle
   **2-message split** live while you talk.

---

## Swapping the AI provider

Edit one line in `.env` and restart:

```env
AI_PROVIDER=claude   # → openai → gemini
```

Each provider reads its own key + model from `.env`:

| `AI_PROVIDER` | Key | Model var (default) | Implemented in |
|---|---|---|---|
| `claude` | `ANTHROPIC_API_KEY` | `CLAUDE_MODEL` (`claude-sonnet-5`) | `src/ai/claude.js` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` (`gpt-4o-mini`) | `src/ai/openai.js` |
| `gemini` | `GEMINI_API_KEY` | `GEMINI_MODEL` (`gemini-2.5-flash`) | `src/ai/gemini.js` |
| `groq` | `GROQ_API_KEY` | `GROQ_MODEL` (`llama-3.3-70b-versatile`) | `src/ai/groq.js` |

> **For demos, `groq` is the easiest** — its free tier has far higher daily limits
> than Gemini's (Gemini free tier is ~20 requests/day per model). Get a free key at
> <https://console.groq.com/keys>.

All three sit behind one interface — `generateReply(systemPrompt, messages) → string`
— wired up by the factory in `src/ai/index.js`.

---

## Branded number (WhatsApp Cloud API) instead of Twilio

To send from a real branded number (custom display name + profile photo) via Meta's
official WhatsApp Cloud API, set `CHANNEL=cloud` and fill the `5b` block in `.env`
(`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`,
`WHATSAPP_OPENER_TEMPLATE`, `WHATSAPP_OPENER_LANG`). Then set the webhook in the Meta
app (WhatsApp → Configuration → Webhooks) to `https://<ngrok>/webhook/whatsapp` with
your `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`.

Difference from Twilio: Meta requires an **approved template** to send the *first*
message, so the form-triggered opener is sent as that template (with the lead's name
and interest as `{{1}}`/`{{2}}`); every reply after the lead responds is normal
AI free-form and behaves identically. Leave `CHANNEL=twilio` (or unset) for the
Twilio sandbox path.

## Customizing the setter

Edit [`prompt.txt`](prompt.txt) — the setter's persona, business, offer, and
call-to-action. It's re-read on every reply, so you can tweak it without restarting.
The default mirrors 1prompt-os's "ultra-human" style: short messages, one question at
a time, understand the pain before pitching, drive to a booked call.

---

## Project layout

```
server.js            Express app: /webhook/whatsapp, lead form, config, SSE log
prompt.txt           Editable setter system prompt
src/
  ai/index.js        Provider factory (reads AI_PROVIDER)
  ai/claude.js       Anthropic Messages API adapter
  ai/openai.js       OpenAI Chat Completions adapter
  ai/gemini.js       Google Gemini adapter
  twilio.js          Outbound WhatsApp via Twilio SDK
  store.js           In-memory leads + config + live log (no database)
  debounce…          (in conversation.js) per-lead debounce + grouping
  humanize.js        Typing delay + 2-message split
  conversation.js    Orchestrator: inbound → debounce → AI → humanized reply
public/index.html    Control panel (lead form, live log, tuning controls)
NOTES.md             Study of 1prompt-os: debounce, prompt, message flow
```

---

## Troubleshooting

- **Startup exits with "API key is missing"** — your `AI_PROVIDER` points at a
  provider whose key isn't in `.env`. Fix the key (or switch providers) and restart.
- **Form says "Twilio is not configured"** — set the three `TWILIO_*` vars, restart.
- **No WhatsApp arrives** — the recipient hasn't sent `join <code>` to the sandbox,
  or the number isn't in E.164 (`+…`). Sandbox opt-ins also expire after 72h of
  inactivity; just re-send the join code.
- **Replies never come back** — the Twilio "when a message comes in" webhook isn't
  set to your current ngrok URL + `/webhook/whatsapp`, or ngrok restarted with a new
  URL. Check the Twilio Console → Sandbox settings.
- **State disappears on restart** — expected. State is in-memory by design.

---

## Notes / limitations

- **In-memory state.** Leads and history reset on restart. No database, by design.
- **Sandbox constraints.** Twilio's WhatsApp sandbox only messages numbers that
  opted in with the join code. For arbitrary recipients you'd need an approved
  WhatsApp Business sender — out of scope for this demo.
- This reimplements 1prompt-os's **pattern**, not their infrastructure. We don't run
  Supabase, Trigger.dev, n8n, or GoHighLevel — see [`NOTES.md`](NOTES.md).
