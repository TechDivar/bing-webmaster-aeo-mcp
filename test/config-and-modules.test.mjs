import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { readApiKey } from "../src/bing-client.mjs";
import {
  credentialFileCandidates,
  resolveConfigDirectory
} from "../src/config/credentials.mjs";
import { readIndexNowKey } from "../src/indexnow-client.mjs";
import {
  MODULE_NAMES,
  ModuleConfigurationError,
  moduleForTool,
  resolveEnabledModules
} from "../src/modules/registry.mjs";

test("resolves neutral config directories on macOS, Linux, and Windows", () => {
  assert.equal(
    resolveConfigDirectory({ platform: "darwin", env: {}, home: "/Users/test" }),
    "/Users/test/Library/Application Support/bing-webmaster-aeo-mcp"
  );
  assert.equal(
    resolveConfigDirectory({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/config" },
      home: "/home/test"
    }),
    "/config/bing-webmaster-aeo-mcp"
  );
  assert.equal(
    resolveConfigDirectory({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
      home: "C:\\Users\\test"
    }),
    join("C:\\Users\\test\\AppData\\Roaming", "bing-webmaster-aeo-mcp")
  );
});

test("supports an app-specific config override and explicit key files", () => {
  assert.equal(
    resolveConfigDirectory({
      platform: "linux",
      env: { BING_WEBMASTER_MCP_CONFIG_DIR: "/custom/mcp" },
      home: "/home/test"
    }),
    "/custom/mcp"
  );
  assert.deepEqual(
    credentialFileCandidates("bing-webmaster-api-key", {
      explicitPath: "/secure/bing-key",
      platform: "darwin",
      env: {},
      home: "/Users/test"
    }),
    ["/secure/bing-key"]
  );
});

test("keeps the previous Codex key location as a macOS fallback", async () => {
  const visited = [];
  const key = await readApiKey({
    env: {},
    platform: "darwin",
    home: "/Users/test",
    readFileImpl: async path => {
      visited.push(path);
      if (path.includes("/Codex/secrets/")) return "LEGACY-BING-KEY\n";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
  });

  assert.equal(key, "LEGACY-BING-KEY");
  assert.equal(visited.length, 2);
  assert.match(visited[0], /bing-webmaster-aeo-mcp\/secrets/);
  assert.match(visited[1], /Codex\/secrets/);
});

test("reads IndexNow credentials from the neutral cross-platform location", async () => {
  const visited = [];
  const key = await readIndexNowKey({
    env: { XDG_CONFIG_HOME: "/config" },
    platform: "linux",
    home: "/home/test",
    readFileImpl: async path => {
      visited.push(path);
      return "IndexNow-Neutral-Key-1234\n";
    }
  });

  assert.equal(key, "IndexNow-Neutral-Key-1234");
  assert.deepEqual(visited, [
    "/config/bing-webmaster-aeo-mcp/secrets/indexnow-key"
  ]);
});

test("enables all modules by default and accepts a selected list", () => {
  assert.deepEqual([...resolveEnabledModules()].sort(), [...MODULE_NAMES].sort());
  assert.deepEqual(
    [...resolveEnabledModules("seo,aeo")].sort(),
    ["aeo", "seo"]
  );
  assert.deepEqual(
    [...resolveEnabledModules(["bing", "indexnow"])].sort(),
    ["bing", "indexnow"]
  );
});

test("rejects unknown modules and assigns every tool family", () => {
  assert.throws(
    () => resolveEnabledModules("bing,wordpress"),
    error => error instanceof ModuleConfigurationError && /Unknown MCP module/.test(error.message)
  );

  assert.equal(moduleForTool("bing_get_query_stats").name, "bing");
  assert.equal(moduleForTool("aeo_find_ai_traffic_opportunities").name, "bing");
  assert.equal(moduleForTool("seo_scan_page").name, "seo");
  assert.equal(moduleForTool("aeo_prepare_wordpress_fixes").name, "seo");
  assert.equal(moduleForTool("aeo_audit_page").name, "aeo");
  assert.equal(moduleForTool("indexnow_submit_url").name, "indexnow");
  assert.equal(moduleForTool("unknown_tool"), null);
});
