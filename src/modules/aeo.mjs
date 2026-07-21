const TOOLS_REGISTERED_WITH_SEO = new Set([
  "aeo_plan_page_fixes",
  "aeo_prepare_wordpress_fixes"
]);

export const aeoModule = Object.freeze({
  name: "aeo",
  description: "AI-search, catalog, multilingual, entity, intent, citation, and freshness audits",
  matchesTool(toolName) {
    return toolName.startsWith("aeo_") &&
      toolName !== "aeo_find_ai_traffic_opportunities" &&
      !TOOLS_REGISTERED_WITH_SEO.has(toolName);
  }
});
