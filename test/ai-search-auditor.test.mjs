import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeAiReadability,
  analyzeEntityCoverage,
  analyzeIntentCoverage,
  auditAiSearch,
  auditFreshness,
  auditInternalLinks,
  buildPageModel,
  comparePageModels,
  prepareAeoAutofix,
  recommendSchemas
} from "../src/ai-search-auditor.mjs";

const strongHtml = `<!doctype html>
<html lang="en"><head>
  <title>Pionex Card Review and Fees</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>
</head><body><article>
  <h1>Pionex Card Review</h1>
  <p>The Pionex Card is a virtual crypto payment card that lets eligible users spend USDT with supported merchants. It has no annual fee, while transaction and foreign exchange charges may apply.</p>
  <h2>How the Pionex Card works</h2>
  <p>Users fund the card with USDT and payments are converted for the merchant. Visa acceptance depends on the merchant, country, and merchant category code.</p>
  <h2>Pionex Card fees and limits</h2>
  <table><tr><th>Item</th><th>Amount</th></tr><tr><td>Annual fee</td><td>$0</td></tr></table>
  <h2>Pionex Card vs other crypto cards</h2>
  <p>The comparison should include supported regions, refunds, limits, and payment-network acceptance.</p>
  <ol><li>Check eligibility.</li><li>Complete verification.</li><li>Fund the card.</li></ol>
  <h2>Frequently asked questions</h2>
  <p>Does the card support every merchant? No. Acceptance varies by location and merchant category.</p>
  <p>See the <a href="/usdt-guide/">USDT guide</a> and <a href="https://example.org/reference">external reference</a>.</p>
  <img src="/screenshots/card-2024.png" alt="Pionex Card dashboard screenshot">
</article></body></html>`;

test("runs the full transparent AI-search audit", () => {
  const model = buildPageModel(strongHtml, "https://example.com/pionex-card/");
  const result = auditAiSearch(model, {
    primaryEntity: "Pionex Card",
    relatedEntities: ["USDT", "Visa", "Apple Pay"],
    expectedIntents: ["informational", "commercial", "comparison", "pricing"],
    currentYear: 2026
  });

  assert.ok(result.ai_readability.score >= 70);
  assert.equal(result.entity_coverage.primary_entity.present, true);
  assert.deepEqual(result.entity_coverage.related_entities_missing, ["Apple Pay"]);
  assert.ok(result.citation_readiness.score >= 60);
  assert.ok(result.intent_coverage.detected_intents.includes("comparison"));
  assert.ok(result.citable_chunks.chunks.length > 0);
  assert.match(result.ai_overview_preview.warning, /does not simulate or predict/i);
  assert.equal(result.freshness.screenshot_signals.length, 1);
});

test("reports weak readability without pretending to use an LLM", () => {
  const filler = "Welcome to our revolutionary world class ultimate solution. ".repeat(80);
  const model = buildPageModel(`<html><body><main><h1>Welcome</h1><p>${filler}</p></main></body></html>`);
  const result = analyzeAiReadability(model);

  assert.ok(result.score < 60);
  assert.ok(result.issues.some(issue => /No H2/i.test(issue)));
  assert.match(result.method, /Deterministic/i);
});

test("uses supplied entities, intents, and real internal-link candidates", () => {
  const model = buildPageModel(strongHtml, "https://example.com/pionex-card/");
  const entities = analyzeEntityCoverage(model, {
    primaryEntity: "Pionex Card",
    relatedEntities: ["USDT", "Google Pay"]
  });
  const intents = analyzeIntentCoverage(model, ["pricing", "troubleshooting"]);
  const links = auditInternalLinks(model, [
    { url: "https://example.com/fees/", title: "Card fees", keywords: ["fees"] },
    { url: "https://example.com/usdt-guide/", title: "USDT guide", keywords: ["USDT"] }
  ]);

  assert.deepEqual(entities.related_entities_missing, ["Google Pay"]);
  assert.ok(intents.missing_expected_intents.includes("troubleshooting"));
  assert.deepEqual(links.suggested_links.map(item => item.url), ["https://example.com/fees/"]);
  assert.match(links.method, /not invented/i);
});

test("compares heading topics rather than copying competitor content", () => {
  const page = buildPageModel(`<article><h1>Card review</h1><h2>Fees</h2></article>`, "https://example.com/card/");
  const one = buildPageModel(`<article><h1>Other card</h1><h2>Fees</h2><h2>ATM withdrawals</h2></article>`, "https://competitor.example/one/");
  const two = buildPageModel(`<article><h1>Another card</h1><h2>ATM withdrawal limits</h2><h2>Refunds and chargebacks</h2></article>`, "https://competitor.example/two/");
  const result = comparePageModels(page, [one, two]);

  assert.ok(result.missing_topics.some(item => /ATM/i.test(item.topic)));
  assert.ok(result.missing_topics.some(item => /Refunds/i.test(item.topic)));
  assert.match(result.method, /not an instruction to copy/i);
});

test("detects schema and only flags freshness for review", () => {
  const model = buildPageModel(strongHtml, "https://example.com/card/");
  const schema = recommendSchemas(model);
  const freshness = auditFreshness(model, 2026);

  assert.ok(schema.existing_schema_types.includes("Article"));
  assert.equal(schema.recommendations.find(item => item.type === "Article").already_present, true);
  assert.equal(freshness.needs_review, true);
  assert.match(freshness.method, /does not declare them false/i);
});

test("prepares an exact diff and never publishes", () => {
  const content = `<h2>Fees</h2><p>Fees may apply.</p>`;
  const result = prepareAeoAutofix({
    contentHtml: content,
    proposedChanges: [{
      find_html: "<p>Fees may apply.</p>",
      replace_html: "<p>Fees depend on the transaction type and region.</p>",
      reason: "Clarify the fee statement"
    }]
  });

  assert.equal(result.changed, true);
  assert.equal(result.approval_required, true);
  assert.equal(result.publish_performed, false);
  assert.match(result.updated_content_html, /transaction type and region/);
  assert.equal(result.changes[0].before, "<p>Fees may apply.</p>");
});

test("rejects ambiguous or unsafe autofix replacements", () => {
  const ambiguous = prepareAeoAutofix({
    contentHtml: "<p>Same</p><p>Same</p>",
    proposedChanges: [{ find_html: "<p>Same</p>", replace_html: "<p>New</p>", reason: "Test" }]
  });
  const unsafe = prepareAeoAutofix({
    contentHtml: "<p>Old</p>",
    proposedChanges: [{ find_html: "<p>Old</p>", replace_html: "<script>alert(1)</script>", reason: "Test" }]
  });

  assert.equal(ambiguous.changed, false);
  assert.match(ambiguous.unresolved[0].reason, /matched 2 places/);
  assert.equal(unsafe.changed, false);
  assert.match(unsafe.unresolved[0].reason, /unsafe/i);
});
