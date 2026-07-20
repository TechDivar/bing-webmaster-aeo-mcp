# Bing Webmaster AEO MCP

An open-source MCP server that helps marketers use Bing Webmaster data, find technical SEO/AEO problems, prepare safe WordPress fixes, verify the live page, and request a fresh Bing crawl from Codex.

No API key is stored in this repository.

## What marketers can do

- See the queries and pages already receiving Bing impressions and clicks.
- Review rankings, crawl activity, crawl issues, sitemaps, and submission quota.
- Scan one page or up to 20 pages for common SEO/AEO problems.
- Find duplicate H1s, missing image alt text, metadata, canonical, robots, language, HTTP, and JSON-LD problems.
- Turn every finding into a clear fix plan.
- Prepare corrected WordPress HTML without publishing it automatically.
- Recheck the live page after a fix.
- Submit an approved URL or sitemap to Bing.

## Example prompts for Codex

> List the websites connected to my Bing Webmaster account.

> Show my top Bing queries and pages.

> Scan these 10 URLs and group the AEO problems by priority.

> Scan this WordPress article, prepare the safe fixes, show me the changes, update it after I approve, verify the live page, then submit it to Bing.

## How the automated workflow works

1. `seo_scan_page` finds live-page problems.
2. `aeo_plan_page_fixes` explains where and how each problem should be fixed.
3. Codex reads the latest post through your connected WordPress MCP.
4. `aeo_prepare_wordpress_fixes` prepares corrected content without publishing.
5. Codex shows the changes and requests approval before a WordPress write.
6. `seo_recheck_page` verifies the public page after the update.
7. `bing_submit_url` requests a fresh Bing crawl when you ask for it.

The fixer will not invent image descriptions. Codex must supply meaningful alt text based on the image and its surrounding content. It also requires confirmation that the WordPress theme already renders the post title as the page H1 before changing content-body H1s to H2s.

## The 18 MCP tools

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

### Bing submissions

- `bing_submit_url`
- `bing_submit_sitemap`

Submission tools are marked as write actions. The scanning and fix-preparation tools are read-only.

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
