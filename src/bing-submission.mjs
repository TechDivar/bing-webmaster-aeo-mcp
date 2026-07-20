import {
  BingWebmasterError,
  callBingApi,
  isUrlWithinSite
} from "./bing-client.mjs";
import { validatePublicUrl } from "./web-scanner.mjs";

export const BING_MAX_URLS_PER_BATCH = 500;

function resultItem(url, code, reason) {
  return {
    url,
    ...(code ? { code } : {}),
    ...(reason ? { reason } : {})
  };
}

function safeReason(error) {
  return error instanceof BingWebmasterError
    ? error.message
    : "Bing Webmaster rejected the URL batch unexpectedly.";
}

export function parseUrlSubmissionQuota(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BingWebmasterError(
      "Bing returned a malformed URL submission quota response. No URLs were submitted."
    );
  }

  const daily = value.DailyQuota;
  const monthly = value.MonthlyQuota;
  if (
    !Number.isInteger(daily) ||
    daily < 0 ||
    !Number.isInteger(monthly) ||
    monthly < 0
  ) {
    throw new BingWebmasterError(
      "Bing returned a malformed URL submission quota response. No URLs were submitted."
    );
  }

  return {
    DailyQuota: daily,
    MonthlyQuota: monthly,
    available: Math.min(daily, monthly)
  };
}

export async function submitBingUrlBatch({
  siteUrl,
  urls,
  callApi = callBingApi,
  validateUrl = validatePublicUrl
}) {
  const success = [];
  const failed = [];
  const skipped = [];
  const valid = [];
  const seen = new Set();

  try {
    await validateUrl(siteUrl);
  } catch (error) {
    throw new BingWebmasterError(
      `The verified site URL is not a valid public URL: ${error.message}`
    );
  }

  for (const value of urls) {
    const url = typeof value === "string" ? value.trim() : "";
    if (!url) {
      skipped.push(resultItem(String(value ?? ""), "invalid_url", "Enter a valid public URL."));
      continue;
    }
    if (seen.has(url)) {
      skipped.push(resultItem(url, "duplicate_url", "The URL appeared more than once."));
      continue;
    }
    seen.add(url);

    try {
      await validateUrl(url);
    } catch (error) {
      skipped.push(resultItem(url, "invalid_url", error.message));
      continue;
    }

    if (!isUrlWithinSite(siteUrl, url)) {
      skipped.push(
        resultItem(
          url,
          "wrong_host",
          "The URL does not belong to the configured Bing site."
        )
      );
      continue;
    }

    valid.push(url);
  }

  let rawQuota;
  let quota;
  try {
    rawQuota = await callApi("GetUrlSubmissionQuota", {
      params: { siteUrl }
    });
    quota = parseUrlSubmissionQuota(rawQuota);
  } catch (error) {
    const reason = safeReason(error);
    failed.push(...valid.map(url => resultItem(url, "quota_check_failed", reason)));
    return buildResult({ siteUrl, quota: null, success, failed, skipped });
  }

  const allowedCount = Math.min(
    valid.length,
    BING_MAX_URLS_PER_BATCH,
    quota.available
  );
  const toSubmit = valid.slice(0, allowedCount);

  for (const url of valid.slice(allowedCount)) {
    const maximumReached = allowedCount >= BING_MAX_URLS_PER_BATCH;
    skipped.push(
      resultItem(
        url,
        maximumReached ? "batch_limit" : "quota_limit",
        maximumReached
          ? `Bing accepts at most ${BING_MAX_URLS_PER_BATCH} URLs in one batch.`
          : "The URL was not submitted because the remaining Bing quota was reached."
      )
    );
  }

  if (toSubmit.length) {
    try {
      await callApi("SubmitUrlbatch", {
        httpMethod: "POST",
        body: { siteUrl, urlList: toSubmit }
      });
      success.push(...toSubmit.map(url => resultItem(url, "submitted")));
    } catch (error) {
      const reason = safeReason(error);
      failed.push(...toSubmit.map(url => resultItem(url, "submission_failed", reason)));
    }
  }

  return buildResult({ siteUrl, quota, success, failed, skipped });
}

function buildResult({ siteUrl, quota, success, failed, skipped }) {
  return {
    site_url: siteUrl,
    maximum_batch_size: BING_MAX_URLS_PER_BATCH,
    quota,
    summary: {
      submitted: success.length,
      failed: failed.length,
      skipped: skipped.length
    },
    success,
    failed,
    skipped,
    notice:
      "Submission tells Bing that URLs changed. It does not guarantee crawling or indexing. Bing's batch response does not provide a separate result for each URL."
  };
}
