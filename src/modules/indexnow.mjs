export const indexNowModule = Object.freeze({
  name: "indexnow",
  description: "IndexNow key validation and URL-change notifications",
  matchesTool(toolName) {
    return toolName.startsWith("indexnow_");
  }
});
