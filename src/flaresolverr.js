'use strict';

const axios = require('axios');
const cache = require('./cache');
const { agent } = require('./config');

const FLARESOLVERR_ENDPOINT = process.env.FLARESOLVERR_ENDPOINT || '';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes (shorter to avoid stale sessions)
let missingFsWarned = false;
const REQUEST_TIMEOUT = 30000; // 30s per attempt
const MAX_RETRIES = 2; // 2 attempts (1+1 retry)

// Global FlareSolverr concurrency limiter: only 1 solve at a time.
// This prevents flooding FlareSolverr when multiple hubcloud URLs all
// enter Phase 2 simultaneously (5+ URLs × 8 TLD variants = 40+ concurrent).
let fsQueue = [];
let fsRunning = false;

/**
 * Acquire the FlareSolverr lock. Resolves when it's this caller's turn.
 */
function acquireFSLock() {
  return new Promise(resolve => {
    fsQueue.push(resolve);
    if (!fsRunning) drainFSQueue();
  });
}

/**
 * Release the FlareSolverr lock and start the next queued request.
 */
function releaseFSLock() {
  fsRunning = false;
  drainFSQueue();
}

/**
 * Process the next queued FlareSolverr request, if any.
 */
function drainFSQueue() {
  if (fsRunning || fsQueue.length === 0) return;
  fsRunning = true;
  const next = fsQueue.shift();
  next();
}

/**
 * Detect if a response body contains a Cloudflare challenge page.
 */
function isCloudflareChallenge(body) {
  if (!body || typeof body !== 'string') return false;
  return (
    body.includes('Just a moment...') ||
    body.includes('cf-challenge') ||
    body.includes('cf-mitigated') ||
    body.includes('challenges.cloudflare.com') ||
    body.includes('__cf_chl_opt') ||
    body.includes('/cdn-cgi/challenge-platform')
  );
}

/**
 * Solve a Cloudflare challenge for the given URL using FlareSolverr.
 * Uses a session per host (so challenges are solved once per host, not per URL).
 *
 * @param {string} url - The target URL to fetch
 * @param {object} options - Optional parameters
 * @param {object} options.headers - Additional headers to send
 * @param {string} options.method - HTTP method (default: GET)
 * @param {string} options.body - Request body for POST requests
 * @param {string} options.contentType - Content-Type for POST requests
 * @returns {Promise<{body: string, headers: object, status: number, cookies: array}|null>}
 */
async function solveViaFlareSolverr(url, options = {}) {
  if (!FLARESOLVERR_ENDPOINT) {
    if (!missingFsWarned) {
      missingFsWarned = true;
      console.warn('[flaresolverr] FLARESOLVERR_ENDPOINT is not set — Cloudflare bypass will rely on CF_WORKER_URL only.');
    }
    return null;
  }

  const cacheKey = `flaresolverr:${url}`;

  return cache.getOrSet(cacheKey, async () => {
    // Acquire the global FlareSolverr lock — only 1 concurrent solve allowed
    await acquireFSLock();
    try {
      const session = `httpstream_${new URL(url).hostname}`;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const payload = {
            cmd: 'request.get',
            url: url,
            session: session,
            session_ttl_minutes: 60,
            maxTimeout: 30000,
            disableMedia: true,
          };

          console.log(`[flaresolverr] Attempt ${attempt + 1}/${MAX_RETRIES}: solving challenge for ${url.substring(0, 80)}...`);

          const response = await axios.post(
            `${FLARESOLVERR_ENDPOINT}/v1`,
            payload,
            {
              headers: { 'Content-Type': 'application/json' },
              httpsAgent: agent,
              timeout: REQUEST_TIMEOUT,
            }
          );

          const result = response.data;

          if (!result || result.status !== 'ok') {
            console.warn(`[flaresolverr] Challenge failed: ${result ? result.message : 'no response'}`);
            if (attempt < MAX_RETRIES - 1) {
              const delay = (attempt + 1) * 3000 + Math.floor(Math.random() * 3000);
              console.log(`[flaresolverr] Retrying in ${Math.round(delay / 1000)}s...`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            return null;
          }

          const solution = result.solution;
          if (!solution) {
            console.warn('[flaresolverr] No solution returned');
            return null;
          }

          console.log(`[flaresolverr] Challenge solved for ${new URL(url).hostname} (${solution.status})`);

          return {
            body: solution.response,
            headers: solution.headers || {},
            status: solution.status,
            cookies: solution.cookies || [],
            userAgent: solution.userAgent,
          };
        } catch (e) {
          const status = e.response?.status;
          const msg = status ? `HTTP ${status}` : e.message;
          console.warn(`[flaresolverr] Error (attempt ${attempt + 1}/${MAX_RETRIES}): ${msg}`);

          if (attempt < MAX_RETRIES - 1) {
            const delay = (attempt + 1) * 3000 + Math.floor(Math.random() * 3000);
            console.log(`[flaresolverr] Retrying in ${Math.round(delay / 1000)}s...`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }

      console.warn(`[flaresolverr] All ${MAX_RETRIES} attempts failed for ${url.substring(0, 80)} — clearing cache to retry fresh next time`);
      try { require('./cache').delete(cacheKey); } catch (_) {}
      return null;
    } finally {
      releaseFSLock();
    }
  }, CACHE_TTL);
}

/**
 * Fetch a URL by first trying direct axios, then falling back to FlareSolverr
 * if a Cloudflare challenge is detected.
 *
 * @param {string} url - The URL to fetch
 * @param {object} options - Options (headers, method, body, etc.)
 * @returns {Promise<string|null>} - The response body text, or null on failure
 */
async function fetchWithFlareSolverrFallback(url, options = {}) {
  // Try direct fetch first
  try {
    const axiosConfig = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': new URL(url).origin + '/',
        ...(options.headers || {}),
      },
      httpsAgent: agent,
      timeout: 15000,
      method: options.method || 'GET',
      responseType: 'text',
    };

    if (options.body) {
      axiosConfig.data = options.body;
    }

    const response = await axios(url, axiosConfig);
    const body = typeof response.data === 'string' ? response.data : String(response.data || '');

    // Check if we got a Cloudflare challenge page
    if (!isCloudflareChallenge(body)) {
      return body;
    }

    console.log(`[flaresolverr] Cloudflare challenge detected for ${url.substring(0, 80)}, routing through FlareSolverr...`);
  } catch (e) {
    const isBlocked = e.response?.status === 403 ||
                      e.response?.headers?.['cf-mitigated'] === 'challenge' ||
                      (e.response?.data && isCloudflareChallenge(String(e.response.data)));

    if (!isBlocked) {
      console.warn(`[flaresolverr] Direct fetch failed (${e.message}), trying FlareSolverr...`);
    }
  }

  // Fallback: try via FlareSolverr
  if (!FLARESOLVERR_ENDPOINT) {
    console.log('[flaresolverr] No FLARESOLVERR_ENDPOINT set, cannot bypass Cloudflare');
    return null;
  }

  const solution = await solveViaFlareSolverr(url, options);
  if (solution && solution.body) {
    return solution.body;
  }

  return null;
}

module.exports = {
  solveViaFlareSolverr,
  fetchWithFlareSolverrFallback,
  isCloudflareChallenge,
};
