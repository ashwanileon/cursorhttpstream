'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { normalizeSearchText } = require('../utils');

async function searchExtraFlix(query) {
  try {
    // Chrome UA + proper Referer is essential to bypass Cloudflare
    const chromeHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': CONFIG.EXTRAFLIX_URL + '/',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    };

    // Try multiple search URL patterns and header variations to bypass Cloudflare
    const searchAttempts = [
      // Standard GET search with full Chrome headers (most likely to work)
      { url: `${CONFIG.EXTRAFLIX_URL}/?s=${encodeURIComponent(query)}`, headers: chromeHeaders },
      // Without year for better results
      { url: `${CONFIG.EXTRAFLIX_URL}/?s=${encodeURIComponent(query.replace(/\s+\d{4}$/, ''))}`, headers: chromeHeaders },
    ];

    const pages = await Promise.allSettled(searchAttempts.map(({ url, headers }) =>
      axios.get(url, { headers, httpsAgent: agent, timeout: 12000 }).then(r => ({ status: r.status, data: r.data }))
        .catch(e => ({ status: e.response?.status || 0, data: null, error: e.message }))
    ));

    // If all axios GET attempts failed (Cloudflare blocked), try via CF Proxy
    if (!pages.some(p => p.status === 'fulfilled' && p.value?.status === 200 && p.value?.data && typeof p.value.data === 'string' && p.value.data.length > 200 && !p.value.data.includes('cloudflare'))) {
      try {
        const { fetchViaCfProxy } = require('../cf-proxy');
        const proxyResults = await Promise.allSettled(searchAttempts.map(({ url }) =>
          fetchViaCfProxy(url)
        ));
        for (const r of proxyResults) {
          if (r.status === 'fulfilled' && r.value && typeof r.value === 'string') {
            pages.push({ status: 'fulfilled', value: { status: 200, data: r.value } });
          }
        }
      } catch (_) {}
    }

    // Try POST search as fallback if all GET attempts failed
    if (!pages.some(p => p.status === 'fulfilled' && p.value?.status === 200 && p.value?.data)) {
      try {
        const { data: postData } = await axios.post(CONFIG.EXTRAFLIX_URL + '/',
          `s=${encodeURIComponent(query)}`,
          { headers: { ...chromeHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: agent, timeout: 12000 }
        );
        if (postData && typeof postData === 'string' && postData.length > 500) {
          pages.push({ status: 'fulfilled', value: { status: 200, data: postData } });
        }
      } catch (_) {}
    }

    const results = [];

    for (const page of pages) {
      if (page.status !== 'fulfilled') continue;
      const responseData = page.value?.data;
      if (!responseData || typeof responseData !== 'string') continue;
      const $ = cheerio.load(responseData);

      // ExtraFlix uses <article> tags for search results
      $('article').each((_, el) => {
        const e = $(el);
        // Try to find the link and title within the article
        const linkEl = e.find('h2 a, h3 a, .entry-title a, a[href*="extraflix"], a[href]').first();
        const href = linkEl.attr('href') || '';
        const title = (
          e.find('h2, h3, .entry-title').first().text().trim() ||
          linkEl.text().trim() ||
          e.find('.title, .name').first().text().trim()
        ).replace(/\s+/g, ' ');
        if (href && title && title.length < 300 && !title.match(/^(share|comment|reply)/i)) {
          results.push({
            title,
            url: href.startsWith('http') ? href : `${CONFIG.EXTRAFLIX_URL}${href}`,
            source: 'extraflix',
          });
        }
      });

      // Broader matching to catch any relevant links
      $('h2 a[href], h3 a[href], .entry-title a, a[href*="extraflix"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (href && text && text.length < 300 && !text.match(/^(share|comment|reply|next|prev)/i)) {
          const full = href.startsWith('http') ? href : `${CONFIG.EXTRAFLIX_URL}${href}`;
          // Avoid adding duplicates from article matching above
          if (!results.some(r => r.url === full)) {
            results.push({ title: text, url: full, source: 'extraflix' });
          }
        }
      });
    }

    const seen = new Set();
    return results.filter(r => {
      if (!r.url || !r.title || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 20);
  } catch (e) { return []; }
}

module.exports = { searchExtraFlix };
