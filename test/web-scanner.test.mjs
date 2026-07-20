import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeHtml,
  fetchTextResource,
  isBlockedIp,
  scanPage,
  validatePublicUrl
} from "../src/web-scanner.mjs";

const scanContext = {
  requestedUrl: "https://example.com/page",
  finalUrl: "https://example.com/page",
  status: 200,
  statusText: "OK",
  contentType: "text/html; charset=utf-8",
  scannedAt: "2026-07-20T10:00:00.000Z"
};

test("detects duplicate H1s and exact images missing alt text", () => {
  const result = analyzeHtml(
    `<!doctype html>
    <html lang="en">
      <head>
        <title>Example page</title>
        <meta name="description" content="An example description">
        <link rel="canonical" href="https://example.com/page">
      </head>
      <body>
        <h1>First heading</h1>
        <h1>Second heading</h1>
        <img src="/hero.jpg">
        <img src="/decorative.svg" alt="">
      </body>
    </html>`,
    scanContext
  );

  assert.ok(result.issue_codes.includes("multiple_h1"));
  assert.ok(result.issue_codes.includes("image_missing_alt"));
  assert.ok(result.issue_codes.includes("image_empty_alt"));

  const h1Issue = result.issues.find(issue => issue.code === "multiple_h1");
  assert.equal(h1Issue.evidence.count, 2);
  assert.deepEqual(
    h1Issue.evidence.elements.map(element => element.text),
    ["First heading", "Second heading"]
  );

  const altIssue = result.issues.find(issue => issue.code === "image_missing_alt");
  assert.equal(altIssue.evidence.elements[0].source, "https://example.com/hero.jpg");
  assert.equal(result.summary.errors, 2);
});

test("passes a page with the core deterministic checks present", () => {
  const result = analyzeHtml(
    `<!doctype html>
    <html lang="en">
      <head>
        <title>Example page</title>
        <meta name="description" content="An example description">
        <link rel="canonical" href="https://example.com/page">
        <script type="application/ld+json">{"@context":"https://schema.org"}</script>
      </head>
      <body>
        <h1>One heading</h1>
        <img src="/hero.jpg" alt="Useful description">
      </body>
    </html>`,
    scanContext
  );

  assert.equal(result.summary.passed, true);
  assert.equal(result.summary.total_issues, 0);
});

test("reports invalid JSON-LD with evidence", () => {
  const result = analyzeHtml(
    `<!doctype html>
    <html lang="en">
      <head>
        <title>Example page</title>
        <meta name="description" content="An example description">
        <link rel="canonical" href="https://example.com/page">
        <script type="application/ld+json">{"broken":</script>
      </head>
      <body><h1>One heading</h1></body>
    </html>`,
    scanContext
  );

  const issue = result.issues.find(item => item.code === "invalid_json_ld");
  assert.equal(issue.severity, "error");
  assert.equal(issue.evidence.blocks.length, 1);
});

test("blocks local and private network scan targets", async () => {
  assert.equal(isBlockedIp("127.0.0.1"), true);
  assert.equal(isBlockedIp("10.0.0.1"), true);
  assert.equal(isBlockedIp("8.8.8.8"), false);
  await assert.rejects(
    validatePublicUrl("http://127.0.0.1/private"),
    /Local or private network addresses cannot be scanned/
  );
});

test("does not report article SEO defects from a non-2xx block page", () => {
  const result = analyzeHtml(
    `<!doctype html><html><head><title>Just a moment...</title>
    <meta name="robots" content="noindex,nofollow"></head><body></body></html>`,
    { ...scanContext, status: 429, statusText: "Too Many Requests" }
  );

  assert.deepEqual(result.issue_codes, ["http_status_error"]);
  assert.equal(result.checks.skipped, true);
  assert.equal(result.summary.total_issues, 1);
});

test("retries a rate-limited page before scanning its HTML", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("<html><title>Blocked</title></html>", {
        status: 429,
        headers: { "content-type": "text/html", "retry-after": "0" }
      });
    }
    return new Response(
      `<!doctype html><html lang="en"><head><title>Example</title>
      <meta name="description" content="Description">
      <link rel="canonical" href="https://8.8.8.8/page"></head>
      <body><h1>Example</h1></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } }
    );
  };

  const result = await scanPage("https://8.8.8.8/page", {
    fetchImpl,
    sleepImpl: async () => {},
    retryLimit: 1
  });

  assert.equal(calls, 2);
  assert.equal(result.http.status, 200);
  assert.equal(result.summary.passed, true);
});

test("safely follows redirects when fetching a public text resource", async () => {
  let calls = 0;
  const result = await fetchTextResource("https://8.8.8.8/llms.txt", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "/files/llms.txt", "content-type": "text/plain" }
        });
      }
      return new Response("# Example", {
        status: 200,
        headers: { "content-type": "text/markdown" }
      });
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.text, "# Example");
  assert.equal(result.context.finalUrl, "https://8.8.8.8/files/llms.txt");
});

test("blocks a text-resource redirect to a private address", async () => {
  let calls = 0;
  await assert.rejects(
    fetchTextResource("https://8.8.8.8/llms.txt", {
      fetchImpl: async () => {
        calls += 1;
        return new Response("", {
          status: 302,
          headers: {
            location: "http://127.0.0.1/private",
            "content-type": "text/plain"
          }
        });
      }
    }),
    /Local or private network addresses cannot be scanned/
  );
  assert.equal(calls, 1);
});
