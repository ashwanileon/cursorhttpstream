'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');

async function searchMWSDb(query) {
  try {
    const urls = [
      `${CONFIG.MWSDB_URL}/search?q=${encodeURIComponent(query)}`,
      `${CONFIG.MWSDB_URL}/search?query=${encodeURIComponent(query)}`,
      `${CONFIG.MWSDB_URL}/?s=${encodeURIComponent(query)}`,
    ];
    for (const url of urls) {
      try {
        const { data, status } = await axios.get(url, {
          headers: {
            'User-Agent': HEADERS['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml,*/*',
            'Referer': CONFIG.MWSDB_URL + '/',
          },
          httpsAgent: agent,
          timeout: 8000,
        });
        if (status !== 200 || !data) continue;
        const $ = cheerio.load(data);
        const results = [];
        $('a[href]').each((_, el) => {
          const e    = $(el);
          const href = e.attr('href') || '';
          const txt  = e.text().trim()
                    || e.find('h2,h3,h4,p,.title,.name').first().text().trim()
                    || e.find('img').attr('alt') || '';
          if (
            href &&
            txt.length > 3 &&
            (href.includes('/movie/') || href.includes('/show/') ||
             href.includes('/series/') || href.includes('/title/') ||
             href.includes('/film/'))
          ) {
            const full = href.startsWith('http') ? href : `${CONFIG.MWSDB_URL}${href}`;
            results.push({ title: txt, url: full, source: 'mwsdb' });
          }
        });
        if (results.length) {
          const seen = new Set();
          return results.filter(r => { if(seen.has(r.url))return false; seen.add(r.url); return true; });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return [];
}

async function getMWSDbStreams(mediaUrl, episode) {
  try {
    const { data } = await axios.get(mediaUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': CONFIG.MWSDB_URL + '/',
      },
      httpsAgent: agent,
      timeout: 10000,
    });
    const $ = cheerio.load(data);
    const streams = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const txt  = $(el).text().trim();
      if (
        href.startsWith('http') &&
        !href.includes(CONFIG.MWSDB_URL) &&
        !href.includes('.zip') &&
        (
          href.includes('hubcloud') || href.includes('pixeldrain') ||
          href.includes('streamtape') || href.includes('gdrive') ||
          href.includes('mega.nz') || href.includes('1drv') ||
          href.includes('mediafire') || href.includes('drive.google') ||
          /\.(mp4|mkv|m3u8)/.test(href)
        )
      ) {
        const qm = txt.match(/(\d{3,4})p/i) || href.match(/(\d{3,4})p/i);
        streams.push({
          source: `MWSDb | ${new URL(href).hostname.replace('www.','')}`,
          quality: qm ? parseInt(qm[1]) : 0,
          url: href,
          size: 0,
          episode: episode || null,
        });
      }
    });

    $('iframe[src], source[src]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && src.startsWith('http') && !src.includes(CONFIG.MWSDB_URL)) {
        streams.push({ source: 'MWSDb | embed', quality: 0, url: src, size: 0, episode: episode||null });
      }
    });

    return streams;
  } catch (_) { return []; }
}

module.exports = { searchMWSDb, getMWSDbStreams };
