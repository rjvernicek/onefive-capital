/**
 * Scan scheduling policy. Pure functions with no imports so the module
 * compiles standalone for the test suite (see pretest).
 *
 * Duplicate detection GROUP BYs the whole contacts and contact_emails tables,
 * so its cost scales with the size of the rolodex rather than with what
 * changed. At the 30-minute sync cadence that is 48 full scans a day, nearly
 * all of them over data that did not move. These rules decide when a scan is
 * actually worth paying for.
 */

/** Backstop: never let more than a day pass without a scan. */
export const DUPLICATE_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type ScanDecision = "changed" | "interval" | "skipped";

/**
 * Whether a sync run should pay for a full duplicate scan.
 *
 * `changed` means the contact set actually moved this run — Outlook reported
 * additions or removals, or a queued push was applied (which is how a contact
 * created over SMS shows up, since Outlook's delta won't report it as ours).
 *
 * A missing or unparseable last-scan timestamp scans rather than skips: the
 * failure mode worth engineering against is silently never scanning, not
 * scanning one extra time.
 */
export function duplicateScanDecision(
  changed: boolean,
  lastScanIso: string | null,
  now: Date,
  intervalMs: number = DUPLICATE_SCAN_INTERVAL_MS,
): ScanDecision {
  if (changed) return "changed";
  if (!lastScanIso) return "interval";

  const last = Date.parse(lastScanIso);
  if (!Number.isFinite(last)) return "interval";

  // A clock skew that puts the last scan in the future must not wedge the
  // backstop shut forever; treat anything non-recent as due.
  const elapsed = now.getTime() - last;
  if (elapsed < 0) return "interval";

  return elapsed >= intervalMs ? "interval" : "skipped";
}
