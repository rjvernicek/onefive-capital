import type { Env } from "./env.js";

/**
 * Microsoft Graph client for Outlook contacts.
 *
 * Auth is delegated (one user — the owner), via the authorization-code flow:
 * /auth/start redirects to Microsoft, /auth/callback trades the code for
 * tokens. The refresh token lives in KV and is rotated on every refresh, so
 * a leaked access token expires in about an hour and nothing durable is ever
 * in a URL.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access https://graph.microsoft.com/Contacts.ReadWrite";

/** Fields pulled from Outlook. Anything not listed here is left untouched. */
const SELECT_FIELDS = [
  "id",
  "displayName",
  "givenName",
  "surname",
  "companyName",
  "jobTitle",
  "emailAddresses",
  "businessPhones",
  "homePhones",
  "mobilePhone",
  "businessAddress",
  "personalNotes",
].join(",");

const KV_REFRESH_TOKEN = "graph:refresh_token";
const KV_ACCESS_TOKEN = "graph:access_token";
const KV_OAUTH_STATE = "graph:oauth_state";

export interface GraphContact {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  companyName?: string;
  jobTitle?: string;
  emailAddresses?: { address?: string; name?: string }[];
  businessPhones?: string[];
  homePhones?: string[];
  mobilePhone?: string;
  businessAddress?: { city?: string; state?: string; countryOrRegion?: string };
  personalNotes?: string;
  "@removed"?: { reason: string };
}

const tokenEndpoint = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

// ---------------------------------------------------------------------------
// OAuth

export async function buildAuthorizeUrl(
  env: Env,
  redirectUri: string,
): Promise<string> {
  const state = crypto.randomUUID();
  await env.STATE.put(KV_OAUTH_STATE, state, { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES,
    state,
  });
  return `https://login.microsoftonline.com/${env.MS_TENANT}/oauth2/v2.0/authorize?${params}`;
}

export async function handleAuthCallback(
  env: Env,
  code: string,
  state: string,
  redirectUri: string,
): Promise<void> {
  const expected = await env.STATE.get(KV_OAUTH_STATE);
  if (!expected || state !== expected) {
    throw new Error("OAuth state mismatch — start again from /auth/start");
  }
  await env.STATE.delete(KV_OAUTH_STATE);

  await requestTokens(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
}

/** Whether the Outlook connection has been established. */
export async function isConnected(env: Env): Promise<boolean> {
  return (await env.STATE.get(KV_REFRESH_TOKEN)) !== null;
}

async function requestTokens(
  env: Env,
  grant: Record<string, string>,
): Promise<string> {
  const response = await fetch(tokenEndpoint(env.MS_TENANT), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      scope: SCOPES,
      ...grant,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Token request failed (${response.status}): ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  // Microsoft rotates refresh tokens; always store the newest one.
  if (body.refresh_token) {
    await env.STATE.put(KV_REFRESH_TOKEN, body.refresh_token);
  }
  // Cache the access token slightly short of its real lifetime.
  await env.STATE.put(KV_ACCESS_TOKEN, body.access_token, {
    expirationTtl: Math.max(60, body.expires_in - 120),
  });
  return body.access_token;
}

async function accessToken(env: Env): Promise<string> {
  const cached = await env.STATE.get(KV_ACCESS_TOKEN);
  if (cached) return cached;

  const refresh = await env.STATE.get(KV_REFRESH_TOKEN);
  if (!refresh) {
    throw new Error(
      "Outlook is not connected — visit /auth/start?key=<ADMIN_KEY> once to authorize",
    );
  }
  return requestTokens(env, {
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
}

// ---------------------------------------------------------------------------
// Reads

/**
 * Where the next pull resumes from.
 *
 * `delta` means the crawl finished and the URL returns only what changes from
 * here. `next` means a run stopped mid-crawl at the page cap and the URL is
 * the next page — persisting it is what lets a large initial crawl finish
 * across several runs instead of restarting from page one forever.
 */
export type DeltaCursor =
  | { type: "delta"; url: string }
  | { type: "next"; url: string };

export interface DeltaResult {
  contacts: GraphContact[];
  removedIds: string[];
  /** Persist this and hand it back on the next call. */
  cursor: DeltaCursor | null;
  /** False when the page cap stopped the crawl before it reached the end. */
  complete: boolean;
}

/**
 * Graph's default page size for contacts is small (10), which would turn a
 * few thousand contacts into hundreds of round trips. Ask for the maximum.
 */
const PAGE_SIZE = 100;

/**
 * Bounded so one invocation can't run away. At PAGE_SIZE that is 5,000
 * contacts per run; beyond it the run returns a `next` cursor and the
 * following run picks up exactly where this one stopped.
 */
const MAX_PAGES = 50;

/**
 * Pull everything that changed since the last sync. A `previous` of null
 * means a full initial crawl.
 */
export async function pullContactsDelta(
  env: Env,
  previous: DeltaCursor | null,
): Promise<DeltaResult> {
  const token = await accessToken(env);
  let url =
    previous?.url ??
    `${GRAPH}/me/contacts/delta?$select=${SELECT_FIELDS}&$top=${PAGE_SIZE}`;

  const contacts: GraphContact[] = [];
  const removedIds: string[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `Graph delta failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      value: GraphContact[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };

    for (const item of body.value) {
      if (item["@removed"]) removedIds.push(item.id);
      else contacts.push(item);
    }

    // A deltaLink ends the crawl: everything is imported and this URL returns
    // changes from here on.
    if (body["@odata.deltaLink"]) {
      return {
        contacts,
        removedIds,
        cursor: { type: "delta", url: body["@odata.deltaLink"] },
        complete: true,
      };
    }

    // No nextLink and no deltaLink shouldn't happen, but if Graph ends a page
    // sequence without handing back a resume point there is nothing to store;
    // keeping the previous cursor would re-read pages we just consumed.
    if (!body["@odata.nextLink"]) {
      console.warn("Graph ended pagination without a deltaLink");
      return { contacts, removedIds, cursor: null, complete: true };
    }

    url = body["@odata.nextLink"];
  }

  // Hit the page cap. `url` is the page we did not fetch, so storing it makes
  // the next run resume rather than start over.
  console.info(`Delta paused at page cap; resuming next run (${contacts.length} so far)`);
  return { contacts, removedIds, cursor: { type: "next", url }, complete: false };
}

/**
 * Read a stored cursor. Tolerates the bare URL string an older deploy may
 * have written, treating it as a delta link.
 */
export function parseCursor(raw: string | null): DeltaCursor | null {
  if (!raw) return null;
  if (raw.startsWith("http")) return { type: "delta", url: raw };
  try {
    const parsed = JSON.parse(raw) as DeltaCursor;
    if (
      (parsed?.type === "delta" || parsed?.type === "next") &&
      typeof parsed.url === "string"
    ) {
      return parsed;
    }
  } catch {
    // fall through — a corrupt cursor restarts the crawl, which is correct
    // but expensive, so say so.
  }
  console.warn("Unreadable delta cursor; restarting the crawl");
  return null;
}

// ---------------------------------------------------------------------------
// Writes (applied only through approved proposals — see sync.ts)

export async function patchContact(
  env: Env,
  graphId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const token = await accessToken(env);
  const response = await fetch(`${GRAPH}/me/contacts/${graphId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(
      `Graph patch failed (${response.status}): ${await response.text()}`,
    );
  }
}

export async function createOutlookContact(
  env: Env,
  payload: Record<string, unknown>,
): Promise<string> {
  const token = await accessToken(env);
  const response = await fetch(`${GRAPH}/me/contacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `Graph create failed (${response.status}): ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { id: string };
  return body.id;
}

export async function deleteOutlookContact(
  env: Env,
  graphId: string,
): Promise<void> {
  const token = await accessToken(env);
  const response = await fetch(`${GRAPH}/me/contacts/${graphId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 is success for a delete: the duplicate is already gone.
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Graph delete failed (${response.status}): ${await response.text()}`,
    );
  }
}
