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
import {
  WebScannerError,
  scanPage,
  scanPages
} from "./web-scanner.mjs";
import {
  AeoFixerError,
  buildAeoFixPlan,
  prepareWordPressFixes
} from "./aeo-fixer.mjs";

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

function failure(error) {
  const message = error instanceof BingWebmasterError ||
    error instanceof WebScannerError ||
    error instanceof AeoFixerError
    ? error.message
    : "The Bing Webmaster request failed unexpectedly.";

  return {
    isError: true,
    content: [{ type: "text", text: message }]
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
    { name: "bing-webmaster", version: "1.2.0" },
    {
      instructions:
        "Bing tools call Bing's public Webmaster API; they do not reproduce the full dashboard URL Inspection SEO/GEO report. For AEO fixes, scan the page, call aeo_plan_page_fixes, read the latest post through a connected WordPress MCP, call aeo_prepare_wordpress_fixes, request approval before updating WordPress, recheck the public page, then submit it to Bing when requested. Never request or reveal API keys."
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
