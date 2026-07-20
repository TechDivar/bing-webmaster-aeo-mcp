import assert from "node:assert/strict";
import test from "node:test";

import { BingWebmasterError } from "../src/bing-client.mjs";
import {
  BING_MAX_URLS_PER_BATCH,
  parseUrlSubmissionQuota,
  submitBingUrlBatch
} from "../src/bing-submission.mjs";

const validateUrl = async value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Only public URLs are allowed.");
  return url;
};

test("submits valid Bing URLs after checking quota and skips the rest", async () => {
  const calls = [];
  const callApi = async (method, options) => {
    calls.push({ method, options });
    if (method === "GetUrlSubmissionQuota") {
      return { DailyQuota: 2, MonthlyQuota: 5 };
    }
    return null;
  };

  const result = await submitBingUrlBatch({
    siteUrl: "https://example.com/",
    urls: [
      "https://example.com/one",
      "https://www.example.com/two",
      "https://example.com/three"
    ],
    callApi,
    validateUrl
  });

  assert.deepEqual(calls.map(call => call.method), [
    "GetUrlSubmissionQuota",
    "SubmitUrlbatch"
  ]);
  assert.deepEqual(calls[1].options.body, {
    siteUrl: "https://example.com/",
    urlList: ["https://example.com/one", "https://www.example.com/two"]
  });
  assert.equal(result.summary.submitted, 2);
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.skipped[0].code, "quota_limit");
});

test("returns structured skips for invalid, duplicate, and wrong-host URLs", async () => {
  const result = await submitBingUrlBatch({
    siteUrl: "https://example.com/",
    urls: [
      "not-a-url",
      "https://other.example/path",
      "https://example.com/ok",
      "https://example.com/ok"
    ],
    callApi: async method =>
      method === "GetUrlSubmissionQuota"
        ? { DailyQuota: 10, MonthlyQuota: 10 }
        : null,
    validateUrl
  });

  assert.equal(result.summary.submitted, 1);
  assert.deepEqual(result.skipped.map(item => item.code), [
    "invalid_url",
    "wrong_host",
    "duplicate_url"
  ]);
});

test("does not submit when Bing returns a malformed quota response", async () => {
  const calls = [];
  const result = await submitBingUrlBatch({
    siteUrl: "https://example.com/",
    urls: ["https://example.com/one"],
    callApi: async method => {
      calls.push(method);
      return { DailyQuota: "unknown", MonthlyQuota: 10 };
    },
    validateUrl
  });

  assert.deepEqual(calls, ["GetUrlSubmissionQuota"]);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.failed[0].code, "quota_check_failed");
});

test("returns a structured missing-credential failure without exposing credentials", async () => {
  const result = await submitBingUrlBatch({
    siteUrl: "https://example.com/",
    urls: ["https://example.com/one", "https://example.com/two"],
    callApi: async () => {
      throw new BingWebmasterError("Bing API key is not configured.");
    },
    validateUrl
  });

  assert.equal(result.summary.failed, 2);
  assert.ok(result.failed.every(item => item.code === "quota_check_failed"));
  assert.ok(result.failed.every(item => /not configured/.test(item.reason)));
});

test("parses only the documented Bing quota fields", () => {
  assert.deepEqual(parseUrlSubmissionQuota({ DailyQuota: 5, MonthlyQuota: 24 }), {
    DailyQuota: 5,
    MonthlyQuota: 24,
    available: 5
  });
  assert.throws(
    () => parseUrlSubmissionQuota({ remaining: 5 }),
    /malformed URL submission quota/
  );
  assert.equal(BING_MAX_URLS_PER_BATCH, 500);
});

test("reuses the public URL guard for Bing batch submissions", async () => {
  await assert.rejects(
    submitBingUrlBatch({
      siteUrl: "http://127.0.0.1/",
      urls: ["http://127.0.0.1/page"],
      callApi: async () => ({ DailyQuota: 1, MonthlyQuota: 1 })
    }),
    /not a valid public URL/
  );
});
