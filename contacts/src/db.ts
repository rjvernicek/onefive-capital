import type { Env } from "./env.js";
import { normalizeCompanyKey, normalizeEmail } from "./clean.js";

/** Brief row returned by search — enough to identify, cheap to list. */
export interface SearchHit {
  id: number;
  display_name: string;
  job_title: string | null;
  company: string | null;
  email: string | null;
}

export interface ContactCard {
  id: number;
  graph_id: string | null;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  job_title: string | null;
  company: { id: number; name: string } | null;
  emails: { email: string; label: string | null; is_primary: number }[];
  phones: { phone: string; label: string | null; is_primary: number }[];
  city: string | null;
  state: string | null;
  country: string | null;
  linkedin_url: string | null;
  tags: string[];
  source: string;
  notes: { body: string; occurred_at: string }[];
}

interface ContactRow {
  id: number;
  graph_id: string | null;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  company_id: number | null;
  job_title: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  linkedin_url: string | null;
  source: string;
  tags: string;
  deleted: number;
}

// ---------------------------------------------------------------------------
// Search

/**
 * FTS5 chokes on raw user input ("sarah@acme.com" parses as syntax), so the
 * query is reduced to quoted prefix tokens: `"sarah"* "acme"*`.
 */
function ftsQuery(query: string): string {
  return query
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((token) => `"${token}"*`)
    .join(" ");
}

export async function searchContacts(
  env: Env,
  query: string,
  limit = 8,
): Promise<SearchHit[]> {
  const match = ftsQuery(query);
  if (!match) return [];

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.display_name, c.job_title, co.name AS company,
            (SELECT email FROM contact_emails e
              WHERE e.contact_id = c.id ORDER BY e.is_primary DESC, e.id LIMIT 1) AS email
       FROM contact_search s
       JOIN contacts c ON c.id = s.contact_id
       LEFT JOIN companies co ON co.id = c.company_id
      WHERE contact_search MATCH ? AND c.deleted = 0
      ORDER BY rank
      LIMIT ?`,
  )
    .bind(match, limit)
    .all<SearchHit>();

  if (results.length > 0) return results;

  // FTS found nothing — fall back to substring match, which catches partial
  // tokens FTS prefix search misses ("rosen" inside "vanrosendale").
  const like = `%${query.trim()}%`;
  const fallback = await env.DB.prepare(
    `SELECT DISTINCT c.id, c.display_name, c.job_title, co.name AS company,
            (SELECT email FROM contact_emails e
              WHERE e.contact_id = c.id ORDER BY e.is_primary DESC, e.id LIMIT 1) AS email
       FROM contacts c
       LEFT JOIN companies co ON co.id = c.company_id
       LEFT JOIN contact_emails ce ON ce.contact_id = c.id
      WHERE c.deleted = 0
        AND (c.display_name LIKE ?1 OR co.name LIKE ?1 OR ce.email LIKE ?1)
      LIMIT ?2`,
  )
    .bind(like, limit)
    .all<SearchHit>();

  return fallback.results;
}

// ---------------------------------------------------------------------------
// Contact cards

export async function getContactCard(
  env: Env,
  id: number,
): Promise<ContactCard | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM contacts WHERE id = ? AND deleted = 0`,
  )
    .bind(id)
    .first<ContactRow>();
  if (!row) return null;

  const [emails, phones, notes, company] = await Promise.all([
    env.DB.prepare(
      `SELECT email, label, is_primary FROM contact_emails
        WHERE contact_id = ? ORDER BY is_primary DESC, id`,
    )
      .bind(id)
      .all<{ email: string; label: string | null; is_primary: number }>(),
    env.DB.prepare(
      `SELECT phone, label, is_primary FROM contact_phones
        WHERE contact_id = ? ORDER BY is_primary DESC, id`,
    )
      .bind(id)
      .all<{ phone: string; label: string | null; is_primary: number }>(),
    env.DB.prepare(
      `SELECT body, occurred_at FROM notes
        WHERE contact_id = ? ORDER BY occurred_at DESC LIMIT 8`,
    )
      .bind(id)
      .all<{ body: string; occurred_at: string }>(),
    row.company_id
      ? env.DB.prepare(`SELECT id, name FROM companies WHERE id = ?`)
          .bind(row.company_id)
          .first<{ id: number; name: string }>()
      : Promise.resolve(null),
  ]);

  return {
    id: row.id,
    graph_id: row.graph_id,
    display_name: row.display_name,
    given_name: row.given_name,
    family_name: row.family_name,
    job_title: row.job_title,
    company: company ?? null,
    emails: emails.results,
    phones: phones.results,
    city: row.city,
    state: row.state,
    country: row.country,
    linkedin_url: row.linkedin_url,
    tags: parseTags(row.tags),
    source: row.source,
    notes: notes.results,
  };
}

export function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Companies

export interface CompanyCard {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  description: string | null;
  people: SearchHit[];
  notes: { body: string; occurred_at: string }[];
}

export async function getCompanyCard(
  env: Env,
  name: string,
): Promise<CompanyCard | null> {
  const key = normalizeCompanyKey(name);
  let company = await env.DB.prepare(
    `SELECT id, name, domain, industry, description FROM companies
      WHERE normalized_name = ?`,
  )
    .bind(key)
    .first<Omit<CompanyCard, "people" | "notes">>();

  if (!company) {
    company = await env.DB.prepare(
      `SELECT id, name, domain, industry, description FROM companies
        WHERE normalized_name LIKE ? ORDER BY length(normalized_name) LIMIT 1`,
    )
      .bind(`%${key}%`)
      .first<Omit<CompanyCard, "people" | "notes">>();
  }
  if (!company) return null;

  const [people, notes] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.display_name, c.job_title, co.name AS company,
              (SELECT email FROM contact_emails e
                WHERE e.contact_id = c.id ORDER BY e.is_primary DESC, e.id LIMIT 1) AS email
         FROM contacts c
         JOIN companies co ON co.id = c.company_id
        WHERE c.company_id = ? AND c.deleted = 0
        ORDER BY c.display_name`,
    )
      .bind(company.id)
      .all<SearchHit>(),
    env.DB.prepare(
      `SELECT body, occurred_at FROM notes
        WHERE company_id = ? ORDER BY occurred_at DESC LIMIT 8`,
    )
      .bind(company.id)
      .all<{ body: string; occurred_at: string }>(),
  ]);

  return { ...company, people: people.results, notes: notes.results };
}

/**
 * Per-run memo of company key -> id. A few thousand contacts resolve to far
 * fewer distinct firms, so during the initial crawl this turns most company
 * lookups into no round trip at all.
 */
export type CompanyCache = Map<string, number | null>;

/** Find-or-create a company row by its normalized key. */
export async function ensureCompany(
  env: Env,
  name: string,
  cache?: CompanyCache,
): Promise<number | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const key = normalizeCompanyKey(trimmed);
  if (!key) return null;

  const memo = cache?.get(key);
  if (memo !== undefined) return memo;

  const existing = await env.DB.prepare(
    `SELECT id FROM companies WHERE normalized_name = ?`,
  )
    .bind(key)
    .first<{ id: number }>();
  if (existing) {
    cache?.set(key, existing.id);
    return existing.id;
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO companies (name, normalized_name) VALUES (?, ?) RETURNING id`,
  )
    .bind(trimmed, key)
    .first<{ id: number }>();
  const id = inserted?.id ?? null;
  cache?.set(key, id);
  return id;
}

// ---------------------------------------------------------------------------
// Writes

export interface ContactFields {
  display_name?: string;
  given_name?: string;
  family_name?: string;
  job_title?: string;
  company?: string;
  city?: string;
  state?: string;
  country?: string;
  linkedin_url?: string;
  tags?: string[];
}

export async function createContact(
  env: Env,
  fields: ContactFields & { source: string; graph_id?: string },
  emails: string[] = [],
  phones: string[] = [],
): Promise<number> {
  const companyId = fields.company ? await ensureCompany(env, fields.company) : null;

  const inserted = await env.DB.prepare(
    `INSERT INTO contacts
       (graph_id, display_name, given_name, family_name, company_id, job_title,
        city, state, country, linkedin_url, source, tags, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      fields.graph_id ?? null,
      fields.display_name ?? "(unnamed)",
      fields.given_name ?? null,
      fields.family_name ?? null,
      companyId,
      fields.job_title ?? null,
      fields.city ?? null,
      fields.state ?? null,
      fields.country ?? null,
      fields.linkedin_url ?? null,
      fields.source,
      JSON.stringify(fields.tags ?? []),
      fields.graph_id ? new Date().toISOString() : null,
    )
    .first<{ id: number }>();

  const id = inserted!.id;
  await replaceEmails(env, id, emails);
  await replacePhones(env, id, phones);
  await reindexContact(env, id);
  return id;
}

export async function updateContactFields(
  env: Env,
  id: number,
  fields: ContactFields,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  const scalarColumns: [keyof ContactFields, string][] = [
    ["display_name", "display_name"],
    ["given_name", "given_name"],
    ["family_name", "family_name"],
    ["job_title", "job_title"],
    ["city", "city"],
    ["state", "state"],
    ["country", "country"],
    ["linkedin_url", "linkedin_url"],
  ];
  for (const [field, column] of scalarColumns) {
    if (fields[field] !== undefined) {
      sets.push(`${column} = ?`);
      binds.push(fields[field]);
    }
  }
  if (fields.company !== undefined) {
    sets.push(`company_id = ?`);
    binds.push(fields.company ? await ensureCompany(env, fields.company) : null);
  }
  if (fields.tags !== undefined) {
    sets.push(`tags = ?`);
    binds.push(JSON.stringify(fields.tags));
  }
  if (sets.length === 0) return;

  sets.push(`updated_at = datetime('now')`);
  await env.DB.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, id)
    .run();
  await reindexContact(env, id);
}

/**
 * Statement builders for the rows that hang off a contact.
 *
 * These return statements rather than executing them so a caller can commit
 * emails, phones, and the search row in a single D1 batch. The initial Outlook
 * crawl writes thousands of contacts, and one round trip per row is the
 * difference between a crawl that finishes inside one invocation and one that
 * does not.
 */
export function emailStatements(
  env: Env,
  contactId: number,
  emails: string[],
): D1PreparedStatement[] {
  const unique = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  return [
    env.DB.prepare(`DELETE FROM contact_emails WHERE contact_id = ?`).bind(
      contactId,
    ),
    ...unique.map((email, i) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO contact_emails (contact_id, email, is_primary)
         VALUES (?, ?, ?)`,
      ).bind(contactId, email, i === 0 ? 1 : 0),
    ),
  ];
}

export function phoneStatements(
  env: Env,
  contactId: number,
  phones: string[],
): D1PreparedStatement[] {
  const unique = [...new Set(phones.map((p) => p.trim()).filter(Boolean))];
  return [
    env.DB.prepare(`DELETE FROM contact_phones WHERE contact_id = ?`).bind(
      contactId,
    ),
    ...unique.map((phone, i) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO contact_phones (contact_id, phone, is_primary)
         VALUES (?, ?, ?)`,
      ).bind(contactId, phone, i === 0 ? 1 : 0),
    ),
  ];
}

export function searchStatements(
  env: Env,
  contactId: number,
  blob: string | null,
): D1PreparedStatement[] {
  const statements = [
    env.DB.prepare(`DELETE FROM contact_search WHERE contact_id = ?`).bind(
      contactId,
    ),
  ];
  // A null blob means the contact is gone or tombstoned: drop it from the
  // index and write nothing back.
  if (blob !== null) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO contact_search (blob, contact_id) VALUES (?, ?)`,
      ).bind(blob, contactId),
    );
  }
  return statements;
}

export async function replaceEmails(
  env: Env,
  contactId: number,
  emails: string[],
): Promise<void> {
  await env.DB.batch(emailStatements(env, contactId, emails));
}

export async function replacePhones(
  env: Env,
  contactId: number,
  phones: string[],
): Promise<void> {
  await env.DB.batch(phoneStatements(env, contactId, phones));
}

export async function addNote(
  env: Env,
  note: {
    contactId?: number;
    companyId?: number;
    body: string;
    occurredAt?: string;
    source?: string;
  },
): Promise<number> {
  const inserted = await env.DB.prepare(
    `INSERT INTO notes (contact_id, company_id, body, occurred_at, source)
     VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?)
     RETURNING id`,
  )
    .bind(
      note.contactId ?? null,
      note.companyId ?? null,
      note.body,
      note.occurredAt ?? null,
      note.source ?? "sms",
    )
    .first<{ id: number }>();
  if (note.contactId) await reindexContact(env, note.contactId);
  return inserted!.id;
}

// ---------------------------------------------------------------------------
// Search index maintenance

export interface SearchBlobInput {
  displayName: string;
  givenName?: string | null;
  familyName?: string | null;
  jobTitle?: string | null;
  companyName?: string | null;
  city?: string | null;
  state?: string | null;
  emails: string[];
  phones: string[];
  tags: string[];
  notes: string[];
}

/**
 * Flatten everything a lookup might reasonably key on into one indexable
 * string: name, title, company, location, emails, phones, tags, and recent
 * note text.
 *
 * Shared by both writers so the blob the sync path builds inline and the one
 * reindexContact rebuilds from a card can't drift apart — a difference between
 * them would show up as contacts that are findable only until the next sync
 * touches them.
 */
export function buildSearchBlob(input: SearchBlobInput): string {
  return [
    input.displayName,
    input.givenName,
    input.familyName,
    input.jobTitle,
    input.companyName,
    input.city,
    input.state,
    ...input.emails,
    ...input.phones,
    ...input.tags,
    ...input.notes,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Note bodies that belong in the search blob, without loading a whole card. */
export async function recentNoteBodies(
  env: Env,
  contactId: number,
  limit = 8,
): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT body FROM notes WHERE contact_id = ? ORDER BY occurred_at DESC LIMIT ?`,
  )
    .bind(contactId, limit)
    .all<{ body: string }>();
  return results.map((r) => r.body);
}

/**
 * Rebuild the one search row for a contact by re-reading its card. Callers
 * that already hold the contact's data should build the blob with
 * buildSearchBlob and batch searchStatements instead — this path costs a full
 * card read.
 */
export async function reindexContact(env: Env, id: number): Promise<void> {
  const card = await getContactCard(env, id);
  const blob = card
    ? buildSearchBlob({
        displayName: card.display_name,
        givenName: card.given_name,
        familyName: card.family_name,
        jobTitle: card.job_title,
        companyName: card.company?.name,
        city: card.city,
        state: card.state,
        emails: card.emails.map((e) => e.email),
        phones: card.phones.map((p) => p.phone),
        tags: card.tags,
        notes: card.notes.map((n) => n.body),
      })
    : null; // deleted/tombstoned: leave it out of the index

  await env.DB.batch(searchStatements(env, id, blob));
}

// ---------------------------------------------------------------------------
// Proposals (the change queue between this database and Outlook)

export interface Proposal {
  id: number;
  kind: string;
  contact_id: number | null;
  payload: string;
  summary: string;
  status: string;
  error: string | null;
  created_at: string;
}

export async function createProposal(
  env: Env,
  proposal: {
    kind: string;
    contactId?: number;
    payload: unknown;
    summary: string;
    dedupeKey?: string;
    status?: string;
  },
): Promise<number | null> {
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO proposals (kind, contact_id, payload, summary, dedupe_key, status)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      proposal.kind,
      proposal.contactId ?? null,
      JSON.stringify(proposal.payload),
      proposal.summary,
      proposal.dedupeKey ?? null,
      proposal.status ?? "pending",
    )
    .first<{ id: number }>();
  return inserted?.id ?? null;
}

export async function listProposals(
  env: Env,
  status: string,
  limit = 10,
): Promise<Proposal[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, contact_id, payload, summary, status, error, created_at
       FROM proposals WHERE status = ? ORDER BY id LIMIT ?`,
  )
    .bind(status, limit)
    .all<Proposal>();
  return results;
}

export async function getProposal(
  env: Env,
  id: number,
): Promise<Proposal | null> {
  return env.DB.prepare(
    `SELECT id, kind, contact_id, payload, summary, status, error, created_at
       FROM proposals WHERE id = ?`,
  )
    .bind(id)
    .first<Proposal>();
}

export async function countProposals(
  env: Env,
  status: string,
  kind?: string,
): Promise<number> {
  const row = kind
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM proposals WHERE status = ? AND kind = ?`,
      )
        .bind(status, kind)
        .first<{ n: number }>()
    : await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM proposals WHERE status = ?`,
      )
        .bind(status)
        .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Resolve every pending proposal at once, optionally limited to one kind.
 *
 * Exists for the migration case: a first crawl of a long-lived rolodex can
 * surface a hundred or more duplicates, and clearing that backlog one id per
 * text is not a review, it is a chore that gets abandoned half-done. Approving
 * in bulk is the owner's call to make explicitly — nothing calls this on its
 * own initiative.
 *
 * Returns the number of proposals moved.
 */
export async function resolveAllProposals(
  env: Env,
  status: "approved" | "rejected",
  kind?: string,
): Promise<number> {
  const statement = kind
    ? env.DB.prepare(
        `UPDATE proposals SET status = ?, resolved_at = datetime('now')
          WHERE status = 'pending' AND kind = ?`,
      ).bind(status, kind)
    : env.DB.prepare(
        `UPDATE proposals SET status = ?, resolved_at = datetime('now')
          WHERE status = 'pending'`,
      ).bind(status);

  const result = await statement.run();
  return result.meta.changes ?? 0;
}

export async function setProposalStatus(
  env: Env,
  id: number,
  status: string,
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE proposals
        SET status = ?, error = ?, resolved_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(status, error ?? null, id)
    .run();
}

// ---------------------------------------------------------------------------
// Sync bookkeeping

export async function getSyncState(
  env: Env,
  key: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT value FROM sync_state WHERE key = ?`,
  )
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSyncState(
  env: Env,
  key: string,
  value: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, value)
    .run();
}
