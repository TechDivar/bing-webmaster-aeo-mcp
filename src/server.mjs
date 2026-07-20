#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";

import {
  BingWebmasterError,
  callBingApi,
  isUrlWithinSite,
  limitRows
} from "./bing-client.mjs";
import { submitBingUrlBatch } from "./bing-submission.mjs";
import {
  IndexNowError,
  submitIndexNowUrls,
  validateIndexNowKey
} from "./indexnow-client.mjs";
import {
  WebScannerError,
  fetchPageDocument,
  scanPage,
  scanPages,
  validatePublicUrl
} from "./web-scanner.mjs";
import {
  AeoFixerError,
  buildAeoFixPlan,
  prepareWordPressFixes
} from "./aeo-fixer.mjs";
import {
  AeoCatalogAuditError,
  auditLlmsTxt,
  checkInternalDuplicates,
  checkMultilangSchemaParity
} from "./aeo-catalog-audits.mjs";
import {
  AeoTrafficOpportunityError,
  findAiTrafficOpportunities
} from "./aeo-traffic-opportunities.mjs";
import {
  AiSearchAuditError,
  analyzeAiReadability,
  analyzeCitationReadiness,
  analyzeEntityCoverage,
  analyzeIntentCoverage,
  auditAiSearch,
  auditFreshness,
  auditInternalLinks,
  buildPageModel,
  comparePageModels,
  extractCitableChunks,
  generateAiOverviewPreview,
  prepareAeoAutofix,
  recommendSchemas
} from "./ai-search-auditor.mjs";

const siteUrlSchema = z
  .url()
  .refine(value => /^https?:\/\//i.test(value), "Use an http or https site URL")
  .describe("Exact verified site URL returned by bing_list_sites");

const webUrlSchema = z
  .url()
  .refine(value => /^https?:\/\//i.test(value), "Use an http or https URL");

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .optional()
  .default(100)
  .describe("Maximum rows to return, from 1 to 1000");

const signedPageSchema = z
  .number()
  .int()
  .min(0)
  .max(32_767)
  .optional()
  .default(0)
  .describe("Zero-based API result page");

const unsignedPageSchema = z
  .number()
  .int()
  .min(0)
  .max(65_535)
  .optional()
  .default(0)
  .describe("Zero-based API result page");

const keywordSchema = z.string().trim().min(1).max(500);
const countrySchema = z.string().trim().min(1).max(20);
const languageSchema = z.string().trim().min(1).max(50);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format");
const submissionUrlSchema = z.string().trim().max(4096);
const changeTypeSchema = z.enum(["added", "updated", "deleted"]);

const entitySchema = z.string().min(1).max(150);
const intentSchema = z.enum([
  "informational",
  "commercial",
  "comparison",
  "troubleshooting",
  "pricing",
  "transactional"
]);
const candidateLinkSchema = z.object({
  url: webUrlSchema.describe("Real internal page URL"),
  title: z.string().min(1).max(300),
  keywords: z.array(z.string().min(1).max(100)).max(20).optional().default([])
});
const auditOptionsSchema = {
  primary_entity: entitySchema.optional(),
  related_entities: z.array(entitySchema).max(100).optional().default([]),
  expected_intents: z.array(intentSchema).max(6).optional().default([]),
  candidate_links: z.array(candidateLinkSchema).max(500).optional().default([]),
  current_year: z.number().int().min(1900).max(2200).optional()
};

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};

function success(label, data) {
  return {
    content: [
      {
        type: "text",
        text: `${label}\n${JSON.stringify(data, null, 2)}`
      }
    ]
  };
}

function structuredSuccess(label, data) {
  return {
    ...success(label, data),
    structuredContent: data
  };
}

function failure(error) {
  const message = error instanceof BingWebmasterError ||
    error instanceof IndexNowError ||
    error instanceof WebScannerError ||
    error instanceof AeoFixerError ||
    error instanceof AeoCatalogAuditError ||
    error instanceof AeoTrafficOpportunityError ||
    error instanceof AiSearchAuditError
    ? error.message
    : "The Bing Webmaster request failed unexpectedly.";

  return {
    isError: true,
    content: [{ type: "text", text: message }]
  };
}

async function getPageModel(url) {
  const document = await fetchPageDocument(url);
  if (document.scan.http.status < 200 || document.scan.http.status >= 300) {
    throw new AiSearchAuditError(
      `The page returned HTTP ${document.scan.http.status}; AI-search content checks were skipped.`
    );
  }
  return {
    model: buildPageModel(document.html, document.scan.final_url),
    technical_scan: document.scan
  };
}

function normalizedAuditOptions(args) {
  return {
    primaryEntity: args.primary_entity,
    relatedEntities: args.related_entities || [],
    expectedIntents: args.expected_intents || [],
    candidateLinks: args.candidate_links || [],
    currentYear: args.current_year
  };
}

function safeHandler(handler) {
  return async args => {
    try {
      return await handler(args || {});
    } catch (error) {
      return failure(error);
    }
  };
}

function registerLimitedReadTool(server, name, title, description, method) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: { site_url: siteUrlSchema, limit: limitSchema },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url, limit }) => {
      const data = await callBingApi(method, { params: { siteUrl: site_url } });
      return success(title, limitRows(data, limit));
    })
  );
}

function registerUrlReadTool(server, name, title, description, method) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: {
        site_url: siteUrlSchema,
        url: webUrlSchema.describe("Exact live page URL")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url, url }) => {
      const data = await callBingApi(method, {
        params: { siteUrl: site_url, url }
      });
      return success(title, data);
    })
  );
}

export function createServer() {
  const server = new McpServer(
    { name: "bing-webmaster-aeo", version: "2.3.0" },
    {
      instructions:
        "Bing tools call Bing's public Webmaster API; they do not reproduce the full dashboard URL Inspection SEO/GEO report. The AI-traffic opportunity tool compares Bing's top-page data with an aggregated GA4 CSV or aggregated GA4 rows and never requires a Google credential. IndexNow uses a separate client and local key. AI-search audits are transparent heuristics, not predictions or guarantees about citations by ChatGPT, Copilot, Google, or Bing. For AEO fixes, audit the page, read the latest post through a connected WordPress MCP, prepare an exact diff, request approval before updating WordPress, recheck the public page, then submit it when requested. Never request or reveal Bing API keys or IndexNow keys."
    }
  );

  server.registerTool(
    "bing_list_sites",
    {
      title: "List Bing sites",
      description: "List sites available to the connected Bing Webmaster account. Verification codes are removed from the result.",
      annotations: readOnlyAnnotations
    },
    safeHandler(async () => {
      const data = await callBingApi("GetUserSites");
      const sites = Array.isArray(data)
        ? data.map(site => ({ Url: site.Url, IsVerified: site.IsVerified }))
        : data;
      return success("Bing Webmaster sites", sites);
    })
  );

  registerLimitedReadTool(
    server,
    "bing_get_query_stats",
    "Top Bing queries",
    "Get clicks, impressions, and average positions for top search queries.",
    "GetQueryStats"
  );

  registerLimitedReadTool(
    server,
    "bing_get_page_stats",
    "Top Bing pages",
    "Get clicks, impressions, and average positions for top pages.",
    "GetPageStats"
  );

  server.registerTool(
    "aeo_find_ai_traffic_opportunities",
    {
      title: "Find high-impression, low-AI-traffic pages",
      description: "Pull Bing's official top-page statistics and match them with an aggregated GA4 CSV or GA4 rows. Returns pages with high Bing impressions but low identifiable AI-referral traffic. GA4 data stays in this local MCP process.",
      inputSchema: {
        site_url: siteUrlSchema,
        ga4_csv: z
          .string()
          .max(2 * 1024 * 1024)
          .optional()
          .describe("Optional GA4 CSV text with a page column, a traffic metric such as Sessions, and normally Session source or Page referrer"),
        ga4_rows: z
          .array(
            z.object({
              page: z
                .string()
                .trim()
                .min(1)
                .max(4096)
                .describe("Page path such as /blog/example/ or a same-site absolute URL"),
              source: z
                .string()
                .trim()
                .max(500)
                .optional()
                .describe("Aggregated traffic source or referrer, such as chatgpt.com"),
              traffic: z
                .number()
                .nonnegative()
                .describe("Aggregated sessions, users, or views for this page and source")
            })
          )
          .max(10_000)
          .optional()
          .default([])
          .describe("Optional aggregated GA4 rows; use this instead of ga4_csv"),
        ga4_rows_are_ai_filtered: z
          .boolean()
          .optional()
          .default(false)
          .describe("Set true only when every supplied GA4 row is already filtered to AI-referral traffic"),
        ga4_metric_name: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .default("Sessions")
          .describe("Metric label for structured GA4 rows, such as Sessions"),
        additional_ai_sources: z
          .array(z.string().trim().min(1).max(200))
          .max(50)
          .optional()
          .default([])
          .describe("Optional extra AI referral domains to recognize"),
        minimum_bing_impressions: z
          .number()
          .nonnegative()
          .optional()
          .default(1000)
          .describe("Minimum Bing impressions for a page to count as high visibility"),
        maximum_ai_traffic: z
          .number()
          .nonnegative()
          .optional()
          .default(5)
          .describe("Maximum GA4 AI-referral traffic value for a page to count as low AI traffic"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(100)
          .describe("Maximum opportunity pages to return")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async args => {
      const bingRows = await callBingApi("GetPageStats", {
        params: { siteUrl: args.site_url }
      });
      const result = findAiTrafficOpportunities({
        siteUrl: args.site_url,
        bingRows,
        ga4Csv: args.ga4_csv,
        ga4Rows: args.ga4_rows,
        ga4RowsAreAiFiltered: args.ga4_rows_are_ai_filtered,
        ga4MetricName: args.ga4_metric_name,
        additionalAiSources: args.additional_ai_sources,
        minimumBingImpressions: args.minimum_bing_impressions,
        maximumAiTraffic: args.maximum_ai_traffic,
        limit: args.limit
      });
      return structuredSuccess("Bing-to-AI traffic opportunities", result);
    })
  );

  registerLimitedReadTool(
    server,
    "bing_get_rank_and_traffic_stats",
    "Bing rank and traffic",
    "Get overall Bing rank and traffic statistics for a verified site.",
    "GetRankAndTrafficStats"
  );

  registerLimitedReadTool(
    server,
    "bing_get_crawl_stats",
    "Bing crawl statistics",
    "Get Bing crawl statistics for the site, typically covering recent months.",
    "GetCrawlStats"
  );

  registerLimitedReadTool(
    server,
    "bing_get_crawl_issues",
    "Bing crawl issues",
    "Get crawling problems Bing has found for the site.",
    "GetCrawlIssues"
  );

  registerLimitedReadTool(
    server,
    "bing_get_sitemaps",
    "Bing sitemaps",
    "Get submitted sitemap and feed status from Bing Webmaster.",
    "GetFeeds"
  );

  registerUrlReadTool(
    server,
    "bing_get_fetched_url_details",
    "Bing fetched URL details",
    "Get Bing's stored fetch details for one URL. This is not the full URL Inspection SEO/GEO report shown in Bing's dashboard.",
    "GetFetchedUrlDetails"
  );

  registerUrlReadTool(
    server,
    "bing_get_url_traffic_info",
    "Bing URL traffic information",
    "Get Bing index traffic details for one URL.",
    "GetUrlTrafficInfo"
  );

  server.registerTool(
    "bing_get_link_counts",
    {
      title: "Bing inbound link counts",
      description: "Get one official Bing result page of site URLs and their inbound-link counts.",
      inputSchema: {
        site_url: siteUrlSchema,
        page: signedPageSchema
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url, page }) => {
      const data = await callBingApi("GetLinkCounts", {
        params: { siteUrl: site_url, page }
      });
      return success("Bing inbound link counts", data);
    })
  );

  server.registerTool(
    "bing_get_url_links",
    {
      title: "Bing inbound links for URL",
      description: "Get one official Bing result page of inbound links and anchor text for a site URL.",
      inputSchema: {
        site_url: siteUrlSchema,
        url: webUrlSchema.describe("Site URL whose inbound links should be returned"),
        page: signedPageSchema
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url, url, page }) => {
      const data = await callBingApi("GetUrlLinks", {
        params: { siteUrl: site_url, link: url, page }
      });
      return success("Bing inbound links for URL", data);
    })
  );

  server.registerTool(
    "bing_get_keyword_stats",
    {
      title: "Bing keyword historical statistics",
      description: "Get Bing's historical keyword statistics for a query, country, and language.",
      inputSchema: {
        query: keywordSchema,
        country: countrySchema,
        language: languageSchema,
        limit: limitSchema
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ query, country, language, limit }) => {
      const data = await callBingApi("GetKeywordStats", {
        params: { q: query, country, language }
      });
      return success("Bing keyword historical statistics", limitRows(data, limit));
    })
  );

  server.registerTool(
    "bing_get_related_keywords",
    {
      title: "Bing related keywords",
      description: "Get related-keyword impressions for the exact query, country, language, and date range supported by Bing's API.",
      inputSchema: {
        query: keywordSchema,
        country: countrySchema,
        language: languageSchema,
        start_date: dateSchema,
        end_date: dateSchema,
        limit: limitSchema
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ query, country, language, start_date, end_date, limit }) => {
      if (start_date > end_date) {
        throw new BingWebmasterError("start_date must be on or before end_date.");
      }
      const data = await callBingApi("GetRelatedKeywords", {
        params: {
          q: query,
          country,
          language,
          startDate: start_date,
          endDate: end_date
        }
      });
      return success("Bing related keywords", limitRows(data, limit));
    })
  );

  server.registerTool(
    "bing_get_query_page_stats",
    {
      title: "Bing pages for query",
      description: "Get Bing traffic statistics for pages associated with one search query.",
      inputSchema: {
        site_url: siteUrlSchema,
        query: keywordSchema,
        limit: limitSchema
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url, query, limit }) => {
      const data = await callBingApi("GetQueryPageStats", {
        params: { siteUrl: site_url, query }
      });
      return success("Bing pages for query", limitRows(data, limit));
    })
  );

  server.registerTool(
    "bing_get_query_page_detail_stats",
    {
      title: "Bing query and page detail statistics",
      description: "Get dated clicks, impressions, and position details for one query and one page.",
      inputSchema: {
        site_url: siteUrlSchema,
        query: keywordSchema,
        page_url: webUrlSchema,
        limit: limitSchema
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url, query, page_url, limit }) => {
      const data = await callBingApi("GetQueryPageDetailStats", {
        params: { siteUrl: site_url, query, page: page_url }
      });
      return success("Bing query and page detail statistics", limitRows(data, limit));
    })
  );

  registerUrlReadTool(
    server,
    "bing_get_url_info",
    "Bing URL index information",
    "Get Bing's index details for one page, including only fields returned by the official GetUrlInfo method.",
    "GetUrlInfo"
  );

  server.registerTool(
    "bing_get_children_url_traffic_info",
    {
      title: "Bing child URL traffic information",
      description: "Get one official Bing result page of index traffic details for URLs under a directory.",
      inputSchema: {
        site_url: siteUrlSchema,
        url: webUrlSchema.describe("Directory URL whose child traffic should be returned"),
        page: unsignedPageSchema,
        limit: limitSchema
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url, url, page, limit }) => {
      const data = await callBingApi("GetChildrenUrlTrafficInfo", {
        params: { siteUrl: site_url, url, page }
      });
      return success("Bing child URL traffic information", limitRows(data, limit));
    })
  );

  server.registerTool(
    "seo_scan_page",
    {
      title: "Scan a live webpage for SEO issues",
      description: "Independently fetch and scan one public webpage for HTTP, title, meta description, H1, image alt, canonical, robots, language, and JSON-LD problems. This does not use Bing's API.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL to scan")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url }) => {
      const result = await scanPage(url);
      return success("Live webpage SEO scan", result);
    })
  );

  server.registerTool(
    "seo_scan_pages",
    {
      title: "Scan multiple live webpages for SEO issues",
      description: "Independently scan up to 20 public webpages and return each affected URL with exact issue codes and evidence.",
      inputSchema: {
        urls: z
          .array(webUrlSchema)
          .min(1)
          .max(20)
          .describe("One to 20 public webpage URLs")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ urls }) => {
      const results = await scanPages(urls);
      const summary = {
        pages_requested: [...new Set(urls)].length,
        pages_scanned: results.filter(result => !result.scan_failed).length,
        pages_failed: results.filter(result => result.scan_failed).length,
        pages_with_errors: results.filter(result => result.summary?.errors > 0).length
      };
      return success("Live webpage SEO scans", { summary, results });
    })
  );

  server.registerTool(
    "seo_recheck_page",
    {
      title: "Recheck a webpage after SEO fixes",
      description: "Rescan one live page after a WordPress or code fix and report whether specified issue codes are gone.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL to recheck"),
        expected_fixed_issue_codes: z
          .array(z.string().min(1))
          .min(1)
          .max(30)
          .describe("Issue codes expected to be fixed, such as multiple_h1 or image_missing_alt")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url, expected_fixed_issue_codes }) => {
      const scan = await scanPage(url);
      const currentCodes = new Set(scan.issue_codes);
      const expectedCodes = [...new Set(expected_fixed_issue_codes)];
      const remaining = expectedCodes.filter(code => currentCodes.has(code));
      const fixed = expectedCodes.filter(code => !currentCodes.has(code));
      return success("Live webpage SEO recheck", {
        all_expected_issues_fixed: remaining.length === 0,
        fixed_issue_codes: fixed,
        remaining_issue_codes: remaining,
        scan
      });
    })
  );

  server.registerTool(
    "aeo_plan_page_fixes",
    {
      title: "Plan AEO fixes for a live webpage",
      description: "Scan one live page and turn every detected issue into an exact fix plan, including whether WordPress content, SEO metadata, schema, the theme, or manual review is required.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL to scan and plan fixes for")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url }) => {
      const scan = await scanPage(url);
      return success("AEO page fix plan", {
        scan,
        plan: buildAeoFixPlan(scan)
      });
    })
  );

  server.registerTool(
    "aeo_prepare_wordpress_fixes",
    {
      title: "Prepare corrected WordPress content",
      description: "Prepare, but do not publish, corrected WordPress post HTML for duplicate content H1s and missing or empty image alt text. Returns exact changes and unresolved items for review before the connected WordPress MCP updates the post.",
      inputSchema: {
        page_url: webUrlSchema.describe("Live WordPress page URL"),
        content_html: z.string().max(2 * 1024 * 1024).describe("Latest WordPress post body HTML"),
        issue_codes: z
          .array(z.string().min(1))
          .min(1)
          .max(30)
          .describe("Issue codes to fix, such as multiple_h1 or image_missing_alt"),
        image_alt_texts: z
          .array(
            z.object({
              image_src: webUrlSchema.describe("Affected image URL from the scan evidence"),
              alt_text: z.string().min(1).max(300).describe("Concise meaningful alt text")
            })
          )
          .max(100)
          .optional()
          .default([]),
        theme_renders_title_h1: z
          .boolean()
          .optional()
          .default(false)
          .describe("Set true only after confirming the WordPress theme already renders the post title as the page H1")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async args => {
      const result = prepareWordPressFixes({
        contentHtml: args.content_html,
        pageUrl: args.page_url,
        issueCodes: args.issue_codes,
        imageAltTexts: args.image_alt_texts,
        themeRendersTitleH1: args.theme_renders_title_h1
      });
      return success("Prepared WordPress AEO fixes", result);
    })
  );

  server.registerTool(
    "aeo_llms_txt_audit",
    {
      title: "Audit llms.txt",
      description: "Safely check for a root-level llms.txt Markdown file, inspect its links and heading, and compare it with supplied canonical or hub URLs. llms.txt is a community proposal, not a ranking guarantee.",
      inputSchema: {
        site_url: webUrlSchema.describe("Public site URL, such as https://example.com"),
        canonical_urls: z
          .array(webUrlSchema)
          .max(50)
          .optional()
          .default([])
          .describe("Optional canonical or hub URLs that should appear in llms.txt")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url, canonical_urls }) => {
      const result = await auditLlmsTxt(site_url, {
        canonicalUrls: canonical_urls
      });
      return success("llms.txt audit", result);
    })
  );

  server.registerTool(
    "aeo_internal_duplicate_check",
    {
      title: "Check internal near-duplicate content",
      description: "Safely fetch 2 to 30 public pages and flag highly similar article bodies using word-shingle similarity. Results are review signals, not canonicalization decisions.",
      inputSchema: {
        urls: z
          .array(webUrlSchema)
          .min(2)
          .max(30)
          .describe("Two to 30 published internal page URLs"),
        similarity_threshold: z
          .number()
          .min(0.5)
          .max(0.99)
          .optional()
          .default(0.82)
          .describe("Similarity level from 0.5 to 0.99 used to flag a pair")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ urls, similarity_threshold }) => {
      const result = await checkInternalDuplicates(urls, {
        similarityThreshold: similarity_threshold
      });
      return success("Internal near-duplicate check", result);
    })
  );

  server.registerTool(
    "aeo_multilang_schema_parity",
    {
      title: "Check multilingual schema and freshness parity",
      description: "Compare Article and FAQPage JSON-LD plus dateModified freshness across 2 to 20 translated versions of the same article. Supports common @graph markup.",
      inputSchema: {
        pages: z
          .array(
            z.object({
              locale: z.string().trim().min(1).max(20),
              url: webUrlSchema.describe("Published page URL for this locale")
            })
          )
          .min(2)
          .max(20)
          .describe("Translated versions of the same article")
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ pages }) => {
      const result = await checkMultilangSchemaParity(pages);
      return success("Multilingual schema and freshness parity", result);
    })
  );

  server.registerTool(
    "aeo_audit_page",
    {
      title: "Complete AI-search page audit",
      description: "Run AI readability, entity coverage, citation readiness, intent coverage, an extractive answer preview, citable chunks, internal linking, schema, and freshness checks on one public page.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL"),
        ...auditOptionsSchema
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async args => {
      const { model, technical_scan } = await getPageModel(args.url);
      return success("Complete AI-search page audit", {
        technical_scan,
        audit: auditAiSearch(model, normalizedAuditOptions(args))
      });
    })
  );

  server.registerTool(
    "aeo_ai_readability_audit",
    {
      title: "AI readability audit",
      description: "Check whether a page gives a focused direct answer, clear definition, useful heading structure, readable sections, and restrained marketing language.",
      inputSchema: { url: webUrlSchema.describe("Public webpage URL") },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url }) => {
      const { model } = await getPageModel(url);
      return success("AI readability audit", analyzeAiReadability(model));
    })
  );

  server.registerTool(
    "aeo_entity_coverage",
    {
      title: "Entity coverage audit",
      description: "Check a primary entity and an explicit list of related entities against the page. It also returns heuristically detected entities without inventing missing ones.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL"),
        primary_entity: entitySchema.optional(),
        related_entities: z.array(entitySchema).max(100).optional().default([])
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async args => {
      const { model } = await getPageModel(args.url);
      return success("Entity coverage audit", analyzeEntityCoverage(model, {
        primaryEntity: args.primary_entity,
        relatedEntities: args.related_entities
      }));
    })
  );

  server.registerTool(
    "aeo_citation_readiness",
    {
      title: "Citation readiness audit",
      description: "Score whether the page contains concise, structured, well-supported passages that are easy for humans and AI systems to extract. This is not a citation guarantee.",
      inputSchema: { url: webUrlSchema.describe("Public webpage URL") },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url }) => {
      const { model } = await getPageModel(url);
      return success("Citation readiness audit", analyzeCitationReadiness(model));
    })
  );

  server.registerTool(
    "aeo_intent_coverage",
    {
      title: "Search intent coverage",
      description: "Detect informational, commercial, comparison, troubleshooting, pricing, and transactional intent signals and report any expected intents that are missing.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL"),
        expected_intents: z.array(intentSchema).max(6).optional().default([])
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url, expected_intents }) => {
      const { model } = await getPageModel(url);
      return success("Search intent coverage", analyzeIntentCoverage(model, expected_intents));
    })
  );

  server.registerTool(
    "aeo_compare_pages",
    {
      title: "Competitor topic gap",
      description: "Compare one page with up to five public competitor pages and find heading topics competitors cover that the page does not. It does not copy competitor content.",
      inputSchema: {
        url: webUrlSchema.describe("Your public webpage URL"),
        competitor_urls: z.array(webUrlSchema).min(1).max(5)
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url, competitor_urls }) => {
      const page = (await getPageModel(url)).model;
      const competitors = [];
      for (const competitorUrl of [...new Set(competitor_urls)]) {
        competitors.push((await getPageModel(competitorUrl)).model);
      }
      return success("Competitor topic gap", comparePageModels(page, competitors));
    })
  );

  server.registerTool(
    "aeo_ai_overview_preview",
    {
      title: "Page-only AI answer preview",
      description: "Build an extractive answer using only passages already on the page and report confidence based on page structure. It does not simulate a proprietary AI platform.",
      inputSchema: { url: webUrlSchema.describe("Public webpage URL") },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url }) => {
      const { model } = await getPageModel(url);
      return success("Page-only AI answer preview", generateAiOverviewPreview(model));
    })
  );

  server.registerTool(
    "aeo_extract_citable_chunks",
    {
      title: "Extract citable chunks",
      description: "Find concise standalone definitions and factual passages on a page and explain a transparent heuristic score for each.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL"),
        limit: z.number().int().min(1).max(50).optional().default(15)
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url, limit }) => {
      const { model } = await getPageModel(url);
      return success("Citable page chunks", extractCitableChunks(model, limit));
    })
  );

  server.registerTool(
    "aeo_internal_link_opportunities",
    {
      title: "Internal link opportunities",
      description: "Audit existing internal links and match page topics to a supplied inventory of real internal URLs. It never invents destination URLs.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL"),
        candidate_links: z.array(candidateLinkSchema).max(500).optional().default([])
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url, candidate_links }) => {
      const { model } = await getPageModel(url);
      return success("Internal link opportunities", auditInternalLinks(model, candidate_links));
    })
  );

  server.registerTool(
    "aeo_schema_recommendations",
    {
      title: "Schema audit and recommendations",
      description: "Validate JSON-LD syntax, list existing schema types, and assess whether Article, BreadcrumbList, FAQPage, HowTo, Product, or Review markup fits the visible page.",
      inputSchema: { url: webUrlSchema.describe("Public webpage URL") },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url }) => {
      const { model } = await getPageModel(url);
      return success("Schema audit and recommendations", recommendSchemas(model));
    })
  );

  server.registerTool(
    "aeo_freshness_audit",
    {
      title: "Content freshness audit",
      description: "Flag older years, relative time claims, pricing or limits, and dated screenshots for human verification. It does not declare flagged content incorrect.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL"),
        current_year: z.number().int().min(1900).max(2200).optional()
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ url, current_year }) => {
      const { model } = await getPageModel(url);
      return success("Content freshness audit", auditFreshness(model, current_year));
    })
  );

  server.registerTool(
    "aeo_autofix_page",
    {
      title: "Prepare an approval-gated AEO autofix",
      description: "Scan and audit a public page, then optionally apply exact caller-supplied replacements to the latest WordPress content in memory. Returns a diff and always requires approval; it never publishes.",
      inputSchema: {
        url: webUrlSchema.describe("Public webpage URL"),
        ...auditOptionsSchema,
        content_html: z.string().max(2 * 1024 * 1024).optional().describe("Latest WordPress post body HTML"),
        proposed_changes: z.array(z.object({
          find_html: z.string().min(1).max(200_000).describe("Exact unique HTML fragment from the latest post body"),
          replace_html: z.string().max(200_000).describe("Approved replacement HTML fragment"),
          reason: z.string().min(1).max(300)
        })).max(20).optional().default([])
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async args => {
      const { model, technical_scan } = await getPageModel(args.url);
      const audit = auditAiSearch(model, normalizedAuditOptions(args));
      const prepared_fix = prepareAeoAutofix({
        contentHtml: args.content_html,
        proposedChanges: args.proposed_changes
      });
      return success("Approval-gated AEO autofix package", {
        page_url: model.page_url,
        technical_scan,
        audit,
        prepared_fix
      });
    })
  );

  server.registerTool(
    "bing_get_page_query_stats",
    {
      title: "Queries for a Bing page",
      description: "Get search-query statistics for one specific page.",
      inputSchema: {
        site_url: siteUrlSchema,
        page_url: webUrlSchema.describe("Exact page URL"),
        limit: limitSchema
      },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url, page_url, limit }) => {
      const data = await callBingApi("GetPageQueryStats", {
        params: { siteUrl: site_url, page: page_url }
      });
      return success("Bing queries for page", limitRows(data, limit));
    })
  );

  server.registerTool(
    "bing_get_url_submission_quota",
    {
      title: "Bing URL submission quota",
      description: "Check how many URL submissions remain before submitting URLs.",
      inputSchema: { site_url: siteUrlSchema },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url }) => {
      const data = await callBingApi("GetUrlSubmissionQuota", {
        params: { siteUrl: site_url }
      });
      return success("Bing URL submission quota", data);
    })
  );

  server.registerTool(
    "bing_submit_url",
    {
      title: "Submit URL to Bing",
      description: "Submit one page URL to Bing for crawling. This uses the account's submission quota.",
      inputSchema: {
        site_url: siteUrlSchema,
        url: webUrlSchema.describe("Page URL to submit")
      },
      annotations: writeAnnotations
    },
    safeHandler(async ({ site_url, url }) => {
      await validatePublicUrl(site_url);
      await validatePublicUrl(url);
      if (!isUrlWithinSite(site_url, url)) {
        throw new BingWebmasterError(
          "The submitted URL must belong to the verified site's domain."
        );
      }

      await callBingApi("SubmitUrl", {
        httpMethod: "POST",
        body: { siteUrl: site_url, url }
      });
      return success("URL submitted to Bing", { site_url, url, submitted: true });
    })
  );

  server.registerTool(
    "bing_submit_url_batch",
    {
      title: "Submit a URL batch to Bing",
      description: "Validate and submit up to 500 same-site public URLs through Bing's documented SubmitUrlbatch route. The remaining daily and monthly quota is checked first.",
      inputSchema: {
        site_url: siteUrlSchema,
        urls: z
          .array(submissionUrlSchema)
          .min(1)
          .max(500)
          .describe("One to 500 URLs belonging to the configured Bing site")
      },
      annotations: writeAnnotations
    },
    safeHandler(async ({ site_url, urls }) => {
      const result = await submitBingUrlBatch({ siteUrl: site_url, urls });
      return structuredSuccess("Bing URL batch submission", result);
    })
  );

  server.registerTool(
    "bing_submit_sitemap",
    {
      title: "Submit sitemap to Bing",
      description: "Submit a sitemap or feed URL to Bing Webmaster.",
      inputSchema: {
        site_url: siteUrlSchema,
        sitemap_url: webUrlSchema.describe("Sitemap or feed URL to submit")
      },
      annotations: writeAnnotations
    },
    safeHandler(async ({ site_url, sitemap_url }) => {
      await validatePublicUrl(site_url);
      await validatePublicUrl(sitemap_url);
      if (!isUrlWithinSite(site_url, sitemap_url)) {
        throw new BingWebmasterError(
          "The sitemap URL must belong to the verified site's domain."
        );
      }

      await callBingApi("SubmitFeed", {
        httpMethod: "POST",
        body: { siteUrl: site_url, feedUrl: sitemap_url }
      });
      return success("Sitemap submitted to Bing", {
        site_url,
        sitemap_url,
        submitted: true
      });
    })
  );

  server.registerTool(
    "indexnow_validate_key",
    {
      title: "Validate IndexNow key setup",
      description: "Check that the locally configured IndexNow key file is publicly accessible, contains the configured key, and remains on the configured site's host. The key is never returned.",
      inputSchema: { site_url: siteUrlSchema },
      annotations: readOnlyAnnotations
    },
    safeHandler(async ({ site_url }) => {
      const result = await validateIndexNowKey({ siteUrl: site_url });
      return structuredSuccess("IndexNow key validation", result);
    })
  );

  server.registerTool(
    "indexnow_submit_url",
    {
      title: "Submit one URL through IndexNow",
      description: "Validate the same-host key file and notify IndexNow about one added, updated, or deleted public URL. This does not guarantee crawling or indexing.",
      inputSchema: {
        site_url: siteUrlSchema,
        url: submissionUrlSchema,
        change_type: changeTypeSchema.optional().default("updated")
      },
      annotations: writeAnnotations
    },
    safeHandler(async ({ site_url, url, change_type }) => {
      const result = await submitIndexNowUrls({
        siteUrl: site_url,
        entries: [{ url, changeType: change_type }]
      });
      return structuredSuccess("IndexNow URL submission", result);
    })
  );

  server.registerTool(
    "indexnow_submit_urls",
    {
      title: "Submit URL changes through IndexNow",
      description: "Validate the same-host key file and notify IndexNow about up to 10,000 added, updated, or deleted public URLs on the configured host. This does not guarantee crawling or indexing.",
      inputSchema: {
        site_url: siteUrlSchema,
        urls: z
          .array(
            z.object({
              url: submissionUrlSchema,
              change_type: changeTypeSchema.optional().default("updated")
            })
          )
          .min(1)
          .max(10_000)
      },
      annotations: writeAnnotations
    },
    safeHandler(async ({ site_url, urls }) => {
      const result = await submitIndexNowUrls({
        siteUrl: site_url,
        entries: urls.map(item => ({
          url: item.url,
          changeType: item.change_type
        }))
      });
      return structuredSuccess("IndexNow URL submissions", result);
    })
  );

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Bing Webmaster MCP failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
