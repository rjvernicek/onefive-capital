/**
 * Normalization rules for contact hygiene. Pure functions with no imports so
 * the module compiles standalone for the test suite (see pretest).
 *
 * The rules are deliberately conservative: when a value can't be confidently
 * improved it is returned unchanged. A normalizer that guesses wrong corrupts
 * a rolodex faster than one that declines.
 */

/**
 * Normalize a phone number toward E.164.
 *
 * Handles the common North American cases without a libphonenumber dependency:
 * 10 digits get +1, 11 digits starting with 1 get +, and anything already
 * carrying + keeps its country code. Everything else — short numbers,
 * extensions, international without + — is returned as-is with ok: false so
 * callers can flag it for review instead of mangling it.
 */
export function normalizePhone(
  raw: string,
  defaultRegion = "US",
): { value: string; ok: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: raw, ok: false };

  // "x123" / "ext. 4" style extensions can't be represented in E.164.
  if (/(x|ext)\.?\s*\d+\s*$/i.test(trimmed)) return { value: trimmed, ok: false };

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (hasPlus) {
    // Already international; just strip the decoration.
    if (digits.length >= 8 && digits.length <= 15) {
      return { value: `+${digits}`, ok: true };
    }
    return { value: trimmed, ok: false };
  }

  if (defaultRegion === "US" || defaultRegion === "CA") {
    if (digits.length === 10) return { value: `+1${digits}`, ok: true };
    if (digits.length === 11 && digits.startsWith("1")) {
      return { value: `+${digits}`, ok: true };
    }
  }

  return { value: trimmed, ok: false };
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Fix casing on a personal name only when it is clearly wrong — all caps or
 * all lower. Mixed-case input is someone's deliberate spelling (deWitt,
 * van der Berg) and passes through untouched.
 */
export function normalizeNameCase(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return trimmed;

  const isAllCaps = trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed);
  const isAllLower = trimmed === trimmed.toLowerCase() && /[a-z]/.test(trimmed);
  if (!isAllCaps && !isAllLower) return trimmed;

  return trimmed
    .toLowerCase()
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((part) => titleCaseWord(part))
        .join("-"),
    )
    .join(" ");
}

function titleCaseWord(word: string): string {
  if (!word) return word;
  // O'Brien, D'Angelo
  const apostrophe = word.match(/^([a-z])'(.+)$/);
  if (apostrophe) {
    return (
      apostrophe[1].toUpperCase() + "'" + titleCaseWord(apostrophe[2])
    );
  }
  // McDonald, MacIntyre — Mc is reliable; Mac is ambiguous (Mackey), skip it.
  if (word.startsWith("mc") && word.length > 2) {
    return "Mc" + word[2].toUpperCase() + word.slice(3);
  }
  return word[0].toUpperCase() + word.slice(1);
}

const COMPANY_SUFFIXES = new RegExp(
  "[,\\s]+(inc|incorporated|llc|l\\.l\\.c|llp|lp|l\\.p|ltd|limited|corp|" +
    "corporation|co|company|plc|gmbh|holdings?|group)\\.?$",
  "i",
);

/**
 * Reduce a company name to a matching key: lower-cased, punctuation-stripped,
 * legal suffixes removed (repeatedly — "Acme Holdings, LLC" sheds both). Used
 * to land every spelling of a firm on one companies row. The display name
 * keeps its original form; only the key is normalized.
 */
export function normalizeCompanyKey(raw: string): string {
  let name = raw.trim();
  let previous = "";
  while (name !== previous) {
    previous = name;
    name = name.replace(COMPANY_SUFFIXES, "").trim();
  }
  return name
    .toLowerCase()
    .replace(/[.,'"()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether two display names likely refer to the same person: exact match
 * after casing/whitespace normalization. Deliberately narrow — fuzzy name
 * matching produces merge proposals that erode trust in the hygiene queue.
 */
export function namesLikelySame(a: string, b: string): boolean {
  const clean = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const ca = clean(a);
  const cb = clean(b);
  return ca.length > 0 && ca === cb;
}
