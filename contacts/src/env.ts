export interface Env {
  DB: D1Database;
  STATE: KVNamespace;

  // Plain vars (wrangler.toml)
  ALLOWED_NUMBERS: string;
  TWILIO_FROM_NUMBER: string;
  TIMEZONE: string;
  DEFAULT_REGION: string;
  MS_TENANT: string;
  PUBLIC_URL?: string;

  // Secrets (wrangler secret put)
  ANTHROPIC_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
  ADMIN_KEY: string;
}

/**
 * Fail loudly at request time rather than producing a confusing downstream
 * error. A missing secret here is a deploy mistake, not a runtime condition.
 */
export function assertConfigured(env: Env): void {
  const required: (keyof Env)[] = [
    "ANTHROPIC_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "ALLOWED_NUMBERS",
    "ADMIN_KEY",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing configuration: ${missing.join(", ")}`);
  }
}

/** The Graph pieces are only required once Outlook sync is being used. */
export function assertGraphConfigured(env: Env): void {
  const required: (keyof Env)[] = ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_TENANT"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing Graph configuration: ${missing.join(", ")}`);
  }
}

/** Numbers permitted to read from and write to the contact database. */
export function allowedNumbers(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_NUMBERS.split(",")
      .map((n) => n.trim())
      .filter(Boolean),
  );
}

/**
 * Constant-time comparison for the admin key guarding /auth and /sync.
 * A plain === would leak the key byte by byte through response timing.
 */
export function checkAdminKey(env: Env, provided: string | null): boolean {
  if (!provided || !env.ADMIN_KEY) return false;
  if (provided.length !== env.ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ env.ADMIN_KEY.charCodeAt(i);
  }
  return diff === 0;
}
