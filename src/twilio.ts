/**
 * The slice of configuration this module needs. Declared structurally rather
 * than importing Env so the module has no internal dependencies and can be
 * compiled and tested on its own; Env satisfies it without any change at the
 * call site.
 */
export interface TwilioConfig {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  PUBLIC_URL?: string;
}

/**
 * Twilio signs each webhook with HMAC-SHA1 over the full request URL followed
 * by every POST parameter, sorted by key and concatenated as key+value with no
 * separators. See Twilio's "Validating Signatures from Twilio" reference.
 */
export async function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;

  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  return timingSafeEqual(expected, signature);
}

/** Constant-time string compare — avoids leaking the signature byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The URL Twilio signed. `request.url` is correct in the normal Workers setup;
 * PUBLIC_URL exists for deployments behind a proxy that rewrites it.
 */
export function signedUrl(request: Request, config: TwilioConfig): string {
  return config.PUBLIC_URL || request.url;
}

const MAX_SMS_CHARS = 1400;

/**
 * Send a message via the Twilio REST API.
 *
 * Replies go out here rather than as TwiML because a Claude turn that reads the
 * health record takes longer than Twilio's 15-second webhook timeout. The
 * webhook acknowledges immediately and the answer arrives as a separate message.
 */
export async function sendSms(
  config: TwilioConfig,
  to: string,
  body: string,
): Promise<void> {
  const text =
    body.length > MAX_SMS_CHARS
      ? body.slice(0, MAX_SMS_CHARS - 1) + "…"
      : body;

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = btoa(
    `${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`,
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: to,
      From: config.TWILIO_FROM_NUMBER,
      Body: text,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Twilio send failed (${response.status}): ${await response.text()}`,
    );
  }
}
