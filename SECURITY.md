# Security

## API keys

Never put a Bing Webmaster API key or IndexNow key in this repository, an issue, a prompt, a screenshot, or a checked-in MCP configuration file.

The setup scripts save keys outside the repository in an operating-system-specific private folder:

| Platform | Default private folder |
| --- | --- |
| macOS | `~/Library/Application Support/bing-webmaster-aeo-mcp/secrets/` |
| Linux | `~/.config/bing-webmaster-aeo-mcp/secrets/` |
| Windows | `%APPDATA%\bing-webmaster-aeo-mcp\secrets\` |

The files are created with owner-only permissions. Existing macOS installations may still read the previous Codex secrets path as a compatibility fallback. New keys are saved only in the neutral folder.

Private environment settings are also supported through `BING_WEBMASTER_API_KEY`, `BING_WEBMASTER_API_KEY_FILE`, `INDEXNOW_KEY`, and `INDEXNOW_KEY_FILE`. Prefer file paths or your MCP client's secret-input feature over plain-text shared configuration.

Neither secret is returned by an MCP tool. Bing errors are redacted. IndexNow submission redirects are not replayed, which prevents the secret-bearing request body from being sent to another location.

WordPress credentials are not accepted or stored by this repository. Publishing requires a separately configured WordPress MCP.

## Safe tool behavior

- Scanning and fix preparation are read-only.
- Loading fewer modules with `MCP_MODULES` changes the visible tool list but does not bypass validation or security checks.
- The local server uses standard MCP `stdio`; one client starts and communicates with its own server process.
- Bing and IndexNow submissions are marked as write actions.
- WordPress changes should be previewed and approved before a connected WordPress MCP writes them.
- `aeo_autofix_page` never publishes. It applies only exact unique replacements in memory, returns a diff, and keeps `approval_required` true.
- Autofix replacement fragments reject scripts, forms, inline event handlers, and `javascript:` URLs.
- The scanner blocks local and private network addresses, nonstandard ports, oversized pages, and excessive redirects.
- HTML pages and plain-text catalog resources use the same redirect-by-redirect SSRF checks and 5 MB response limit.
- Bing and IndexNow submissions reuse the public-URL checks and reject URLs outside the configured site or host.
- IndexNow key validation follows only public, same-host redirects and never returns the key or key-file URL.
- The fixer does not guess image alt text or remove `noindex` directives automatically.
- `aeo_find_ai_traffic_opportunities` accepts only aggregate page/source/traffic data. It does not need a Google credential, does not call GA4, does not return the raw CSV, and rejects GA4 page URLs from another host.
- Do not supply GA4 exports containing user identifiers, event-level records, emails, client IDs, or other personal data.

## Reporting a vulnerability

Please do not open a public issue containing a secret or exploitable security detail. Use GitHub's private security-advisory reporting for this repository instead.
