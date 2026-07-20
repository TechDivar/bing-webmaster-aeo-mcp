# Security

## API keys

Never put a Bing Webmaster API key in this repository, an issue, a prompt, a screenshot, or an MCP configuration file.

The included setup script saves the key outside the repository at:

`~/Library/Application Support/Codex/secrets/bing-webmaster-api-key`

The file is created with owner-only permissions. The server also redacts the key from Bing error messages.

## Safe tool behavior

- Scanning and fix preparation are read-only.
- Bing submissions are marked as write actions.
- WordPress changes should be previewed and approved before a connected WordPress MCP writes them.
- The scanner blocks local and private network addresses, nonstandard ports, oversized pages, and excessive redirects.
- The fixer does not guess image alt text or remove `noindex` directives automatically.

## Reporting a vulnerability

Please do not open a public issue containing a secret or exploitable security detail. Use GitHub's private security-advisory reporting for this repository instead.
