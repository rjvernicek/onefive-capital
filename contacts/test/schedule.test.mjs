import test from "node:test";
import assert from "node:assert/strict";

import {
  duplicateScanDecision,
  DUPLICATE_SCAN_INTERVAL_MS,
} from "../.test-build/schedule.js";

const NOW = new Date("2026-08-17T12:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

test("a run that changed the contact set always scans", () => {
  // Even one minute after the last scan — new data is exactly when a
  // duplicate can appear.
  assert.equal(duplicateScanDecision(true, ago(60_000), NOW), "changed");
});

test("an unchanged run inside the interval skips the scan", () => {
  assert.equal(duplicateScanDecision(false, ago(60 * 60_000), NOW), "skipped");
});

test("the backstop fires once the interval has elapsed", () => {
  assert.equal(
    duplicateScanDecision(false, ago(DUPLICATE_SCAN_INTERVAL_MS), NOW),
    "interval",
  );
});

test("the backstop boundary is inclusive", () => {
  const justUnder = ago(DUPLICATE_SCAN_INTERVAL_MS - 1);
  const exactly = ago(DUPLICATE_SCAN_INTERVAL_MS);
  assert.equal(duplicateScanDecision(false, justUnder, NOW), "skipped");
  assert.equal(duplicateScanDecision(false, exactly, NOW), "interval");
});

test("a first run with no recorded scan scans", () => {
  assert.equal(duplicateScanDecision(false, null, NOW), "interval");
});

test("a corrupt timestamp scans rather than skipping forever", () => {
  // Failing open matters here: failing closed means duplicates silently
  // never surface again.
  assert.equal(duplicateScanDecision(false, "not-a-date", NOW), "interval");
  assert.equal(duplicateScanDecision(false, "", NOW), "interval");
});

test("a future timestamp does not wedge the backstop shut", () => {
  const future = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
  assert.equal(duplicateScanDecision(false, future, NOW), "interval");
});

test("a custom interval is honoured", () => {
  const oneHour = 60 * 60_000;
  assert.equal(
    duplicateScanDecision(false, ago(90 * 60_000), NOW, oneHour),
    "interval",
  );
  assert.equal(
    duplicateScanDecision(false, ago(30 * 60_000), NOW, oneHour),
    "skipped",
  );
});

test("the default interval is one day", () => {
  assert.equal(DUPLICATE_SCAN_INTERVAL_MS, 86_400_000);
});
