import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeHtml,
  isBlockedIp,
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
