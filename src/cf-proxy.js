'use strict';

const axios = require('axios');
const crypto = require('crypto');
const cache = require('./cache');

const CF_WORKER_URL = process.env.CF_WORKER_URL || '';
const CACHE_TTL = 1800000; // 30 min cache
const MAX_RETRIES = 2; // Retry transient failures
const BLOCKED_STATUSES = new Set([403, 503, 530]);
let missingWorkerWarned = false;
const failLogCounts = new Map();

function logProxyFailure(status, url, attempt, maxAttempts) {
  let host = 'unknown';
  try { host = new URL(url).hostname; } catch (_) {}
  const key = `${status}:${host}`;
  const count = (failLogCounts.get(key) || 0) + 1;
  failLogCounts.set(key, count);
  if (count > 2) return;
  console.warn(
    `[cf-proxy] HTTP ${status} for ${host} (attempt ${attempt}/${maxAttempts})` +
    (count === 2 ? ' — further failures for this host suppressed' : '')
  );
}

/**
 * Fetch a URL through our Cloudflare Worker proxy to bypass Cloudflare protection.
 * Cloudflare trusts requests coming from its own edge network, so this effectively
 * bypasses Cloudflare challenges on target sites.
 *
 * Returns the response body (HTML or JSON string) or null on failure.
 * Caches only SUCCESSFUL results to avoid serving stale failures.
 *
 * For POST requests, the body is included in the cache key to avoid
 * collisions between different request payloads (e.g. different SIDs).
 */
async function fetchViaCfProxy(url, options = {}) {
  if (!CF_WORKER_URL) {
    if (!missingWorkerWarned) {
      missingWorkerWarned = true;
      console.warn('[cf-proxy] CF_WORKER_URL is not set — HubCloud and other Cloudflare-protected links will not resolve on Koyeb/Vercel. Deploy cf-worker/ and set CF_WORKER_URL.');
    }
    return null;
  }

  const isPost = options.method === 'POST';
  const cacheKey = isPost
    ? `cfproxy:POST:${url}:${crypto.createHash('md5').update(options.body || '').digest('hex')}`
    : `cfproxy:${url}`;

  // Try the cache only — but don't cache failures (null is not cached by cache.getOrSet)
  return cache.getOrSet(cacheKey, async () => {
    // Internal retry loop for transient errors
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Build proxy URL with target
        let proxyUrl = `${CF_WORKER_URL}?target=${encodeURIComponent(url)}`;

        // Forward custom headers as query params (e.g. header_Referer, header_Cookie)
        if (options.headers && typeof options.headers === 'object') {
          for (const [key, value] of Object.entries(options.headers)) {
            if (value && typeof value === 'string') {
              const safeKey = key.replace(/-/g, '_');
              proxyUrl += `&header_${encodeURIComponent(safeKey)}=${encodeURIComponent(value)}`;
            }
          }
        }

        const axiosConfig = {
          timeout: 30000,
          responseType: 'text',
          transformResponse: [data => data],
          validateStatus: () => true,
        };

        let response;
        if (isPost) {
          response = await axios.post(proxyUrl,
            options.body || '',
            {
              ...axiosConfig,
              headers: {
                'Content-Type': options.contentType || 'application/x-www-form-urlencoded',
                ...(options.headers || {}),
              },
            }
          );
        } else {
          response = await axios.get(proxyUrl, axiosConfig);
        }

        if (!response || !response.data) {
          console.warn('[cf-proxy] Empty response for:', url.substring(0, 80));
          if (attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          return null;
        }

        const data = response.data;
        const status = response.status;

        if (status < 200 || status >= 300 || BLOCKED_STATUSES.has(status)) {
          logProxyFailure(status, url, attempt + 1, MAX_RETRIES);
          if ((status === 429 || status === 502) && attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
            continue;
          }
          return null;
        }

        const isChallengeByContent = typeof data === 'string' && (
          data.includes('Just a moment...') ||
          data.includes('__cf_chl_') ||
          data.includes('/cdn-cgi/challenge-platform') ||
          data.includes('cf-browser-verification')
        );

        if (isChallengeByContent) {
          logProxyFailure(403, url, attempt + 1, MAX_RETRIES);
          return null;
        }

        if (!data || (typeof data === 'string' && data.length < 50)) {
          return null;
        }

        return data;
      } catch (e) {
        const status = e.response?.status;
        const isTransient = status === 429 || status === 502 || !status;

        if (status === 429) {
          console.warn(`[cf-proxy] Rate limited (429) — attempt ${attempt + 1}/${MAX_RETRIES}`);
        } else if (status === 502) {
          console.warn(`[cf-proxy] Worker proxy error (502) — attempt ${attempt + 1}/${MAX_RETRIES}`);
        } else if (status) {
          logProxyFailure(status, url, attempt + 1, MAX_RETRIES);
        } else {
          console.warn(`[cf-proxy] ${e.message} — attempt ${attempt + 1}/${MAX_RETRIES}`);
        }

        if (isTransient && attempt < MAX_RETRIES - 1) {
          const delay = (attempt + 1) * 1500;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return null; // Don't cache failures
      }
    }
    return null; // All retries exhausted
  }, CACHE_TTL);
}

module.exports = { fetchViaCfProxy };
