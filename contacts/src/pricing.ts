/**
 * Model catalog, pricing, and cost math. Pure functions with no imports so the
 * module compiles standalone for the test suite (see pretest).
 *
 * Pricing is NOT available from the Anthropic API — only capability data is
 * (GET /v1/models). So this table is maintained by hand, stamped with the date
 * it was last checked, and the monthly review flags it when it goes stale.
 * That staleness warning is the feature: a silently wrong table would produce
 * confident, wrong recommendations.
 */

/** When the prices below were last verified against Anthropic's pricing page. */
export const PRICING_VERIFIED = "2026-08-17";

/** Past this age the review stops trusting its own numbers and says so. */
export const PRICING_STALE_DAYS = 120;

export interface ModelPrice {
  id: string;
  /** Short name for SMS — "Sonnet 5", not "claude-sonnet-5". */
  label: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * Promotional pricing that reverts to the standard rate on `until`.
   * Catching these expiries before they land on a bill is half the point of
   * the monthly review.
   */
  intro?: { inputPerMTok: number; outputPerMTok: number; until: string };
}

/**
 * Every model this worker will run. Setting a model outside this list is
 * rejected — a typo over SMS shouldn't be able to wedge the gateway on a
 * model id that 404s.
 */
export const MODELS: ModelPrice[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    inputPerMTok: 5,
    outputPerMTok: 25,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    inputPerMTok: 3,
    outputPerMTok: 15,
    intro: { inputPerMTok: 2, outputPerMTok: 10, until: "2026-08-31" },
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    inputPerMTok: 1,
    outputPerMTok: 5,
  },
];

/** Models the monthly review costs the actual traffic against. */
export const CANDIDATES = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"];

/** Shorthand accepted over SMS ("model haiku"). */
const ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  "opus 5": "claude-opus-5",
  sonnet: "claude-sonnet-5",
  "sonnet 5": "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  "haiku 4.5": "claude-haiku-4-5",
};

export function findModel(id: string): ModelPrice | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * Resolve user input to a model id, accepting both full ids and shorthand.
 * Returns null for anything not in the catalog.
 */
export function resolveModelAlias(input: string): string | null {
  const key = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  if (ALIASES[key]) return ALIASES[key];
  return MODELS.some((m) => m.id === key) ? key : null;
}

// ---------------------------------------------------------------------------
// Cost

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** Cached input reads bill at ~10% of the base input rate. */
const CACHE_READ_MULTIPLIER = 0.1;

/** Cache writes bill at 1.25x base input for the 5-minute TTL this worker uses. */
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * The rate in effect at a given moment, accounting for promotional pricing
 * that has not yet expired.
 */
export function effectivePrice(
  price: ModelPrice,
  at: Date,
): { inputPerMTok: number; outputPerMTok: number; introActive: boolean } {
  if (price.intro && at < endOfDay(price.intro.until)) {
    return {
      inputPerMTok: price.intro.inputPerMTok,
      outputPerMTok: price.intro.outputPerMTok,
      introActive: true,
    };
  }
  return {
    inputPerMTok: price.inputPerMTok,
    outputPerMTok: price.outputPerMTok,
    introActive: false,
  };
}

/** Intro pricing runs through the end of its final day, not its first instant. */
function endOfDay(isoDate: string): Date {
  return new Date(`${isoDate}T23:59:59.999Z`);
}

export function costUsd(usage: TokenUsage, price: ModelPrice, at: Date): number {
  const rate = effectivePrice(price, at);
  const millions = (n: number) => n / 1_000_000;
  return (
    millions(usage.input) * rate.inputPerMTok +
    millions(usage.output) * rate.outputPerMTok +
    millions(usage.cacheRead) * rate.inputPerMTok * CACHE_READ_MULTIPLIER +
    millions(usage.cacheWrite) * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER
  );
}

/**
 * Days since the pricing table was last verified. The review uses this to
 * decide whether to caveat its own numbers.
 */
export function pricingAgeDays(at: Date): number {
  const verified = new Date(`${PRICING_VERIFIED}T00:00:00.000Z`);
  return Math.floor((at.getTime() - verified.getTime()) / 86_400_000);
}

/**
 * Promotional rates expiring within `withinDays`. These are the surprises
 * worth a text — a bill that rises 50% overnight with no change in usage.
 */
export function expiringIntroPricing(
  at: Date,
  withinDays: number,
): { price: ModelPrice; until: string; increasePct: number }[] {
  const horizon = new Date(at.getTime() + withinDays * 86_400_000);
  return MODELS.flatMap((price) => {
    if (!price.intro) return [];
    const expiry = endOfDay(price.intro.until);
    if (expiry < at || expiry > horizon) return [];
    // Quote the rise on output, the dominant term for chat-shaped traffic.
    const increasePct = Math.round(
      (price.outputPerMTok / price.intro.outputPerMTok - 1) * 100,
    );
    return [{ price, until: price.intro.until, increasePct }];
  });
}

export function formatUsd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}
