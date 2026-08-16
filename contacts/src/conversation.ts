import type { Env } from "./env.js";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** How long a thread stays warm before the next text starts fresh. */
const CONVERSATION_TTL_SECONDS = 3 * 60 * 60;

/** Turns retained (user + assistant each count as one). */
const MAX_TURNS = 12;

/** Long enough that Twilio's retry window is covered. */
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

const threadKey = (phone: string) => `thread:${phone}`;
const seenKey = (messageSid: string) => `seen:${messageSid}`;

export async function loadThread(env: Env, phone: string): Promise<Turn[]> {
  const raw = await env.STATE.get(threadKey(phone));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Turn[]) : [];
  } catch {
    // A corrupt thread should not wedge the conversation forever.
    return [];
  }
}

export async function saveThread(
  env: Env,
  phone: string,
  turns: Turn[],
): Promise<void> {
  await env.STATE.put(threadKey(phone), JSON.stringify(turns.slice(-MAX_TURNS)), {
    expirationTtl: CONVERSATION_TTL_SECONDS,
  });
}

export async function clearThread(env: Env, phone: string): Promise<void> {
  await env.STATE.delete(threadKey(phone));
}

/**
 * Twilio retries webhooks it considers unacknowledged. Without this, a retry
 * could add the same note twice — the failure mode that matters most in a
 * write-capable database.
 *
 * Returns true the first time a given MessageSid is seen, false thereafter.
 */
export async function claimMessage(
  env: Env,
  messageSid: string,
): Promise<boolean> {
  const key = seenKey(messageSid);
  if (await env.STATE.get(key)) return false;
  await env.STATE.put(key, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
  return true;
}
