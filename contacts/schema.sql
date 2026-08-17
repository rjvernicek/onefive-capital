-- OneFive contact database schema (Cloudflare D1 / SQLite).
--
-- D1 is the canonical store; Outlook is a synced view of it. Contacts carry a
-- graph_id linking them to their Outlook record; rows created over SMS have no
-- graph_id until a push_create proposal is applied.
--
-- Apply with:  npm run db:migrate   (or db:migrate:local for wrangler dev)

CREATE TABLE IF NOT EXISTS companies (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  -- Suffix-stripped, lower-cased key ("Acme Holdings, LLC" -> "acme holdings")
  -- so every spelling of the same firm lands on one row.
  normalized_name TEXT NOT NULL UNIQUE,
  domain          TEXT,
  industry        TEXT,
  description     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY,
  -- Outlook (Microsoft Graph) id. NULL for contacts that exist only here.
  graph_id      TEXT UNIQUE,
  display_name  TEXT NOT NULL,
  given_name    TEXT,
  family_name   TEXT,
  company_id    INTEGER REFERENCES companies(id),
  job_title     TEXT,
  city          TEXT,
  state         TEXT,
  country       TEXT,
  linkedin_url  TEXT,
  -- Where the row originated: 'outlook' | 'sms' | 'import'
  source        TEXT NOT NULL DEFAULT 'outlook',
  -- JSON array of free-form tags, e.g. ["lp","dallas","real-estate"]
  tags          TEXT NOT NULL DEFAULT '[]',
  synced_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- Soft delete: Outlook deletions tombstone the row so notes are never lost.
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_name    ON contacts(display_name);

CREATE TABLE IF NOT EXISTS contact_emails (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  label      TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE (contact_id, email)
);

CREATE INDEX IF NOT EXISTS idx_emails_email ON contact_emails(email);

CREATE TABLE IF NOT EXISTS contact_phones (
  id            INTEGER PRIMARY KEY,
  contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- E.164 when normalization succeeded; the raw string otherwise.
  phone         TEXT NOT NULL,
  label         TEXT,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (contact_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_phones_phone ON contact_phones(phone);

-- The layer Outlook has no room for: dated, attributable intel. "Met at the
-- Dallas conference", "raising fund II, target $150M", "prefers email".
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER REFERENCES contacts(id),
  company_id  INTEGER REFERENCES companies(id),
  body        TEXT NOT NULL,
  -- When the thing happened, as distinct from when it was recorded.
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  source      TEXT NOT NULL DEFAULT 'sms',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (contact_id IS NOT NULL OR company_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_notes_company ON notes(company_id);

-- Every change that touches Outlook goes through here, in both directions:
-- hygiene findings wait as 'pending' until approved over SMS; user-initiated
-- edits enter as 'approved' and the next sync run pushes them.
--
-- kind: 'merge_duplicates' | 'fix_formatting' | 'push_update' | 'push_create'
-- status: 'pending' -> 'approved'/'rejected' -> 'applied'/'error'
CREATE TABLE IF NOT EXISTS proposals (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  contact_id  INTEGER REFERENCES contacts(id),
  -- Kind-specific JSON payload (patch fields, merge keep/drop ids, ...).
  payload     TEXT NOT NULL,
  -- One-line human summary, readable in an SMS list.
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  -- Stable key so re-detecting the same issue doesn't re-open a new proposal.
  dedupe_key  TEXT UNIQUE,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

-- Sync bookkeeping: Graph delta link, last run time, last run summary,
-- known model ids, last pricing review.
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per SMS turn, summed across that turn's tool rounds. The monthly
-- pricing review reads these back to cost real traffic against other models
-- instead of guessing at it.
CREATE TABLE IF NOT EXISTS model_usage (
  id                 INTEGER PRIMARY KEY,
  occurred_at        TEXT NOT NULL DEFAULT (datetime('now')),
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_usage_occurred ON model_usage(occurred_at);

-- Full-text search over a flattened blob per contact (name, company, title,
-- emails, phones, tags, recent notes). Maintained by db.reindexContact —
-- rebuilt row-per-contact on every write rather than via triggers, because
-- the blob spans four tables.
CREATE VIRTUAL TABLE IF NOT EXISTS contact_search USING fts5(
  blob,
  contact_id UNINDEXED
);
