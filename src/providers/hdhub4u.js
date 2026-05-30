'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { normalizeSearchText, slugify } = require('../utils');
const { fetchWithFlareSolverrFallback } = require('../flaresolverr');

async function searchHDHub4u(query) {
  try {
    // Try TypeSense search API first (primary search method for this site)
    const typesenseResults = await searchViaTypeSense(query);
    if (typesenseResults.length) return typesenseResults;

    // Fallback: scrape HTML search results (for compatibility)
    const searchUrls = [
      `${CONFIG.MAIN_URL}/?s=${encodeURIComponent(query)}`,
      `${CONFIG.MAIN_URL}/?q=${encodeURIComponent(query)}`,
    ];

    // Try regular axios first
    const pages = await Promise.allSettled(searchUrls.map(url =>
      axios.get(url, { headers: HEADERS, httpsAgent: agent, timeout: 12000 }).then(r => r.data)
    ));

    const allDirectFailed = !pages.some(p => p.status === 'fulfilled' && p.value && p.value.length > 200 && !p.value.includes('cloudflare'));

    // FlareSolverr before CF worker (403-heavy on hdhub4u HTML search)
    if (allDirectFailed && CONFIG.FLARESOLVERR_ENDPOINT) {
      try {
        const fsResults = await Promise.allSettled(searchUrls.map(url =>
          fetchWithFlareSolverrFallback(url)
        ));
        for (const r of fsResults) {
          if (r.status === 'fulfilled' && r.value) {
            pages.push({ status: 'fulfilled', value: r.value });
          }
        }
      } catch (_) {}
    }

    if (allDirectFailed && CONFIG.CF_WORKER_URL && !pages.some(p => p.status === 'fulfilled' && p.value?.length > 200)) {
      try {
        const { fetchViaCfProxy } = require('../cf-proxy');
        const proxyResults = await Promise.allSettled(searchUrls.map(url =>
          fetchViaCfProxy(url, { headers: { Referer: CONFIG.MAIN_URL + '/' } })
        ));
        for (const r of proxyResults) {
          if (r.status === 'fulfilled' && r.value) {
            pages.push({ status: 'fulfilled', value: r.value });
          }
        }
      } catch (_) {}
    }
    const results = [];

    for (const page of pages) {
      if (page.status !== 'fulfilled') continue;
      const data = page.value;
      const $ = cheerio.load(data);

      $('article, .post, .post-item, .item, [class*="movie"], [class*="series"], a.movie-card').each((_, el) => {
        const e = $(el);
        const titleLink = e.find('h2 a, h3 a, h4 a, .entry-title a, .title a, .name a, .movie-title a, .movie-card a').first();
        const title = titleLink.text().trim() || e.find('h2, h3, h4, .movie-title, .card-title').first().text().trim();
        const href = titleLink.attr('href') || e.find('a[href]').first().attr('href') || (e.is('a') ? e.attr('href') : '');

        if (title && title.length < 300 && href && href.length > 5) {
          results.push({
            title: title.replace(/\s+/g, ' '),
            url: href.startsWith('http') ? href : `${CONFIG.MAIN_URL}${href}`
          });
        }
      });

      $('a[href*="/"]').each((_, el) => {
        const e = $(el);
        const href = e.attr('href') || '';
        const text = e.text().trim();
        const full = href.startsWith('http') ? href : `${CONFIG.MAIN_URL}${href}`;
        const queryTokens = normalizeSearchText(query).split(' ').filter(t => t.length > 2);
        const haystack = normalizeSearchText(`${text} ${href}`);

        if (
          (href.includes(CONFIG.MAIN_URL) || href.startsWith('/')) &&
          (/\/(20\d{2}|20\d{2}-)/.test(href) || /^\/[a-z0-9-]{8,}/.test(href)) &&
          queryTokens.every(t => haystack.includes(t)) &&
          !href.includes('?s=') && !href.includes('?q=') &&
          !href.includes('comment') &&
          !text.match(/^(next|prev|page|post)\s*\d/i) &&
          full.startsWith(CONFIG.MAIN_URL)
        ) {
          results.push({ title: (text || full.split('/').filter(Boolean).pop()).replace(/\s+/g, ' '), url: full });
        }
      });
    }

    const seen = new Set();
    return results.filter(r => {
      if (!r.url || !r.title || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 20);
  } catch (e) {
    return [];
  }
}

async function searchViaTypeSense(query) {
  // TypeSense endpoint variants — domains change frequently
  const typeSenseVariants = [
    { baseUrl: 'https://search.hdhub4u.glass', path: '/collections/post/documents/search' },
    { baseUrl: 'https://search.hdhub4u.bond', path: '/collections/post/documents/search' },
    { baseUrl: 'https://search.hdhub4u.click', path: '/collections/post/documents/search' },
  ];

  // Strategy: try all variants with the fastest method first, then escalate
  // Phase 1: Try all variants via direct axios (fast — fails quick if Cloudflare blocks)
  const axiosResults = await Promise.allSettled(
    typeSenseVariants.map(async (variant) => {
      const params = {
        q: query,
        query_by: 'post_title',
        per_page: 10,
        prefix: true,
      };
      const { data } = await axios.get(`${variant.baseUrl}${variant.path}`, {
        params,
        httpsAgent: agent,
        timeout: 5000,
      });
      if (data && data.hits && data.hits.length) return { variant, data };
      return null;
    })
  );

  for (const r of axiosResults) {
    if (r.status === 'fulfilled' && r.value && r.value.data) {
      const parsed = parseTypeSenseResults(r.value.data, query);
      if (parsed.length) return parsed;
    }
  }

  // Phase 2: FlareSolverr (works when CF worker gets 403 on search API)
  if (CONFIG.FLARESOLVERR_ENDPOINT) {
    for (const variant of typeSenseVariants) {
      const params = { q: query, query_by: 'post_title', per_page: 10, prefix: true };
      const fullUrl = `${variant.baseUrl}${variant.path}?${new URLSearchParams(params).toString()}`;
      const proxyResult = await fetchWithFlareSolverrFallback(fullUrl, {
        headers: { Accept: 'application/json,text/plain,*/*' },
      });
      if (proxyResult) {
        try {
          const data = JSON.parse(proxyResult);
          if (data?.hits?.length) return parseTypeSenseResults(data, query);
        } catch (_) {}
      }
    }
  }

  // Phase 3: CF worker proxy (often 403 on Typesense; kept as fallback)
  if (CONFIG.CF_WORKER_URL) {
    const { fetchViaCfProxy } = require('../cf-proxy');
    for (const variant of typeSenseVariants) {
      const params = { q: query, query_by: 'post_title', per_page: 10, prefix: true };
      const fullUrl = `${variant.baseUrl}${variant.path}?${new URLSearchParams(params).toString()}`;
      const proxyResult = await fetchViaCfProxy(fullUrl, {
        headers: { Accept: 'application/json,text/plain,*/*', Referer: CONFIG.MAIN_URL + '/' },
      });
      if (proxyResult) {
        try {
          const data = JSON.parse(proxyResult);
          if (data?.hits?.length) return parseTypeSenseResults(data, query);
        } catch (_) {}
      }
    }
  }

  return [];
}

function resolvePermalink(permalink) {
  if (!permalink) return '';
  if (permalink.startsWith('http')) return permalink;
  const path = permalink.startsWith('/') ? permalink : `/${permalink}`;
  return `${CONFIG.MAIN_URL}${path}`;
}

function parseTypeSenseResults(data, query) {
  const results = data.hits.map(hit => {
    const doc = hit.document;
    return {
      title: doc.post_title || query,
      url: resolvePermalink(doc.permalink),
      imdb_id: doc.imdb_id,
      categories: doc.category,
    };
  }).filter(r => r.url);

  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

async function findDirectPage(title, year) {
  const base = CONFIG.MAIN_URL.replace(/\/$/, '');
  const slugs = [];
  const t = slugify(title);
  // More URL pattern variants for better coverage
  if (year) slugs.push(`${t}-${year}-hindi-webrip-full-movie/`);
  if (year) slugs.push(`${t}-${year}-hindi-full-movie/`);
  if (year) slugs.push(`${t}-${year}-full-movie/`);
  if (year) slugs.push(`${t}-${year}/`);
  if (year) slugs.push(`${t}-${year}-webrip/`);
  if (year) slugs.push(`${t}-${year}-web-dl/`);
  if (year) slugs.push(`${t}-${year}-dual-audio/`);
  slugs.push(`${t}-full-movie/`);
  slugs.push(`${t}-hindi-full-movie/`);
  slugs.push(`${t}/`);
  slugs.push(`${t}-hindi/`);

  for (const s of slugs) {
    const url = s.startsWith('/') ? `${base}${s}` : `${base}/${s}`;
    try {
      const r = await axios.get(url, { headers: HEADERS, httpsAgent: agent, timeout: 8000 });
      const body = (r.data || '') + '';
      if (body.includes('hubcdn') || body.includes('hubdrive') || body.includes('hubcloud') || body.includes('gadgetsweb') || body.includes('pixeldrain')) {
        console.log(`[hdhub4u-direct] Found direct URL: ${url.substring(0, 80)}`);
        return url;
      }
    } catch (_) {}
  }
  return null;
}

module.exports = { searchHDHub4u, findDirectPage };
