import assert from "node:assert/strict";
import test from "node:test";

import {
  INDEXNOW_MAX_URLS_PER_REQUEST,
  IndexNowError,
  readIndexNowKey,
  submitIndexNowUrls,
  validateIndexNowKey
} from "../src/indexnow-client.mjs";

const TEST_KEY = "IndexNow-Test-Key-1234";
const validateUrl = async value => new URL(value);

function response(body = "", status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

test("validates an accessible same-host IndexNow key without returning it", async () => {
  const result = await validateIndexNowKey({
    siteUrl: "https://example.com/",
    key: TEST_KEY,
    fetchImpl: async () => response(TEST_KEY),
    validateUrl
  });

  assert.equal(result.valid, true);
  assert.equal(result.site_host, "example.com");
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test("follows same-host key redirects and rejects cross-host redirects", async () => {
  let calls = 0;
  const sameHost = await validateIndexNowKey({
    siteUrl: "https://example.com/",
    key: TEST_KEY,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response("", 302, { Location: "/keys/indexnow.txt" })
        : response(TEST_KEY);
    },
    validateUrl
  });
  assert.equal(sameHost.valid, true);
  assert.equal(sameHost.redirects_followed, 1);

  const crossHost = await validateIndexNowKey({
    siteUrl: "https://example.com/",
    key: TEST_KEY,
    fetchImpl: async () =>
      response("", 302, { Location: "https://other.example/key.txt" }),
    validateUrl
  });
  assert.equal(crossHost.valid, false);
  assert.match(crossHost.reason, /different host/);
});

test("submits valid IndexNow changes and returns structured skips", async () => {
  const requests = [];
  const result = await submitIndexNowUrls({
    siteUrl: "https://example.com/",
    key: TEST_KEY,
    entries: [
      { url: "https://example.com/new", changeType: "added" },
      { url: "https://example.com/old", changeType: "deleted" },
      { url: "https://other.example/wrong", changeType: "updated" },
      { url: "not-a-url", changeType: "updated" }
    ],
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return options.method === "GET" ? response(TEST_KEY) : response("", 200);
    },
    validateUrl
  });

  assert.equal(result.summary.accepted, 2);
  assert.equal(result.summary.skipped, 2);
  assert.deepEqual(result.success.map(item => item.change_type), ["added", "deleted"]);
  assert.deepEqual(result.skipped.map(item => item.code), ["wrong_host", "invalid_url"]);

  const payload = JSON.parse(requests.find(item => item.options.method === "POST").options.body);
  assert.deepEqual(payload.urlList, [
    "https://example.com/new",
    "https://example.com/old"
  ]);
  assert.equal(payload.host, "example.com");
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test("fails safely when the key file response is malformed", async () => {
  let postCalled = false;
  const result = await submitIndexNowUrls({
    siteUrl: "https://example.com/",
    key: TEST_KEY,
    entries: [{ url: "https://example.com/page", changeType: "updated" }],
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") postCalled = true;
      return response("wrong-key-file-content");
    },
    validateUrl
  });

  assert.equal(postCalled, false);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.failed[0].code, "key_validation_failed");
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test("does not replay a secret-bearing IndexNow submission after a redirect", async () => {
  let postCalls = 0;
  const result = await submitIndexNowUrls({
    siteUrl: "https://example.com/",
    key: TEST_KEY,
    entries: [{ url: "https://example.com/page", changeType: "updated" }],
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") return response(TEST_KEY);
      postCalls += 1;
      return response("", 307, { Location: "https://other.example/indexnow" });
    },
    validateUrl
  });

  assert.equal(postCalls, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.failed[0].code, "unsafe_redirect");
});

test("reports partial IndexNow failures across official-size chunks", async () => {
  const entries = Array.from({ length: INDEXNOW_MAX_URLS_PER_REQUEST + 1 }, (_, index) => ({
    url: `https://example.com/page-${index}`,
    changeType: "updated"
  }));
  let postCalls = 0;
  const result = await submitIndexNowUrls({
    siteUrl: "https://example.com/",
    key: TEST_KEY,
    entries,
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") return response(TEST_KEY);
      postCalls += 1;
      return postCalls === 1 ? response("", 200) : response("", 429);
    },
    validateUrl
  });

  assert.equal(postCalls, 2);
  assert.equal(result.summary.accepted, INDEXNOW_MAX_URLS_PER_REQUEST);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.failed[0].http_status, 429);
});

test("rejects a custom IndexNow key location on the wrong host", async () => {
  await assert.rejects(
    validateIndexNowKey({
      siteUrl: "https://example.com/",
      key: TEST_KEY,
      keyLocation: "https://other.example/key.txt",
      fetchImpl: async () => response(TEST_KEY),
      validateUrl
    }),
    error => error instanceof IndexNowError && /same host/.test(error.message)
  );
});

test("enforces a custom IndexNow key file's directory scope", async () => {
  const result = await submitIndexNowUrls({
    siteUrl: "https://example.com/",
    key: TEST_KEY,
    keyLocation: "https://example.com/catalog/indexnow.txt",
    entries: [
      { url: "https://example.com/catalog/product", changeType: "updated" },
      { url: "https://example.com/help/article", changeType: "updated" }
    ],
    fetchImpl: async (_url, options) =>
      options.method === "GET" ? response(TEST_KEY) : response("", 200),
    validateUrl
  });

  assert.equal(result.summary.accepted, 1);
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.skipped[0].code, "outside_key_scope");
});

test("reuses the public URL guard for IndexNow key validation", async () => {
  await assert.rejects(
    validateIndexNowKey({
      siteUrl: "http://127.0.0.1/",
      key: TEST_KEY,
      fetchImpl: async () => response(TEST_KEY)
    }),
    /not a valid public URL/
  );
});

test("reports missing IndexNow credentials without exposing a key", async () => {
  const previousKey = process.env.INDEXNOW_KEY;
  const previousFile = process.env.INDEXNOW_KEY_FILE;
  delete process.env.INDEXNOW_KEY;
  process.env.INDEXNOW_KEY_FILE = "/private/tmp/bing-webmaster-aeo-mcp-missing-indexnow-key";

  try {
    await assert.rejects(
      readIndexNowKey(),
      error => error instanceof IndexNowError && /not configured/.test(error.message)
    );
  } finally {
    if (previousKey === undefined) delete process.env.INDEXNOW_KEY;
    else process.env.INDEXNOW_KEY = previousKey;
    if (previousFile === undefined) delete process.env.INDEXNOW_KEY_FILE;
    else process.env.INDEXNOW_KEY_FILE = previousFile;
  }
});
