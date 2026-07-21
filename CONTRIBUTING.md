# Contributing

Contributions from marketers, SEO specialists, content teams, and developers are welcome.

## Good contribution ideas

- Add deterministic AEO or technical SEO checks.
- Improve plain-language explanations and fix plans.
- Add safe CMS integrations.
- Improve accessibility, security, tests, or documentation.

## Before opening a pull request

1. Do not include API keys, customer URLs, private content, or credentials.
2. Keep write actions clearly marked and approval-gated.
3. Add or update tests for behavior changes.
4. Run `npm test`.
5. Explain what changed, why it helps marketers, and how it was verified.

Please keep checks deterministic where possible. A warning should include the affected URL, a stable issue code, and useful evidence.

## MCP compatibility

- Keep tool names and existing behavior backward compatible unless a breaking change is clearly documented.
- Keep client-specific assumptions out of tool logic. The server must work through standard MCP `stdio` regardless of which compatible client starts it.
- Assign every new tool to exactly one module in `src/modules/`.
- Test both the full default toolset and any affected filtered `MCP_MODULES` toolset.
- Keep WordPress publishing separate and approval-gated.
