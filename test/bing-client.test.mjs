import assert from "node:assert/strict";
import test from "node:test";

import {
  BingWebmasterError,
  callBingApi,
  isUrlWithinSite,
  normalizeBingValue
} from "../src/bing-client.mjs";

test("normalizes Bing dates and removes sensitive metadata", () => {
  const result = normalizeBingValue({
    __type: "Site:#Microsoft.Bing.Webmaster.Api",
    Url: "https://example.com/",
    AuthenticationCode: "do-not-return",
    Date: "/Date(1316156400000-0700)/"
  });

  assert.deepEqual(result, {
    Url: "https://example.com/",
    Date: "2011-09-16T07:00:00.000Z"
  });
});

test("builds an encoded Bing JSON request", async () => {
  let capturedUrl;
  const fetchImpl = async url => {
    capturedUrl = url;
    return new Response(JSON.stringify({ d: [{ Query: "test", Clicks: 3 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const result = await callBingApi("GetQueryStats", {
    apiKey: "TEST-KEY",
    params: { siteUrl: "https://example.com/" },
    fetchImpl
  });

  assert.equal(capturedUrl.searchParams.get("apikey"), "TEST-KEY");
  assert.equal(capturedUrl.searchParams.get("siteUrl"), "https://example.com/");
  assert.deepEqual(result, [{ Query: "test", Clicks: 3 }]);
});

test("never includes the API key in Bing error messages", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ Message: "Invalid key TEST-KEY" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });

  await assert.rejects(
    callBingApi("GetUserSites", { apiKey: "TEST-KEY", fetchImpl }),
    error => {
      assert.ok(error instanceof BingWebmasterError);
      assert.equal(error.message.includes("TEST-KEY"), false);
      assert.equal(error.message.includes("[REDACTED]"), true);
      return true;
    }
  );
});

test("allows only URLs on the verified site's domain", () => {
  assert.equal(
    isUrlWithinSite("https://pionex.com/", "https://www.pionex.com/blog/test"),
    true
  );
  assert.equal(
    isUrlWithinSite("https://pionex.com/", "https://support.pionex.com/article"),
    true
  );
  assert.equal(
    isUrlWithinSite("https://pionex.com/", "https://example.com/"),
    false
  );
});
