import {
  assertConfigured,
  assertGraphConfigured,
  allowedNumbers,
  checkAdminKey,
  type Env,
} from "./env.js";
import { verifyTwilioSignature, signedUrl, sendSms } from "./twilio.js";
import {
  loadThread,
  saveThread,
  clearThread,
  claimMessage,
} from "./conversation.js";
import { ask } from "./claude.js";
import { buildAuthorizeUrl, handleAuthCallback } from "./graph.js";
import { runSync } from "./sync.js";

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
      return new Response("onefive-contacts: ok\n", { status: 200 });
    }

    // --- Microsoft Graph OAuth (one-time connect, admin-key gated) ---------

    if (request.method === "GET" && url.pathname === "/auth/start") {
      if (!checkAdminKey(env, url.searchParams.get("key"))) {
        return new Response("Forbidden", { status: 403 });
      }
      assertGraphConfigured(env);
      const redirectUri = `${url.origin}/auth/callback`;
      return Response.redirect(await buildAuthorizeUrl(env, redirectUri), 302);
    }

    if (request.method === "GET" && url.pathname === "/auth/callback") {
      // No admin key here: Microsoft redirects the browser to this URL. The
      // CSRF state stored by /auth/start (which was key-gated) is the guard.
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return new Response(
          `Authorization failed: ${url.searchParams.get("error_description") ?? "missing code"}`,
          { status: 400 },
        );
      }
      try {
        await handleAuthCallback(env, code, state, `${url.origin}/auth/callback`);
      } catch (error) {
        console.error("OAuth callback failed:", error);
        return new Response("Authorization failed — check logs.", { status: 400 });
      }
      // Kick the initial crawl immediately rather than waiting for cron.
      ctx.waitUntil(
        runSync(env).then(
          (s) => console.info("Initial sync:", JSON.stringify(s)),
          (e) => console.error("Initial sync failed:", e),
        ),
      );
      return new Response(
        "Outlook connected. The first sync is running now; text the number in a few minutes.",
        { status: 200 },
      );
    }

    // --- Manual sync trigger (admin-key gated) -----------------------------

    if (request.method === "POST" && url.pathname === "/sync") {
      if (!checkAdminKey(env, url.searchParams.get("key"))) {
        return new Response("Forbidden", { status: 403 });
      }
      const summary = await runSync(env);
      return new Response(JSON.stringify(summary, null, 2) + "\n", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Twilio webhook ----------------------------------------------------

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
    // keeps a retry from adding the same note twice.
    if (messageSid && !(await claimMessage(env, messageSid))) {
      console.info(`Duplicate webhook for ${messageSid}, skipping`);
      return twiml();
    }

    if (RESET_WORDS.has(body.toLowerCase())) {
      await clearThread(env, from);
      ctx.waitUntil(sendSms(env, from, "Fresh start — who do you need?"));
      return twiml();
    }

    // A Claude turn that searches the database outlasts Twilio's 15-second
    // webhook timeout, so acknowledge now and deliver the answer as its own
    // message.
    ctx.waitUntil(handle(env, from, body));
    return twiml();
  },

  /** Cron: incremental Outlook sync (see wrangler.toml [triggers]). */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runSync(env).then(
        (s) => console.info("Sync:", JSON.stringify(s)),
        (e) => console.error("Sync failed:", e),
      ),
    );
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
        "Something broke on my end and I couldn't reach the database. Try again in a minute.",
      );
    } catch (sendError) {
      console.error("Failed to send error notice:", sendError);
    }
  }
}
