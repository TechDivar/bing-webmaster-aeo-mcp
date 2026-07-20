# Security

## API keys

Never put a Bing Webmaster API key or IndexNow key in this repository, an issue, a prompt, a screenshot, or an MCP configuration file.

The included setup script saves the key outside the repository at:

`~/Library/Application Support/Codex/secrets/bing-webmaster-api-key`

The file is created with owner-only permissions. The server also redacts the key from Bing error messages.

The separate IndexNow setup stores its key at:

`~/Library/Application Support/Codex/secrets/indexnow-key`

Neither secret is returned by an MCP tool. IndexNow submission redirects are not replayed, which prevents the secret-bearing request body from being sent to another location.

## Safe tool behavior

- Scanning and fix preparation are read-only.
- Bing and IndexNow submissions are marked as write actions.
- WordPress changes should be previewed and approved before a connected WordPress MCP writes them.
- `aeo_autofix_page` never publishes. It applies only exact unique replacements in memory, returns a diff, and keeps `approval_required` true.
- Autofix replacement fragments reject scripts, forms, inline event handlers, and `javascript:` URLs.
- The scanner blocks local and private network addresses, nonstandard ports, oversized pages, and excessive redirects.
- Bing and IndexNow submissions reuse the public-URL checks and reject URLs outside the configured site or host.
- IndexNow key validation follows only public, same-host redirects and never returns the key or key-file URL.
- The fixer does not guess image alt text or remove `noindex` directives automatically.

## Reporting a vulnerability

Please do not open a public issue containing a secret or exploitable security detail. Use GitHub's private security-advisory reporting for this repository instead.
