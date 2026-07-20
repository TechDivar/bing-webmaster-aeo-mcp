import { load } from "cheerio";

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_LENGTH = 500;
const MARKETING_PHRASES = [
  "best in class",
  "game changer",
  "revolutionary",
  "world class",
  "unmatched",
  "unparalleled",
  "leading platform",
  "don't miss out",
  "act now",
  "ultimate solution"
];

const INTENT_RULES = {
  informational: ["what is", "how does", "guide", "learn", "explained", "definition"],
  commercial: ["review", "benefits", "features", "pros", "cons", "worth it"],
  comparison: [" vs ", "versus", "compare", "comparison", "alternative", "differences"],
  troubleshooting: ["fix", "error", "problem", "not working", "troubleshoot", "why can't"],
  pricing: ["price", "pricing", "fee", "fees", "cost", "limit", "rate"],
  transactional: ["buy", "sign up", "apply", "download", "start trading", "get started"]
};

export class AiSearchAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiSearchAuditError";
  }
}

function cleanText(value, maxLength = Infinity) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function words(value) {
  return cleanText(value).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
}

function includesPhrase(text, phrase) {
  return text.toLocaleLowerCase().includes(String(phrase).toLocaleLowerCase());
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function pageRoot($) {
  return $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body").first();
}

function parseSchemas($) {
  const types = new Set();
  const invalid = [];

  function collect(value) {
    if (!value || typeof value !== "object") return;
    const type = value["@type"];
    for (const item of Array.isArray(type) ? type : [type]) {
      if (typeof item === "string" && item.trim()) types.add(item.trim());
    }
    if (Array.isArray(value)) value.forEach(collect);
    else Object.values(value).forEach(collect);
  }

  $("script[type='application/ld+json']").each((index, element) => {
    try {
      collect(JSON.parse($(element).text()));
    } catch (error) {
      invalid.push({ index: index + 1, error: cleanText(error.message, 200) });
    }
  });

  return { types: [...types].sort(), invalid };
}

export function buildPageModel(html, pageUrl = "https://example.com/") {
  if (typeof html !== "string") throw new AiSearchAuditError("Page HTML must be a string.");
  const $ = load(html);
  const schemas = parseSchemas($);
  $("script,style,noscript,svg,template,form").remove();
  const root = pageRoot($);
  const title = cleanText($("title").first().text());
  const h1 = cleanText(root.find("h1").first().text() || $("h1").first().text());
  const headings = root.find("h1,h2,h3,h4,h5,h6").map((_, element) => ({
    level: Number(element.tagName.slice(1)),
    text: cleanText($(element).text(), 300)
  })).get().filter(item => item.text);
  const paragraphs = root.find("p").map((_, element) => cleanText($(element).text(), 1_500))
    .get().filter(text => words(text).length >= 5);
  const listItems = root.find("li").map((_, element) => cleanText($(element).text(), 500))
    .get().filter(Boolean);
  const text = cleanText(root.text());
  const blocks = root.find("h1,h2,h3,h4,h5,h6,p,li,table").map((_, element) => ({
    tag: element.tagName.toLowerCase(),
    text: cleanText($(element).text(), 1_500)
  })).get().filter(block => block.text);

  let cursor = 0;
  let firstH2Word = null;
  for (const block of blocks) {
    if (block.tag === "h2" && firstH2Word === null) firstH2Word = cursor;
    cursor += words(block.text).length;
  }

  let hostname = "";
  try { hostname = new URL(pageUrl).hostname.replace(/^www\./, ""); } catch {}
  const links = root.find("a[href]").map((_, element) => {
    try {
      const url = new URL($(element).attr("href"), pageUrl);
      return {
        url: url.href,
        anchor: cleanText($(element).text(), 200),
        internal: url.hostname.replace(/^www\./, "") === hostname
      };
    } catch {
      return null;
    }
  }).get().filter(Boolean);

  return {
    page_url: pageUrl,
    title,
    h1,
    text,
    word_count: words(text).length,
    headings,
    paragraphs,
    list_items: listItems,
    first_h2_word: firstH2Word,
    table_count: root.find("table").length,
    ordered_list_count: root.find("ol").length,
    faq_present: headings.some(item => /\bfaq|frequently asked|questions?\b/i.test(item.text)),
    links,
    images: root.find("img").map((_, element) => ({
      src: cleanText($(element).attr("src") || $(element).attr("data-src"), 500),
      alt: cleanText($(element).attr("alt"), 300)
    })).get(),
    schemas
  };
}

function findDirectAnswer(model) {
  const candidates = model.paragraphs.slice(0, 4);
  const definition = candidates.find(text =>
    /\b(?:is|are|means|refers to|allows?|lets you|works by)\b/i.test(text) &&
    words(text).length >= 15 && words(text).length <= 90
  );
  const concise = candidates.find(text => words(text).length >= 20 && words(text).length <= 80);
  const answer = definition || concise || null;
  const position = answer ? words(model.text.slice(0, model.text.indexOf(answer))).length : null;
  return { text: answer, word_position: position, is_definition: Boolean(definition) };
}

export function analyzeAiReadability(model) {
  const answer = findDirectAnswer(model);
  const issues = [];
  let score = 100;

  if (!answer.text) {
    score -= 25;
    issues.push("No concise direct answer was found near the top.");
  } else if (answer.word_position > 150) {
    score -= 18;
    issues.push(`The first likely direct answer appears after about ${answer.word_position} words.`);
  }
  if (!answer.is_definition) {
    score -= 12;
    issues.push("No concise definition was found near the top.");
  }
  if (model.first_h2_word === null) {
    score -= 15;
    issues.push("No H2 section headings were found.");
  } else if (model.first_h2_word > 250) {
    score -= 12;
    issues.push(`The first H2 appears after about ${model.first_h2_word} words.`);
  }

  const jumps = [];
  for (let index = 1; index < model.headings.length; index += 1) {
    if (model.headings[index].level > model.headings[index - 1].level + 1) {
      jumps.push(`${model.headings[index - 1].text} → ${model.headings[index].text}`);
    }
  }
  if (jumps.length) {
    score -= Math.min(12, jumps.length * 4);
    issues.push(`${jumps.length} heading hierarchy jump${jumps.length === 1 ? "" : "s"} found.`);
  }

  const marketingHits = MARKETING_PHRASES.filter(phrase => includesPhrase(model.text, phrase));
  if (marketingHits.length) {
    score -= Math.min(15, marketingHits.length * 3);
    issues.push(`Marketing-heavy language found: ${marketingHits.join(", ")}.`);
  }
  if (model.word_count > 700 && model.table_count === 0 && model.ordered_list_count === 0) {
    score -= 8;
    issues.push("A long page has no table or ordered step-by-step list.");
  }

  return {
    score: clampScore(score),
    direct_answer: answer,
    issues,
    signals: {
      word_count: model.word_count,
      first_h2_word: model.first_h2_word,
      heading_hierarchy_jumps: jumps,
      marketing_phrases: marketingHits,
      tables: model.table_count,
      ordered_lists: model.ordered_list_count,
      faq_present: model.faq_present
    },
    method: "Deterministic HTML and language-pattern audit; no claim is made about a specific AI model."
  };
}

function inferredEntities(text) {
  const ignored = new Set(["The", "This", "That", "These", "Those", "What", "How", "Why", "When", "Where", "For", "With", "From", "Your", "You", "Our"]);
  const matches = text.match(/\b(?:[A-Z][A-Za-z0-9+.-]{1,}|[A-Z]{2,})(?:\s+(?:[A-Z][A-Za-z0-9+.-]{1,}|[A-Z]{2,})){0,3}\b/g) || [];
  const counts = new Map();
  for (const match of matches) {
    const value = cleanText(match);
    if (!value || ignored.has(value)) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([entity, mentions]) => ({ entity, mentions }));
}

export function analyzeEntityCoverage(model, { primaryEntity, relatedEntities = [] } = {}) {
  const detected = inferredEntities(model.text);
  const primary = primaryEntity ? {
    entity: primaryEntity,
    present: includesPhrase(model.text, primaryEntity),
    mentions: model.text.toLocaleLowerCase().split(primaryEntity.toLocaleLowerCase()).length - 1
  } : null;
  const related = [...new Set(relatedEntities)].map(entity => ({
    entity,
    present: includesPhrase(model.text, entity)
  }));
  const present = related.filter(item => item.present);
  const missing = related.filter(item => !item.present);
  const denominator = related.length + (primary ? 1 : 0);
  const numerator = present.length + (primary?.present ? 1 : 0);

  return {
    score: denominator ? clampScore((numerator / denominator) * 100) : null,
    primary_entity: primary,
    related_entities_present: present.map(item => item.entity),
    related_entities_missing: missing.map(item => item.entity),
    detected_entities: detected,
    method: related.length
      ? "Coverage is measured against the entities supplied by the user; detected entities are heuristic."
      : "No expected related-entity list was supplied, so missing entities are not guessed."
  };
}

export function extractCitableChunks(model, limit = 15) {
  const candidates = [...model.paragraphs, ...model.list_items]
    .filter(text => words(text).length >= 12 && words(text).length <= 120)
    .map((text, index) => {
      let score = 30;
      const reasons = [];
      const count = words(text).length;
      if (count >= 25 && count <= 75) { score += 20; reasons.push("concise standalone length"); }
      if (/\b(?:is|are|means|refers to|defined as)\b/i.test(text)) { score += 18; reasons.push("definition-like statement"); }
      if (/\b\d+(?:[.,]\d+)?%?|[$€£¥]\s?\d/i.test(text)) { score += 16; reasons.push("specific fact or number"); }
      if (/\b(?:because|therefore|which means|as a result)\b/i.test(text)) { score += 8; reasons.push("explains a relationship"); }
      if (/\b[A-Z]{2,}\b/.test(text)) { score += 6; reasons.push("named entity or acronym"); }
      if (/[!?]$/.test(text)) score -= 8;
      return { index: index + 1, text: cleanText(text, MAX_CHUNK_LENGTH), score: clampScore(score), reasons };
    })
    .sort((a, b) => b.score - a.score);

  return {
    chunks_found: candidates.length,
    chunks: candidates.slice(0, limit),
    method: "Heuristic citation-readiness score, not a prediction or guarantee of citation by an AI system."
  };
}

export function analyzeCitationReadiness(model) {
  const answer = findDirectAnswer(model);
  const chunks = extractCitableChunks(model, 5);
  const externalReferences = model.links.filter(link => !link.internal).length;
  const strengths = [];
  const weaknesses = [];
  let score = 20;

  if (answer.text && answer.word_position <= 150) { score += 18; strengths.push("Concise answer near the top"); }
  else weaknesses.push("Missing concise answer near the top");
  if (answer.is_definition) { score += 12; strengths.push("Definition-like passage"); }
  else weaknesses.push("No clear definition block");
  if (model.headings.filter(item => item.level === 2).length >= 2) { score += 10; strengths.push("Structured H2 sections"); }
  else weaknesses.push("Weak H2 structure");
  if (model.table_count) { score += 8; strengths.push("Comparison or data table"); }
  else weaknesses.push("No table");
  if (model.faq_present) { score += 7; strengths.push("FAQ section"); }
  if (externalReferences) { score += Math.min(10, externalReferences * 2); strengths.push("External references"); }
  else weaknesses.push("No external references");
  const strongChunks = chunks.chunks.filter(chunk => chunk.score >= 70).length;
  score += Math.min(15, strongChunks * 5);
  if (strongChunks) strengths.push(`${strongChunks} strong citable chunk${strongChunks === 1 ? "" : "s"}`);
  else weaknesses.push("No strong standalone factual chunks");

  return {
    score: clampScore(score),
    strengths,
    weaknesses,
    strong_chunk_count: strongChunks,
    external_reference_count: externalReferences,
    method: "Transparent structural heuristic; no AI platform guarantees citations."
  };
}

export function analyzeIntentCoverage(model, expectedIntents = []) {
  const haystack = ` ${model.title} ${model.h1} ${model.headings.map(item => item.text).join(" ")} ${model.text} `.toLocaleLowerCase();
  const detected = [];
  const evidence = {};
  for (const [intent, phrases] of Object.entries(INTENT_RULES)) {
    const hits = phrases.filter(phrase => haystack.includes(phrase));
    if (hits.length) {
      detected.push(intent);
      evidence[intent] = hits.slice(0, 5);
    }
  }
  const expected = [...new Set(expectedIntents.map(item => item.toLocaleLowerCase()))];
  return {
    detected_intents: detected,
    expected_intents: expected,
    missing_expected_intents: expected.filter(intent => !detected.includes(intent)),
    evidence,
    supported_intents: Object.keys(INTENT_RULES),
    method: "Intent labels are inferred from visible language patterns and headings."
  };
}

export function generateAiOverviewPreview(model) {
  const answer = findDirectAnswer(model);
  const chunks = extractCitableChunks(model, 4).chunks;
  const selected = [];
  if (answer.text) selected.push(answer.text);
  for (const chunk of chunks) {
    if (!selected.includes(chunk.text) && selected.join(" ").length < 900) selected.push(chunk.text);
  }
  const readiness = analyzeCitationReadiness(model);
  return {
    preview: selected.join("\n\n") || "The page does not contain enough concise standalone text for a useful extractive preview.",
    confidence: clampScore(readiness.score * 0.8),
    source_chunks_used: selected.length,
    warning: "This is an extractive page-only preview. It does not simulate or predict ChatGPT, Copilot, Google AI Overviews, or another model."
  };
}

export function auditInternalLinks(model, candidateLinks = []) {
  const existing = model.links.filter(link => link.internal);
  const existingUrls = new Set(existing.map(link => link.url.replace(/\/$/, "")));
  const suggestions = [];

  for (const candidate of candidateLinks) {
    let normalized;
    try { normalized = new URL(candidate.url, model.page_url).href; } catch { continue; }
    if (existingUrls.has(normalized.replace(/\/$/, ""))) continue;
    const keywords = candidate.keywords?.length ? candidate.keywords : [candidate.title];
    const matches = keywords.filter(keyword => includesPhrase(model.text, keyword));
    if (matches.length) {
      suggestions.push({
        url: normalized,
        title: candidate.title,
        matched_terms: matches,
        reason: `The page discusses ${matches.slice(0, 3).join(", ")} but does not link to this candidate.`
      });
    }
  }

  return {
    existing_internal_link_count: existing.length,
    existing_internal_links: existing.slice(0, 100),
    suggested_links: suggestions.slice(0, 30),
    method: candidateLinks.length
      ? "Suggestions come only from the supplied internal-link inventory; URLs are not invented."
      : "No candidate-link inventory was supplied, so the tool reports existing links without inventing destinations."
  };
}

export function recommendSchemas(model) {
  const current = new Set(model.schemas.types.map(type => type.toLocaleLowerCase()));
  const text = `${model.title} ${model.h1} ${model.headings.map(item => item.text).join(" ")} ${model.text}`;
  const recommendations = [];
  const add = (type, suitable, reason) => recommendations.push({ type, suitable, already_present: current.has(type.toLocaleLowerCase()), reason });

  add("Article", model.word_count >= 300, model.word_count >= 300 ? "The page contains substantial article content." : "The page is too short to confidently classify as an article.");
  add("BreadcrumbList", true, "Breadcrumb markup can describe the page's place in the site hierarchy when visible breadcrumbs exist.");
  add("FAQPage", model.faq_present, model.faq_present ? "A visible FAQ-like section was detected." : "No visible FAQ section was detected.");
  add("HowTo", model.ordered_list_count > 0 && /\bhow to|steps?|instructions?\b/i.test(text), "Use only when the visible page teaches a real sequence of steps.");
  add("Product", /\bproduct|card|software|app|price|pricing|fee\b/i.test(text), "Use only when the page is about a specific product and the required visible fields are present.");
  add("Review", /\breview|rating|pros|cons\b/i.test(text), "Use only for a genuine visible review with an eligible reviewed item and real rating data.");

  return {
    existing_schema_types: model.schemas.types,
    invalid_json_ld_blocks: model.schemas.invalid,
    recommendations,
    warning: "A recommendation is not automatic eligibility for a search rich result. Markup must match visible content and current platform rules."
  };
}

export function auditFreshness(model, currentYear = new Date().getUTCFullYear()) {
  const yearMatches = [...new Set((model.text.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number))].sort();
  const oldYears = yearMatches.filter(year => year <= currentYear - 2);
  const relativeClaims = [...new Set((model.text.match(/\b(?:currently|today|now|latest|newest|recently|this year)\b/gi) || []).map(value => value.toLocaleLowerCase()))];
  const pricingSignals = (model.text.match(/(?:[$€£¥]\s?\d[\d,.]*|\b\d+(?:\.\d+)?%\b|\b(?:fee|fees|price|pricing|cost|limit|rate)s?\b)/gi) || []).slice(0, 30);
  const screenshotSignals = model.images.filter(image => /screenshot|screen shot|\b20\d{2}\b/i.test(`${image.src} ${image.alt}`));
  const reviewItems = [];
  if (oldYears.length) reviewItems.push(`Check statements tied to older years: ${oldYears.join(", ")}.`);
  if (relativeClaims.length) reviewItems.push(`Verify time-sensitive wording: ${relativeClaims.join(", ")}.`);
  if (pricingSignals.length) reviewItems.push("Verify pricing, fees, rates, and limits against the current product source.");
  if (screenshotSignals.length) reviewItems.push(`${screenshotSignals.length} screenshot or dated image may need review.`);

  return {
    current_year: currentYear,
    years_mentioned: yearMatches,
    potentially_old_years: oldYears,
    relative_time_claims: relativeClaims,
    pricing_or_limit_signals: pricingSignals,
    screenshot_signals: screenshotSignals,
    needs_review: reviewItems.length > 0,
    review_items: reviewItems,
    method: "Flags potentially time-sensitive statements for human verification; it does not declare them false."
  };
}

function normalizedHeading(text) {
  return cleanText(text).toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");
}

function headingSimilarity(left, right) {
  const a = new Set(words(normalizedHeading(left)).filter(word => word.length > 2));
  const b = new Set(words(normalizedHeading(right)).filter(word => word.length > 2));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter(word => b.has(word)).length;
  return overlap / Math.min(a.size, b.size);
}

export function comparePageModels(page, competitors) {
  const missing = [];
  const pageHeadings = page.headings.filter(item => item.level >= 2).map(item => item.text);
  for (const competitor of competitors) {
    for (const heading of competitor.headings.filter(item => item.level >= 2)) {
      if (words(heading.text).length < 2) continue;
      const covered = pageHeadings.some(item => headingSimilarity(item, heading.text) >= 0.6);
      if (!covered) {
        const existing = missing.find(item => headingSimilarity(item.topic, heading.text) >= 0.75);
        if (existing) {
          existing.competitors_covering += 1;
          existing.source_urls.push(competitor.page_url);
        } else {
          missing.push({ topic: heading.text, competitors_covering: 1, source_urls: [competitor.page_url] });
        }
      }
    }
  }

  return {
    page_url: page.page_url,
    competitors_compared: competitors.length,
    missing_topics: missing.sort((a, b) => b.competitors_covering - a.competitors_covering).slice(0, 40),
    your_headings: page.headings,
    competitor_summaries: competitors.map(item => ({ page_url: item.page_url, headings: item.headings })),
    method: "Compares visible heading topics. A gap is an editorial lead, not an instruction to copy a competitor."
  };
}

export function auditAiSearch(model, options = {}) {
  return {
    page_url: model.page_url,
    ai_readability: analyzeAiReadability(model),
    entity_coverage: analyzeEntityCoverage(model, options),
    citation_readiness: analyzeCitationReadiness(model),
    intent_coverage: analyzeIntentCoverage(model, options.expectedIntents),
    ai_overview_preview: generateAiOverviewPreview(model),
    citable_chunks: extractCitableChunks(model, options.chunkLimit || 15),
    internal_linking: auditInternalLinks(model, options.candidateLinks),
    schema: recommendSchemas(model),
    freshness: auditFreshness(model, options.currentYear)
  };
}

function safeReplacementHtml(value) {
  return !/<\s*(?:script|object|embed|form)\b/i.test(value) &&
    !/\son[a-z]+\s*=/i.test(value) &&
    !/javascript\s*:/i.test(value);
}

export function prepareAeoAutofix({ contentHtml, proposedChanges = [] } = {}) {
  if (contentHtml === undefined || contentHtml === null) {
    return {
      changed: false,
      approval_required: true,
      publish_performed: false,
      changes: [],
      unresolved: [{ reason: "Provide the latest WordPress content_html and exact proposed_changes to prepare a diff." }]
    };
  }
  if (typeof contentHtml !== "string") throw new AiSearchAuditError("content_html must be a string.");
  if (Buffer.byteLength(contentHtml, "utf8") > MAX_CONTENT_BYTES) throw new AiSearchAuditError("WordPress content is larger than the 2 MB limit.");
  if (!Array.isArray(proposedChanges) || proposedChanges.length > 20) throw new AiSearchAuditError("Use no more than 20 proposed changes.");

  let updated = contentHtml;
  const changes = [];
  const unresolved = [];
  for (const [index, proposal] of proposedChanges.entries()) {
    const find = String(proposal.find_html || "");
    const replacement = String(proposal.replace_html || "");
    if (!find) {
      unresolved.push({ index: index + 1, reason: "find_html is empty." });
      continue;
    }
    if (!safeReplacementHtml(replacement)) {
      unresolved.push({ index: index + 1, reason: "Replacement contains an unsafe script, form, event handler, or javascript URL." });
      continue;
    }
    const occurrences = updated.split(find).length - 1;
    if (occurrences !== 1) {
      unresolved.push({ index: index + 1, reason: occurrences ? `find_html matched ${occurrences} places; an exact unique match is required.` : "find_html was not found in the latest content." });
      continue;
    }
    updated = updated.replace(find, replacement);
    changes.push({
      index: index + 1,
      reason: cleanText(proposal.reason, 300) || "AEO content improvement",
      before: cleanText(find, 800),
      after: cleanText(replacement, 800)
    });
  }

  return {
    changed: updated !== contentHtml,
    approval_required: true,
    publish_performed: false,
    changes,
    unresolved,
    updated_content_html: updated,
    next_steps: [
      "Review this exact before-and-after diff.",
      "Ask for explicit approval before sending updated_content_html to a connected WordPress write tool.",
      "After publishing, rerun the audits and submit the approved URL to Bing if desired."
    ]
  };
}
