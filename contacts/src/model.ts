import type { Env } from "./env.js";
import { findModel, resolveModelAlias, MODELS } from "./pricing.js";

/**
 * The active model is the DEFAULT_MODEL var unless an override has been set
 * over SMS. Keeping the override in KV rather than wrangler.toml means
 * switching models is a text message, not a redeploy — which matters when the
 * monthly review recommends a switch and you want to act on it from a phone.
 */
const KV_MODEL_OVERRIDE = "config:model";

/** Fallback if DEFAULT_MODEL is unset or names something not in the catalog. */
const SAFETY_NET = "claude-sonnet-5";

export async function activeModel(env: Env): Promise<string> {
  const override = await env.STATE.get(KV_MODEL_OVERRIDE);
  if (override && findModel(override)) return override;

  if (env.DEFAULT_MODEL && findModel(env.DEFAULT_MODEL)) {
    return env.DEFAULT_MODEL;
  }
  // A bad override or a bad var must not take the gateway down.
  console.warn(
    `No valid model configured (override=${override}, var=${env.DEFAULT_MODEL}); using ${SAFETY_NET}`,
  );
  return SAFETY_NET;
}

/** True when the active model came from an SMS override rather than the var. */
export async function isOverridden(env: Env): Promise<boolean> {
  const override = await env.STATE.get(KV_MODEL_OVERRIDE);
  return override !== null && findModel(override) !== undefined;
}

export async function setModel(env: Env, id: string): Promise<void> {
  if (!findModel(id)) throw new Error(`unknown model: ${id}`);
  await env.STATE.put(KV_MODEL_OVERRIDE, id);
}

export async function clearModel(env: Env): Promise<void> {
  await env.STATE.delete(KV_MODEL_OVERRIDE);
}

/**
 * Handle a `model ...` text. Returns the reply to send.
 *
 * This is deliberately a reserved command handled before the model is ever
 * called, not a tool: if the configured model is broken or unavailable, the
 * conversational path can't run, and this is the only way back.
 */
export async function handleModelCommand(
  env: Env,
  argument: string,
): Promise<string> {
  const arg = argument.trim();

  if (!arg) {
    const current = await activeModel(env);
    const price = findModel(current);
    const overridden = await isOverridden(env);
    const source = overridden ? "set by text" : "default";
    return (
      `Currently on ${price?.label ?? current} (${source}). ` +
      `Options: ${MODELS.map((m) => m.label).join(", ")}. ` +
      `Reply "model haiku" to switch, "model reset" for the default.`
    );
  }

  if (arg.toLowerCase() === "reset" || arg.toLowerCase() === "default") {
    await clearModel(env);
    const current = await activeModel(env);
    return `Back to the default: ${findModel(current)?.label ?? current}.`;
  }

  const resolved = resolveModelAlias(arg);
  if (!resolved) {
    return (
      `Don't know "${arg}". Options: ` +
      `${MODELS.map((m) => m.label).join(", ")}.`
    );
  }

  await setModel(env, resolved);
  const price = findModel(resolved)!;
  return (
    `Switched to ${price.label} ($${price.inputPerMTok}/$${price.outputPerMTok} per Mtok). ` +
    `Takes effect on your next message.`
  );
}
