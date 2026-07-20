const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_GA4_ROWS = 10_000;

const DEFAULT_AI_SOURCES = [
  "chatgpt.com",
  "chat.openai.com",
  "perplexity.ai",
  "claude.ai",
  "copilot.microsoft.com",
  "gemini.google.com",
  "bard.google.com",
  "you.com",
  "phind.com",
  "poe.com",
  "meta.ai",
  "chat.mistral.ai",
  "mistral.ai",
  "chat.deepseek.com",
  "deepseek.com",
  "grok.com"
];

const PAGE_HEADERS = new Set([
  "page",
  "url",
  "pagelocation",
  "pagepath",
  "pagepathandscreenclass",
  "pagepathquerystring",
  "pagepathquerystringandscreenclass",
  "landingpage",
  "landingpagequerystring"
]);

const SOURCE_HEADERS = new Set([
  "source",
  "referrer",
  "pagereferrer",
  "fullreferrer",
  "sessionsource",
  "sessionsourcemedium",
  "firstusersource",
  "firstusersourcemedium"
]);

const TRAFFIC_HEADERS = new Set([
  "sessions",
  "activeusers",
  "totalusers",
  "users",
  "views",
  "screenpageviews",
  "eventcount",
  "aitraffic",
  "aivisits",
  "aisessions"
]);

export class AeoTrafficOpportunityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AeoTrafficOpportunityError";
  }
}

function normalizeHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function cleanLabel(value, maxLength = 120) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength - 1)}…`
    : cleaned;
}

function parseNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const normalized = String(value ?? "")
    .trim()
    .replace(/,/g, "")
    .replace(/\s/g, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseCsv(csvText) {
  if (typeof csvText !== "string" || !csvText.trim()) {
    throw new AeoTrafficOpportunityError("The GA4 CSV is empty.");
  }
  if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
    throw new AeoTrafficOpportunityError("The GA4 CSV must be 2 MB or smaller.");
  }

  const text = csvText.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some(value => String(value).trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new AeoTrafficOpportunityError(
      "The GA4 CSV contains an unfinished quoted value. Export it again and retry."
    );
  }
  row.push(field);
  if (row.some(value => String(value).trim())) rows.push(row);
  if (!rows.length) throw new AeoTrafficOpportunityError("The GA4 CSV has no rows.");
  if (rows.length > MAX_GA4_ROWS + 25) {
    throw new AeoTrafficOpportunityError(
      `The GA4 export must contain at most ${MAX_GA4_ROWS.toLocaleString("en-US")} data rows.`
    );
  }
  return rows;
}

function stripWww(hostname) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function parseSite(siteUrl) {
  let site;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new AeoTrafficOpportunityError("The Bing site URL is invalid.");
  }
  if (!["http:", "https:"].includes(site.protocol)) {
    throw new AeoTrafficOpportunityError("The Bing site URL must use http or https.");
  }
  return site;
}

function normalizePageReference(value, site) {
  const rawValue = String(value || "").trim();
  if (!rawValue || /^\(not set\)$/i.test(rawValue)) return null;

  let page;
  try {
    if (/^https?:\/\//i.test(rawValue)) {
      page = new URL(rawValue);
    } else if (rawValue.startsWith("/")) {
      page = new URL(rawValue, site.origin);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(page.protocol)) return null;
  if (stripWww(page.hostname) !== stripWww(site.hostname)) return null;

  page.hash = "";
  page.search = "";
  page.pathname = page.pathname.replace(/\/{2,}/g, "/");
  if (page.pathname !== "/") page.pathname = page.pathname.replace(/\/+$/, "");

  return {
    key: `${stripWww(page.hostname)}${page.pathname}`,
    url: page.href
  };
}

function matchingSource(source, knownSources) {
  const value = String(source || "").toLowerCase().trim();
  if (!value || /^\(not set\)$/i.test(value)) return null;

  let sourceHost = "";
  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value.split(/\s+/)[0]}`;
    sourceHost = new URL(candidate).hostname.replace(/^www\./, "");
  } catch {
    sourceHost = "";
  }

  return knownSources.find(sourceName => {
    const domain = sourceName.replace(/^www\./, "");
    if (sourceHost === domain || sourceHost.endsWith(`.${domain}`)) return true;
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9.-])${escaped}([^a-z0-9.-]|$)`, "i").test(value);
  }) || null;
}

function findHeaderRow(rows) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 25); rowIndex += 1) {
    const normalized = rows[rowIndex].map(normalizeHeader);
    const pageIndex = normalized.findIndex(header => PAGE_HEADERS.has(header));
    const trafficIndex = normalized.findIndex(header => TRAFFIC_HEADERS.has(header));
    if (pageIndex >= 0 && trafficIndex >= 0) {
      const sourceIndex = normalized.findIndex(header => SOURCE_HEADERS.has(header));
      return {
        rowIndex,
        pageIndex,
        sourceIndex,
        trafficIndex,
        pageHeader: cleanLabel(rows[rowIndex][pageIndex]),
        sourceHeader: sourceIndex >= 0
          ? cleanLabel(rows[rowIndex][sourceIndex])
          : null,
        trafficHeader: cleanLabel(rows[rowIndex][trafficIndex])
      };
    }
  }
  throw new AeoTrafficOpportunityError(
    "The GA4 CSV needs a page column and a traffic column such as Sessions. Include Session source or Page referrer unless the export is already filtered to AI traffic."
  );
}

function emptySkipCounts() {
  return {
    missing_or_invalid_page: 0,
    wrong_host: 0,
    invalid_traffic_value: 0,
    non_ai_source: 0
  };
}

function classifyPage(rawPage, site) {
  const normalized = normalizePageReference(rawPage, site);
  if (normalized) return { normalized };

  const value = String(rawPage || "").trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      if (stripWww(new URL(value).hostname) !== stripWww(site.hostname)) {
        return { reason: "wrong_host" };
      }
    } catch {
      // Count malformed absolute URLs with the other invalid page values.
    }
  }
  return { reason: "missing_or_invalid_page" };
}

function aggregateGa4Rows({
  site,
  rows,
  rowsAreAiFiltered,
  knownSources,
  metricName
}) {
  const trafficByPage = new Map();
  const skipCounts = emptySkipCounts();
  const matchedSources = new Set();
  let countedRows = 0;

  for (const row of rows) {
    const pageValue = row.page;
    const traffic = parseNumber(row.traffic);
    if (traffic === null) {
      skipCounts.invalid_traffic_value += 1;
      continue;
    }

    const pageResult = classifyPage(pageValue, site);
    if (!pageResult.normalized) {
      skipCounts[pageResult.reason] += 1;
      continue;
    }

    const matchedSource = row.source
      ? matchingSource(row.source, knownSources)
      : null;
    if (!rowsAreAiFiltered && !matchedSource) {
      skipCounts.non_ai_source += 1;
      continue;
    }

    const normalized = pageResult.normalized;
    const existing = trafficByPage.get(normalized.key) || {
      url: normalized.url,
      traffic: 0
    };
    existing.traffic += traffic;
    trafficByPage.set(normalized.key, existing);
    countedRows += 1;
    if (matchedSource) matchedSources.add(matchedSource);
  }

  return {
    trafficByPage,
    countedRows,
    skipCounts,
    metricName: cleanLabel(metricName || "Sessions"),
    matchedSources: [...matchedSources].slice(0, 50)
  };
}

function ga4DataFromCsv({
  site,
  ga4Csv,
  rowsAreAiFiltered,
  knownSources
}) {
  const parsed = parseCsv(ga4Csv);
  const header = findHeaderRow(parsed);
  if (header.sourceIndex < 0 && !rowsAreAiFiltered) {
    throw new AeoTrafficOpportunityError(
      "The GA4 CSV has no Session source or Page referrer column. Add one, or mark the export as already filtered to AI traffic."
    );
  }

  const dataRows = parsed.slice(header.rowIndex + 1, header.rowIndex + 1 + MAX_GA4_ROWS);
  const rows = dataRows.map(row => ({
    page: row[header.pageIndex],
    source: header.sourceIndex >= 0 ? row[header.sourceIndex] : undefined,
    traffic: row[header.trafficIndex]
  }));
  const aggregated = aggregateGa4Rows({
    site,
    rows,
    rowsAreAiFiltered,
    knownSources,
    metricName: header.trafficHeader
  });

  return {
    ...aggregated,
    inputType: "csv",
    rowsReceived: dataRows.length,
    detectedColumns: {
      page: header.pageHeader,
      source: header.sourceHeader,
      traffic: header.trafficHeader
    }
  };
}

function ga4DataFromStructuredRows({
  site,
  ga4Rows,
  rowsAreAiFiltered,
  knownSources,
  metricName
}) {
  if (!Array.isArray(ga4Rows) || !ga4Rows.length) {
    throw new AeoTrafficOpportunityError("Provide a GA4 CSV or aggregated GA4 rows.");
  }
  if (ga4Rows.length > MAX_GA4_ROWS) {
    throw new AeoTrafficOpportunityError(
      `Provide at most ${MAX_GA4_ROWS.toLocaleString("en-US")} GA4 rows.`
    );
  }
  if (!rowsAreAiFiltered && ga4Rows.some(row => !String(row?.source || "").trim())) {
    throw new AeoTrafficOpportunityError(
      "Each GA4 row needs a source unless the rows are already filtered to AI traffic."
    );
  }

  const aggregated = aggregateGa4Rows({
    site,
    rows: ga4Rows,
    rowsAreAiFiltered,
    knownSources,
    metricName
  });
  return {
    ...aggregated,
    inputType: "structured_rows",
    rowsReceived: ga4Rows.length,
    detectedColumns: null
  };
}

function aggregateBingRows(bingRows, site) {
  if (!Array.isArray(bingRows)) {
    throw new AeoTrafficOpportunityError(
      "Bing returned an unexpected GetPageStats response. No comparison was made."
    );
  }

  const pages = new Map();
  const skipped = {
    missing_or_invalid_url: 0,
    wrong_host: 0,
    malformed_statistics: 0
  };

  for (const row of bingRows) {
    const rawPage = row?.Query;
    const pageResult = classifyPage(rawPage, site);
    if (!pageResult.normalized) {
      if (pageResult.reason === "wrong_host") skipped.wrong_host += 1;
      else skipped.missing_or_invalid_url += 1;
      continue;
    }

    const impressions = parseNumber(row?.Impressions);
    const clicks = parseNumber(row?.Clicks);
    if (impressions === null || clicks === null) {
      skipped.malformed_statistics += 1;
      continue;
    }

    const normalized = pageResult.normalized;
    const existing = pages.get(normalized.key) || {
      url: normalized.url,
      impressions: 0,
      clicks: 0,
      impressionPositionTotal: 0,
      impressionPositionWeight: 0,
      clickPositionTotal: 0,
      clickPositionWeight: 0
    };
    existing.impressions += impressions;
    existing.clicks += clicks;

    const impressionPosition = parseNumber(row?.AvgImpressionPosition);
    if (impressionPosition !== null && impressions > 0) {
      existing.impressionPositionTotal += impressionPosition * impressions;
      existing.impressionPositionWeight += impressions;
    }
    const clickPosition = parseNumber(row?.AvgClickPosition);
    if (clickPosition !== null && clicks > 0) {
      existing.clickPositionTotal += clickPosition * clicks;
      existing.clickPositionWeight += clicks;
    }
    pages.set(normalized.key, existing);
  }

  return { pages, skipped };
}

function rounded(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function findAiTrafficOpportunities({
  siteUrl,
  bingRows,
  ga4Csv,
  ga4Rows,
  ga4RowsAreAiFiltered = false,
  ga4MetricName = "Sessions",
  additionalAiSources = [],
  minimumBingImpressions = 1_000,
  maximumAiTraffic = 5,
  limit = 100
}) {
  const site = parseSite(siteUrl);
  if (ga4Csv && Array.isArray(ga4Rows) && ga4Rows.length) {
    throw new AeoTrafficOpportunityError(
      "Provide either a GA4 CSV or GA4 rows, not both."
    );
  }
  if (!ga4Csv && (!Array.isArray(ga4Rows) || !ga4Rows.length)) {
    throw new AeoTrafficOpportunityError("Provide a GA4 CSV or aggregated GA4 rows.");
  }
  if (!Number.isFinite(minimumBingImpressions) || minimumBingImpressions < 0) {
    throw new AeoTrafficOpportunityError("minimumBingImpressions cannot be negative.");
  }
  if (!Number.isFinite(maximumAiTraffic) || maximumAiTraffic < 0) {
    throw new AeoTrafficOpportunityError("maximumAiTraffic cannot be negative.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AeoTrafficOpportunityError("limit must be between 1 and 500.");
  }

  const extraSources = additionalAiSources
    .map(source => String(source || "").trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
  const knownSources = [...new Set([...DEFAULT_AI_SOURCES, ...extraSources])];

  const bing = aggregateBingRows(bingRows, site);
  const ga4 = ga4Csv
    ? ga4DataFromCsv({
        site,
        ga4Csv,
        rowsAreAiFiltered: ga4RowsAreAiFiltered,
        knownSources
      })
    : ga4DataFromStructuredRows({
        site,
        ga4Rows,
        rowsAreAiFiltered: ga4RowsAreAiFiltered,
        knownSources,
        metricName: ga4MetricName
      });

  const opportunities = [];
  let highImpressionPages = 0;
  for (const [key, page] of bing.pages.entries()) {
    if (page.impressions < minimumBingImpressions) continue;
    highImpressionPages += 1;
    const ga4Page = ga4.trafficByPage.get(key);
    const aiTraffic = ga4Page?.traffic || 0;
    if (aiTraffic > maximumAiTraffic) continue;

    opportunities.push({
      url: page.url,
      bing_impressions: rounded(page.impressions, 0),
      bing_clicks: rounded(page.clicks, 0),
      bing_ctr_percent: page.impressions > 0
        ? rounded((page.clicks / page.impressions) * 100)
        : 0,
      average_bing_impression_position: page.impressionPositionWeight > 0
        ? rounded(page.impressionPositionTotal / page.impressionPositionWeight)
        : null,
      average_bing_click_position: page.clickPositionWeight > 0
        ? rounded(page.clickPositionTotal / page.clickPositionWeight)
        : null,
      ga4_ai_traffic: rounded(aiTraffic, 2),
      ga4_metric: ga4.metricName,
      ai_traffic_row_found: Boolean(ga4Page),
      reason: ga4Page
        ? "High Bing visibility with low identifiable AI-referral traffic in the supplied GA4 data."
        : "High Bing visibility with no matching AI-referral row in the supplied GA4 data.",
      recommended_next_step:
        "Run aeo_audit_page on this URL, review the findings, and prepare only approved fixes."
    });
  }

  opportunities.sort((left, right) =>
    right.bing_impressions - left.bing_impressions ||
    left.ga4_ai_traffic - right.ga4_ai_traffic ||
    left.url.localeCompare(right.url)
  );

  const unmatchedGa4Pages = [...ga4.trafficByPage.entries()]
    .filter(([key]) => !bing.pages.has(key))
    .map(([, page]) => page.url)
    .slice(0, 50);

  return {
    site_url: site.href,
    thresholds: {
      minimum_bing_impressions: minimumBingImpressions,
      maximum_ga4_ai_traffic: maximumAiTraffic,
      ga4_metric: ga4.metricName
    },
    summary: {
      bing_rows_received: bingRows.length,
      bing_pages_matched_to_site: bing.pages.size,
      high_impression_pages: highImpressionPages,
      ga4_rows_received: ga4.rowsReceived,
      ga4_ai_rows_counted: ga4.countedRows,
      ga4_ai_pages: ga4.trafficByPage.size,
      opportunity_pages: opportunities.length,
      opportunities_returned: Math.min(opportunities.length, limit)
    },
    opportunities: opportunities.slice(0, limit),
    skipped: {
      bing_rows: bing.skipped,
      ga4_rows: ga4.skipCounts
    },
    ga4_input: {
      type: ga4.inputType,
      rows_already_filtered_to_ai: ga4RowsAreAiFiltered,
      detected_columns: ga4.detectedColumns,
      matched_sources: ga4.matchedSources,
      unmatched_pages_sample: unmatchedGa4Pages
    },
    notes: [
      "Bing GetPageStats reports Bing's top-page search data and Microsoft says it is updated weekly.",
      "GA4 only shows identifiable AI referrals. Some AI visits may appear as direct, organic, or unknown traffic.",
      "Use matching or clearly labelled date ranges where possible; this tool does not claim that Bing and GA4 cover identical periods.",
      "A missing GA4 row means no matching row was present in the supplied export, not proof that the page received absolutely no AI visits.",
      "This comparison finds pages to review. It does not guarantee an AI citation, ranking improvement, crawling, or indexing."
    ]
  };
}

export const AI_TRAFFIC_SOURCE_DEFAULTS = [...DEFAULT_AI_SOURCES];
