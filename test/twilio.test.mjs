import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { verifyTwilioSignature } from "../.test-build/twilio.js";

/**
 * Twilio's documented algorithm, implemented independently with node:crypto:
 * HMAC-SHA1 over the request URL followed by every POST parameter sorted by
 * key and concatenated as key+value. The module under test implements the same
 * thing on Web Crypto (what the Workers runtime provides); agreement between
 * the two is the assertion.
 */
function referenceSignature(authToken, url, params) {
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  return crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(payload, "utf-8"))
    .digest("base64");
}

const URL_UNDER_TEST = "https://mycompany.com/myapp.php?foo=1&bar=2";
const PARAMS = {
  CallSid: "CA1234567890ABCDE",
  Caller: "+14158675309",
  Digits: "1234",
  From: "+14158675309",
  To: "+18005551212",
};
const TOKEN = "12345";
const VALID = referenceSignature(TOKEN, URL_UNDER_TEST, PARAMS);

test("payload is built in Twilio's documented order", () => {
  // Sorted by key, key and value concatenated with no separator, appended to
  // the full URL. Pinned literally so a refactor can't silently reorder it.
  assert.equal(
    URL_UNDER_TEST +
      Object.keys(PARAMS)
        .sort()
        .map((k) => k + PARAMS[k])
        .join(""),
    "https://mycompany.com/myapp.php?foo=1&bar=2" +
      "CallSidCA1234567890ABCDE" +
      "Caller+14158675309" +
      "Digits1234" +
      "From+14158675309" +
      "To+18005551212",
  );
});

test("accepts a correctly signed request", async () => {
  assert.equal(
    await verifyTwilioSignature(TOKEN, URL_UNDER_TEST, PARAMS, VALID),
    true,
  );
});

test("rejects a tampered signature", async () => {
  const tampered = (VALID[0] === "A" ? "B" : "A") + VALID.slice(1);
  assert.equal(
    await verifyTwilioSignature(TOKEN, URL_UNDER_TEST, PARAMS, tampered),
    false,
  );
});

test("rejects a wrong auth token", async () => {
  assert.equal(
    await verifyTwilioSignature("wrong-token", URL_UNDER_TEST, PARAMS, VALID),
    false,
  );
});

test("rejects a mutated parameter", async () => {
  assert.equal(
    await verifyTwilioSignature(
      TOKEN,
      URL_UNDER_TEST,
      { ...PARAMS, Digits: "9999" },
      VALID,
    ),
    false,
  );
});

test("rejects an injected extra parameter", async () => {
  assert.equal(
    await verifyTwilioSignature(
      TOKEN,
      URL_UNDER_TEST,
      { ...PARAMS, Injected: "x" },
      VALID,
    ),
    false,
  );
});

test("rejects a mutated URL", async () => {
  assert.equal(
    await verifyTwilioSignature(
      TOKEN,
      URL_UNDER_TEST + "&evil=1",
      PARAMS,
      VALID,
    ),
    false,
  );
});

test("rejects a missing signature header", async () => {
  assert.equal(
    await verifyTwilioSignature(TOKEN, URL_UNDER_TEST, PARAMS, null),
    false,
  );
});

test("rejects a signature of the wrong length", async () => {
  assert.equal(
    await verifyTwilioSignature(TOKEN, URL_UNDER_TEST, PARAMS, "short"),
    false,
  );
});
