# healthspan-sms

> This repo holds two projects: `healthspan-sms` (this directory) and
> [`contacts/`](contacts/) — the OneFive contact database with Outlook sync
> and its own SMS interface.

Text your health record. Send a message to a Twilio number and Claude reads
from — and writes to — the Healthspan MCP server, then texts you back.

```
you  → "weight 246.8 this morning, slept badly, maybe a 2"
back ← "Logged 246.8 lb and a sleep rating of 2 for this morning. That's down
        1.2 lb from last week's average."

you  → "how's my apoB trending?"
back ← "Only one ApoB on record — 70.1 mg/dL from the Aug 13 panel. No trend
        yet. It's inside the optimal range (<80)."
```

## How it works

```
Twilio SMS ──► Cloudflare Worker ──► Claude API ──► Healthspan MCP
                    │                                      │
                    │  ◄──────── tools + results ──────────┘
                    │
                    └──► Twilio REST API ──► reply SMS
```

The Worker never wraps any Healthspan tools itself. It hands Claude the MCP
server's URL via the Claude API's MCP connector, and Anthropic makes that
connection server-side — so every tool the server exposes (`log_measurement`,
`get_trend`, `query_observations`, all 14) is available automatically, and new
ones appear without a code change.

**Replies arrive as a separate message, not as a webhook response.** A turn that
reads the record and calls tools takes longer than Twilio's 15-second webhook
timeout, so the Worker acknowledges immediately and sends the answer via the
REST API when it's ready. Expect a few seconds' delay.

## Setup

### 1. Prerequisites

- A Cloudflare account (`npx wrangler login`)
- A Twilio account with an SMS-capable number
- An Anthropic API key
- The Healthspan MCP server's URL and bearer token

### 2. Install and create state storage

```sh
npm install
npx wrangler kv namespace create HEALTHSPAN_SMS
```

Paste the returned namespace id into `wrangler.toml` in place of
`REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Configure

Edit the `[vars]` block in `wrangler.toml`:

| Var | Meaning |
| --- | --- |
| `ALLOWED_NUMBERS` | Comma-separated E.164 numbers permitted to reach the record. Anything else is ignored. |
| `TWILIO_FROM_NUMBER` | The Twilio number replies are sent from, E.164. |
| `TIMEZONE` | IANA zone used to resolve "this morning" and "last night". |

Then set the secrets — these never go in the repo:

```sh
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put HEALTHSPAN_MCP_URL
npx wrangler secret put HEALTHSPAN_MCP_TOKEN   # only if the server uses a separate bearer
```

Treat the Healthspan URL itself as a credential. Some deployments carry the auth
token as a path segment (`…/mcp/<long-hex-string>`); where they do, the URL alone
grants full read/write access to the record, and `HEALTHSPAN_MCP_TOKEN` stays
unset. It goes in Cloudflare's secret store via the command above and nowhere
else — never in `wrangler.toml`, which is committed.

### 4. Deploy

```sh
npm run deploy
```

### 5. Point Twilio at it

In the Twilio console, open your number's **Messaging** configuration and set
"A message comes in" to **Webhook**, `HTTP POST`, with the URL:

```
https://healthspan-sms.<your-subdomain>.workers.dev/sms
```

Text the number. `npm run tail` streams live logs if something looks wrong.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev
```

`wrangler dev` serves on localhost; to receive real Twilio webhooks you'll need
a tunnel (`cloudflared tunnel --url http://localhost:8787`) and must set
`PUBLIC_URL` in `wrangler.toml` to the tunnel's `/sms` URL, since the signature
is computed over the exact URL Twilio posted to.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Local Worker with hot reload |
| `npm run deploy` | Deploy to Cloudflare |
| `npm test` | Twilio signature verification suite |
| `npm run typecheck` | Type check without emitting |
| `npm run tail` | Stream production logs |

## What you can text it

Anything conversational — it has the full tool surface. Some shapes that work:

- **Log a measurement** — "weight 246.8", "bp 118/76", "body fat 21.9"
- **Morning check-in** — "slept ok, 3 out of 5, feeling good today"
- **Context** — "started a new allergy med", "traveling this week, sleep is wrecked"
- **Ask** — "what's my resting HR doing?", "when was my last lipid panel?",
  "is my weight trending down?"
- **`reset`** — starts a fresh thread (see below)

## Behavior worth knowing

**Conversation memory.** The last 12 turns per number are kept in KV for 3 hours,
so follow-ups work ("what about last month?"). Only the text of each turn is
stored — not raw tool results — so a follow-up may re-query the record rather
than reusing stale numbers. Text `reset` to start clean.

**Duplicate protection.** Twilio retries webhooks it thinks weren't acknowledged.
Each `MessageSid` is claimed in KV before processing, so a retry can't log the
same weight twice.

**Rapid-fire messages.** Two texts sent before the first reply lands are handled
concurrently and both write thread state, so the later write wins and one turn
can drop out of the history. Both messages are still processed and logged — only
the conversational context is affected. Send one, wait for the reply, then send
the next if the follow-up depends on the first.

**Access control.** Two gates, both mandatory: an HMAC-SHA1 signature check
against `TWILIO_AUTH_TOKEN` proves the request came from Twilio, and the sender
must be on `ALLOWED_NUMBERS`. Messages from other numbers are acknowledged and
dropped without a reply — replying would confirm to a stranger that the number
is live.

**Units.** Weights are always reported in pounds, matching how the record's own
guidance says the owner reads them, even though values are stored in kilograms.

**Boundaries.** The assistant surfaces findings and quantifies uncertainty. It
does not diagnose and does not suggest changing a prescription; anything
clinically significant gets routed to a physician.

## Cost

Roughly, at a few messages a day: Twilio ~$1.15/month for the number plus
~$0.008 per message segment; Cloudflare Workers and KV fit inside the free tier;
Anthropic API usage dominates and depends on how much of the record each
question reads. The model is `claude-opus-5` at `medium` effort — a deliberate
latency trade for a texting interface. Both are one-line changes in
`src/claude.ts`.

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Webhook entry: verify, authorize, de-dupe, dispatch |
| `src/twilio.ts` | Signature verification and outbound SMS |
| `src/claude.ts` | Claude call with the Healthspan MCP server attached |
| `src/prompt.ts` | System prompt — record conventions and SMS style |
| `src/conversation.ts` | KV-backed thread state and de-duplication |
| `src/env.ts` | Configuration shape and startup validation |
| `test/twilio.test.mjs` | Signature verification suite |
