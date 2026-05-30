'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { normalizeSearchText } = require('../utils');

async function search4KHDHub4u(query) {
  try {
    const searchUrls = [
      `${CONFIG.FOURTH_K_URL}/?s=${encodeURIComponent(query)}`,
      `${CONFIG.FOURTH_K_URL}/?q=${encodeURIComponent(query)}`,
    ];

    // Use browser-like headers to avoid Cloudflare blocks
    const browserHeaders = {
      ...HEADERS,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': CONFIG.FOURTH_K_URL + '/',
    };

    const pages = await Promise.allSettled(searchUrls.map(url =>
      axios.get(url, { headers: browserHeaders, httpsAgent: agent, timeout: 12000 }).then(r => r.data)
    ));

    // If all axios attempts failed (Cloudflare blocked), try via CF Proxy
    if (!pages.some(p => p.status === 'fulfilled' && p.value && p.value.length > 200 && !p.value.includes('cloudflare'))) {
      try {
        const { fetchViaCfProxy } = require('../cf-proxy');
        const proxyResults = await Promise.allSettled(searchUrls.map(url =>
          fetchViaCfProxy(url)
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
      const $ = cheerio.load(page.value);

      // Primary: match a.movie-card anchors (the main search result container)
      $('a.movie-card').each((_, el) => {
        const e = $(el);
        const href = e.attr('href') || '';
        // Title from h3.movie-card-title or img alt or any text in the card
        const title = e.find('.movie-card-title').first().text().trim() ||
                      e.find('h3').first().text().trim() ||
                      e.find('img').first().attr('alt') || '';
        if (title && title.length < 300 && href && href.length > 5) {
          results.push({
            title: title.replace(/\s+/g, ' '),
            url: href.startsWith('http') ? href : `${CONFIG.FOURTH_K_URL}${href}`,
            source: '4khdhub',
          });
        }
      });

      // Secondary: match any links within .card-grid
      if (!results.length) {
        $('.card-grid a[href]').each((_, el) => {
          const href = $(el).attr('href') || '';
          const title = $(el).find('.movie-card-title, h3, img[alt]').first().text().trim() ||
                        $(el).find('img').first().attr('alt') || '';
          if (title && title.length < 300 && href) {
            results.push({
              title: title.replace(/\s+/g, ' '),
              url: href.startsWith('http') ? href : `${CONFIG.FOURTH_K_URL}${href}`,
              source: '4khdhub',
            });
          }
        });
      }

      // Tertiary: broad link matching as fallback
      if (!results.length) {
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href') || '';
          const text = $(el).text().trim().replace(/\s+/g, ' ');
          const full = href.startsWith('http') ? href : `${CONFIG.FOURTH_K_URL}${href}`;
          const queryTokens = normalizeSearchText(query).split(' ').filter(t => t.length > 2);
          const haystack = normalizeSearchText(`${text} ${href}`);
          if (
            (href.startsWith('/')) &&
            (/\/(20\d{2}|20\d{2}-)/.test(href) || /^\/[a-z0-9-]{8,}/.test(href)) &&
            queryTokens.every(t => haystack.includes(t)) &&
            !href.includes('?s=') && !href.includes('?q=') &&
            !href.includes('comment') && !href.includes('page/') &&
            full.startsWith(CONFIG.FOURTH_K_URL)
          ) {
            results.push({
              title: text || full.split('/').filter(Boolean).pop(),
              url: full,
              source: '4khdhub',
            });
          }
        });
      }
    }

    const seen = new Set();
    return results.filter(r => {
      if (!r.url || !r.title || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 20);
  } catch (e) { return []; }
}

module.exports = { search4KHDHub4u };
