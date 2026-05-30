'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { loadExtractor } = require('../extractors');
const { withTimeout } = require('../utils');

// Domains/substrings to exclude from link extraction (ads, social, spam)
const EXCLUDED_DOMAINS = [
  'facebook', 'twitter', 'instagram', 'pinterest', 'linkedin',
  'wordpress', 'yoast', 'tumblr', 'reddit', 'youtube.com',
  'google.', 'blogger', 'tiktok', 'snapchat',
];

// Content area selectors to try in order (WordPress common)
const CONTENT_SELECTORS = [
  '.entry-content', '.post-content', '#content', 'main',
  'article', '.post', '.the-content', '.single-content',
];

async function searchUHDRodeo(query) {
  try {
    const searchUrls = [
      `${CONFIG.UHDMOVIES_URL}/?s=${encodeURIComponent(query)}`,
      `${CONFIG.UHDMOVIES_URL}/?s=${encodeURIComponent(query.replace(/\s+\d{4}$/, ''))}`,
    ];
    for (const searchUrl of searchUrls) {
      try {
        const { data } = await axios.get(searchUrl, {
          headers: { ...HEADERS, Referer: CONFIG.UHDMOVIES_URL + '/' },
          httpsAgent: agent,
          timeout: 10000,
        });
        const $ = cheerio.load(data);
        const results = [];

        // Try multiple search result containers
        $('article, .post, .type-post, .search-result').each((_, el) => {
          const e = $(el);
          const titleLink = e.find('h2 a, h3 a, .entry-title a, a.entry-image, a[href*="/download-"], a[href*="/movie-"]').first();
          const href = titleLink.attr('href') || e.find('a[href]').first().attr('href') || '';
          const title = titleLink.text().trim() || e.find('h2, h3, .entry-title').first().text().trim() || '';
          if (title && title.length < 300 && href && !href.includes('?s=') && href !== CONFIG.UHDMOVIES_URL) {
            results.push({
              title: title.replace(/\s+/g, ' ').substring(0, 200),
              url: href.startsWith('http') ? href : `${CONFIG.UHDMOVIES_URL}${href}`,
            });
          }
        });

        // Fallback: find any link containing /download- or /movie- in URL
        if (!results.length) {
          $('a[href*="/download-"], a[href*="/movie-"], a[href*="/superman"], a[href*="/movie"]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim().replace(/\s+/g, ' ').substring(0, 150);
            if (href && text && !href.includes('?s=')) {
              results.push({
                title: text || href.split('/').filter(Boolean).pop() || query,
                url: href.startsWith('http') ? href : `${CONFIG.UHDMOVIES_URL}${href}`,
              });
            }
          });
        }

        if (results.length) {
          const seen = new Set();
          return results.filter(r => {
            if (!r.url || seen.has(r.url)) return false;
            seen.add(r.url);
            return true;
          }).slice(0, 15);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return [];
}

async function getUHDRodeoLinks(mediaUrl) {
  try {
    const { data } = await axios.get(mediaUrl, {
      headers: { ...HEADERS, Referer: CONFIG.UHDMOVIES_URL + '/' },
      httpsAgent: agent,
      timeout: 15000,
    });
    const $ = cheerio.load(data);
    const links = [];

    // Find content area using multiple selectors
    let contentArea = null;
    for (const sel of CONTENT_SELECTORS) {
      const el = $(sel);
      if (el.length > 0) {
        contentArea = el;
        break;
      }
    }

    let pendingQuality = 0;

    if (contentArea) {
      // Scrape links within content area only
      contentArea.find('*').each((_, el) => {
        const tag = el.name;
        const txt = $(el).text().trim().replace(/\s+/g, ' ');

        if (['h2','h3','h4','h5','strong'].includes(tag)) {
          if (/\b4K\b|\b2160\b|2160p/i.test(txt)) pendingQuality = 2160;
          else if (/1080p/i.test(txt)) pendingQuality = 1080;
          else if (/720p/i.test(txt)) pendingQuality = 720;
          else if (/480p/i.test(txt)) pendingQuality = 480;
        }

        if (tag === 'a') {
          const href = $(el).attr('href') || '';
          if (isValidExternalLink(href, txt)) {
            let quality = pendingQuality;
            if (!quality) {
              if (/\b4K\b|\b2160\b|2160p/i.test(txt)) quality = 2160;
              else if (/1080p/i.test(txt)) quality = 1080;
              else if (/720p/i.test(txt)) quality = 720;
              else if (/480p/i.test(txt)) quality = 480;
            }

            const sizeMatch = txt.match(/([\d.]+)\s*(GB|MB|KB)/i);
            const contextLabel = (quality ? `${quality}p ` : '') + txt;

            links.push({ url: href, quality, size: sizeMatch ? sizeMatch[0] : '', heading: contextLabel });
          }
        }
      });
    }

    // If no links found in content area, do targeted fallback
    if (!links.length) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const txt = $(el).text().trim().replace(/\s+/g, ' ');
        
        // Only include links that look like real downloadable content
        if (isValidExternalLink(href, txt) && looksLikeDownload(href, txt)) {
          let quality = 0;
          if (/\b4K\b|\b2160\b|2160p/i.test(txt)) quality = 2160;
          else if (/1080p/i.test(txt)) quality = 1080;
          else if (/720p/i.test(txt)) quality = 720;
          else if (/480p/i.test(txt)) quality = 480;
          
          const sizeMatch = txt.match(/([\d.]+)\s*(GB|MB|KB)/i);
          links.push({ url: href, quality, size: sizeMatch ? sizeMatch[0] : '', heading: txt });
        }
      });
    }

    const seen = new Set();
    const uniqueLinks = links.filter(l => {
      if (!l.url || seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });

    // Resolve links through loadExtractor to get playable URLs
    const resolveResults = await Promise.allSettled(uniqueLinks.map(async (link) => {
      try {
        const resolved = await withTimeout(loadExtractor(link.url, mediaUrl), 15000, []);
        if (resolved && resolved.length) {
          return resolved.map(r => ({
            source: r.source || 'UHDRodeo',
            quality: r.quality && !['Unknown', 'M3U8', 'Stream'].includes(String(r.quality)) ? r.quality : (link.quality || 0),
            url: r.url,
            size: r.size || link.size || 0,
            labelSource: link.heading,
          }));
        }
      } catch (_) {}
      // Fallback: only pass through if the URL is directly playable (video file extension)
      // Do NOT pass through hubcloud/hubdrive pages — they're HTML, not video
      if (/\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(link.url)) {
        return [{
          source: 'UHDRodeo',
          quality: link.quality || 0,
          url: link.url,
          size: link.size || 0,
          labelSource: link.heading,
        }];
      }
      return [];
    }));

    const allResolved = [];
    resolveResults.forEach(r => { if (r.status === 'fulfilled') allResolved.push(...r.value); });

    // Post-filter: remove any resolved URLs pointing to excluded/spam domains
    // Empty results are better than broken results
    return allResolved.filter(r => !isExcludedHost(r.url));
  } catch (e) { return []; }
}

/**
 * Check if a link is a valid external link (not social, spam, or self-referencing).
 */
function isValidExternalLink(href, text) {
  if (!href.startsWith('http')) return false;
  // Exclude self-referencing domains
  if (href.includes('uhdmovies.') || href.includes('uhdmovies.rodeo')) return false;
  // Exclude known ad/social/spam domains
  if (isExcludedHost(href)) return false;
  // Exclude links with no useful text
  if (!text || text.length < 3) return false;
  return true;
}

/**
 * Check if a URL belongs to an excluded/spam domain.
 */
function isExcludedHost(href) {
  for (const domain of EXCLUDED_DOMAINS) {
    if (href.includes(domain)) return true;
  }
  return false;
}

/**
 * Check if a link looks like it points to downloadable/video content.
 * Used in the fallback path to filter out sidebar/footer noise.
 */
function looksLikeDownload(href, text) {
  // Known file hoster domains
  const hosterPatterns = [
    'cloud.', 'hubcloud', 'hubdrive', 'drivehub', 'linkshub',
    'hubcdn', 'pixeldrain', 'streamtape', 'hdstream4u', 'gdflix',
    'extralink', 'filepress', 'vikingfile', 'streamhg', 'vidhide',
    'mdrive.lol', 'modlist.', 'moviesmod',
  ];
  
  // Check for known file hosters in URL
  for (const pattern of hosterPatterns) {
    if (href.includes(pattern)) return true;
  }
  
  // Check for direct media file extensions
  if (/\.(mp4|mkv|m3u8|webm|avi|mov)(\?|$)/i.test(href)) return true;
  
  // Check URL path for download indicators
  if (/\/(download|file|redirect|stream|d\/|dl\/)/i.test(href)) return true;
  
  // Check text for download/quality indicators
  if (/\b(2160|2160p|4K|1080p|720p|download|server|watch|play)\b/i.test(text)) return true;
  
  // Check for size in text
  if (/[\d.]+\s*(GB|MB|KB)/i.test(text)) return true;
  
  return false;
}

module.exports = { searchUHDRodeo, getUHDRodeoLinks };
