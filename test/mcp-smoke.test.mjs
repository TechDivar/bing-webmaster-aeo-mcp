import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("serves tools over MCP stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "src", "server.mjs")],
    cwd: projectRoot,
    env: {
      BING_WEBMASTER_API_KEY_FILE: "/private/tmp/bing-webmaster-mcp-test-missing-key"
    },
    stderr: "pipe"
  });

  const client = new Client({ name: "bing-mcp-smoke-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);

    assert.ok(names.includes("bing_list_sites"));
    assert.ok(names.includes("bing_get_query_stats"));
    assert.ok(names.includes("bing_get_fetched_url_details"));
    assert.ok(names.includes("bing_get_url_traffic_info"));
    assert.ok(names.includes("bing_submit_url"));
    assert.ok(names.includes("seo_scan_page"));
    assert.ok(names.includes("seo_scan_pages"));
    assert.ok(names.includes("seo_recheck_page"));
    assert.ok(names.includes("aeo_plan_page_fixes"));
    assert.ok(names.includes("aeo_prepare_wordpress_fixes"));
    assert.equal(names.includes("bing_get_url_info"), false);

    const submitTool = listed.tools.find(tool => tool.name === "bing_submit_url");
    assert.equal(submitTool.annotations.readOnlyHint, false);

    const prepareTool = listed.tools.find(
      tool => tool.name === "aeo_prepare_wordpress_fixes"
    );
    assert.equal(prepareTool.annotations.readOnlyHint, true);

    const result = await client.callTool({ name: "bing_list_sites", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /API key is not configured/);
  } finally {
    await client.close();
  }
});
