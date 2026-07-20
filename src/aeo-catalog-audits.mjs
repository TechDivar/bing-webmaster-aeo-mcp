import { load } from "cheerio";

import {
  WebScannerError,
  fetchPageDocument,
  fetchTextResource,
  validatePublicUrl
} from "./web-scanner.mjs";

const DEFAULT_SIMILARITY_THRESHOLD = 0.82;
const MAX_DUPLICATE_URLS = 30;
const MAX_LOCALE_PAGES = 20;
const SHINGLE_SIZE = 5;

export class AeoCatalogAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "AeoCatalogAuditError";
  }
}

function issue(severity, code, message, evidence) {
  return {
    severity,
    code,
    message,
    ...(evidence ? { evidence } : {})
  };
}

function summarize(issues) {
  return {
    errors: issues.filter(item => item.severity === "error").length,
    warnings: issues.filter(item => item.severity === "warning").length,
    notices: issues.filter(item => item.severity === "notice").length,
    total_issues: issues.length
  };
}

function cleanText(value, maxLength = 300) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeComparableUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AeoCatalogAuditError(`Invalid URL: ${String(value).slice(0, 200)}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AeoCatalogAuditError("Catalog audit URLs must use http or https.");
  }
  parsed.hash = "";
  if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.href;
}

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/gi;

function missingLlmsResult(site, llmsTxtUrl, code, message, evidence) {
  const issues = [issue("warning", code, message, evidence)];
  return {
    site_url: site.href,
    llms_txt_url: llmsTxtUrl,
    exists: false,
    summary: summarize(issues),
    issue_codes: [code],
    issues,
    checks: { link_count: 0, links: [] },
    notice:
      "llms.txt is a community proposal, not a ranking or citation guarantee and not a replacement for robots.txt or sitemaps."
  };
}

export async function auditLlmsTxt(
  siteUrl,
  {
    canonicalUrls = [],
    fetchImpl = globalThis.fetch,
    fetchTextImpl = fetchTextResource
  } = {}
) {
  const site = await validatePublicUrl(siteUrl);
  const llmsTxtUrl = new URL("/llms.txt", site.origin).href;

  let resource;
  try {
    resource = await fetchTextImpl(llmsTxtUrl, { fetchImpl });
  } catch (error) {
    const reason = error instanceof WebScannerError
      ? error.message
      : "The file could not be fetched safely.";
    return missingLlmsResult(
      site,
      llmsTxtUrl,
      "llms_txt_unavailable",
      "A valid plain-text or Markdown llms.txt file was not available at the site root.",
      { reason }
    );
  }

  if (resource.context.status < 200 || resource.context.status >= 300) {
    return missingLlmsResult(
      site,
      llmsTxtUrl,
      "llms_txt_missing",
      `No valid llms.txt was found at the site root (HTTP ${resource.context.status}).`,
      { http_status: resource.context.status }
    );
  }

  const rawText = resource.text;
  const links = [...rawText.matchAll(MARKDOWN_LINK_PATTERN)].map(match => ({
    label: cleanText(match[1]),
    url: normalizeComparableUrl(match[2])
  }));
  const issues = [];

  if (!/^#\s+\S+/m.test(rawText)) {
    issues.push(
      issue(
        "warning",
        "llms_txt_missing_h1",
        "llms.txt has no top-level Markdown heading naming the site or project."
      )
    );
  }
  if (!links.length) {
    issues.push(
      issue(
        "warning",
        "llms_txt_no_links",
        "llms.txt contains no absolute Markdown links to useful pages."
      )
    );
  }

  const canonicalSet = new Set(canonicalUrls.map(normalizeComparableUrl));
  if (canonicalSet.size) {
    const linkedSet = new Set(links.map(link => link.url));
    const missing = [...canonicalSet].filter(url => !linkedSet.has(url));
    if (missing.length) {
      issues.push(
        issue(
          "notice",
          "llms_txt_missing_canonical_pages",
          `${missing.length} supplied canonical or hub URL(s) are not listed in llms.txt.`,
          { missing_urls: missing.slice(0, 50) }
        )
      );
    }
  }

  return {
    site_url: site.href,
    llms_txt_url: llmsTxtUrl,
    final_url: resource.context.finalUrl,
    exists: true,
    summary: summarize(issues),
    issue_codes: [...new Set(issues.map(item => item.code))],
    issues,
    checks: {
      has_h1: /^#\s+\S+/m.test(rawText),
      link_count: links.length,
      links: links.slice(0, 100)
    },
    notice:
      "llms.txt is a community proposal, not a ranking or citation guarantee and not a replacement for robots.txt or sitemaps."
  };
}

function extractArticleText(html) {
  const $ = load(html);
  const scope = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body");
  scope.find("script, style, nav, header, footer, aside, noscript").remove();
  return cleanText(scope.text(), 200_000);
}

function textTokens(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(Boolean);
}

function shingleSet(text) {
  const tokens = textTokens(text);
  const shingles = new Set();
  for (let index = 0; index <= tokens.length - SHINGLE_SIZE; index += 1) {
    shingles.add(tokens.slice(index, index + SHINGLE_SIZE).join(" "));
  }

  if (!shingles.size) {
    const compact = text.toLowerCase().replace(/\s+/g, "");
    for (let index = 0; index <= compact.length - 20; index += 1) {
      shingles.add(compact.slice(index, index + 20));
    }
  }
  return shingles;
}

function jaccardSimilarity(first, second) {
  if (!first.size || !second.size) return 0;
  const [smaller, larger] = first.size <= second.size
    ? [first, second]
    : [second, first];
  let intersection = 0;
  for (const value of smaller) {
    if (larger.has(value)) intersection += 1;
  }
  return intersection / (first.size + second.size - intersection);
}

const defaultSleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

export async function checkInternalDuplicates(
  urls,
  {
    fetchImpl = globalThis.fetch,
    fetchPageImpl = fetchPageDocument,
    similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
    delayMs = 500,
    sleepImpl = defaultSleep
  } = {}
) {
  const uniqueUrls = [...new Set(urls.map(normalizeComparableUrl))];
  if (uniqueUrls.length < 2) {
    throw new AeoCatalogAuditError("Provide at least two unique URLs to compare.");
  }
  if (uniqueUrls.length > MAX_DUPLICATE_URLS) {
    throw new AeoCatalogAuditError(`Provide at most ${MAX_DUPLICATE_URLS} URLs per check.`);
  }
  if (similarityThreshold < 0.5 || similarityThreshold > 0.99) {
    throw new AeoCatalogAuditError("similarityThreshold must be between 0.5 and 0.99.");
  }

  const pages = [];
  for (let index = 0; index < uniqueUrls.length; index += 1) {
    const url = uniqueUrls[index];
    if (index > 0 && delayMs > 0) await sleepImpl(delayMs);
    try {
      const document = await fetchPageImpl(url, { fetchImpl });
      if (document.context.status < 200 || document.context.status >= 300) {
        throw new WebScannerError(`The page returned HTTP ${document.context.status}.`);
      }
      const text = extractArticleText(document.html);
      const tokenCount = textTokens(text).length;
      pages.push({
        url,
        word_count: tokenCount,
        character_count: text.length,
        shingles: shingleSet(text),
        comparable: tokenCount >= 50 || text.length >= 300,
        fetch_failed: false
      });
    } catch (error) {
      pages.push({
        url,
        comparable: false,
        fetch_failed: true,
        error: error instanceof WebScannerError
          ? error.message
          : "The page could not be fetched."
      });
    }
  }

  const comparable = pages.filter(page => page.comparable && !page.fetch_failed);
  const duplicatePairs = [];
  for (let first = 0; first < comparable.length; first += 1) {
    for (let second = first + 1; second < comparable.length; second += 1) {
      const similarity = jaccardSimilarity(
        comparable[first].shingles,
        comparable[second].shingles
      );
      if (similarity >= similarityThreshold) {
        duplicatePairs.push({
          url_a: comparable[first].url,
          url_b: comparable[second].url,
          similarity: Math.round(similarity * 1000) / 1000
        });
      }
    }
  }
  duplicatePairs.sort((left, right) => right.similarity - left.similarity);

  return {
    urls_requested: uniqueUrls.length,
    urls_compared: comparable.length,
    urls_failed: pages
      .filter(page => page.fetch_failed)
      .map(({ url, error }) => ({ url, error })),
    urls_too_short: pages
      .filter(page => !page.fetch_failed && !page.comparable)
      .map(({ url, word_count, character_count }) => ({
        url,
        word_count,
        character_count
      })),
    similarity_threshold: similarityThreshold,
    duplicate_pairs: duplicatePairs,
    summary: {
      duplicate_pair_count: duplicatePairs.length,
      review_required: duplicatePairs.length > 0
    },
    notice:
      "Similarity is a heuristic review signal. It does not determine canonical URLs, search-engine deduplication, or which page should be removed."
  };
}

function schemaNodes(value, nodes = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return nodes;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) schemaNodes(item, nodes, seen);
    return nodes;
  }
  nodes.push(value);
  if (value["@graph"]) schemaNodes(value["@graph"], nodes, seen);
  return nodes;
}

function hasSchemaType(node, expectedTypes) {
  const values = Array.isArray(node?.["@type"])
    ? node["@type"]
    : [node?.["@type"]];
  return values.some(value => {
    const shortType = String(value || "").split(/[\/#]/).pop();
    return expectedTypes.includes(shortType);
  });
}

function extractSchemaParity(html) {
  const $ = load(html);
  const nodes = [];
  let invalidJsonLdBlocks = 0;
  $("script[type]").each((_, element) => {
    if (String($(element).attr("type") || "").toLowerCase() !== "application/ld+json") return;
    const raw = $(element).text().trim();
    if (!raw) return;
    try {
      schemaNodes(JSON.parse(raw), nodes);
    } catch {
      invalidJsonLdBlocks += 1;
    }
  });

  const article = nodes.find(node =>
    hasSchemaType(node, ["Article", "BlogPosting", "NewsArticle"])
  );
  const faqPage = nodes.find(node => hasSchemaType(node, ["FAQPage"]));
  return {
    has_article_schema: Boolean(article),
    has_faq_schema: Boolean(faqPage),
    date_published: article?.datePublished || null,
    date_modified: article?.dateModified || null,
    has_headline: Boolean(article?.headline),
    has_author: Boolean(article?.author),
    has_image: Boolean(article?.image),
    invalid_json_ld_blocks: invalidJsonLdBlocks
  };
}

export async function checkMultilangSchemaParity(
  pages,
  {
    fetchImpl = globalThis.fetch,
    fetchPageImpl = fetchPageDocument,
    delayMs = 500,
    sleepImpl = defaultSleep
  } = {}
) {
  if (!Array.isArray(pages) || pages.length < 2 || pages.length > MAX_LOCALE_PAGES) {
    throw new AeoCatalogAuditError(
      `Provide between 2 and ${MAX_LOCALE_PAGES} locale pages for the same article.`
    );
  }
  const locales = pages.map(page => cleanText(page.locale, 20).toLowerCase());
  if (new Set(locales).size !== locales.length) {
    throw new AeoCatalogAuditError("Each locale label must be unique.");
  }

  const results = [];
  for (let index = 0; index < pages.length; index += 1) {
    const locale = locales[index];
    const url = normalizeComparableUrl(pages[index].url);
    if (index > 0 && delayMs > 0) await sleepImpl(delayMs);
    try {
      const document = await fetchPageImpl(url, { fetchImpl });
      if (document.context.status < 200 || document.context.status >= 300) {
        throw new WebScannerError(`The page returned HTTP ${document.context.status}.`);
      }
      results.push({
        locale,
        url,
        ...extractSchemaParity(document.html),
        fetch_failed: false
      });
    } catch (error) {
      results.push({
        locale,
        url,
        fetch_failed: true,
        error: error instanceof WebScannerError
          ? error.message
          : "The page could not be fetched."
      });
    }
  }

  const usable = results.filter(page => !page.fetch_failed);
  const issues = [];
  const withArticle = usable.filter(page => page.has_article_schema);
  const withoutArticle = usable.filter(page => !page.has_article_schema);
  if (withArticle.length && withoutArticle.length) {
    issues.push(
      issue(
        "warning",
        "locale_missing_article_schema",
        `${withoutArticle.length} locale(s) lack Article or BlogPosting schema present in another locale.`,
        { locales: withoutArticle.map(page => page.locale) }
      )
    );
  }

  const withFaq = usable.filter(page => page.has_faq_schema);
  const withoutFaq = usable.filter(page => !page.has_faq_schema);
  if (withFaq.length && withoutFaq.length) {
    issues.push(
      issue(
        "notice",
        "locale_missing_faq_schema",
        `${withoutFaq.length} locale(s) lack FAQPage schema present in another locale.`,
        { locales: withoutFaq.map(page => page.locale) }
      )
    );
  }

  const modifiedDates = usable
    .map(page => ({
      locale: page.locale,
      value: page.date_modified,
      date: page.date_modified ? new Date(page.date_modified) : null
    }))
    .filter(item => item.date && !Number.isNaN(item.date.getTime()));
  if (modifiedDates.length >= 2) {
    const newest = modifiedDates.reduce((left, right) =>
      left.date > right.date ? left : right
    );
    const stale = modifiedDates.filter(item =>
      item.locale !== newest.locale &&
      newest.date.getTime() - item.date.getTime() >= 90 * 24 * 60 * 60 * 1000
    );
    if (stale.length) {
      issues.push(
        issue(
          "notice",
          "locale_freshness_drift",
          `${stale.length} locale(s) have dateModified values at least 90 days behind the freshest locale.`,
          {
            newest_locale: newest.locale,
            newest_date_modified: newest.value,
            stale_locales: stale.map(item => ({
              locale: item.locale,
              date_modified: item.value
            }))
          }
        )
      );
    }
  }

  return {
    locales_requested: pages.length,
    locales_checked: usable.length,
    locales_failed: results
      .filter(page => page.fetch_failed)
      .map(({ locale, url, error }) => ({ locale, url, error })),
    summary: summarize(issues),
    issue_codes: [...new Set(issues.map(item => item.code))],
    issues,
    per_locale: results,
    notice:
      "This compares parity between supplied translations. It does not validate search-engine eligibility or prove that every locale should use identical schema."
  };
}
