import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import {
  credentialFileCandidates,
  defaultCredentialPath
} from "./config/credentials.mjs";
import { validatePublicUrl } from "./web-scanner.mjs";

const DEFAULT_ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_REDIRECTS = 5;
const MAX_KEY_FILE_BYTES = 16 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const CHANGE_TYPES = new Set(["added", "updated", "deleted"]);

export const INDEXNOW_MAX_URLS_PER_REQUEST = 10_000;
export const defaultIndexNowSecretPath = defaultCredentialPath("indexnow-key");

export class IndexNowError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "IndexNowError";
    this.status = status;
  }
}

export async function readIndexNowKey({
  env = process.env,
  platform = process.platform,
  home,
  readFileImpl = readFile
} = {}) {
  const environmentKey = env.INDEXNOW_KEY?.trim();
  if (environmentKey) return validateKey(environmentKey);

  const candidates = credentialFileCandidates("indexnow-key", {
    explicitPath: env.INDEXNOW_KEY_FILE,
    platform,
    env,
    home
  });
  for (const keyPath of candidates) {
    try {
      const fileKey = (await readFileImpl(keyPath, "utf8")).trim();
      if (fileKey) return validateKey(fileKey);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new IndexNowError(
          "The IndexNow key file could not be read. Run the secure IndexNow key setup again."
        );
      }
    }
  }

  throw new IndexNowError(
    "IndexNow key is not configured. Run npm run setup-indexnow-key or provide INDEXNOW_KEY, then restart your MCP client."
  );
}

function validateKey(key) {
  if (!KEY_PATTERN.test(key)) {
    throw new IndexNowError(
      "The configured IndexNow key does not meet the official 8 to 128 character format."
    );
  }
  return key;
}

function exactHostMatches(first, second) {
  return first.host.toLowerCase() === second.host.toLowerCase();
}

function safeNetworkReason(status) {
  const reasons = {
    400: "IndexNow rejected the request format.",
    403: "IndexNow could not validate the configured key.",
    422: "IndexNow rejected URLs that do not match the submitted host or key scope.",
    429: "IndexNow rejected the request because too many URLs were submitted."
  };
  return reasons[status] || `IndexNow returned HTTP ${status}.`;
}

async function resolveConfiguration({ siteUrl, key, keyLocation, validateUrl }) {
  let site;
  try {
    site = await validateUrl(siteUrl);
  } catch (error) {
    throw new IndexNowError(`The configured site is not a valid public URL: ${error.message}`);
  }

  const configuredLocation = keyLocation || process.env.INDEXNOW_KEY_LOCATION;
  let location;
  try {
    location = configuredLocation
      ? new URL(configuredLocation)
      : new URL(`/${key}.txt`, site.origin);
  } catch {
    throw new IndexNowError("The configured IndexNow key location is not a valid URL.");
  }

  try {
    await validateUrl(location.href);
  } catch (error) {
    throw new IndexNowError(`The IndexNow key location is not a valid public URL: ${error.message}`);
  }

  if (!exactHostMatches(site, location)) {
    throw new IndexNowError(
      "The IndexNow key file must be hosted on the same host as the configured site."
    );
  }

  const customLocation = Boolean(configuredLocation);
  const scopePath = customLocation
    ? `${posix.dirname(location.pathname).replace(/\/$/, "")}/`
    : "/";

  return { site, location, customLocation, scopePath };
}

export async function validateIndexNowKey({
  siteUrl,
  key,
  keyLocation,
  fetchImpl = globalThis.fetch,
  validateUrl = validatePublicUrl
}) {
  const resolvedKey = validateKey(key || (await readIndexNowKey()));
  const config = await resolveConfiguration({
    siteUrl,
    key: resolvedKey,
    keyLocation,
    validateUrl
  });

  let current = config.location;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        headers: { Accept: "text/plain" },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      return validationResult(config, false, null, redirects, "The IndexNow key file could not be fetched.");
    }

    if (response.status >= 300 && response.status < 400) {
      const destination = response.headers.get("location");
      if (!destination || redirects === MAX_REDIRECTS) {
        return validationResult(config, false, response.status, redirects, "The IndexNow key file redirect could not be followed safely.");
      }

      const next = new URL(destination, current);
      try {
        await validateUrl(next.href);
      } catch {
        return validationResult(config, false, response.status, redirects, "The IndexNow key file redirected to an unsafe URL.");
      }
      if (!exactHostMatches(config.site, next)) {
        return validationResult(config, false, response.status, redirects, "The IndexNow key file redirected to a different host.");
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      return validationResult(config, false, response.status, redirects, `The IndexNow key file returned HTTP ${response.status}.`);
    }

    const lengthHeader = Number(response.headers.get("content-length"));
    if (Number.isFinite(lengthHeader) && lengthHeader > MAX_KEY_FILE_BYTES) {
      return validationResult(config, false, response.status, redirects, "The IndexNow key file is unexpectedly large.", true);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_KEY_FILE_BYTES) {
      return validationResult(config, false, response.status, redirects, "The IndexNow key file is unexpectedly large.", true);
    }

    const valid = text.trim() === resolvedKey;
    return validationResult(
      config,
      valid,
      response.status,
      redirects,
      valid ? null : "The IndexNow key file content does not match the configured key.",
      true
    );
  }

  return validationResult(config, false, null, MAX_REDIRECTS, "The IndexNow key file exceeded the redirect limit.");
}

function validationResult(config, valid, httpStatus, redirects, reason, accessible = valid) {
  return {
    valid,
    site_host: config.site.host,
    key_file: {
      same_host: true,
      custom_location: config.customLocation,
      accessible
    },
    http_status: httpStatus,
    redirects_followed: redirects,
    ...(reason ? { reason } : {})
  };
}

function submissionResult({ siteUrl, success, failed, skipped, keyValidation }) {
  return {
    site_url: siteUrl,
    maximum_urls_per_request: INDEXNOW_MAX_URLS_PER_REQUEST,
    key_validation: keyValidation,
    summary: {
      accepted: success.length,
      failed: failed.length,
      skipped: skipped.length
    },
    success,
    failed,
    skipped,
    notice:
      "IndexNow accepts notifications for added, updated, and deleted URLs, but submission does not guarantee crawling or indexing. The change type is workflow context and is not sent as a separate IndexNow field."
  };
}

function submissionItem(item, code, reason, status) {
  return {
    url: item.url,
    change_type: item.changeType,
    ...(code ? { code } : {}),
    ...(reason ? { reason } : {}),
    ...(status ? { http_status: status } : {})
  };
}

export async function submitIndexNowUrls({
  siteUrl,
  entries,
  key,
  keyLocation,
  endpoint = process.env.INDEXNOW_ENDPOINT || DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  validateUrl = validatePublicUrl
}) {
  const resolvedKey = validateKey(key || (await readIndexNowKey()));
  const config = await resolveConfiguration({
    siteUrl,
    key: resolvedKey,
    keyLocation,
    validateUrl
  });
  const keyValidation = await validateIndexNowKey({
    siteUrl,
    key: resolvedKey,
    keyLocation,
    fetchImpl,
    validateUrl
  });

  const success = [];
  const failed = [];
  const skipped = [];
  const valid = [];
  const seen = new Set();

  for (const rawEntry of entries) {
    const item = {
      url: String(rawEntry?.url || "").trim(),
      changeType: String(rawEntry?.changeType || "updated").toLowerCase()
    };

    if (!item.url || !CHANGE_TYPES.has(item.changeType)) {
      skipped.push(
        submissionItem(
          item,
          !item.url ? "invalid_url" : "invalid_change_type",
          !item.url
            ? "Enter a valid public URL."
            : "Use added, updated, or deleted as the change type."
        )
      );
      continue;
    }
    if (seen.has(item.url)) {
      skipped.push(submissionItem(item, "duplicate_url", "The URL appeared more than once."));
      continue;
    }
    seen.add(item.url);

    let parsed;
    try {
      parsed = await validateUrl(item.url);
    } catch (error) {
      skipped.push(submissionItem(item, "invalid_url", error.message));
      continue;
    }

    if (!exactHostMatches(config.site, parsed)) {
      skipped.push(
        submissionItem(
          item,
          "wrong_host",
          "The URL does not belong to the configured IndexNow host."
        )
      );
      continue;
    }
    if (!parsed.pathname.startsWith(config.scopePath)) {
      skipped.push(
        submissionItem(
          item,
          "outside_key_scope",
          "The URL is outside the configured IndexNow key file's path scope."
        )
      );
      continue;
    }

    valid.push(item);
  }

  if (!keyValidation.valid) {
    failed.push(
      ...valid.map(item =>
        submissionItem(item, "key_validation_failed", keyValidation.reason)
      )
    );
    return submissionResult({ siteUrl, success, failed, skipped, keyValidation });
  }

  let endpointUrl;
  try {
    endpointUrl = await validateUrl(endpoint);
  } catch (error) {
    throw new IndexNowError(`The IndexNow endpoint is not a valid public URL: ${error.message}`);
  }

  for (let offset = 0; offset < valid.length; offset += INDEXNOW_MAX_URLS_PER_REQUEST) {
    const chunk = valid.slice(offset, offset + INDEXNOW_MAX_URLS_PER_REQUEST);
    const body = {
      host: config.site.host,
      key: resolvedKey,
      ...(config.customLocation ? { keyLocation: config.location.href } : {}),
      urlList: chunk.map(item => item.url)
    };

    let response;
    try {
      response = await fetchImpl(endpointUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      failed.push(
        ...chunk.map(item =>
          submissionItem(item, "submission_failed", "Could not connect to IndexNow.")
        )
      );
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      failed.push(
        ...chunk.map(item =>
          submissionItem(
            item,
            "unsafe_redirect",
            "IndexNow redirected the submission, so it was not replayed with the secret key.",
            response.status
          )
        )
      );
      continue;
    }

    if (response.status === 200 || response.status === 202) {
      success.push(
        ...chunk.map(item =>
          submissionItem(
            item,
            response.status === 202 ? "accepted_key_pending" : "accepted",
            response.status === 202 ? "IndexNow key validation is pending." : null,
            response.status
          )
        )
      );
    } else {
      const reason = safeNetworkReason(response.status);
      failed.push(
        ...chunk.map(item =>
          submissionItem(item, "submission_failed", reason, response.status)
        )
      );
    }
  }

  return submissionResult({ siteUrl, success, failed, skipped, keyValidation });
}
