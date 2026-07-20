import assert from "node:assert/strict";
import test from "node:test";

import {
  AeoCatalogAuditError,
  auditLlmsTxt,
  checkInternalDuplicates,
  checkMultilangSchemaParity
} from "../src/aeo-catalog-audits.mjs";

function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers }
  });
}

function textResponse(text, status = 200, headers = {}) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers }
  });
}

test("reports a missing root-level llms.txt", async () => {
  const result = await auditLlmsTxt("https://8.8.8.8", {
    fetchImpl: async () => textResponse("not found", 404)
  });

  assert.equal(result.exists, false);
  assert.deepEqual(result.issue_codes, ["llms_txt_missing"]);
});

test("parses llms.txt and flags supplied canonical URLs that are absent", async () => {
  const body = "# Example\n\n## Guides\n- [Card guide](https://8.8.8.8/card-guide)\n";
  const result = await auditLlmsTxt("https://8.8.8.8", {
    fetchImpl: async () => textResponse(body),
    canonicalUrls: [
      "https://8.8.8.8/card-guide/",
      "https://8.8.8.8/xstocks-hub"
    ]
  });

  assert.equal(result.exists, true);
  assert.equal(result.checks.has_h1, true);
  assert.equal(result.checks.link_count, 1);
  assert.ok(result.issue_codes.includes("llms_txt_missing_canonical_pages"));
  assert.match(result.notice, /community proposal/);
});

test("does not bypass the safe fetcher for an HTML llms.txt response", async () => {
  let calls = 0;
  const result = await auditLlmsTxt("https://8.8.8.8", {
    fetchImpl: async () => {
      calls += 1;
      return htmlResponse("<html><body>not llms.txt</body></html>");
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.exists, false);
  assert.deepEqual(result.issue_codes, ["llms_txt_unavailable"]);
});

test("flags near-identical article bodies and skips non-2xx pages", async () => {
  const shared = Array.from({ length: 100 }, (_, index) => `word${index % 25}`).join(" ");
  const unique = Array.from({ length: 100 }, (_, index) => `unique${index}`).join(" ");
  const fetchImpl = async url => {
    const href = String(url);
    if (href.endsWith("/a") || href.endsWith("/b")) {
      return htmlResponse(`<article><p>${shared}</p></article>`);
    }
    if (href.endsWith("/failed")) return htmlResponse("error", 404);
    return htmlResponse(`<article><p>${unique}</p></article>`);
  };

  const result = await checkInternalDuplicates(
    [
      "https://8.8.8.8/a",
      "https://8.8.8.8/b",
      "https://8.8.8.8/c",
      "https://8.8.8.8/failed"
    ],
    { fetchImpl, delayMs: 0 }
  );

  assert.equal(result.urls_compared, 3);
  assert.equal(result.urls_failed.length, 1);
  assert.equal(result.duplicate_pairs.length, 1);
  assert.equal(result.duplicate_pairs[0].url_a, "https://8.8.8.8/a");
  assert.equal(result.summary.review_required, true);
});

test("requires at least two unique URLs for duplicate comparison", async () => {
  await assert.rejects(
    checkInternalDuplicates([
      "https://8.8.8.8/a",
      "https://8.8.8.8/a#section"
    ]),
    error => error instanceof AeoCatalogAuditError && /two unique URLs/.test(error.message)
  );
});

test("finds Article and FAQPage schema inside common @graph JSON-LD", async () => {
  const graph = locale => ({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        headline: "Title",
        author: { "@type": "Person", name: "Author" },
        image: "https://8.8.8.8/image.jpg",
        datePublished: "2026-01-01T00:00:00Z",
        dateModified: locale === "en"
          ? "2026-07-01T00:00:00Z"
          : "2026-02-01T00:00:00Z"
      },
      { "@type": "FAQPage", mainEntity: [] }
    ]
  });
  const fetchImpl = async url => {
    const locale = String(url).endsWith("/en") ? "en" : "fr";
    return htmlResponse(
      `<script type="application/ld+json">${JSON.stringify(graph(locale))}</script>`
    );
  };

  const result = await checkMultilangSchemaParity(
    [
      { locale: "en", url: "https://8.8.8.8/en" },
      { locale: "fr", url: "https://8.8.8.8/fr" }
    ],
    { fetchImpl, delayMs: 0 }
  );

  assert.ok(result.per_locale.every(page => page.has_article_schema));
  assert.ok(result.per_locale.every(page => page.has_faq_schema));
  assert.ok(result.issue_codes.includes("locale_freshness_drift"));
});

test("flags a locale missing Article and FAQPage schema", async () => {
  const schema = {
    "@type": ["Article"],
    headline: "Title",
    dateModified: "2026-07-01T00:00:00Z"
  };
  const faq = { "@type": "https://schema.org/FAQPage" };
  const fetchImpl = async url => String(url).endsWith("/de")
    ? htmlResponse("<article>No JSON-LD</article>")
    : htmlResponse(
        `<script type="application/ld+json">${JSON.stringify([schema, faq])}</script>`
      );

  const result = await checkMultilangSchemaParity(
    [
      { locale: "en", url: "https://8.8.8.8/en" },
      { locale: "de", url: "https://8.8.8.8/de" }
    ],
    { fetchImpl, delayMs: 0 }
  );

  assert.ok(result.issue_codes.includes("locale_missing_article_schema"));
  assert.ok(result.issue_codes.includes("locale_missing_faq_schema"));
});
