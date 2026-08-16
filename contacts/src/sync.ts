import type { Env } from "./env.js";
import {
  pullContactsDelta,
  patchContact,
  createOutlookContact,
  deleteOutlookContact,
  isConnected,
  type GraphContact,
} from "./graph.js";
import {
  createContact,
  updateContactFields,
  replaceEmails,
  replacePhones,
  reindexContact,
  createProposal,
  listProposals,
  setProposalStatus,
  getSyncState,
  setSyncState,
  getContactCard,
} from "./db.js";
import { normalizePhone, normalizeNameCase, normalizeEmail } from "./clean.js";

export interface SyncSummary {
  connected: boolean;
  pulled: number;
  removed: number;
  proposalsOpened: number;
  proposalsApplied: number;
  errors: string[];
}

/**
 * One full sync cycle, run by cron and on demand via POST /sync.
 *
 * Order matters: pushes go first so an edit made over SMS reaches Outlook
 * before the pull — otherwise the pull could re-import the stale value and
 * the push would then look like a conflict.
 */
export async function runSync(env: Env): Promise<SyncSummary> {
  const summary: SyncSummary = {
    connected: await isConnected(env),
    pulled: 0,
    removed: 0,
    proposalsOpened: 0,
    proposalsApplied: 0,
    errors: [],
  };
  if (!summary.connected) return summary;

  summary.proposalsApplied = await pushApproved(env, summary.errors);

  const deltaLink = await getSyncState(env, "graph_delta_link");
  const delta = await pullContactsDelta(env, deltaLink);

  for (const contact of delta.contacts) {
    try {
      const opened = await upsertFromGraph(env, contact);
      summary.pulled++;
      summary.proposalsOpened += opened;
    } catch (error) {
      summary.errors.push(`upsert ${contact.id}: ${message(error)}`);
    }
  }

  for (const graphId of delta.removedIds) {
    // Tombstone rather than delete: the notes attached to a contact are this
    // database's whole value-add and outlive the Outlook record.
    await env.DB.prepare(
      `UPDATE contacts SET deleted = 1, updated_at = datetime('now') WHERE graph_id = ?`,
    )
      .bind(graphId)
      .run();
    summary.removed++;
  }

  summary.proposalsOpened += await detectDuplicates(env);

  if (delta.deltaLink) {
    await setSyncState(env, "graph_delta_link", delta.deltaLink);
  }
  await setSyncState(
    env,
    "last_sync",
    JSON.stringify({ at: new Date().toISOString(), ...summary }),
  );
  return summary;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Pull: Outlook -> D1

/**
 * Upsert one Outlook contact. Normalized values (E.164 phones, lower-cased
 * emails, fixed name casing) are what D1 stores; where the normalized form
 * differs from what Outlook holds, a pending fix_formatting proposal is
 * opened instead of silently rewriting the Outlook record.
 *
 * Returns the number of hygiene proposals opened.
 */
async function upsertFromGraph(
  env: Env,
  graphContact: GraphContact,
): Promise<number> {
  const rawName =
    graphContact.displayName ||
    [graphContact.givenName, graphContact.surname].filter(Boolean).join(" ") ||
    graphContact.emailAddresses?.[0]?.address ||
    "(unnamed)";
  const displayName = normalizeNameCase(rawName);

  const rawPhones = [
    ...(graphContact.mobilePhone ? [graphContact.mobilePhone] : []),
    ...(graphContact.businessPhones ?? []),
    ...(graphContact.homePhones ?? []),
  ];
  const phones = rawPhones.map((p) => normalizePhone(p, env.DEFAULT_REGION));
  const emails = (graphContact.emailAddresses ?? [])
    .map((e) => e.address ?? "")
    .filter(Boolean);

  const fields = {
    display_name: displayName,
    given_name: graphContact.givenName ?? undefined,
    family_name: graphContact.surname ?? undefined,
    job_title: graphContact.jobTitle ?? undefined,
    company: graphContact.companyName ?? undefined,
    city: graphContact.businessAddress?.city ?? undefined,
    state: graphContact.businessAddress?.state ?? undefined,
    country: graphContact.businessAddress?.countryOrRegion ?? undefined,
  };

  const existing = await env.DB.prepare(
    `SELECT id FROM contacts WHERE graph_id = ?`,
  )
    .bind(graphContact.id)
    .first<{ id: number }>();

  let contactId: number;
  if (existing) {
    contactId = existing.id;
    await updateContactFields(env, contactId, fields);
    await env.DB.prepare(
      `UPDATE contacts SET deleted = 0, synced_at = datetime('now') WHERE id = ?`,
    )
      .bind(contactId)
      .run();
    await replaceEmails(env, contactId, emails);
    await replacePhones(env, contactId, phones.map((p) => p.value));
    await reindexContact(env, contactId);
  } else {
    contactId = await createContact(
      env,
      { ...fields, source: "outlook", graph_id: graphContact.id },
      emails,
      phones.map((p) => p.value),
    );
  }

  return openFormattingProposals(env, contactId, graphContact, {
    displayName,
    rawName,
    rawPhones,
    phones,
    emails,
  });
}

async function openFormattingProposals(
  env: Env,
  contactId: number,
  graphContact: GraphContact,
  normalized: {
    displayName: string;
    rawName: string;
    rawPhones: string[];
    phones: { value: string; ok: boolean }[];
    emails: string[];
  },
): Promise<number> {
  let opened = 0;
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];

  if (normalized.displayName !== normalized.rawName.trim()) {
    patch.displayName = normalized.displayName;
    changes.push(`name "${normalized.rawName}" -> "${normalized.displayName}"`);
  }

  const phoneChanges = normalized.rawPhones
    .map((raw, i) => ({ raw: raw.trim(), fixed: normalized.phones[i] }))
    .filter(({ raw, fixed }) => fixed.ok && fixed.value !== raw);
  if (phoneChanges.length > 0) {
    // Phones write back into the slots they came from. Mobile first mirrors
    // the read order in upsertFromGraph.
    const fixedAll = normalized.rawPhones.map(
      (raw, i) => normalized.phones[i].ok ? normalized.phones[i].value : raw.trim(),
    );
    let cursor = 0;
    if (graphContact.mobilePhone) patch.mobilePhone = fixedAll[cursor++];
    if ((graphContact.businessPhones ?? []).length > 0) {
      patch.businessPhones = fixedAll.slice(
        cursor,
        cursor + graphContact.businessPhones!.length,
      );
      cursor += graphContact.businessPhones!.length;
    }
    if ((graphContact.homePhones ?? []).length > 0) {
      patch.homePhones = fixedAll.slice(cursor);
    }
    changes.push(
      ...phoneChanges.map(({ raw, fixed }) => `phone ${raw} -> ${fixed.value}`),
    );
  }

  const badEmails = normalized.emails.filter((e) => e !== normalizeEmail(e));
  if (badEmails.length > 0) {
    patch.emailAddresses = normalized.emails.map((e) => ({
      address: normalizeEmail(e),
    }));
    changes.push(...badEmails.map((e) => `email ${e} -> ${normalizeEmail(e)}`));
  }

  if (changes.length > 0) {
    const id = await createProposal(env, {
      kind: "fix_formatting",
      contactId,
      payload: { graphId: graphContact.id, patch },
      summary: `${normalized.displayName}: ${changes.join(", ")}`,
      dedupeKey: `fmt:${graphContact.id}:${JSON.stringify(patch)}`,
    });
    if (id !== null) opened++;
  }
  return opened;
}

// ---------------------------------------------------------------------------
// Hygiene: duplicate detection

/**
 * Open merge proposals for contacts that share an email address or an exact
 * display name. Detection is deliberately narrow (see clean.ts) — a hygiene
 * queue full of false positives gets ignored, and then real duplicates rot.
 */
async function detectDuplicates(env: Env): Promise<number> {
  let opened = 0;

  const byEmail = await env.DB.prepare(
    `SELECT MIN(c.id) AS keep_id, MAX(c.id) AS drop_id, e.email AS reason
       FROM contact_emails e
       JOIN contacts c ON c.id = e.contact_id AND c.deleted = 0
      GROUP BY e.email
     HAVING COUNT(DISTINCT c.id) > 1`,
  ).all<{ keep_id: number; drop_id: number; reason: string }>();

  const byName = await env.DB.prepare(
    `SELECT MIN(id) AS keep_id, MAX(id) AS drop_id,
            lower(trim(display_name)) AS reason
       FROM contacts
      WHERE deleted = 0
      GROUP BY lower(trim(display_name))
     HAVING COUNT(*) > 1`,
  ).all<{ keep_id: number; drop_id: number; reason: string }>();

  const pairs = new Map<string, { keep: number; drop: number; why: string }>();
  for (const row of byEmail.results) {
    pairs.set(`${row.keep_id}:${row.drop_id}`, {
      keep: row.keep_id,
      drop: row.drop_id,
      why: `shared email ${row.reason}`,
    });
  }
  for (const row of byName.results) {
    const key = `${row.keep_id}:${row.drop_id}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        keep: row.keep_id,
        drop: row.drop_id,
        why: `same name "${row.reason}"`,
      });
    }
  }

  for (const { keep, drop, why } of pairs.values()) {
    const [keepCard, dropCard] = await Promise.all([
      getContactCard(env, keep),
      getContactCard(env, drop),
    ]);
    if (!keepCard || !dropCard) continue;
    const id = await createProposal(env, {
      kind: "merge_duplicates",
      contactId: keep,
      payload: { keepId: keep, dropId: drop },
      summary: `merge "${dropCard.display_name}" (#${drop}) into "${keepCard.display_name}" (#${keep}) — ${why}`,
      dedupeKey: `merge:${keep}:${drop}`,
    });
    if (id !== null) opened++;
  }
  return opened;
}

// ---------------------------------------------------------------------------
// Push: approved proposals -> Outlook

async function pushApproved(env: Env, errors: string[]): Promise<number> {
  const approved = await listProposals(env, "approved", 50);
  let applied = 0;

  for (const proposal of approved) {
    try {
      const payload = JSON.parse(proposal.payload) as Record<string, unknown>;
      switch (proposal.kind) {
        case "fix_formatting":
          await patchContact(
            env,
            payload.graphId as string,
            payload.patch as Record<string, unknown>,
          );
          break;
        case "push_update": {
          const contactId = payload.contactId as number;
          const card = await getContactCard(env, contactId);
          if (!card) throw new Error(`contact #${contactId} not found`);
          if (!card.graph_id) throw new Error(`contact #${contactId} has no Outlook record`);
          await patchContact(env, card.graph_id, outlookPayload(card));
          break;
        }
        case "push_create": {
          const contactId = payload.contactId as number;
          const card = await getContactCard(env, contactId);
          if (!card) throw new Error(`contact #${contactId} not found`);
          const graphId = await createOutlookContact(env, outlookPayload(card));
          await env.DB.prepare(
            `UPDATE contacts SET graph_id = ?, synced_at = datetime('now') WHERE id = ?`,
          )
            .bind(graphId, contactId)
            .run();
          break;
        }
        case "merge_duplicates":
          await applyMerge(env, payload.keepId as number, payload.dropId as number);
          break;
        default:
          throw new Error(`unknown proposal kind: ${proposal.kind}`);
      }
      await setProposalStatus(env, proposal.id, "applied");
      applied++;
    } catch (error) {
      const msg = message(error);
      errors.push(`proposal #${proposal.id}: ${msg}`);
      await setProposalStatus(env, proposal.id, "error", msg);
    }
  }
  return applied;
}

/** The Outlook representation of a D1 contact card. */
function outlookPayload(card: {
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  job_title: string | null;
  company: { name: string } | null;
  emails: { email: string }[];
  phones: { phone: string; is_primary: number }[];
}): Record<string, unknown> {
  return {
    displayName: card.display_name,
    givenName: card.given_name ?? undefined,
    surname: card.family_name ?? undefined,
    jobTitle: card.job_title ?? undefined,
    companyName: card.company?.name ?? undefined,
    emailAddresses: card.emails.map((e) => ({ address: e.email })),
    // The primary phone lands in mobilePhone, the rest in businessPhones —
    // a simplification of Outlook's slot model, applied consistently.
    mobilePhone: card.phones[0]?.phone,
    businessPhones: card.phones.slice(1).map((p) => p.phone),
  };
}

/**
 * Merge drop into keep: children move over, missing scalar fields backfill,
 * the losing row tombstones, and its Outlook record (if any) is deleted so
 * the duplicate doesn't resurrect on the next pull.
 */
async function applyMerge(
  env: Env,
  keepId: number,
  dropId: number,
): Promise<void> {
  const drop = await getContactCard(env, dropId);
  if (!drop) return; // already merged by an earlier proposal

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE OR IGNORE contact_emails SET contact_id = ?1 WHERE contact_id = ?2`,
    ).bind(keepId, dropId),
    env.DB.prepare(
      `UPDATE OR IGNORE contact_phones SET contact_id = ?1 WHERE contact_id = ?2`,
    ).bind(keepId, dropId),
    // Anything OR IGNORE skipped was an exact duplicate on the keeper.
    env.DB.prepare(`DELETE FROM contact_emails WHERE contact_id = ?`).bind(dropId),
    env.DB.prepare(`DELETE FROM contact_phones WHERE contact_id = ?`).bind(dropId),
    env.DB.prepare(`UPDATE notes SET contact_id = ?1 WHERE contact_id = ?2`).bind(
      keepId,
      dropId,
    ),
    env.DB.prepare(
      `UPDATE contacts SET
         job_title    = COALESCE(job_title, (SELECT job_title FROM contacts WHERE id = ?2)),
         company_id   = COALESCE(company_id, (SELECT company_id FROM contacts WHERE id = ?2)),
         city         = COALESCE(city, (SELECT city FROM contacts WHERE id = ?2)),
         state        = COALESCE(state, (SELECT state FROM contacts WHERE id = ?2)),
         country      = COALESCE(country, (SELECT country FROM contacts WHERE id = ?2)),
         linkedin_url = COALESCE(linkedin_url, (SELECT linkedin_url FROM contacts WHERE id = ?2)),
         updated_at   = datetime('now')
       WHERE id = ?1`,
    ).bind(keepId, dropId),
    env.DB.prepare(
      `UPDATE contacts SET deleted = 1, updated_at = datetime('now') WHERE id = ?`,
    ).bind(dropId),
  ]);

  if (drop.graph_id) {
    await deleteOutlookContact(env, drop.graph_id);
  }
  await reindexContact(env, keepId);
  await reindexContact(env, dropId);
}

// Re-exported for the SMS tools: a user-initiated edit or creation enters the
// queue pre-approved and rides out on the next sync run.
export async function queuePush(
  env: Env,
  kind: "push_update" | "push_create",
  contactId: number,
  summary: string,
): Promise<void> {
  await createProposal(env, {
    kind,
    contactId,
    payload: { contactId },
    summary,
    // One open push per contact is enough — the push reads current state.
    dedupeKey: `${kind}:${contactId}`,
    status: "approved",
  });
}
