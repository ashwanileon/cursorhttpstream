'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { normalizeSearchText, slugify, withTimeout } = require('../utils');
const { loadExtractor } = require('../extractors');

async function searchMoviesDrives(query) {
  try {
    const { data } = await axios.get(`${CONFIG.MOVIESDRIVES_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`, {
      headers: { ...HEADERS, Accept: 'application/json', Referer: CONFIG.MOVIESDRIVES_URL + '/' },
      httpsAgent: agent,
      timeout: 8000,
    });
    if (Array.isArray(data) && data.length) {
      const results = data.map(p => ({
        title: (p.title?.rendered || p.slug || '').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim(),
        url: p.link || '',
      })).filter(r => r.title && r.url);
      if (results.length) return results.slice(0, 20);
    }
  } catch (_) {}

  try {
    const { data: wpData } = await axios.get(`${CONFIG.MOVIESDRIVES_URL}/wp-json/wp/v2/posts?per_page=50`, {
      headers: { ...HEADERS, Accept: 'application/json', Referer: CONFIG.MOVIESDRIVES_URL + '/' },
      httpsAgent: agent,
      timeout: 8000,
    });
    if (Array.isArray(wpData) && wpData.length) {
      const queryTokens = normalizeSearchText(query).split(' ').filter(t => t.length > 2);
      const matches = wpData
        .map(p => ({
          title: (p.title?.rendered || p.slug || '').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim(),
          url: p.link || '',
        }))
        .filter(r => {
          if (!r.title || !r.url) return false;
          const haystack = normalizeSearchText(r.title + ' ' + r.url);
          return queryTokens.every(t => haystack.includes(t));
        });
      if (matches.length) return matches.slice(0, 20);
    }
  } catch (_) {}

  try {
    const slug = slugify(query);
    const year = (query.match(/\b(\d{4})\b/) || [])[1] || '';
    const variants = [
      `${slug}/`,
      year ? `${slug}-${year}/` : null,
      `${slug}-hindi/`,
      `${slug}-full-movie/`,
      `${slug}-web-dl/`,
    ].filter(Boolean);

    for (const v of variants) {
      try {
        const url = `${CONFIG.MOVIESDRIVES_URL}/${v}`;
        const r = await axios.get(url, { headers: { ...HEADERS, Referer: CONFIG.MOVIESDRIVES_URL + '/' }, httpsAgent: agent, timeout: 6000 });
        if (r.status === 200) {
          const $$ = cheerio.load(r.data);
          const h1 = $$('h1').text().trim().replace(/\s+/g, ' ').substring(0, 200) || query;
          return [{ title: h1, url }];
        }
      } catch (_) {}
    }
  } catch (_) {}

  return [];
}

async function getMoviesDrivesLinks(mediaUrl) {
  try {
    const { data } = await axios.get(mediaUrl, { headers: { ...HEADERS, Referer: CONFIG.MOVIESDRIVES_URL + '/' }, httpsAgent: agent, timeout: 15000 });
    const $ = cheerio.load(data);
    const linkPairs = [];
    const h5s = $('h5').toArray();
    
    for (let i = 0; i < h5s.length - 1; i++) {
      const heading = $(h5s[i]).text().trim().replace(/\s+/g, ' ');
      if (!heading || heading.length < 10) continue;
      const linkEl = $(h5s[i + 1]).find('a[href^="http"]').first();
      const href = (linkEl.length ? linkEl.attr('href') : '') || $(h5s[i + 1]).find('a[href]').first().attr('href') || '';
      if (href && href.startsWith('http') && !href.includes('moviesdrives.my') && !href.includes('facebook') && !href.includes('twitter') && !href.includes('pinterest') && !href.includes('imdb')) {
        const linkText = $(h5s[i + 1]).text().trim().replace(/\s+/g, ' ');
        const context = heading + ' ' + linkText;
        let quality = 0;
        const qm = context.match(/(\d{3,4})\s*p/i);
        if (qm) quality = parseInt(qm[1]);
        if (quality > 0 && quality < 1080) continue;
        const sizeMatch = context.match(/\[?([\d.]+\s*(?:GB|MB|KB))\]?/i);
        linkPairs.push({ url: href, quality, size: sizeMatch ? sizeMatch[1] : '', heading });
      }
    }

    if (!linkPairs.length) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.startsWith('http') && !href.includes('moviesdrives.my') && !href.includes('facebook') && !href.includes('twitter') && !href.includes('pinterest') && !href.includes('imdb')) {
          if (href.includes('hubcloud') || href.includes('hubdrive') || href.includes('pixeldrain') || href.includes('streamtape') || href.includes('hdstream4u') || href.includes('drivehub') || href.includes('linkshub')) {
            const parentText = $(el).closest('h5, p, div').text().trim().replace(/\s+/g, ' ');
            let quality = 0;
            const qm = parentText.match(/(\d{3,4})\s*p/i);
            if (qm) quality = parseInt(qm[1]);
            if (quality > 0 && quality < 1080) return;
            const sizeMatch = parentText.match(/\[?([\d.]+\s*(?:GB|MB|KB))\]?/i);
            linkPairs.push({ url: href, quality, size: sizeMatch ? sizeMatch[1] : '', heading: parentText });
          }
        }
      });
    }

    const seen = new Set();
    const uniquePairs = linkPairs.filter(p => { if (seen.has(p.url)) return false; seen.add(p.url); return true; });

    const resolveResults = await Promise.allSettled(uniquePairs.map(async (pair) => {
      try {
        const resolved = await withTimeout(loadExtractor(pair.url, mediaUrl), 20000, []);
        if (resolved && resolved.length) {
          return resolved.map(link => ({
            ...link,
            quality: link.quality && !['Unknown', 'M3U8', 'Stream'].includes(String(link.quality)) ? link.quality : pair.quality,
            size: link.size || pair.size,
            labelSource: pair.heading,
          }));
        }
        // Only pass through if the URL is directly playable (video file extension)
        // Do NOT pass through hubcloud/hubdrive pages — they're HTML, not video
        if (/\\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(pair.url)) {
          return [{ source: 'MoviesDrives', quality: pair.quality || 0, url: pair.url, size: pair.size, labelSource: pair.heading }];
        }
        return [];
      } catch (_) { return []; }
    }));

    const allStreamLinks = [];
    resolveResults.forEach(r => { if (r.status === 'fulfilled') allStreamLinks.push(...r.value); });
    const seenUrls = new Set();
    return allStreamLinks.filter(l => { if (!l.url || seenUrls.has(l.url)) return false; seenUrls.add(l.url); return true; });
  } catch (e) { return []; }
}

module.exports = { searchMoviesDrives, getMoviesDrivesLinks };
