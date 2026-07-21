import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIRECTORY = "bing-webmaster-aeo-mcp";
const LEGACY_CODEX_DIRECTORY = join(
  "Library",
  "Application Support",
  "Codex",
  "secrets"
);

export function resolveConfigDirectory({
  platform = process.platform,
  env = process.env,
  home = homedir()
} = {}) {
  const explicit = env.BING_WEBMASTER_MCP_CONFIG_DIR?.trim();
  if (explicit) return explicit;

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", APP_DIRECTORY);
  }
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(appData, APP_DIRECTORY);
  }

  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(xdgConfig, APP_DIRECTORY);
}

export function credentialFileCandidates(
  fileName,
  {
    explicitPath,
    platform = process.platform,
    env = process.env,
    home = homedir()
  } = {}
) {
  if (explicitPath?.trim()) return [explicitPath.trim()];

  const candidates = [
    join(resolveConfigDirectory({ platform, env, home }), "secrets", fileName)
  ];

  if (platform === "darwin") {
    candidates.push(join(home, LEGACY_CODEX_DIRECTORY, fileName));
  }

  return [...new Set(candidates)];
}

export function defaultCredentialPath(fileName, options = {}) {
  return credentialFileCandidates(fileName, options)[0];
}
