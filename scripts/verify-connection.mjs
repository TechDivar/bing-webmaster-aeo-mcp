import { callBingApi } from "../src/bing-client.mjs";

try {
  const result = await callBingApi("GetUserSites");
  const sites = Array.isArray(result)
    ? result.map(site => ({ Url: site.Url, IsVerified: site.IsVerified }))
    : result;

  process.stdout.write(`${JSON.stringify({ connected: true, sites }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ connected: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
