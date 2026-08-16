import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePhone,
  normalizeEmail,
  normalizeNameCase,
  normalizeCompanyKey,
  namesLikelySame,
} from "../.test-build/clean.js";

// ---------------------------------------------------------------------------
// normalizePhone

test("US 10-digit gets +1", () => {
  assert.deepEqual(normalizePhone("(214) 555-1234"), {
    value: "+12145551234",
    ok: true,
  });
});

test("US 11-digit starting with 1 gets +", () => {
  assert.deepEqual(normalizePhone("1-214-555-1234"), {
    value: "+12145551234",
    ok: true,
  });
});

test("already-international number keeps its country code", () => {
  assert.deepEqual(normalizePhone("+44 20 7946 0958"), {
    value: "+442079460958",
    ok: true,
  });
});

test("dotted format normalizes", () => {
  assert.deepEqual(normalizePhone("214.555.1234"), {
    value: "+12145551234",
    ok: true,
  });
});

test("extension is left alone and flagged", () => {
  const result = normalizePhone("214-555-1234 x203");
  assert.equal(result.ok, false);
  assert.equal(result.value, "214-555-1234 x203");
});

test("short number is left alone and flagged", () => {
  const result = normalizePhone("555-1234");
  assert.equal(result.ok, false);
});

test("10 digits without + is presumed domestic under US region", () => {
  // A UK number written without its + is indistinguishable from a US number;
  // the region default decides, by design.
  assert.deepEqual(normalizePhone("20 7946 0958"), {
    value: "+12079460958",
    ok: true,
  });
});

test("12 digits without + is left alone and flagged", () => {
  const result = normalizePhone("442079460958");
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// normalizeEmail

test("email lower-cases and trims", () => {
  assert.equal(normalizeEmail("  Rob@OneFiveCap.COM "), "rob@onefivecap.com");
});

// ---------------------------------------------------------------------------
// normalizeNameCase

test("all-caps name title-cases", () => {
  assert.equal(normalizeNameCase("JOHN SMITH"), "John Smith");
});

test("all-lower name title-cases", () => {
  assert.equal(normalizeNameCase("jane doe"), "Jane Doe");
});

test("mixed-case name passes through untouched", () => {
  assert.equal(normalizeNameCase("Willem van der Berg"), "Willem van der Berg");
});

test("O'Brien survives casing fix", () => {
  assert.equal(normalizeNameCase("PATRICK O'BRIEN"), "Patrick O'Brien");
});

test("McDonald survives casing fix", () => {
  assert.equal(normalizeNameCase("ANGUS MCDONALD"), "Angus McDonald");
});

test("hyphenated name cases both halves", () => {
  assert.equal(normalizeNameCase("mary smith-jones"), "Mary Smith-Jones");
});

test("interior whitespace collapses", () => {
  assert.equal(normalizeNameCase("JOHN   SMITH"), "John Smith");
});

// ---------------------------------------------------------------------------
// normalizeCompanyKey

test("legal suffixes strip, repeatedly", () => {
  assert.equal(normalizeCompanyKey("Acme Holdings, LLC"), "acme");
});

test("Inc with period strips", () => {
  assert.equal(normalizeCompanyKey("Initech, Inc."), "initech");
});

test("same firm, different spellings, one key", () => {
  assert.equal(
    normalizeCompanyKey("Blackstone Group LP"),
    normalizeCompanyKey("The Blackstone Group L.P.".replace("The ", "")),
  );
});

test("punctuation drops out of the key", () => {
  assert.equal(normalizeCompanyKey("O'Neill & Partners"), "o'neill & partners".replace(/[.,'"()]/g, "").replace(/\s+/g, " "));
});

// ---------------------------------------------------------------------------
// namesLikelySame

test("same name, different case and spacing, matches", () => {
  assert.equal(namesLikelySame("John  Smith", "john smith"), true);
});

test("different names do not match", () => {
  assert.equal(namesLikelySame("John Smith", "Jon Smith"), false);
});

test("empty names never match", () => {
  assert.equal(namesLikelySame("", ""), false);
});
