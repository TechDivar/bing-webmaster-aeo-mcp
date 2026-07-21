export const bingModule = Object.freeze({
  name: "bing",
  description: "Bing Webmaster reporting, GA4 opportunity matching, and Bing submissions",
  matchesTool(toolName) {
    return toolName.startsWith("bing_") ||
      toolName === "aeo_find_ai_traffic_opportunities";
  }
});
