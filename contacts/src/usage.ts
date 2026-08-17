import type { Env } from "./env.js";
import {
  costUsd,
  findModel,
  type TokenUsage,
  type ModelPrice,
} from "./pricing.js";

/**
 * Per-message token accounting. Every turn writes one row; the monthly review
 * reads them back to cost the actual traffic rather than guessing at it.
 *
 * Recording is best-effort — a failed insert must never cost the user their
 * reply, so callers swallow errors and log.
 */

export async function recordUsage(
  env: Env,
  model: string,
  usage: TokenUsage,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO model_usage
       (model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite)
    .run();
}

export interface UsageSummary {
  days: number;
  messages: number;
  /** Totals across every model used in the window. */
  totals: TokenUsage;
  /** Per-model breakdown, heaviest first. */
  byModel: {
    model: string;
    label: string;
    messages: number;
    usage: TokenUsage;
    /** Cost at the rate in effect now, for the tokens this model actually used. */
    costUsd: number;
  }[];
  /** Actual spend across all models in the window. */
  actualCostUsd: number;
}

interface UsageRow {
  model: string;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export async function summarizeUsage(
  env: Env,
  days: number,
  at: Date = new Date(),
): Promise<UsageSummary> {
  const since = new Date(at.getTime() - days * 86_400_000).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT model,
            COUNT(*)                  AS messages,
            SUM(input_tokens)         AS input_tokens,
            SUM(output_tokens)        AS output_tokens,
            SUM(cache_read_tokens)    AS cache_read_tokens,
            SUM(cache_write_tokens)   AS cache_write_tokens
       FROM model_usage
      WHERE occurred_at >= ?
      GROUP BY model
      ORDER BY messages DESC`,
  )
    .bind(since)
    .all<UsageRow>();

  const totals: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let messages = 0;
  let actualCostUsd = 0;

  const byModel = results.map((row) => {
    const usage: TokenUsage = {
      input: row.input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      cacheRead: row.cache_read_tokens ?? 0,
      cacheWrite: row.cache_write_tokens ?? 0,
    };
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    messages += row.messages;

    const price = findModel(row.model);
    const cost = price ? costUsd(usage, price, at) : 0;
    actualCostUsd += cost;

    return {
      model: row.model,
      label: price?.label ?? row.model,
      messages: row.messages,
      usage,
      costUsd: cost,
    };
  });

  return { days, messages, totals, byModel, actualCostUsd };
}

/**
 * What this window's traffic would have cost on another model.
 *
 * Approximate by construction: token counts are re-costed as-is, but models
 * tokenize differently (Opus 5 and Sonnet 5 share a tokenizer; Haiku 4.5 does
 * not), and a smaller model may need more tool rounds to reach the same
 * answer. Good enough to rank options by order of magnitude, not to forecast
 * a bill to the cent — every caller must present it as an estimate.
 */
export function projectCost(
  totals: TokenUsage,
  price: ModelPrice,
  at: Date,
): number {
  return costUsd(totals, price, at);
}
