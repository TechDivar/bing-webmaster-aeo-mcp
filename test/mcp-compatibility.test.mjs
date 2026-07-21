import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function listTools({ clientName, modules }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "src", "server.mjs")],
    cwd: projectRoot,
    env: {
      ...(modules ? { MCP_MODULES: modules } : {}),
      BING_WEBMASTER_API_KEY_FILE: "/private/tmp/bing-webmaster-mcp-compat-missing-key"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: clientName, version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools.map(tool => tool.name).sort();
  } finally {
    await client.close();
  }
}

test("uses the standard stdio lifecycle regardless of MCP client identity", async () => {
  for (const clientName of ["codex-compatible", "claude-code-compatible", "editor-compatible"]) {
    const tools = await listTools({ clientName, modules: "seo" });
    assert.deepEqual(tools, [
      "aeo_plan_page_fixes",
      "aeo_prepare_wordpress_fixes",
      "seo_recheck_page",
      "seo_scan_page",
      "seo_scan_pages"
    ]);
  }
});

test("keeps all 46 existing tools enabled by default", async () => {
  const tools = await listTools({ clientName: "default-compatible-client" });
  assert.equal(tools.length, 46);
  assert.ok(tools.includes("bing_get_query_stats"));
  assert.ok(tools.includes("seo_scan_page"));
  assert.ok(tools.includes("aeo_audit_page"));
  assert.ok(tools.includes("indexnow_submit_urls"));
});

test("loads only explicitly enabled modules", async () => {
  const aeoTools = await listTools({ clientName: "aeo-only-client", modules: "aeo" });
  assert.equal(aeoTools.length, 15);
  assert.ok(aeoTools.includes("aeo_audit_page"));
  assert.equal(aeoTools.includes("aeo_find_ai_traffic_opportunities"), false);
  assert.equal(aeoTools.some(name => name.startsWith("bing_")), false);

  const bingAndIndexNow = await listTools({
    clientName: "reporting-client",
    modules: "bing,indexnow"
  });
  assert.equal(bingAndIndexNow.length, 26);
  assert.ok(bingAndIndexNow.includes("aeo_find_ai_traffic_opportunities"));
  assert.ok(bingAndIndexNow.includes("indexnow_validate_key"));
  assert.equal(bingAndIndexNow.some(name => name.startsWith("seo_")), false);
});
