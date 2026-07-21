# Architecture

The server is vendor-neutral: an MCP client starts `src/server.mjs` and communicates through standard input and output.

```text
MCP client
  -> standard stdio server
     -> module router
        -> Bing client and submission safety
        -> SEO webpage scanner and fix preparation
        -> AEO and catalog audits
        -> IndexNow client and submission safety
```

## Modules

The module router lives in `src/modules/`:

- `bing` owns Bing reporting, Bing submission, and Bing + GA4 opportunity tools.
- `seo` owns page scanning, rechecking, and fix-preparation tools.
- `aeo` owns AI-search, catalog, and multilingual audit tools.
- `indexnow` owns the separate IndexNow integration.

`MCP_MODULES` controls which groups are registered. The default remains all modules, so existing users keep all 46 tools.

## Feature engines

Feature behavior remains in focused files under `src/`, including the Bing client, webpage scanner, AEO auditor, catalog auditor, fix engine, opportunity matcher, Bing submission safety, and IndexNow client. Module routing changes which tools are visible; it does not weaken their validation or security checks.

## Credentials

`src/config/credentials.mjs` resolves private credential files consistently across macOS, Linux, and Windows. Direct environment values and explicit key-file paths are also supported. Secrets are never returned by a tool.

## WordPress boundary

WordPress publishing is deliberately outside this repository. This MCP can scan content and prepare an approval-gated diff. A separate WordPress MCP must perform any approved website write.
