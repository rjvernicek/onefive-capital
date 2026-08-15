export interface Env {
  STATE: KVNamespace;

  // Plain vars (wrangler.toml)
  ALLOWED_NUMBERS: string;
  TWILIO_FROM_NUMBER: string;
  TIMEZONE: string;
  PUBLIC_URL?: string;

  // Secrets (wrangler secret put)
  ANTHROPIC_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  HEALTHSPAN_MCP_URL: string;
  HEALTHSPAN_MCP_TOKEN?: string;
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
    "HEALTHSPAN_MCP_URL",
    "ALLOWED_NUMBERS",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing configuration: ${missing.join(", ")}`);
  }
}

/** Numbers permitted to read from and write to the health record. */
export function allowedNumbers(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_NUMBERS.split(",")
      .map((n) => n.trim())
      .filter(Boolean),
  );
}
