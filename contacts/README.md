# onefive-contacts

Your rolodex as a database you can text. Two jobs:

1. **Keeps Outlook clean.** Contacts sync in from Outlook on a schedule, get
   normalized (phone formats, name casing, duplicate detection), and cleanups
   flow back to Outlook — but only after you approve them by text.
2. **Answers by SMS.** Text a question about a person or company and Claude
   searches the database and texts back.

```
you  → "who do we know at blackstone?"
back ← "3 people: Mark Ellis (MD, real estate), Sarah Kim (VP, credit),
        Tom Ruiz (IR). Last note: Ellis intro'd the Dallas industrial
        deal in June."

you  → "sarah kim's cell?"
back ← "Sarah Kim, VP Credit at Blackstone: +12125550147, skim@blackstone.com"

you  → "met David Park at the Fort Worth conf, he's raising a $50M
        industrial fund, intro'd by Mark Ellis"
back ← "Noted on David Park: met at Fort Worth conf, raising $50M
        industrial fund, intro via Mark Ellis."

you  → "cleanups?"
back ← "2 pending: #4 merge 'Jon Smith' into 'John Smith' (shared email),
        #7 fix phone (214) 555-1234 -> +12145551234. Reply approve/reject
        with the number."
```

## How it works

```
                 ┌────────────── every 30 min (cron) ──────────────┐
                 ▼                                                  │
Outlook ◄──► Microsoft Graph ◄──► sync engine ──► D1 (canonical DB) │
 (delta queries in; approved       │                    ▲           │
  changes only, back out)          └── hygiene queue ───┤           │
                                       (proposals)      │           │
Twilio SMS ──► Cloudflare Worker ──► Claude (tool loop) ┘           │
                    │                                               │
                    └──► Twilio REST API ──► reply SMS ─────────────┘
```

**D1 is the source of truth; Outlook is a synced view.** The database holds
what Outlook has no room for — dated notes, tags, company records, interaction
history — while Outlook keeps the clean basics (name, title, company, emails,
phones) that every device already syncs.

**Cleaning is propose-then-approve.** The sync engine never silently rewrites
an Outlook contact. It detects issues and queues *proposals*:

- `fix_formatting` — phone to E.164, ALL-CAPS names to title case, emails
  lower-cased. Conservative rules only (see `src/clean.ts`); anything
  ambiguous is left alone rather than guessed at.
- `merge_duplicates` — two contacts sharing an email address or an exact
  name. Deliberately narrow: fuzzy matching fills the queue with false
  positives and then real duplicates rot unreviewed.

You review by text ("cleanups?" → "approve 4"). Approved proposals apply on
the next sync run — including the Outlook write. Your own edits over SMS
("Jane moved to Apollo") skip the queue: they enter pre-approved and push on
the next run.

**Sync is incremental.** Graph delta queries return only what changed since
the last run, so the half-hourly cron costs almost nothing. Outlook deletions
tombstone the local row instead of deleting it — the notes survive.

**The SMS loop is client-side tools.** Unlike `healthspan-sms` (which points
Claude at an external MCP server), the data here lives in this Worker's D1
binding, so the Worker defines nine tools (search, contact card, company
card, add note, create, update, cleanups, sync status) and runs the tool
loop itself.

## Setup

### 1. Prerequisites

- A Cloudflare account (`npx wrangler login`)
- A Twilio account with an SMS-capable number
- An Anthropic API key
- A Microsoft account with the Outlook contacts (work M365 or personal)

### 2. Install and create storage

```sh
npm install
npm run db:create                                # D1 database
npx wrangler kv namespace create ONEFIVE_CONTACTS  # tokens + threads
```

Paste the returned ids into `wrangler.toml` (`database_id` and the KV `id`),
then create the schema:

```sh
npm run db:migrate
```

### 3. Register the Azure app (for Outlook access)

In [Azure Portal → App registrations](https://portal.azure.com) → New
registration:

- Supported account types: match your account (single tenant for a work
  M365 account is tightest).
- Redirect URI (Web): `https://onefive-contacts.<your-subdomain>.workers.dev/auth/callback`
- Under **API permissions**, add Microsoft Graph → Delegated →
  `Contacts.ReadWrite` and `offline_access`.
- Under **Certificates & secrets**, create a client secret.

Note the Application (client) ID and the secret value. If you chose single
tenant, set `MS_TENANT` in `wrangler.toml` to your tenant id.

### 4. Configure

Edit the `[vars]` block in `wrangler.toml` (`ALLOWED_NUMBERS`,
`TWILIO_FROM_NUMBER`, `TIMEZONE`), then set the secrets:

```sh
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put MS_CLIENT_ID
npx wrangler secret put MS_CLIENT_SECRET
npx wrangler secret put ADMIN_KEY      # openssl rand -hex 32
```

### 5. Deploy and connect

```sh
npm run deploy
```

Then, once, in a browser:

```
https://onefive-contacts.<your-subdomain>.workers.dev/auth/start?key=<ADMIN_KEY>
```

Sign in to Microsoft and consent. The refresh token lands in KV (rotated on
every use, never in a URL) and the first full crawl of your contacts starts
immediately. After that the cron keeps things current every 30 minutes;
`POST /sync?key=<ADMIN_KEY>` forces a run.

### 6. Point Twilio at it

In the Twilio console, open your number's **Messaging** configuration and set
"A message comes in" to **Webhook**, `HTTP POST`, with the URL:

```
https://onefive-contacts.<your-subdomain>.workers.dev/sms
```

Text the number. `npm run tail` streams live logs if something looks wrong.

## What you can text it

- **Look up a person** — "who is David Park?", "sarah kim's cell?",
  "email for the guy at Reed Capital"
- **Look up a company** — "who do we know at Apollo?", "notes on Blackstone"
- **Capture intel** — "met Tom Reed at the Dallas conf, runs a $200M book",
  "Jane moved to Apollo, now a principal", "tag Ellis as lp"
- **Add someone** — "add Tom Reed, tom@reedcap.com, 214-555-0100, runs Reed
  Capital" (created in Outlook on the next sync)
- **Hygiene** — "cleanups?", then "approve 4" / "reject 7"
- **Status** — "when did the last sync run?"
- **Cost** — "pricing" runs the spend review on demand; "what am I spending?"
  answers conversationally
- **`model`** — shows the current model; `model haiku` switches; `model reset`
  returns to the default
- **`reset`** — starts a fresh thread

## Access control

Same posture as `healthspan-sms`, because the failure modes are identical:

- Twilio webhooks are verified by HMAC signature; the sender must be on
  `ALLOWED_NUMBERS`; strangers are dropped without a reply.
- `/auth/start` and `/sync` require `ADMIN_KEY` (constant-time compared).
  `/auth/callback` is guarded by the CSRF state minted by `/auth/start`.
- The Graph refresh token lives only in KV and rotates on every refresh.
- SMS is not an authenticated channel in any strong sense — SIM swaps happen.
  The blast radius here is your rolodex, not your health record, but keep
  `ALLOWED_NUMBERS` tight.

## Model and cost

The default is **Claude Sonnet 5** — near-Opus quality on the tool-calling work
this does, at roughly 60% of the cost. Change it by text, not by redeploy:

```
you  → "model haiku"
back ← "Switched to Haiku 4.5 ($1/$5 per Mtok). Takes effect on your next message."
```

The override lives in KV and wins over `DEFAULT_MODEL` in `wrangler.toml`;
`model reset` clears it. Only models in the `src/pricing.ts` catalog are
accepted, so a typo can't wedge the gateway on an id that 404s. This is a
reserved command handled *before* the model is called — which is the point: if
the configured model is ever unavailable, it's the only way back.

**Every turn's token usage is recorded** to `model_usage`, and on the 1st of
each month a review costs that real traffic against the alternatives and texts
you the comparison:

```
back ← "Last 30d: 150 msgs, $5.43 on Sonnet 5. Same traffic: Haiku 4.5 ~$1.81,
        Opus 5 ~$9.06 (est). Switching to Haiku 4.5 saves ~$3.62/mo. Reply
        'model <name>' to switch, or ignore to stay on Sonnet 5."
```

The review costs nothing to run — the message is assembled from arithmetic, not
generated — and stays quiet in a month with no usage and no news, so the one
that does matter doesn't arrive pre-muted. Text `pricing` to run it on demand.

It also watches for two things you wouldn't otherwise notice:

- **Promotional pricing about to lapse.** Sonnet 5's introductory rate ends
  2026-08-31, after which output goes $10 → $15 per Mtok — a ~50% rise with no
  change in usage. The review warns 45 days out.
- **New models.** `GET /v1/models` is polled each review; anything new that has
  a price in the catalog gets mentioned.

**Pricing is maintained by hand** in `src/pricing.ts`, because the API exposes
capabilities but not prices. The table is stamped with the date it was last
verified, and the review flags itself as stale after 120 days rather than
quietly producing confident, wrong recommendations. Re-check it against
Anthropic's pricing page when that warning appears and bump `PRICING_VERIFIED`.

One caveat the review states in its own message: alternative costs are
**estimates**. Models tokenize differently, and a cheaper model may need more
tool rounds to reach the same answer. Treat the ranking as sound and the
absolute figures as approximate.

## Design decisions

**Why D1 and not just Outlook via Graph on demand?** Three reasons: full-text
search across notes ("the guy raising the industrial fund") needs an index
Outlook doesn't have; notes/tags/companies don't fit Outlook's schema; and a
local database answers in one round trip instead of several Graph calls per
question.

**Why propose-then-approve instead of auto-clean?** A normalizer that guesses
wrong corrupts a rolodex faster than one that declines, and a bad merge is
data loss. Formatting fixes are near-safe but still visible in the queue so
you learn what the rules do; merges are never applied without you.

**Why companies as first-class rows?** "Who do we know at X" is the query a
deal-flow rolodex exists to answer. Aggregating contacts under a normalized
company key (suffix-stripped, so "Acme Holdings, LLC" and "Acme" collide)
makes it one lookup, and gives company-level notes somewhere to live.

## Roadmap ideas

Deliberately not built yet, in rough order of likely value:

- **Interaction recency from email/calendar.** Graph can also read mail and
  calendar metadata; a "last touched" date per contact enables "who haven't
  I talked to in 6 months at X" and makes dedupe-keep decisions smarter.
  Needs `Mail.Read`/`Calendars.Read` — a meaningful scope expansion, opt in
  consciously.
- **Email signature capture.** New titles and numbers appear in signatures
  long before anyone edits a contact card.
- **CSV import** for lists that live outside Outlook (conference attendees,
  LP lists) via a `/import` admin endpoint.
- **Enrichment** (domain → firm data, LinkedIn URLs) through a provider like
  Clearbit/Apollo — cost per contact, so batch and cache.
- **Weekly hygiene digest by SMS** — proactive "5 cleanups pending, 3
  contacts went stale" instead of waiting to be asked.
- **MCP server surface.** Wrap the same D1 tools as an MCP server (Workers
  can serve MCP directly) so Claude on desktop/web can use the rolodex too,
  not just SMS. The tool layer (`src/tools.ts`) is already shaped for it.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Local Worker with hot reload |
| `npm run deploy` | Deploy to Cloudflare |
| `npm test` | Normalization + pricing rule suites |
| `npm run typecheck` | Type check without emitting |
| `npm run tail` | Stream production logs |
| `npm run db:migrate` | Apply schema.sql to the remote D1 |
| `npm run db:migrate:local` | Apply schema.sql to the local dev D1 |

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Routes: SMS webhook, OAuth connect, manual sync, cron |
| `src/sync.ts` | Sync engine: delta pull, hygiene detection, approved-change push |
| `src/pricing.ts` | Model catalog, prices, cost math (pure, tested) |
| `src/model.ts` | Active-model resolution and the `model` command |
| `src/usage.ts` | Per-turn token accounting and window summaries |
| `src/review.ts` | Monthly pricing review and new-model detection |
| `src/graph.ts` | Microsoft Graph: OAuth, token rotation, delta reads, writes |
| `src/db.ts` | D1 data layer: search, cards, writes, proposals |
| `src/clean.ts` | Normalization rules (pure, tested) |
| `src/tools.ts` | Claude tool definitions + executor over the data layer |
| `src/claude.ts` | Claude call with client-side tool loop |
| `src/prompt.ts` | System prompt — rolodex conventions and SMS style |
| `src/twilio.ts` | Signature verification and outbound SMS |
| `src/conversation.ts` | KV-backed thread state and de-duplication |
| `src/env.ts` | Configuration shape and startup validation |
| `schema.sql` | D1 schema: contacts, companies, notes, proposals, usage, FTS |
