# AI Search Operations MCP for Bing Webmaster

An open-source MCP server that helps marketers improve pages for human readers and AI search. It combines Bing Webmaster data, technical SEO scanning, AI-search content audits, approval-gated WordPress fix preparation, live verification, and Bing URL submission.

No API key is stored in this repository.

## What marketers can do

- See the queries and pages already receiving Bing impressions and clicks.
- Review rankings, crawl activity, crawl issues, sitemaps, and submission quota.
- Scan one page or up to 20 pages for common SEO/AEO problems.
- Find duplicate H1s, missing image alt text, metadata, canonical, robots, language, HTTP, and JSON-LD problems.
- Audit AI readability, entity coverage, citation readiness, intent coverage, schema fit, internal links, and freshness.
- Compare heading topics with public competitor pages.
- Preview the answer that can be extracted using only the page's own words.
- Find concise passages that are easier to quote or paraphrase accurately.
- Turn every finding into a clear fix plan and exact before/after diff.
- Prepare corrected WordPress HTML without publishing it automatically.
- Recheck the live page after a fix.
- Submit an approved URL or sitemap to Bing.

## Example prompts for Codex

> List the websites connected to my Bing Webmaster account.

> Show my top Bing queries and pages.

> Scan these 10 URLs and group the AEO problems by priority.

> Audit this page for AI readability, citation readiness, missing entities, intent gaps, schema, and freshness.

> Compare this article with these three competitors and show only meaningful topic gaps.

> Find internal-link opportunities using this list of published pages. Do not invent URLs.

> Scan this WordPress article, prepare the safe fixes, show me the changes, update it after I approve, verify the live page, then submit it to Bing.

## How the automated workflow works

1. `aeo_audit_page` runs the full technical and AI-search audit.
2. Codex reads the latest post through your connected WordPress MCP.
3. `aeo_autofix_page` applies only exact proposed replacements in memory and returns a before/after diff.
4. The tool marks the package `approval_required: true` and does not publish.
5. Codex shows the changes and requests approval before a WordPress write.
6. After approval, the connected WordPress MCP updates the post.
7. `seo_recheck_page` and the AEO audits verify the public result.
8. `bing_submit_url` requests a fresh Bing crawl when you ask for it.

The fixer will not invent image descriptions, internal destination URLs, facts, prices, or competitor claims. Codex must supply proposed wording from reviewed source material. It also requires confirmation that the WordPress theme already renders the post title as the page H1 before changing content-body H1s to H2s.

## The 30 MCP tools

### Bing Webmaster data

- `bing_list_sites`
- `bing_get_query_stats`
- `bing_get_page_stats`
- `bing_get_rank_and_traffic_stats`
- `bing_get_crawl_stats`
- `bing_get_crawl_issues`
- `bing_get_sitemaps`
- `bing_get_fetched_url_details`
- `bing_get_url_traffic_info`
- `bing_get_page_query_stats`
- `bing_get_url_submission_quota`

### Live SEO/AEO scanning and fixes

- `seo_scan_page`
- `seo_scan_pages`
- `seo_recheck_page`
- `aeo_plan_page_fixes`
- `aeo_prepare_wordpress_fixes`

### AI-search operations

- `aeo_audit_page` — run all AI-search audits together
- `aeo_ai_readability_audit` — direct answers, definitions, headings, structure, and marketing language
- `aeo_entity_coverage` — check a primary entity and supplied related entities
- `aeo_citation_readiness` — score extractable, structured, supported passages
- `aeo_intent_coverage` — detect six common intent types and missing expected intents
- `aeo_compare_pages` — compare visible heading topics with up to five competitors
- `aeo_ai_overview_preview` — create a page-only extractive answer preview
- `aeo_extract_citable_chunks` — find concise standalone definitions and facts
- `aeo_internal_link_opportunities` — match content to a supplied inventory of real URLs
- `aeo_schema_recommendations` — validate JSON-LD and assess schema fit
- `aeo_freshness_audit` — flag dates, prices, limits, relative claims, and screenshots for review
- `aeo_autofix_page` — prepare an exact diff and require approval; never publish

### Bing submissions

- `bing_submit_url`
- `bing_submit_sitemap`

Submission tools are marked as write actions. Audits and fix-preparation tools are read-only because they do not change the website.

## Honest scoring and limitations

The AI-search scores are transparent HTML and language-pattern heuristics. They are useful editorial signals, not secret access to an LLM or a guarantee that ChatGPT, Copilot, Google, or Bing will cite a page.

- Entity gaps are measured against related entities you supply. Heuristically detected entities are labelled as such.
- Internal-link suggestions come only from URLs you supply. The MCP does not invent destinations.
- The answer preview extracts existing page passages. It does not simulate a proprietary AI answer.
- Competitor gaps compare headings and topics. They are research leads, not instructions to copy text.
- Freshness findings mean “verify this,” not “this is false.”
- Schema suggestions must match visible content and current search-platform rules.
- `aeo_autofix_page` prepares changes only. A connected WordPress MCP is needed to publish after human approval.

## Important Bing limitation

Bing's public Webmaster API does not expose the complete URL Inspection report shown in Bing Webmaster Tools. Dashboard warnings such as multiple H1 headings and missing image alt attributes are not returned by `GetCrawlIssues`.

The scanner therefore fetches and checks the public HTML independently. It does not claim to reproduce Bing's private dashboard logic, execute JavaScript, or access private/local network addresses.

## Install

You need Node.js 20 or newer, Codex, a Bing Webmaster account, and a Bing Webmaster API key.

```bash
git clone https://github.com/TechDivar/bing-webmaster-aeo-mcp.git
cd bing-webmaster-aeo-mcp
npm install
npm run setup-key
```

The setup hides the key while you type and stores it locally with owner-only permissions at:

`~/Library/Application Support/Codex/secrets/bing-webmaster-api-key`

The webpage scanner works without a Bing API key.

## Connect it to Codex

From the repository folder, run:

```bash
codex mcp add bing-webmaster -- node "$PWD/src/server.mjs"
```

Restart Codex. You can then ask Codex to list the Bing sites to confirm the connection.

## Development

```bash
npm install
npm test
npm start
```

## Security

Never paste an API key into a prompt, issue, commit, or screenshot. See [SECURITY.md](SECURITY.md) for the security model and vulnerability-reporting guidance.

## Contributing

Marketers, SEO specialists, content teams, and developers are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
