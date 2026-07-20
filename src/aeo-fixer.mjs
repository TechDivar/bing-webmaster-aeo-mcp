const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

const FIX_GUIDANCE = {
  multiple_h1: {
    auto_fixable: true,
    target: "wordpress_content",
    action:
      "Convert H1 headings inside the WordPress post body to H2, while keeping the theme-rendered post title as the page's only H1."
  },
  image_missing_alt: {
    auto_fixable: true,
    target: "wordpress_content",
    action:
      "Add a concise, meaningful alt attribute to each affected content image. Codex must supply the alt text from the image and surrounding context."
  },
  image_empty_alt: {
    auto_fixable: true,
    target: "wordpress_content",
    action:
      "Keep alt empty only for decorative images; otherwise replace it with concise, meaningful alt text."
  },
  missing_title: {
    auto_fixable: true,
    target: "wordpress_seo_meta",
    action: "Set a unique, descriptive SEO title in WordPress."
  },
  empty_title: {
    auto_fixable: true,
    target: "wordpress_seo_meta",
    action: "Set a non-empty, unique SEO title in WordPress."
  },
  multiple_titles: {
    auto_fixable: false,
    target: "theme_or_plugin",
    action: "Find which theme or SEO plugin emits the extra title element and remove that duplicate output."
  },
  missing_meta_description: {
    auto_fixable: true,
    target: "wordpress_seo_meta",
    action: "Write and save a concise answer-focused meta description in WordPress."
  },
  empty_meta_description: {
    auto_fixable: true,
    target: "wordpress_seo_meta",
    action: "Replace the empty meta description with concise answer-focused copy."
  },
  multiple_meta_descriptions: {
    auto_fixable: false,
    target: "theme_or_plugin",
    action: "Remove the duplicate meta-description output from the theme or overlapping SEO plugin."
  },
  missing_h1: {
    auto_fixable: false,
    target: "theme_or_template",
    action: "Ensure the page template renders the page title as one visible H1."
  },
  empty_h1: {
    auto_fixable: false,
    target: "wordpress_content_or_template",
    action: "Replace or remove the empty H1 after confirming whether it belongs to the post body or template."
  },
  missing_canonical: {
    auto_fixable: true,
    target: "wordpress_seo_meta",
    action: "Set the page's preferred public URL as its canonical URL."
  },
  empty_canonical: {
    auto_fixable: true,
    target: "wordpress_seo_meta",
    action: "Replace the empty canonical with the page's preferred public URL."
  },
  multiple_canonicals: {
    auto_fixable: false,
    target: "theme_or_plugin",
    action: "Remove the duplicate canonical output from the theme or overlapping SEO plugin."
  },
  canonical_differs_from_page: {
    auto_fixable: false,
    target: "review_required",
    action: "Confirm the preferred URL before changing the canonical; a different canonical can be intentional."
  },
  robots_noindex: {
    auto_fixable: false,
    target: "review_required",
    action: "Confirm the page should be indexed before removing the noindex directive."
  },
  robots_nofollow: {
    auto_fixable: false,
    target: "review_required",
    action: "Confirm links should be followed before removing the nofollow directive."
  },
  invalid_json_ld: {
    auto_fixable: true,
    target: "wordpress_schema_meta",
    action: "Replace the invalid JSON-LD with validated schema that matches the visible page content."
  },
  missing_html_lang: {
    auto_fixable: false,
    target: "theme_template",
    action: "Add the correct language attribute to the site's HTML template."
  },
  http_status_error: {
    auto_fixable: false,
    target: "hosting_or_wordpress",
    action: "Resolve the HTTP error or restore the page before making AEO content changes."
  },
  redirected_url: {
    auto_fixable: false,
    target: "review_required",
    action: "Use the final canonical URL unless the redirect is unintended."
  }
};

export class AeoFixerError extends Error {
  constructor(message) {
    super(message);
    this.name = "AeoFixerError";
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getAttribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(`\\s${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
  );
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : undefined;
}

function normalizeImageSource(source, pageUrl) {
  if (!source) return null;
  try {
    return new URL(source, pageUrl).href;
  } catch {
    return source;
  }
}

function altTextLookup(entries, pageUrl) {
  const lookup = new Map();
  for (const entry of entries || []) {
    const source = normalizeImageSource(entry.image_src, pageUrl);
    const altText = cleanText(entry.alt_text);
    if (source && altText) lookup.set(source, altText);
  }
  return lookup;
}

function convertContentH1s(contentHtml) {
  const openingCount = (contentHtml.match(/<h1\b/gi) || []).length;
  if (!openingCount) return { html: contentHtml, count: 0 };

  let html = contentHtml
    .replace(/<h1\b/gi, match => (match[1] === "H" ? "<H2" : "<h2"))
    .replace(/<\/h1\s*>/gi, match => (match[2] === "H" ? "</H2>" : "</h2>"));

  html = html.replace(
    /(<!--\s*wp:heading\s+)(\{[^]*?\})(\s*-->)/gi,
    (full, prefix, rawJson, suffix) => {
      try {
        const attributes = JSON.parse(rawJson);
        if (attributes.level !== 1) return full;
        attributes.level = 2;
        return `${prefix}${JSON.stringify(attributes)}${suffix}`;
      } catch {
        return full.replace(/"level"\s*:\s*1/, '"level":2');
      }
    }
  );

  return { html, count: openingCount };
}

function patchImageAlts(
  contentHtml,
  { pageUrl, entries, includeMissingAlt, includeEmptyAlt }
) {
  const lookup = altTextLookup(entries, pageUrl);
  const changes = [];
  const unresolved = [];

  const html = contentHtml.replace(/<img\b[^>]*>/gi, tag => {
    const source =
      getAttribute(tag, "src") ||
      getAttribute(tag, "data-src") ||
      getAttribute(tag, "data-lazy-src") ||
      null;
    const normalizedSource = normalizeImageSource(source, pageUrl);
    const existingAlt = getAttribute(tag, "alt");
    const needsAlt =
      (includeMissingAlt && existingAlt === undefined) ||
      (includeEmptyAlt && existingAlt !== undefined && !cleanText(existingAlt));

    if (!needsAlt) return tag;

    const altText = normalizedSource ? lookup.get(normalizedSource) : null;
    if (!altText) {
      unresolved.push({
        issue_code: existingAlt === undefined ? "image_missing_alt" : "image_empty_alt",
        image_src: normalizedSource,
        reason: "Meaningful alt text was not supplied."
      });
      return tag;
    }

    const escapedAlt = escapeAttribute(altText);
    let updatedTag;
    if (existingAlt === undefined) {
      updatedTag = tag.replace(/\s*\/?\s*>$/, ending => ` alt="${escapedAlt}"${ending}`);
    } else {
      updatedTag = tag.replace(
        /\salt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
        ` alt="${escapedAlt}"`
      );
    }

    changes.push({
      issue_code: existingAlt === undefined ? "image_missing_alt" : "image_empty_alt",
      action: "set_image_alt",
      image_src: normalizedSource,
      alt_text: altText
    });
    return updatedTag;
  });

  return { html, changes, unresolved };
}

export function buildAeoFixPlan(scan) {
  if (!scan || !Array.isArray(scan.issues)) {
    throw new AeoFixerError("A valid webpage scan result is required.");
  }

  const fixes = scan.issues.map(issue => {
    const guidance = FIX_GUIDANCE[issue.code] || {
      auto_fixable: false,
      target: "review_required",
      action: "Review this issue before changing the page."
    };
    return {
      issue_code: issue.code,
      severity: issue.severity,
      message: issue.message,
      ...guidance,
      ...(issue.evidence ? { evidence: issue.evidence } : {})
    };
  });

  return {
    page_url: scan.final_url || scan.requested_url,
    issue_count: fixes.length,
    automatically_actionable_count: fixes.filter(fix => fix.auto_fixable).length,
    fixes,
    workflow: [
      "Read the latest WordPress post content and SEO metadata.",
      "Prepare the proposed AEO fixes without publishing.",
      "Show the exact changes and request approval for the WordPress write.",
      "Update WordPress through the connected Pionex WordPress MCP.",
      "Recheck the public page until the targeted issues are gone.",
      "Submit the corrected URL to Bing when requested."
    ]
  };
}

export function prepareWordPressFixes({
  contentHtml,
  pageUrl,
  issueCodes,
  imageAltTexts = [],
  themeRendersTitleH1 = false
}) {
  if (typeof contentHtml !== "string") {
    throw new AeoFixerError("WordPress content_html must be a string.");
  }
  if (byteLength(contentHtml) > MAX_CONTENT_BYTES) {
    throw new AeoFixerError("WordPress content is larger than the 2 MB fix limit.");
  }

  const requested = [...new Set(issueCodes || [])];
  let updatedHtml = contentHtml;
  const changes = [];
  const unresolved = [];

  if (requested.includes("multiple_h1")) {
    if (!themeRendersTitleH1) {
      unresolved.push({
        issue_code: "multiple_h1",
        reason: "Confirm that the WordPress theme renders the post title as the page H1 before changing content headings."
      });
    } else {
      const converted = convertContentH1s(updatedHtml);
      updatedHtml = converted.html;
      if (converted.count) {
        changes.push({
          issue_code: "multiple_h1",
          action: "convert_content_h1_to_h2",
          count: converted.count
        });
      } else {
        unresolved.push({
          issue_code: "multiple_h1",
          reason: "No H1 was found in the WordPress post body; the duplicate likely comes from the theme or a plugin."
        });
      }
    }
  }

  const patchMissingAlt = requested.includes("image_missing_alt");
  const patchEmptyAlt = requested.includes("image_empty_alt");
  if (patchMissingAlt || patchEmptyAlt) {
    const patched = patchImageAlts(updatedHtml, {
      pageUrl,
      entries: imageAltTexts,
      includeMissingAlt: patchMissingAlt,
      includeEmptyAlt: patchEmptyAlt
    });
    updatedHtml = patched.html;
    changes.push(...patched.changes);
    unresolved.push(
      ...patched.unresolved.filter(item =>
        item.issue_code === "image_missing_alt" ? patchMissingAlt : patchEmptyAlt
      )
    );
  }

  for (const issueCode of requested) {
    if (!["multiple_h1", "image_missing_alt", "image_empty_alt"].includes(issueCode)) {
      unresolved.push({
        issue_code: issueCode,
        reason: "This issue needs a WordPress SEO field, schema field, theme, plugin, or manual review rather than a post-body change."
      });
    }
  }

  return {
    page_url: pageUrl,
    requested_issue_codes: requested,
    changed: updatedHtml !== contentHtml,
    ready_for_wordpress_update: updatedHtml !== contentHtml && unresolved.length === 0,
    changes,
    unresolved,
    updated_content_html: updatedHtml,
    next_steps: [
      "Review the proposed changes.",
      "With approval, pass updated_content_html to the connected WordPress update tool.",
      "Call seo_recheck_page for the targeted issue codes.",
      "If the recheck passes, submit the page to Bing when requested."
    ]
  };
}
