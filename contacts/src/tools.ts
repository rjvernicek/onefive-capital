import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env.js";
import {
  searchContacts,
  getContactCard,
  getCompanyCard,
  createContact,
  updateContactFields,
  replaceEmails,
  replacePhones,
  reindexContact,
  addNote,
  listProposals,
  getProposal,
  setProposalStatus,
  getSyncState,
  ensureCompany,
} from "./db.js";
import { normalizePhone } from "./clean.js";
import { queuePush } from "./sync.js";
import { summarizeUsage, projectCost } from "./usage.js";
import { activeModel } from "./model.js";
import { CANDIDATES, findModel } from "./pricing.js";

/**
 * Client-side tools over the D1 database. Unlike healthspan-sms (which points
 * Claude at an external MCP server), the data here lives in this Worker, so
 * the Worker defines the tools and runs the loop itself (see claude.ts).
 */
export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "search_contacts",
    description:
      "Full-text search across names, companies, titles, emails, phones, tags, and note text. Returns brief hits with ids. Use this first for any 'who is / who do we know' question.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search terms" },
        limit: { type: "number", description: "Max hits, default 8" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_contact",
    description:
      "Full card for one contact by id: all emails and phones, company, title, location, tags, and recent notes.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Contact id from search_contacts" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_company",
    description:
      "Company card by name: everyone we know there plus company-level notes. Name matching is fuzzy on the normalized name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Company name, any spelling" },
      },
      required: ["name"],
    },
  },
  {
    name: "add_note",
    description:
      "Attach a dated note to a contact (by id) or a company (by name). Use for any intel in a message: where you met, what they're working on, preferences, deal context.",
    input_schema: {
      type: "object",
      properties: {
        contact_id: { type: "number" },
        company_name: { type: "string" },
        body: { type: "string", description: "The note text" },
        occurred_at: {
          type: "string",
          description:
            "ISO-8601 datetime of when it happened, if different from now",
        },
      },
      required: ["body"],
    },
  },
  {
    name: "create_contact",
    description:
      "Create a new contact. It is queued to be created in Outlook on the next sync automatically.",
    input_schema: {
      type: "object",
      properties: {
        display_name: { type: "string" },
        given_name: { type: "string" },
        family_name: { type: "string" },
        company: { type: "string" },
        job_title: { type: "string" },
        emails: { type: "array", items: { type: "string" } },
        phones: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["display_name"],
    },
  },
  {
    name: "update_contact",
    description:
      "Update fields on an existing contact by id. Only pass the fields being changed. Changes to a contact that exists in Outlook are pushed there on the next sync automatically.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        display_name: { type: "string" },
        given_name: { type: "string" },
        family_name: { type: "string" },
        company: { type: "string" },
        job_title: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        linkedin_url: { type: "string" },
        emails: {
          type: "array",
          items: { type: "string" },
          description: "Replaces the full email list when present",
        },
        phones: {
          type: "array",
          items: { type: "string" },
          description: "Replaces the full phone list when present",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replaces the full tag list when present",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "list_cleanups",
    description:
      "List pending hygiene proposals (duplicate merges, formatting fixes) awaiting approval, with their ids.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max items, default 10" },
      },
      required: [],
    },
  },
  {
    name: "resolve_cleanup",
    description:
      "Approve or reject a pending hygiene proposal by id. Approved proposals are applied (including to Outlook) on the next sync run.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        decision: { type: "string", enum: ["approve", "reject"] },
      },
      required: ["id", "decision"],
    },
  },
  {
    name: "sync_status",
    description:
      "When the last Outlook sync ran and what it did. Use when asked whether the database is up to date.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "usage_summary",
    description:
      "Token usage and cost over the last N days, per model, plus what the same traffic would cost on the alternatives. Use for questions about spend, cost, or which model to run.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Window in days, default 30" },
      },
      required: [],
    },
  },
];

/**
 * Execute one tool call. Returns a JSON string for the tool_result block;
 * throws on invalid input, which the loop converts to an is_error result so
 * the model can correct itself.
 */
export async function runTool(
  env: Env,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "search_contacts": {
      const hits = await searchContacts(
        env,
        String(input.query ?? ""),
        clampLimit(input.limit),
      );
      return JSON.stringify({ hits });
    }

    case "get_contact": {
      const card = await getContactCard(env, requireNumber(input.id, "id"));
      return JSON.stringify(card ?? { error: "no contact with that id" });
    }

    case "get_company": {
      const card = await getCompanyCard(env, String(input.name ?? ""));
      return JSON.stringify(card ?? { error: "no company matching that name" });
    }

    case "add_note": {
      const body = String(input.body ?? "").trim();
      if (!body) throw new Error("note body is required");
      let contactId: number | undefined;
      let companyId: number | undefined;
      if (input.contact_id !== undefined) {
        contactId = requireNumber(input.contact_id, "contact_id");
      } else if (input.company_name) {
        companyId =
          (await ensureCompany(env, String(input.company_name))) ?? undefined;
      }
      if (!contactId && !companyId) {
        throw new Error("a note needs a contact_id or a company_name");
      }
      const id = await addNote(env, {
        contactId,
        companyId,
        body,
        occurredAt: input.occurred_at ? String(input.occurred_at) : undefined,
      });
      return JSON.stringify({ ok: true, note_id: id });
    }

    case "create_contact": {
      const displayName = String(input.display_name ?? "").trim();
      if (!displayName) throw new Error("display_name is required");
      const phones = stringArray(input.phones).map(
        (p) => normalizePhone(p, env.DEFAULT_REGION).value,
      );
      const id = await createContact(
        env,
        {
          display_name: displayName,
          given_name: optString(input.given_name),
          family_name: optString(input.family_name),
          company: optString(input.company),
          job_title: optString(input.job_title),
          tags: stringArray(input.tags),
          source: "sms",
        },
        stringArray(input.emails),
        phones,
      );
      await queuePush(env, "push_create", id, `create "${displayName}" in Outlook`);
      return JSON.stringify({ ok: true, contact_id: id });
    }

    case "update_contact": {
      const id = requireNumber(input.id, "id");
      const card = await getContactCard(env, id);
      if (!card) throw new Error(`no contact with id ${id}`);

      await updateContactFields(env, id, {
        display_name: optString(input.display_name),
        given_name: optString(input.given_name),
        family_name: optString(input.family_name),
        company: optString(input.company),
        job_title: optString(input.job_title),
        city: optString(input.city),
        state: optString(input.state),
        linkedin_url: optString(input.linkedin_url),
        tags: input.tags !== undefined ? stringArray(input.tags) : undefined,
      });
      if (input.emails !== undefined) {
        await replaceEmails(env, id, stringArray(input.emails));
      }
      if (input.phones !== undefined) {
        await replacePhones(
          env,
          id,
          stringArray(input.phones).map(
            (p) => normalizePhone(p, env.DEFAULT_REGION).value,
          ),
        );
      }
      await reindexContact(env, id);

      if (card.graph_id) {
        await queuePush(env, "push_update", id, `push edits to "${card.display_name}"`);
      }
      return JSON.stringify({ ok: true, contact_id: id });
    }

    case "list_cleanups": {
      const pending = await listProposals(env, "pending", clampLimit(input.limit, 10));
      return JSON.stringify({
        pending: pending.map((p) => ({ id: p.id, kind: p.kind, summary: p.summary })),
      });
    }

    case "resolve_cleanup": {
      const id = requireNumber(input.id, "id");
      const decision = String(input.decision ?? "");
      if (decision !== "approve" && decision !== "reject") {
        throw new Error("decision must be approve or reject");
      }
      const proposal = await getProposal(env, id);
      if (!proposal) throw new Error(`no proposal with id ${id}`);
      if (proposal.status !== "pending") {
        return JSON.stringify({
          error: `proposal #${id} is already ${proposal.status}`,
        });
      }
      await setProposalStatus(
        env,
        id,
        decision === "approve" ? "approved" : "rejected",
      );
      return JSON.stringify({ ok: true, id, status: decision + "d" });
    }

    case "sync_status": {
      const raw = await getSyncState(env, "last_sync");
      return raw ?? JSON.stringify({ error: "no sync has run yet" });
    }

    case "usage_summary": {
      const days = clampDays(input.days);
      const at = new Date();
      const summary = await summarizeUsage(env, days, at);
      const current = await activeModel(env);
      const alternatives = CANDIDATES.filter((id) => id !== current).map((id) => {
        const price = findModel(id)!;
        return {
          model: id,
          label: price.label,
          projected_cost_usd: Number(
            projectCost(summary.totals, price, at).toFixed(4),
          ),
        };
      });
      return JSON.stringify({
        current_model: current,
        window_days: days,
        messages: summary.messages,
        actual_cost_usd: Number(summary.actualCostUsd.toFixed(4)),
        by_model: summary.byModel.map((m) => ({
          model: m.model,
          messages: m.messages,
          cost_usd: Number(m.costUsd.toFixed(4)),
        })),
        alternatives,
        caveat:
          "Alternative costs are estimates: models tokenize differently and a smaller model may need more tool rounds.",
      });
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function clampDays(value: unknown, fallback = 30): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 365);
}

function clampLimit(value: unknown, fallback = 8): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 25);
}

function requireNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a number`);
  return n;
}

function optString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}
