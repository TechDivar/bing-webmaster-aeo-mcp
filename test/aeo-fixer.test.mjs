import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAeoFixPlan,
  prepareWordPressFixes
} from "../src/aeo-fixer.mjs";

test("builds an actionable plan from scan issues", () => {
  const plan = buildAeoFixPlan({
    requested_url: "https://example.com/article/",
    final_url: "https://example.com/article/",
    issues: [
      { severity: "error", code: "multiple_h1", message: "Two H1s" },
      {
        severity: "error",
        code: "image_missing_alt",
        message: "Missing alt",
        evidence: { elements: [{ source: "https://example.com/hero.jpg" }] }
      }
    ]
  });

  assert.equal(plan.issue_count, 2);
  assert.equal(plan.automatically_actionable_count, 2);
  assert.equal(plan.fixes[0].target, "wordpress_content");
  assert.equal(plan.fixes[1].evidence.elements[0].source, "https://example.com/hero.jpg");
});

test("prepares Gutenberg-safe H1 and image alt fixes", () => {
  const content = `<!-- wp:heading {"level":1,"className":"intro"} -->
<h1 class="wp-block-heading intro">Eligibility rules</h1>
<!-- /wp:heading -->
<!-- wp:image -->
<figure><img src="/hero.jpg"><figcaption>Eligibility map</figcaption></figure>
<!-- /wp:image -->`;

  const result = prepareWordPressFixes({
    contentHtml: content,
    pageUrl: "https://example.com/article/",
    issueCodes: ["multiple_h1", "image_missing_alt"],
    imageAltTexts: [
      {
        image_src: "https://example.com/hero.jpg",
        alt_text: "Map of tokenized-stock eligibility restrictions"
      }
    ],
    themeRendersTitleH1: true
  });

  assert.equal(result.ready_for_wordpress_update, true);
  assert.match(result.updated_content_html, /<!-- wp:heading \{"level":2,"className":"intro"\} -->/);
  assert.match(result.updated_content_html, /<h2 class="wp-block-heading intro">/);
  assert.match(
    result.updated_content_html,
    /alt="Map of tokenized-stock eligibility restrictions"/
  );
  assert.equal(result.changes.length, 2);
});

test("does not guess image alt text or change H1 without theme confirmation", () => {
  const result = prepareWordPressFixes({
    contentHtml: '<h1>Article heading</h1><img src="/chart.png">',
    pageUrl: "https://example.com/article/",
    issueCodes: ["multiple_h1", "image_missing_alt"],
    themeRendersTitleH1: false
  });

  assert.equal(result.changed, false);
  assert.equal(result.ready_for_wordpress_update, false);
  assert.equal(result.unresolved.length, 2);
  assert.match(result.updated_content_html, /<h1>/);
  assert.doesNotMatch(result.updated_content_html, /alt=/);
});

test("changes only the requested image alt issue type", () => {
  const result = prepareWordPressFixes({
    contentHtml: '<img src="/missing.jpg"><img src="/empty.jpg" alt="">',
    pageUrl: "https://example.com/article/",
    issueCodes: ["image_empty_alt"],
    imageAltTexts: [
      { image_src: "https://example.com/missing.jpg", alt_text: "Missing image" },
      { image_src: "https://example.com/empty.jpg", alt_text: "Useful diagram" }
    ]
  });

  assert.match(result.updated_content_html, /<img src="\/missing.jpg">/);
  assert.match(result.updated_content_html, /<img src="\/empty.jpg" alt="Useful diagram">/);
  assert.equal(result.changes.length, 1);
});
