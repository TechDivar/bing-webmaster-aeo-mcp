import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://ssl.bing.com/webmaster/api.svc/json";
const SECRET_FILE_NAME = "bing-webmaster-api-key";
const REDACTED_KEYS = new Set([
  "apikey",
  "authenticationcode",
  "dnsverificationcode",
  "accesstoken",
  "refreshtoken",
  "clientsecret"
]);

export const defaultSecretPath = join(
  homedir(),
  "Library",
  "Application Support",
  "Codex",
  "secrets",
  SECRET_FILE_NAME
);

export class BingWebmasterError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "BingWebmasterError";
    this.status = status;
  }
}

export async function readApiKey() {
  const environmentKey = process.env.BING_WEBMASTER_API_KEY?.trim();
  if (environmentKey) return environmentKey;

  const keyPath = process.env.BING_WEBMASTER_API_KEY_FILE || defaultSecretPath;

  try {
    const fileKey = (await readFile(keyPath, "utf8")).trim();
    if (fileKey) return fileKey;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new BingWebmasterError(
        "The Bing API key file could not be read. Run the secure key setup again."
      );
    }
  }

  throw new BingWebmasterError(
    "Bing API key is not configured. Run scripts/setup-key.command, enter the key, and restart Codex."
  );
}

export function normalizeBingValue(value) {
  if (typeof value === "string") {
    const dateMatch = value.match(/^\/Date\((-?\d+)(?:[-+]\d{4})?\)\/$/);
    if (dateMatch) {
      const date = new Date(Number(dateMatch[1]));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    return value;
  }

  if (Array.isArray(value)) return value.map(normalizeBingValue);

  if (value && typeof value === "object") {
    const cleaned = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "__type" || REDACTED_KEYS.has(key.toLowerCase())) continue;
      cleaned[key] = normalizeBingValue(child);
    }
    return cleaned;
  }

  return value;
}

function readableApiMessage(payload, fallback) {
  const message =
    payload?.Message ||
    payload?.message ||
    payload?.Error?.Message ||
    payload?.d?.Message ||
    fallback;

  return String(message || "Unknown Bing Webmaster API error").slice(0, 800);
}

function redactText(text, apiKey) {
  return String(text).split(apiKey).join("[REDACTED]");
}

function escapeCurlConfig(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, "");
}

async function curlRequest(url, { httpMethod, body, apiKey }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--silent",
      "--show-error",
      "--location",
      "--max-time",
      "30",
      "--config",
      "/dev/fd/3",
      "--write-out",
      "\n%{http_code}"
    ];

    if (httpMethod !== "GET") args.push("--request", httpMethod);
    args.push("--header", "Accept: application/json");

    if (body) {
      args.push("--header", "Content-Type: application/json");
      args.push("--data-binary", "@-");
    }

    const child = spawn("/usr/bin/curl", args, {
      stdio: ["pipe", "pipe", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", chunk => stdoutChunks.push(chunk));
    child.stderr.on("data", chunk => stderrChunks.push(chunk));
    child.on("error", () => {
      reject(
        new BingWebmasterError(
          "Could not start the secure macOS network client for Bing Webmaster."
        )
      );
    });

    child.on("close", code => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = redactText(
        Buffer.concat(stderrChunks).toString("utf8").trim(),
        apiKey
      );

      if (code !== 0) {
        reject(
          new BingWebmasterError(
            stderr || "Could not connect to Bing Webmaster through macOS."
          )
        );
        return;
      }

      const statusBoundary = stdout.lastIndexOf("\n");
      const responseText = statusBoundary >= 0
        ? stdout.slice(0, statusBoundary)
        : stdout;
      const status = Number(stdout.slice(statusBoundary + 1));

      resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        text: async () => responseText
      });
    });

    child.stdio[3].end(`url = "${escapeCurlConfig(url.toString())}"\n`);
    child.stdin.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function callBingApi(
  method,
  {
    httpMethod = "GET",
    params = {},
    body,
    apiKey,
    fetchImpl = globalThis.fetch,
    baseUrl = process.env.BING_WEBMASTER_BASE_URL || DEFAULT_BASE_URL
  } = {}
) {
  const resolvedKey = apiKey || (await readApiKey());
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${method}`);
  url.searchParams.set("apikey", resolvedKey);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let response;
  const useInjectedFetch = fetchImpl !== globalThis.fetch;
  const preferCurl =
    !useInjectedFetch &&
    (process.env.BING_WEBMASTER_HTTP_TRANSPORT === "curl" ||
      (process.platform === "darwin" &&
        process.env.BING_WEBMASTER_HTTP_TRANSPORT !== "fetch"));

  try {
    if (preferCurl) {
      response = await curlRequest(url, { httpMethod, body, apiKey: resolvedKey });
    } else {
      response = await fetchImpl(url, {
        method: httpMethod,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000)
      });
    }
  } catch (error) {
    if (error instanceof BingWebmasterError) throw error;
    throw new BingWebmasterError(
      "Could not connect to Bing Webmaster. Check your internet connection and try again."
    );
  }

  const rawText = await response.text();
  let payload = null;

  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = rawText;
    }
  }

  if (!response.ok) {
    const safeMessage = redactText(
      readableApiMessage(payload, response.statusText),
      resolvedKey
    );
    throw new BingWebmasterError(
      `Bing Webmaster API returned ${response.status}: ${safeMessage}`,
      response.status
    );
  }

  const unwrapped = payload && typeof payload === "object" && "d" in payload
    ? payload.d
    : payload;

  return normalizeBingValue(unwrapped);
}

export function limitRows(value, limit = 100) {
  return Array.isArray(value) ? value.slice(0, limit) : value;
}

export function isUrlWithinSite(siteUrl, targetUrl) {
  const site = new URL(siteUrl);
  const target = new URL(targetUrl);
  const stripWww = hostname => hostname.toLowerCase().replace(/^www\./, "");
  const siteHost = stripWww(site.hostname);
  const targetHost = stripWww(target.hostname);

  return (
    site.protocol.startsWith("http") &&
    target.protocol.startsWith("http") &&
    (targetHost === siteHost || targetHost.endsWith(`.${siteHost}`))
  );
}
