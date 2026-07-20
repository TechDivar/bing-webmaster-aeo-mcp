import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { load } from "cheerio";

const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class WebScannerError extends Error {
  constructor(message) {
    super(message);
    this.name = "WebScannerError";
  }
}

function isBlockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => part < 0 || part > 255)) return true;
  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("2001:db8:")) return true;

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isBlockedIpv4(mappedIpv4) : false;
}

export function isBlockedIp(address) {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

export async function validatePublicUrl(urlValue) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new WebScannerError("Enter a valid webpage URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new WebScannerError("Only public http and https webpages can be scanned.");
  }
  if (parsed.username || parsed.password) {
    throw new WebScannerError("URLs containing usernames or passwords cannot be scanned.");
  }
  if (parsed.port && !["80", "443"].includes(parsed.port)) {
    throw new WebScannerError("Only standard public web ports 80 and 443 can be scanned.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new WebScannerError("Local or private network addresses cannot be scanned.");
  }

  const directIpVersion = isIP(hostname);
  if (directIpVersion && isBlockedIp(hostname)) {
    throw new WebScannerError("Local or private network addresses cannot be scanned.");
  }

  if (!directIpVersion) {
    let addresses;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new WebScannerError(`Could not resolve the webpage host: ${hostname}`);
    }

    if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
      throw new WebScannerError("The webpage resolved to a local or private network address.");
    }
  }

  return parsed;
}

function cleanText(value, maxLength = 300) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function cleanHtml(value, maxLength = 500) {
  return cleanText(value, maxLength);
}

function absoluteUrl(value, baseUrl) {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

function pageIssue(severity, code, message, evidence) {
  return {
    severity,
    code,
    message,
    ...(evidence ? { evidence } : {})
  };
}

function elementsWithName($, selector, attributeName, expectedValue) {
  return $(selector).filter((_, element) =>
    String($(element).attr(attributeName) || "").toLowerCase() === expectedValue
  );
}

export function analyzeHtml(
  html,
  {
    requestedUrl = "https://example.com/",
    finalUrl = requestedUrl,
    status = 200,
    statusText = "OK",
    contentType = "text/html",
    xRobotsTag = null,
    scannedAt = new Date().toISOString()
  } = {}
) {
  const $ = load(html);
  const issues = [];

  if (status < 200 || status >= 300) {
    issues.push(
      pageIssue("error", "http_status_error", `The page returned HTTP ${status}.`, {
        status,
        status_text: statusText
      })
    );
  }

  if (requestedUrl !== finalUrl) {
    issues.push(
      pageIssue("notice", "redirected_url", "The requested URL redirected.", {
        requested_url: requestedUrl,
        final_url: finalUrl
      })
    );
  }

  const titles = $("head title");
  const titleValues = titles.map((_, element) => cleanText($(element).text())).get();
  if (titles.length === 0) {
    issues.push(pageIssue("error", "missing_title", "The page has no title element."));
  } else if (titles.length > 1) {
    issues.push(
      pageIssue("error", "multiple_titles", `The page has ${titles.length} title elements.`, {
        titles: titleValues
      })
    );
  }
  if (titles.length > 0 && titleValues.some(value => !value)) {
    issues.push(pageIssue("error", "empty_title", "A title element is empty."));
  }

  const descriptions = elementsWithName($, "meta[name]", "name", "description");
  const descriptionValues = descriptions
    .map((_, element) => cleanText($(element).attr("content")))
    .get();
  if (descriptions.length === 0) {
    issues.push(
      pageIssue("warning", "missing_meta_description", "The page has no meta description.")
    );
  } else if (descriptions.length > 1) {
    issues.push(
      pageIssue(
        "warning",
        "multiple_meta_descriptions",
        `The page has ${descriptions.length} meta descriptions.`,
        { descriptions: descriptionValues }
      )
    );
  }
  if (descriptions.length > 0 && descriptionValues.some(value => !value)) {
    issues.push(
      pageIssue("warning", "empty_meta_description", "A meta description is empty.")
    );
  }

  const h1Elements = $("h1");
  const h1Evidence = h1Elements
    .map((index, element) => ({
      index: index + 1,
      text: cleanText($(element).text()),
      html: cleanHtml($.html(element))
    }))
    .get();
  if (h1Elements.length === 0) {
    issues.push(pageIssue("error", "missing_h1", "The page has no H1 heading."));
  } else if (h1Elements.length > 1) {
    issues.push(
      pageIssue(
        "error",
        "multiple_h1",
        `The page has ${h1Elements.length} H1 headings.`,
        { count: h1Elements.length, elements: h1Evidence }
      )
    );
  }
  const emptyH1s = h1Evidence.filter(element => !element.text);
  if (emptyH1s.length) {
    issues.push(
      pageIssue("error", "empty_h1", `${emptyH1s.length} H1 heading is empty.`, {
        elements: emptyH1s
      })
    );
  }

  const images = $("img");
  const imageEvidence = element => {
    const rawSource =
      $(element).attr("src") ||
      $(element).attr("data-src") ||
      $(element).attr("data-lazy-src") ||
      null;
    return {
      source: absoluteUrl(rawSource, finalUrl),
      html: cleanHtml($.html(element))
    };
  };
  const missingAlt = images
    .filter((_, element) => $(element).attr("alt") === undefined)
    .map((index, element) => ({ index: index + 1, ...imageEvidence(element) }))
    .get();
  if (missingAlt.length) {
    issues.push(
      pageIssue(
        "error",
        "image_missing_alt",
        `${missingAlt.length} image element is missing an alt attribute.`,
        { count: missingAlt.length, elements: missingAlt }
      )
    );
  }
  const emptyAlt = images
    .filter((_, element) =>
      $(element).attr("alt") !== undefined && !String($(element).attr("alt")).trim()
    )
    .map((index, element) => ({ index: index + 1, ...imageEvidence(element) }))
    .get();
  if (emptyAlt.length) {
    issues.push(
      pageIssue(
        "notice",
        "image_empty_alt",
        `${emptyAlt.length} image has an empty alt attribute. This is valid only for decorative images.`,
        { count: emptyAlt.length, elements: emptyAlt }
      )
    );
  }

  const canonicals = $("link[rel]").filter((_, element) =>
    String($(element).attr("rel") || "")
      .toLowerCase()
      .split(/\s+/)
      .includes("canonical")
  );
  const canonicalValues = canonicals
    .map((_, element) => absoluteUrl($(element).attr("href"), finalUrl))
    .get();
  if (canonicals.length === 0) {
    issues.push(pageIssue("warning", "missing_canonical", "The page has no canonical link."));
  } else if (canonicals.length > 1) {
    issues.push(
      pageIssue(
        "error",
        "multiple_canonicals",
        `The page has ${canonicals.length} canonical links.`,
        { canonicals: canonicalValues }
      )
    );
  } else if (!canonicalValues[0]) {
    issues.push(pageIssue("error", "empty_canonical", "The canonical link is empty."));
  } else if (canonicalValues[0] !== finalUrl) {
    issues.push(
      pageIssue("notice", "canonical_differs_from_page", "The canonical URL differs from the final page URL.", {
        canonical_url: canonicalValues[0],
        final_url: finalUrl
      })
    );
  }

  const robotsMeta = elementsWithName($, "meta[name]", "name", "robots")
    .map((_, element) => cleanText($(element).attr("content")).toLowerCase())
    .get();
  const robotsDirectives = [...robotsMeta, cleanText(xRobotsTag).toLowerCase()]
    .filter(Boolean)
    .join(",");
  if (/(^|[,\s])noindex([,\s]|$)/.test(robotsDirectives)) {
    issues.push(
      pageIssue("warning", "robots_noindex", "The page tells search engines not to index it.", {
        directives: robotsDirectives
      })
    );
  }
  if (/(^|[,\s])nofollow([,\s]|$)/.test(robotsDirectives)) {
    issues.push(
      pageIssue("notice", "robots_nofollow", "The page tells search engines not to follow its links.", {
        directives: robotsDirectives
      })
    );
  }

  const jsonLdScripts = $("script[type]").filter((_, element) =>
    String($(element).attr("type") || "").toLowerCase() === "application/ld+json"
  );
  const invalidJsonLd = [];
  jsonLdScripts.each((index, element) => {
    const jsonText = $(element).text().trim();
    if (!jsonText) return;
    try {
      JSON.parse(jsonText);
    } catch (error) {
      invalidJsonLd.push({
        index: index + 1,
        error: cleanText(error.message),
        snippet: cleanText(jsonText, 300)
      });
    }
  });
  if (invalidJsonLd.length) {
    issues.push(
      pageIssue(
        "error",
        "invalid_json_ld",
        `${invalidJsonLd.length} JSON-LD block contains invalid JSON.`,
        { blocks: invalidJsonLd }
      )
    );
  }

  const htmlLanguage = cleanText($("html").attr("lang"));
  if (!htmlLanguage) {
    issues.push(
      pageIssue("notice", "missing_html_lang", "The html element has no language attribute.")
    );
  }

  const errorCount = issues.filter(issue => issue.severity === "error").length;
  const warningCount = issues.filter(issue => issue.severity === "warning").length;
  const noticeCount = issues.filter(issue => issue.severity === "notice").length;

  return {
    scanned_at: scannedAt,
    requested_url: requestedUrl,
    final_url: finalUrl,
    http: { status, status_text: statusText, content_type: contentType },
    summary: {
      passed: errorCount === 0,
      errors: errorCount,
      warnings: warningCount,
      notices: noticeCount,
      total_issues: issues.length
    },
    issue_codes: [...new Set(issues.map(issue => issue.code))],
    issues,
    checks: {
      title: { count: titles.length, values: titleValues },
      meta_description: { count: descriptions.length, values: descriptionValues },
      h1: { count: h1Elements.length, elements: h1Evidence },
      images: {
        count: images.length,
        missing_alt_count: missingAlt.length,
        empty_alt_count: emptyAlt.length
      },
      canonical: { count: canonicals.length, values: canonicalValues },
      robots: { directives: robotsDirectives || null },
      json_ld: { count: jsonLdScripts.length, invalid_count: invalidJsonLd.length },
      html_language: htmlLanguage || null
    }
  };
}

async function readHtmlBody(response) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_PAGE_BYTES) {
    throw new WebScannerError("The webpage is larger than the 5 MB scan limit.");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let html = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new WebScannerError("The webpage is larger than the 5 MB scan limit.");
    }
    html += decoder.decode(value, { stream: true });
  }

  return html + decoder.decode();
}

export async function scanPage(urlValue, { fetchImpl = globalThis.fetch } = {}) {
  const requested = await validatePublicUrl(urlValue);
  let current = requested;
  let response;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await validatePublicUrl(current.href);
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "User-Agent": "Codex-Bing-Webmaster-MCP/1.1"
        },
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      throw new WebScannerError(`Could not fetch the live webpage: ${current.href}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      if (redirectCount === MAX_REDIRECTS) {
        throw new WebScannerError("The webpage exceeded the 5-redirect scan limit.");
      }
      current = new URL(location, current);
      continue;
    }
    break;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
    throw new WebScannerError(
      `The URL did not return an HTML webpage. Content-Type: ${contentType || "unknown"}`
    );
  }

  const html = await readHtmlBody(response);
  return analyzeHtml(html, {
    requestedUrl: requested.href,
    finalUrl: current.href,
    status: response.status,
    statusText: response.statusText,
    contentType,
    xRobotsTag: response.headers.get("x-robots-tag")
  });
}

export async function scanPages(urls, { concurrency = 3 } = {}) {
  const uniqueUrls = [...new Set(urls)];
  const results = new Array(uniqueUrls.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < uniqueUrls.length) {
      const index = nextIndex;
      nextIndex += 1;
      const url = uniqueUrls[index];
      try {
        results[index] = await scanPage(url);
      } catch (error) {
        results[index] = {
          requested_url: url,
          scan_failed: true,
          error: error instanceof WebScannerError
            ? error.message
            : "The webpage scan failed unexpectedly."
        };
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), uniqueUrls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
