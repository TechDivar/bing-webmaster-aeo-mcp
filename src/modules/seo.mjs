const SEO_AEO_TOOLS = new Set([
  "aeo_plan_page_fixes",
  "aeo_prepare_wordpress_fixes"
]);

export const seoModule = Object.freeze({
  name: "seo",
  description: "Live technical SEO scanning, rechecking, and safe fix preparation",
  matchesTool(toolName) {
    return toolName.startsWith("seo_") || SEO_AEO_TOOLS.has(toolName);
  }
});
