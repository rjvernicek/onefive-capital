import { assertConfigured, allowedNumbers, type Env } from "./env.js";
import { verifyTwilioSignature, signedUrl, sendSms } from "./twilio.js";
import {
  loadThread,
  saveThread,
  clearThread,
  claimMessage,
} from "./conversation.js";
import { ask } from "./claude.js";

/** Twilio only needs an acknowledgement; the answer goes out via the REST API. */
const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const twiml = () =>
  new Response(EMPTY_TWIML, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });

/** Messages that reset the thread instead of reaching the model. */
const RESET_WORDS = new Set(["reset", "new", "start over", "clear"]);

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("healthspan-sms: ok\n", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/sms") {
      return new Response("Not found", { status: 404 });
    }

    try {
      assertConfigured(env);
    } catch (error) {
      console.error("Configuration error:", error);
      return new Response("Service misconfigured", { status: 500 });
    }

    const form = await request.formData();
    const params: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      params[key] = String(value);
    }

    const valid = await verifyTwilioSignature(
      env.TWILIO_AUTH_TOKEN,
      signedUrl(request, env),
      params,
      request.headers.get("X-Twilio-Signature"),
    );
    if (!valid) {
      console.warn("Rejected webhook: bad Twilio signature");
      return new Response("Forbidden", { status: 403 });
    }

    const from = params.From ?? "";
    const body = (params.Body ?? "").trim();
    const messageSid = params.MessageSid ?? "";

    // Not on the allowlist: acknowledge and drop. Replying would confirm to a
    // stranger that this number is live and backed by something.
    if (!allowedNumbers(env).has(from)) {
      console.warn(`Ignored message from non-allowlisted number: ${from}`);
      return twiml();
    }

    if (!body) return twiml();

    // Twilio retries webhooks it considers unacknowledged. Claiming the SID
    // keeps a retry from logging the same measurement twice.
    if (messageSid && !(await claimMessage(env, messageSid))) {
      console.info(`Duplicate webhook for ${messageSid}, skipping`);
      return twiml();
    }

    if (RESET_WORDS.has(body.toLowerCase())) {
      await clearThread(env, from);
      ctx.waitUntil(sendSms(env, from, "Fresh start — what do you need?"));
      return twiml();
    }

    // A Claude turn that reads the record outlasts Twilio's 15-second webhook
    // timeout, so acknowledge now and deliver the answer as its own message.
    ctx.waitUntil(handle(env, from, body));
    return twiml();
  },
} satisfies ExportedHandler<Env>;

async function handle(env: Env, from: string, body: string): Promise<void> {
  try {
    const history = await loadThread(env, from);
    const reply = await ask(env, history, body);

    await sendSms(env, from, reply.text);

    // A refusal is not conversational context worth carrying forward.
    if (!reply.refused) {
      await saveThread(env, from, [
        ...history,
        { role: "user", content: body },
        { role: "assistant", content: reply.text },
      ]);
    }
  } catch (error) {
    console.error("Failed to handle message:", error);
    // Silence would read as a dropped text. Say something, and keep the
    // underlying error in the logs rather than in the reply.
    try {
      await sendSms(
        env,
        from,
        "Something broke on my end and I couldn't get to your record. Try again in a minute.",
      );
    } catch (sendError) {
      console.error("Failed to send error notice:", sendError);
    }
  }
}
