import assert from "node:assert/strict";
import test from "node:test";

import {
  AeoTrafficOpportunityError,
  findAiTrafficOpportunities
} from "../src/aeo-traffic-opportunities.mjs";

const bingRows = [
  {
    Query: "https://www.example.com/a/",
    Impressions: 12_000,
    Clicks: 120,
    AvgImpressionPosition: 8,
    AvgClickPosition: 7
  },
  {
    Query: "https://www.example.com/b",
    Impressions: 8_000,
    Clicks: 40,
    AvgImpressionPosition: 12,
    AvgClickPosition: 11
  },
  {
    Query: "https://www.example.com/healthy",
    Impressions: 6_000,
    Clicks: 180,
    AvgImpressionPosition: 5,
    AvgClickPosition: 4
  },
  {
    Query: "https://www.example.com/small",
    Impressions: 400,
    Clicks: 10,
    AvgImpressionPosition: 20,
    AvgClickPosition: 18
  }
];

test("finds high-Bing, low-AI opportunities from a normal GA4 CSV", () => {
  const ga4Csv = [
    "# GA4 traffic acquisition export",
    "Page path + query string,Session source / medium,Sessions",
    "/a?campaign=test,chatgpt.com / referral,3",
    "/b,google / organic,100",
    "/healthy,perplexity.ai / referral,50",
    "/small,claude.ai / referral,0"
  ].join("\n");

  const result = findAiTrafficOpportunities({
    siteUrl: "https://example.com/",
    bingRows,
    ga4Csv,
    minimumBingImpressions: 1_000,
    maximumAiTraffic: 5
  });

  assert.equal(result.summary.opportunity_pages, 2);
  assert.deepEqual(
    result.opportunities.map(page => [page.url, page.ga4_ai_traffic]),
    [
      ["https://www.example.com/a", 3],
      ["https://www.example.com/b", 0]
    ]
  );
  assert.equal(result.opportunities[0].bing_ctr_percent, 1);
  assert.equal(result.ga4_input.detected_columns.page, "Page path + query string");
  assert.deepEqual(result.ga4_input.matched_sources.sort(), [
    "chatgpt.com",
    "claude.ai",
    "perplexity.ai"
  ]);
  assert.equal(result.skipped.ga4_rows.non_ai_source, 1);
});

test("accepts a GA4 export already filtered to AI traffic", () => {
  const result = findAiTrafficOpportunities({
    siteUrl: "https://example.com/",
    bingRows,
    ga4Csv: "Page path,Sessions\n/a,2\n/healthy,30",
    ga4RowsAreAiFiltered: true,
    minimumBingImpressions: 1_000,
    maximumAiTraffic: 2
  });

  assert.deepEqual(
    result.opportunities.map(page => page.url),
    ["https://www.example.com/a", "https://www.example.com/b"]
  );
  assert.equal(result.ga4_input.rows_already_filtered_to_ai, true);
});

test("requires a source column unless GA4 data is already AI-filtered", () => {
  assert.throws(
    () => findAiTrafficOpportunities({
      siteUrl: "https://example.com/",
      bingRows,
      ga4Csv: "Page path,Sessions\n/a,2"
    }),
    error => error instanceof AeoTrafficOpportunityError &&
      /no Session source or Page referrer/.test(error.message)
  );
});

test("matches structured GA4 rows, additional AI sources, and www variants", () => {
  const result = findAiTrafficOpportunities({
    siteUrl: "https://example.com/",
    bingRows: [
      ...bingRows,
      {
        Query: "https://example.com/a",
        Impressions: 1_000,
        Clicks: 10,
        AvgImpressionPosition: 10,
        AvgClickPosition: 9
      }
    ],
    ga4Rows: [
      { page: "https://example.com/a?utm_source=test", source: "new-ai.example", traffic: 4 },
      { page: "https://other.example/b", source: "chatgpt.com", traffic: 1 }
    ],
    additionalAiSources: ["new-ai.example"],
    minimumBingImpressions: 1_000,
    maximumAiTraffic: 5
  });

  assert.equal(result.opportunities[0].bing_impressions, 13_000);
  assert.equal(result.opportunities[0].ga4_ai_traffic, 4);
  assert.equal(result.skipped.ga4_rows.wrong_host, 1);
  assert.deepEqual(result.ga4_input.matched_sources, ["new-ai.example"]);
});

test("does not echo a full referrer URL in matched source output", () => {
  const result = findAiTrafficOpportunities({
    siteUrl: "https://example.com/",
    bingRows,
    ga4Rows: [
      {
        page: "/a",
        source: "https://chatgpt.com/c/private-path?private=value",
        traffic: 1
      }
    ]
  });

  assert.deepEqual(result.ga4_input.matched_sources, ["chatgpt.com"]);
  assert.doesNotMatch(JSON.stringify(result), /private-path|private=value/);
});

test("rejects malformed Bing GetPageStats responses", () => {
  assert.throws(
    () => findAiTrafficOpportunities({
      siteUrl: "https://example.com/",
      bingRows: { unexpected: true },
      ga4Rows: [{ page: "/a", source: "chatgpt.com", traffic: 1 }]
    }),
    error => error instanceof AeoTrafficOpportunityError &&
      /unexpected GetPageStats response/.test(error.message)
  );
});

test("skips malformed and wrong-host Bing rows", () => {
  const result = findAiTrafficOpportunities({
    siteUrl: "https://example.com/",
    bingRows: [
      { Query: "https://other.example/a", Impressions: 5_000, Clicks: 10 },
      { Query: "https://example.com/b", Impressions: "bad", Clicks: 10 },
      { Query: "", Impressions: 2_000, Clicks: 10 }
    ],
    ga4Rows: [{ page: "/a", source: "chatgpt.com", traffic: 1 }]
  });

  assert.equal(result.summary.bing_pages_matched_to_site, 0);
  assert.deepEqual(result.skipped.bing_rows, {
    missing_or_invalid_url: 1,
    wrong_host: 1,
    malformed_statistics: 1
  });
});

test("requires exactly one GA4 input format", () => {
  assert.throws(
    () => findAiTrafficOpportunities({
      siteUrl: "https://example.com/",
      bingRows,
      ga4Rows: []
    }),
    /Provide a GA4 CSV or aggregated GA4 rows/
  );

  assert.throws(
    () => findAiTrafficOpportunities({
      siteUrl: "https://example.com/",
      bingRows,
      ga4Csv: "Page path,Sessions\n/a,1",
      ga4Rows: [{ page: "/a", traffic: 1 }],
      ga4RowsAreAiFiltered: true
    }),
    /either a GA4 CSV or GA4 rows/
  );
});
