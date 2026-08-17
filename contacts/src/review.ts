import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env.js";
import { sendSms } from "./twilio.js";
import { allowedNumbers } from "./env.js";
import { activeModel } from "./model.js";
import { summarizeUsage, projectCost } from "./usage.js";
import { getSyncState, setSyncState } from "./db.js";
import {
  CANDIDATES,
  MODELS,
  findModel,
  formatUsd,
  expiringIntroPricing,
  pricingAgeDays,
  PRICING_STALE_DAYS,
  PRICING_VERIFIED,
} from "./pricing.js";

/**
 * The periodic pricing review.
 *
 * Runs on its own cron (monthly), reads the last window's real token usage,
 * costs it against every candidate model, and texts a comparison with a
 * question. Nothing here calls Claude — the message is assembled
 * deterministically, so the review that tells you how to spend less doesn't
 * itself cost anything.
 */

/** Window the review reports on. */
const WINDOW_DAYS = 30;

/** How far ahead to warn about promotional pricing expiring. */
const INTRO_WARNING_DAYS = 45;

/** A saving worth interrupting someone for. */
const MIN_SAVING_USD = 1.0;

export interface ReviewResult {
  sent: boolean;
  reason: string;
  message?: string;
}

export async function runReview(
  env: Env,
  at: Date = new Date(),
): Promise<ReviewResult> {
  const current = await activeModel(env);
  const summary = await summarizeUsage(env, WINDOW_DAYS, at);
  const newModels = await detectNewModels(env);
  const expiring = expiringIntroPricing(at, INTRO_WARNING_DAYS);

  // Nothing used, nothing changed: stay quiet. A review that texts every month
  // regardless of whether it has news gets muted, and then the one that
  // matters gets muted with it.
  if (summary.messages === 0 && newModels.length === 0 && expiring.length === 0) {
    return { sent: false, reason: "no usage and nothing changed" };
  }

  const message = composeReview(
    current,
    summary,
    newModels,
    expiring,
    at,
  );

  const recipients = [...allowedNumbers(env)];
  if (recipients.length === 0) {
    return { sent: false, reason: "no allowlisted numbers to notify", message };
  }

  // First allowlisted number is the owner; the rest are not billed for this.
  await sendSms(env, recipients[0], message);
  await setSyncState(env, "last_review", JSON.stringify({ at: at.toISOString(), message }));
  return { sent: true, reason: "review delivered", message };
}

/** Build the SMS. Kept pure so the wording is testable without a phone. */
export function composeReview(
  currentModel: string,
  summary: Awaited<ReturnType<typeof summarizeUsage>>,
  newModels: string[],
  expiring: ReturnType<typeof expiringIntroPricing>,
  at: Date,
): string {
  const parts: string[] = [];
  const currentLabel = findModel(currentModel)?.label ?? currentModel;

  if (summary.messages > 0) {
    parts.push(
      `Last ${summary.days}d: ${summary.messages} msg${summary.messages === 1 ? "" : "s"}, ` +
        `${formatUsd(summary.actualCostUsd)} on ${currentLabel}.`,
    );

    // Cost the same traffic on every alternative.
    const projections = CANDIDATES.filter((id) => id !== currentModel)
      .map((id) => {
        const price = findModel(id)!;
        return { price, cost: projectCost(summary.totals, price, at) };
      })
      .sort((a, b) => a.cost - b.cost);

    if (projections.length > 0) {
      parts.push(
        "Same traffic: " +
          projections
            .map((p) => `${p.price.label} ~${formatUsd(p.cost)}`)
            .join(", ") +
          " (est).",
      );
    }

    const cheapest = projections[0];
    if (cheapest && summary.actualCostUsd - cheapest.cost >= MIN_SAVING_USD) {
      parts.push(
        `Switching to ${cheapest.price.label} saves ~${formatUsd(
          summary.actualCostUsd - cheapest.cost,
        )}/mo.`,
      );
    }
  }

  for (const item of expiring) {
    const label = item.price.label;
    parts.push(
      `Heads up: ${label} intro pricing ends ${item.until} — output rate rises ~${item.increasePct}%.`,
    );
  }

  if (newModels.length > 0) {
    parts.push(`New model available: ${newModels.join(", ")}.`);
  }

  const age = pricingAgeDays(at);
  if (age > PRICING_STALE_DAYS) {
    parts.push(
      `(Prices last checked ${PRICING_VERIFIED}, ${age}d ago — worth re-verifying.)`,
    );
  }

  parts.push(
    `Reply "model <name>" to switch, or ignore to stay on ${currentLabel}.`,
  );

  return parts.join(" ");
}

/**
 * Ask the Models API what exists now and report anything we haven't seen
 * before. Capability data is live even though pricing isn't, so this is the
 * one part of the review that learns about the world on its own — a new model
 * launching is exactly when the default is worth revisiting.
 */
async function detectNewModels(env: Env): Promise<string[]> {
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const live: string[] = [];
    for await (const model of client.models.list()) {
      live.push(model.id);
    }
    if (live.length === 0) return [];

    const raw = await getSyncState(env, "known_models");
    const known: string[] = raw ? JSON.parse(raw) : [];

    // First run establishes the baseline rather than announcing every model
    // that has ever existed.
    if (known.length === 0) {
      await setSyncState(env, "known_models", JSON.stringify(live));
      return [];
    }

    const fresh = live.filter((id) => !known.includes(id));
    await setSyncState(env, "known_models", JSON.stringify(live));

    // Only mention models we could actually switch to; a new Haiku variant we
    // have no pricing for is noise until the table is updated.
    return fresh.filter((id) => MODELS.some((m) => m.id === id));
  } catch (error) {
    // The review is still useful without this; don't let it fail the run.
    console.error("Model discovery failed:", error);
    return [];
  }
}
