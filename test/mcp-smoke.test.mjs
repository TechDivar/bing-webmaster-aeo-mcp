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
    assert.ok(names.includes("bing_get_link_counts"));
    assert.ok(names.includes("bing_get_url_links"));
    assert.ok(names.includes("bing_get_keyword_stats"));
    assert.ok(names.includes("bing_get_related_keywords"));
    assert.ok(names.includes("bing_get_query_page_stats"));
    assert.ok(names.includes("bing_get_query_page_detail_stats"));
    assert.ok(names.includes("bing_get_url_info"));
    assert.ok(names.includes("bing_get_children_url_traffic_info"));
    assert.ok(names.includes("bing_submit_url"));
    assert.ok(names.includes("bing_submit_url_batch"));
    assert.ok(names.includes("indexnow_validate_key"));
    assert.ok(names.includes("indexnow_submit_url"));
    assert.ok(names.includes("indexnow_submit_urls"));
    assert.ok(names.includes("seo_scan_page"));
    assert.ok(names.includes("seo_scan_pages"));
    assert.ok(names.includes("seo_recheck_page"));
    assert.ok(names.includes("aeo_plan_page_fixes"));
    assert.ok(names.includes("aeo_prepare_wordpress_fixes"));
    assert.ok(names.includes("aeo_audit_page"));
    assert.ok(names.includes("aeo_ai_readability_audit"));
    assert.ok(names.includes("aeo_entity_coverage"));
    assert.ok(names.includes("aeo_citation_readiness"));
    assert.ok(names.includes("aeo_intent_coverage"));
    assert.ok(names.includes("aeo_compare_pages"));
    assert.ok(names.includes("aeo_ai_overview_preview"));
    assert.ok(names.includes("aeo_extract_citable_chunks"));
    assert.ok(names.includes("aeo_internal_link_opportunities"));
    assert.ok(names.includes("aeo_schema_recommendations"));
    assert.ok(names.includes("aeo_freshness_audit"));
    assert.ok(names.includes("aeo_autofix_page"));
    assert.equal(names.length, 42);

    const submitTool = listed.tools.find(tool => tool.name === "bing_submit_url");
    assert.equal(submitTool.annotations.readOnlyHint, false);

    const batchTool = listed.tools.find(tool => tool.name === "bing_submit_url_batch");
    assert.equal(batchTool.annotations.readOnlyHint, false);
    assert.equal(batchTool.inputSchema.properties.urls.maxItems, 500);

    const indexNowTool = listed.tools.find(tool => tool.name === "indexnow_submit_urls");
    assert.equal(indexNowTool.annotations.readOnlyHint, false);
    assert.equal(indexNowTool.inputSchema.properties.urls.maxItems, 10_000);

    const prepareTool = listed.tools.find(
      tool => tool.name === "aeo_prepare_wordpress_fixes"
    );
    assert.equal(prepareTool.annotations.readOnlyHint, true);

    const autofixTool = listed.tools.find(tool => tool.name === "aeo_autofix_page");
    assert.equal(autofixTool.annotations.readOnlyHint, true);

    const result = await client.callTool({ name: "bing_list_sites", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /API key is not configured/);
  } finally {
    await client.close();
  }
});
