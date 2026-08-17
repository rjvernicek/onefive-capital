import test from "node:test";
import assert from "node:assert/strict";

import {
  MODELS,
  CANDIDATES,
  findModel,
  resolveModelAlias,
  effectivePrice,
  costUsd,
  expiringIntroPricing,
  pricingAgeDays,
  formatUsd,
  PRICING_VERIFIED,
} from "../.test-build/pricing.js";

const DURING_INTRO = new Date("2026-08-17T12:00:00Z");
const AFTER_INTRO = new Date("2026-09-01T12:00:00Z");

// ---------------------------------------------------------------------------
// Catalog

test("every candidate exists in the catalog", () => {
  for (const id of CANDIDATES) {
    assert.ok(findModel(id), `${id} missing from MODELS`);
  }
});

test("catalog ids are unique", () => {
  const ids = MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// Alias resolution

test("shorthand resolves to a full model id", () => {
  assert.equal(resolveModelAlias("haiku"), "claude-haiku-4-5");
  assert.equal(resolveModelAlias("Sonnet"), "claude-sonnet-5");
  assert.equal(resolveModelAlias("  OPUS  "), "claude-opus-5");
});

test("multi-word shorthand tolerates extra spacing", () => {
  assert.equal(resolveModelAlias("sonnet  5"), "claude-sonnet-5");
});

test("a full id passes through", () => {
  assert.equal(resolveModelAlias("claude-opus-5"), "claude-opus-5");
});

test("unknown input is rejected rather than guessed", () => {
  assert.equal(resolveModelAlias("gpt-4"), null);
  assert.equal(resolveModelAlias("claude-opus-9"), null);
  assert.equal(resolveModelAlias(""), null);
});

// ---------------------------------------------------------------------------
// Intro pricing

test("intro rate applies before the expiry date", () => {
  const sonnet = findModel("claude-sonnet-5");
  const rate = effectivePrice(sonnet, DURING_INTRO);
  assert.equal(rate.introActive, true);
  assert.equal(rate.inputPerMTok, 2);
  assert.equal(rate.outputPerMTok, 10);
});

test("intro pricing runs through the end of its final day", () => {
  const sonnet = findModel("claude-sonnet-5");
  // 2026-08-31 is the last day, so late that evening is still intro pricing.
  const lastMoment = new Date("2026-08-31T23:00:00Z");
  assert.equal(effectivePrice(sonnet, lastMoment).introActive, true);
});

test("standard rate applies after expiry", () => {
  const sonnet = findModel("claude-sonnet-5");
  const rate = effectivePrice(sonnet, AFTER_INTRO);
  assert.equal(rate.introActive, false);
  assert.equal(rate.inputPerMTok, 3);
  assert.equal(rate.outputPerMTok, 15);
});

test("a model with no intro pricing is unaffected by date", () => {
  const opus = findModel("claude-opus-5");
  assert.deepEqual(
    effectivePrice(opus, DURING_INTRO),
    effectivePrice(opus, AFTER_INTRO),
  );
});

// ---------------------------------------------------------------------------
// Cost

test("plain input/output cost is priced per million tokens", () => {
  const opus = findModel("claude-opus-5"); // $5 / $25
  const cost = costUsd(
    { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
    opus,
    DURING_INTRO,
  );
  assert.equal(cost, 30);
});

test("cached reads bill at a tenth of the input rate", () => {
  const opus = findModel("claude-opus-5");
  const cost = costUsd(
    { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
    opus,
    DURING_INTRO,
  );
  assert.equal(cost, 0.5); // $5 * 0.1
});

test("cache writes carry the 1.25x premium", () => {
  const opus = findModel("claude-opus-5");
  const cost = costUsd(
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 },
    opus,
    DURING_INTRO,
  );
  assert.equal(cost, 6.25); // $5 * 1.25
});

test("zero usage costs nothing", () => {
  const opus = findModel("claude-opus-5");
  assert.equal(
    costUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, opus, DURING_INTRO),
    0,
  );
});

test("the same traffic costs more once intro pricing lapses", () => {
  const sonnet = findModel("claude-sonnet-5");
  const traffic = {
    input: 500_000,
    output: 100_000,
    cacheRead: 2_000_000,
    cacheWrite: 50_000,
  };
  const during = costUsd(traffic, sonnet, DURING_INTRO);
  const after = costUsd(traffic, sonnet, AFTER_INTRO);
  assert.ok(after > during, `expected ${after} > ${during}`);
  // Standard rates are exactly 1.5x the intro rates on both axes, so every
  // term scales together.
  assert.ok(Math.abs(after / during - 1.5) < 1e-9);
});

test("Haiku is cheaper than Opus for identical traffic", () => {
  const traffic = { input: 100_000, output: 20_000, cacheRead: 0, cacheWrite: 0 };
  const haiku = costUsd(traffic, findModel("claude-haiku-4-5"), AFTER_INTRO);
  const opus = costUsd(traffic, findModel("claude-opus-5"), AFTER_INTRO);
  assert.ok(haiku < opus);
});

// ---------------------------------------------------------------------------
// Expiry warnings

test("an expiry inside the horizon is reported with its increase", () => {
  const found = expiringIntroPricing(DURING_INTRO, 45);
  assert.equal(found.length, 1);
  assert.equal(found[0].price.id, "claude-sonnet-5");
  assert.equal(found[0].until, "2026-08-31");
  assert.equal(found[0].increasePct, 50); // $10 -> $15 output
});

test("an expiry beyond the horizon is not reported yet", () => {
  assert.equal(expiringIntroPricing(new Date("2026-01-01T00:00:00Z"), 45).length, 0);
});

test("an already-lapsed intro price is not reported", () => {
  assert.equal(expiringIntroPricing(AFTER_INTRO, 45).length, 0);
});

// ---------------------------------------------------------------------------
// Staleness + formatting

test("pricing age is zero on the day it was verified", () => {
  assert.equal(pricingAgeDays(new Date(`${PRICING_VERIFIED}T06:00:00Z`)), 0);
});

test("pricing age grows with elapsed days", () => {
  const later = new Date(`${PRICING_VERIFIED}T00:00:00Z`);
  later.setUTCDate(later.getUTCDate() + 200);
  assert.equal(pricingAgeDays(later), 200);
});

test("currency formatting keeps small amounts legible", () => {
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(6.4), "$6.40");
  assert.equal(formatUsd(12.345), "$12.35");
});
