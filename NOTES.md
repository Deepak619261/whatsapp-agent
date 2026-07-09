# NOTES — how 1prompt-os runs its AI setter (and what this demo copies)

This is a study of [`genokadzin/1prompt-os`](https://github.com/genokadzin/1prompt-os),
read-only. We did **not** run their stack (Supabase / Trigger.dev / n8n / GoHighLevel).
We reimplemented the *pattern* locally. Line references below point at the clone in
`./reference/1prompt-os`.

---

## The shape of their system

```
Lead sends a DM/SMS  (via GoHighLevel / a CRM)
      │
      ▼
Supabase Edge Function  receive-dm-webhook   ← inbound entry point
      │  - cancels any pending follow-up / outbound for this lead
      │  - inserts the message into the `message_queue` table
      │  - triggers the Trigger.dev "process-messages" task (passes debounce_seconds)
      ▼
Trigger.dev  processMessages.ts              ← THE DEBOUNCE LIVES HERE
      │  - wait.until(now + debounce_seconds)   ← pauses the whole task
      │  - after the wait: pulls ALL unprocessed messages for the lead
      │  - joins them with "\n" into ONE grouped message
      │  - POSTs the grouped text to the n8n "text engine" webhook
      ▼
n8n  Text_Engine.json                        ← THE AI BRAIN
      │  - runs the LLM with the setter persona + chat history
      │  - returns JSON: { Message_1, Message_2, ... Message_5 }  ← reply can be split
      ▼
Trigger.dev forwards that JSON to GoHighLevel's "send reply" webhook
      ▼
GoHighLevel delivers the message(s) back to the lead
```

Everything that makes it feel human happens in **two places**: the debounce/grouping
in `processMessages.ts`, and the persona/prompt that n8n runs.

---

## (a) DEBOUNCE — the exact numbers

**File:** `reference/1prompt-os/trigger/processMessages.ts`

| What | Value | Where |
|---|---|---|
| Debounce window (default) | **60 seconds** | `const debounceSeconds = payload.debounce_seconds ?? 60;` (line ~129) |
| How it waits | `await wait.until({ date: resumeAt })` — a first-class Trigger.dev workflow pause, **not** `setTimeout` (line ~140) |
| Resume time | `new Date(Date.now() + debounceSeconds * 1000)` (line ~130) |
| Grouping | `messages.map(m => m.message_body).join("\n")` — every queued message concatenated into ONE (line ~169) |

How the batching actually works:
1. Each inbound message is written to `message_queue` with `processed = false`.
2. `receive-dm-webhook` also **cancels the previous in-flight processing** for that lead
   before starting a new one — so a burst of messages keeps resetting the window
   (a true debounce, not a fixed timer).
3. When the window finally clears, `processMessages` selects **all** still-unprocessed
   messages for that lead and answers them with a single grouped reply.

There is **no artificial "typing delay"** in their backend — the grouped reply is sent
to n8n immediately after the debounce clears. The human feel of "multiple texts" instead
comes from n8n splitting the answer into `Message_1..Message_5`.

**Follow-ups** are a separate tier (`trigger/sendFollowup.ts`): up to 3 scheduled
follow-ups with per-step delays (`followup_1/2/3_delay_seconds`), each an AI-written,
context-aware nudge — and an AI gate that cancels the follow-up if the lead said bye,
rejected, went cold, or asked to stop (lines ~11–37).

> ### What this demo does differently, and why
> Their production debounce is **60 s**. That is far too long to show off live — nobody
> wants to watch a 60-second pause during a demo. So this demo **defaults to 8 s**
> (`DEBOUNCE_MS=8000`) and makes the window **tunable from the control panel and `.env`**.
> Set it to `60000` if you want to match their exact production behavior. The mechanism
> is identical: buffer per-lead, reset the timer on each new message, then answer the
> whole burst with one reply.

---

## (b) SETTER PROMPT / agent behavior

**Files:** `reference/1prompt-os/frontend/src/data/defaultPromptTemplates.ts`,
`.../defaultBookingPrompt.ts`, `trigger/sendFollowup.ts`.

Their default persona is **"Geno"** — "ultra-human". The behavior we mirror in
`prompt.txt`:

- **Short messages.** "Keep replies SHORT (1-2 sentences mostly). Only go longer when
  people ask for more details."
- **Sound like a real person.** Mixed upper/lowercase, casual slang, occasional missed
  punctuation "for a natural feel." Friendly, never corporate, never mean.
- **One question per message.** "Never bundle multiple questions together." "No walls of text."
- **Understand the pain before pitching (high-skill selling).** This is the standout rule:
  > "DO NOT push the solution before understanding the CORE PROBLEM… DIG DEEPER to find
  > the real issue. Ask 'why?' and 'where are you struggling the most?' Only present the
  > solution AFTER you deeply understand their pain."
  - Wrong: user says what they do → bot immediately pitches.
  - Right: user says what they do → "got it, how's that going?" → "ok but what IS the
    problem, where are you struggling most right now?"
- **Booking discipline** (`defaultBookingPrompt.ts`):
  - First offer **exactly 2 slots** ("this Wednesday at 11am or 4pm — which works?").
  - If neither lands, offer up to 4 across different days.
  - If the lead names an exact time → check availability → book. If the lead picks from
    the slots you offered → book immediately, no extra confirmation.
- **Follow-up writing** (`sendFollowup.ts`): "Sound like the setter naturally continuing
  the conversation… 1-3 sentences… reference something specific… NEVER start with 'Just
  following up' / 'Hey there' / 'I wanted to check in'."

Our `prompt.txt` reimplements this voice for a sample business (a fitness studio). It is
a plain editable file — swap in your own business, offer, and call-to-action.

---

## (c) How a message ENTERS and a reply is SENT

**Inbound entry:**
`reference/1prompt-os/frontend/supabase/functions/receive-dm-webhook/index.ts` (lines
~127–169) receives the lead's message as query params (`Lead_ID`, `GHL_Account_ID`,
`Message_Body`, `Name`, `Email`, `Phone`, `Setter_Number`, `Channel`), queues it, and
kicks off the debounce task.

**Reply out:**
After the AI (n8n) returns `{ Message_1, Message_2, … }`, `processMessages.ts` (lines
~270–298) forwards that JSON to GoHighLevel's "send setter reply" webhook
(`clients.ghl_send_setter_reply_webhook_url`) with the contact id as a query param. GHL
then actually delivers the message(s) to the lead. A separate direct-send path
(`crm-send-message/index.ts`) enforces a **10-second rate limit per contact** to avoid
rapid-fire duplicates.

**How this demo maps onto that:**

| 1prompt-os | This demo |
|---|---|
| GHL/CRM → `receive-dm-webhook` (Supabase) | Twilio → `POST /webhook/whatsapp` (Express) |
| `message_queue` table + Trigger.dev `wait.until()` | in-memory per-lead buffer + a debounce timer |
| n8n `Text_Engine.json` running the LLM | `src/ai/*` provider adapter (Claude / OpenAI / Gemini) |
| Reply `{ Message_1..Message_5 }` → GHL webhook | reply optionally split into 2 messages → Twilio WhatsApp send |
| Supabase/GHL for state | in-memory `src/store.js` (no database) |
| Follow-up tier + typing via message-splitting | length-scaled typing delay + optional 2-message split |
