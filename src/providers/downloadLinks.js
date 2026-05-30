'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { languageTags, withTimeout } = require('../utils');
const { loadExtractor } = require('../extractors');

async function getDownloadLinks(mediaUrl) {
  HEADERS.Referer = new URL(mediaUrl).origin + '/';
  try {
    const { data } = await axios.get(mediaUrl, { headers:HEADERS, httpsAgent:agent, timeout:12000 });
    const $ = cheerio.load(data);

    const typeRaw = $('h1.page-title span, h1, [class*="title"]').first().text();
    const pageLanguageLabel = languageTags(typeRaw).join(', ');
    const isMovie = !typeRaw.toLowerCase().includes('season') && 
                   !typeRaw.toLowerCase().includes('tv series') &&
                   !typeRaw.toLowerCase().includes('web series');

    let allLinks = [];

    if (mediaUrl.includes('4khdhub.link')) {
      $('.download-item').each((_, item) => {
        const box = $(item);
        const header = box.find('.download-header').text().trim().replace(/\s+/g, ' ');
        const sizeMatch = header.match(/([\d.]+\s*(?:GB|MB|KB))/i);
        const qualityMatch = header.match(/(\d{3,4})p/i);
        const variantMatch = header.match(/\(([^)]+)\)/);
        const size = sizeMatch ? sizeMatch[1] : '';
        const quality = qualityMatch ? parseInt(qualityMatch[1]) : 0;
        const variant = variantMatch ? variantMatch[1] : '';
        const langs = languageTags(header).join(', ');

        box.find('a[href]').each((__, el) => {
          const href = $(el).attr('href') || '';
          const text = $(el).text().trim().replace(/\s+/g, ' ');
          if (!href || !href.startsWith('http') || href.includes('.zip')) return;
          if (
            href.includes('hubcloud') || href.includes('hubdrive') || href.includes('hubcdn') ||
            href.includes('pixeldrain') || href.includes('streamtape') || href.includes('hdstream4u') ||
            href.includes('hubstream') || /\.(mp4|mkv|m3u8)/.test(href)
          ) {
            allLinks.push({
              url: href, quality, size, text,
              source: `${text.replace(/^Download\s+/i, '').trim() || 'Stream'}${variant ? ' [' + variant + ']' : ''}${langs ? ' [' + langs + ']' : ''}${size ? ' [' + size + ']' : ''}`,
              isMovie, episode: null
            });
          }
        });
      });
    }

    if (mediaUrl.includes('extraflix.')) {
      const pageLangs = languageTags(typeRaw).join(', ');
      $('.download-options-section a[href], .Untouched-download-links-section a[href], .entry-content a[href*="extralink"], .entry-content a[href*="pixeldrain"], .entry-content a[href*="streamtape"], .entry-content a[href*="hubcloud"], .entry-content a[href*="hubdrive"], .entry-content a[href*="linkshub"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (!href || !href.startsWith('http')) return;
        if (href.includes('extraflix.mobi') || href.includes('facebook') || href.includes('twitter') || href.includes('t.me') || href.includes('.zip')) return;
        
        const parentEl = $(el).parent();
        const parentText = parentEl.text().trim().replace(/\s+/g, ' ');
        const prevSiblingText = parentEl.prev().text().trim().replace(/\s+/g, ' ');
        const grandparentEl = parentEl.parent();
        
        let sectionHeaderText = '';
        grandparentEl.find('h2, h3, h4, h5, h6, strong, .title, .label').each(function() {
          const t = $(this).text().trim();
          if (t && t.length < 100) sectionHeaderText += ' ' + t;
        });
        sectionHeaderText = sectionHeaderText.replace(/\s+/g, ' ').trim();
        
        const context = prevSiblingText || sectionHeaderText || parentText || text;
        
        let quality = 0;
        if (/\b4K\b|\b2160\b/i.test(context)) {
          quality = 2160;
        } else {
          const qualityMatch = context.match(/(\d{3,4})\s*p/i);
          if (qualityMatch) quality = parseInt(qualityMatch[1]);
        }
        
        const sizeMatch = context.match(/\[?([\d.]+\s*(?:GB|MB|KB))\]?/i);
        const size = sizeMatch ? sizeMatch[1] : '';
        
        allLinks.push({
          url: href, quality, size, text: context || text,
          source: `ExtraFlix${context ? ' [' + context.replace(/\s*[-–]\s*/g, ' ') + ']' : ''}${pageLangs ? ' [' + pageLangs + ']' : ''}${size ? ' [' + size + ']' : ''}`,
          isMovie, episode: null,
        });
      });
    }

    if (!allLinks.length) $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      
      if (
        href && href.startsWith('http') && !href.includes(CONFIG.MAIN_URL) && !href.includes(CONFIG.BACKUP_URL) && !href.includes('.zip') &&
        (
          href.includes('hubcdn') || href.includes('hubcloud') || href.includes('hubdrive') ||
          href.includes('drivehub') || href.includes('linkshub') || href.includes('gadgetsweb') ||
          href.includes('pixeldrain') || href.includes('streamtape') || href.includes('hdstream4u') ||
          href.includes('hubstream') || /\.(mp4|mkv|m3u8)/.test(href)
        )
      ) {
        const qualityMatch = text.match(/(\d{3,4})[pP]|(\d{3,4})[pP]/);
        const quality = qualityMatch ? parseInt(qualityMatch[1] || qualityMatch[2]) : 0;
        const sizeMatch = text.match(/\[([0-9.]+\s*(?:GB|MB|KB))\]/i);
        const size = sizeMatch ? sizeMatch[1] : '';
        
        allLinks.push({
          url: href, quality, size, text,
          source: pageLanguageLabel ? `${text || 'Stream'} [${pageLanguageLabel}]${size ? ' [' + size + ']' : ''}` : undefined,
          isMovie, episode: null
        });
      }
    });

    const minQuality = 1080;
    allLinks = allLinks.filter(l => {
      const q = typeof l.quality==='number' ? l.quality : parseInt(l.quality)||0;
      return q === 0 || q >= minQuality;
    });

    if (CONFIG.IS_SERVERLESS) {
      allLinks.sort((a, b) => {
        const qa = typeof a.quality === 'number' ? a.quality : parseInt(a.quality) || 0;
        const qb = typeof b.quality === 'number' ? b.quality : parseInt(b.quality) || 0;
        return qb - qa;
      });
    }
    if (CONFIG.IS_VERCEL && (mediaUrl.includes('4khdhub.link') || mediaUrl.includes('extraflix.'))) {
      allLinks = allLinks.slice(0, 4);
    }

    if (!isMovie) {
      const episodeMap = new Map();
      $('h3, h4, h5').each((_, el) => {
        const text = $(el).text();
        const epMatch = text.match(/(?:EPiSODE|EP|E)\s*(\d+)/i);
        if (epMatch) {
          const ep = parseInt(epMatch[1]);
          if (!episodeMap.has(ep)) episodeMap.set(ep, []);
          $(el).nextUntil('h3, h4, h5').each((__, node) => {
            const href = $(node).attr('href') || $(node).find('a').attr('href');
            if (href) episodeMap.get(ep).push(href);
          });
        }
      });
      if (episodeMap.size > 0) {
        allLinks = allLinks.map(link => {
          for (const [ep, urls] of episodeMap) {
            if (urls.includes(link.url)) { link.episode = ep; break; }
          }
          return link;
        });
      }
    }

    const resolveLink = async (link) => {
      // Skip search-recover.php URLs immediately — JS-rendered, can't be statically resolved
      if (link.url.includes('search-recover.php')) return [];
      try {
        if (
          link.url.includes('gadgetsweb') || link.url.includes('hubcloud') || link.url.includes('hubdrive') ||
          link.url.includes('drivehub') || link.url.includes('linkshub') || link.url.includes('hubcdn') ||
          link.url.includes('extralink')
        ) {
          const resolveMs = mediaUrl.includes('extraflix.')
            ? (CONFIG.IS_SERVERLESS ? 20000 : 15000)
            : (mediaUrl.includes('4khdhub.link') && CONFIG.IS_SERVERLESS ? 15000 : (CONFIG.IS_SERVERLESS ? 10000 : 5000));
          const resolved = await withTimeout(loadExtractor(link.url, mediaUrl), resolveMs, []);
          if (resolved && resolved.length) {
            return resolved.map(r => ({
              ...r,
              quality: r.quality && !['Unknown', 'M3U8', 'Stream'].includes(String(r.quality)) ? r.quality : link.quality,
              size: r.size || link.size,
              labelSource: link.source,
              episode: link.episode,
            }));
          }
        }
        // Only pass through if the URL is directly playable (video file extension)
        // Do NOT pass through hubcloud/hubdrive pages — they're HTML, not video
        if (/\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(link.url)) {
          return [link];
        }
        return [];
      } catch (_) {
        // Only pass through if the URL is directly playable (video file extension)
        if (/\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(link.url)) {
          return [link];
        }
        return [];
      }
    };

    const finalLinks = [];
    if (mediaUrl.includes('extraflix.') && !CONFIG.IS_SERVERLESS) {
      for (const link of allLinks) finalLinks.push(...await resolveLink(link));
    } else {
      const results = await Promise.allSettled(allLinks.map(resolveLink));
      results.forEach(r => { if (r.status === 'fulfilled') finalLinks.push(...r.value); });
    }

    const wrapperHosts = ['hubdrive.', 'drivehub.', 'linkshub.', 'gadgetsweb.', 'hubcloud.', 'hubcdn.', 'hdstream4u.', 'hubstream.'];
    const hasResolvedDirect = finalLinks.some(l => {
      try { return !wrapperHosts.some(h => new URL(l.url).hostname.includes(h)); } catch (_) { return false; }
    });
    const filteredLinks = hasResolvedDirect && !mediaUrl.includes('extraflix.')
      ? finalLinks.filter(l => {
          try { return !wrapperHosts.some(h => new URL(l.url).hostname.includes(h)); } catch (_) { return false; }
        })
      : finalLinks;

    const seen = new Set();
    return {
      finalLinks: filteredLinks.filter(l => {
        if (!l.url || l.url.includes('.zip') || seen.has(l.url)) return false;
        seen.add(l.url); return true;
      }).slice(0, 50),
      isMovie,
    };
  } catch (e) { return { finalLinks: [], isMovie: true }; }
}

module.exports = { getDownloadLinks };
