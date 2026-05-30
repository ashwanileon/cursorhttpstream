'use strict';

const TAG_ORDER = ['WEB-DL', 'BluRay', 'DV', 'HDR', 'HEVC', 'x264', 'DDP5.1', 'Atmos', 'AAC5.1', 'Multi Audio', '10bit'];

const LANG_DISPLAY = {
  hin: 'Hindi', en: 'English', tam: 'Tamil', tel: 'Telugu',
  mal: 'Malayalam', kan: 'Kannada', mar: 'Marathi', ben: 'Bengali',
  pun: 'Punjabi', guj: 'Gujarati', urd: 'Urdu', kor: 'Korean',
  jpn: 'Japanese', spa: 'Spanish', fre: 'French', ger: 'German',
};

function rot13(v) {
  return v.replace(/[a-zA-Z]/g, c =>
    String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));
}

function atob(v) { return Buffer.from(v, 'base64').toString('utf-8'); }

function btoa(v) { return Buffer.from(v).toString('base64'); }

function formatBytes(b) {
  if (!+b) return '';
  const k = 1024, s = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${parseFloat((b/Math.pow(k,i)).toFixed(1))} ${s[i]}`;
}

function displaySize(link) {
  for (const value of [link.labelSource, link.source]) {
    const m = String(value || '').match(/\[([\d.]+\s*(?:GB|MB|KB))\]/i);
    if (m) return m[1];
  }
  if (typeof link.size === 'string' && link.size.trim()) return link.size.trim();
  return typeof link.size === 'number' ? formatBytes(link.size) : '';
}

function cleanHostLabel(source) {
  return String(source || 'Stream')
    .replace(/\[.*?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^cdn\./i, 'CDN ');
}

function normalizeSearchText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function releaseTags(source) {
  const tags = [];
  const rawParts = [...String(source || '').matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
  for (const raw of rawParts) {
    if (/^[\d.]+\s*(?:GB|MB|KB)$/i.test(raw.trim())) continue;
    if (/^(?:hin|en|tam|tel|mal|kan|mar|ben|pun|guj|urd|kor|jpn|spa|fre|ger)(?:\s*,\s*(?:hin|en|tam|tel|mal|kan|mar|ben|pun|guj|urd|kor|jpn|spa|fre|ger))*$/i.test(raw.trim())) continue;
    const normalized = raw
      .replace(/WEB[.\s_-]?DL/ig, 'WEB-DL')
      .replace(/DDP?5[.\s]?1/ig, 'DDP5.1')
      .replace(/H[.\s]?265|x265/ig, 'HEVC')
      .replace(/H[.\s]?264|x264/ig, 'x264')
      .replace(/4kHdHub\.Com\.mkv/ig, '')
      .replace(/\.mkv/ig, '')
      .replace(/[._]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) continue;
    const candidates = [
      /WEB-DL/i.test(normalized) && 'WEB-DL',
      /DV|Dolby.?Vision/i.test(normalized) && 'DV',
      /HDR/i.test(normalized) && 'HDR',
      /HEVC/i.test(normalized) && 'HEVC',
      /x264/i.test(normalized) && 'x264',
      /DDP5\.1|Dolby.?Digital.?Plus/i.test(normalized) && 'DDP5.1',
      /Atmos/i.test(normalized) && 'Atmos',
      /Multi/i.test(normalized) && 'Multi Audio',
      /AAC5\.?1/i.test(normalized) && 'AAC5.1',
      /\bAAC\b(?!5)/i.test(normalized) && 'AAC',
      /BluRay|BRRip|BDRip|Blu.?ray/i.test(normalized) && 'BluRay',
      /10.?bit|Hi10/i.test(normalized) && '10bit',
    ].filter(Boolean);
    tags.push(...(candidates.length ? candidates : [normalized]));
  }
  const unique = [...new Set(tags)];
  return unique.sort((a, b) => {
    const ia = TAG_ORDER.indexOf(a);
    const ib = TAG_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  }).slice(0, 6);
}

function languageTags(source) {
  const text = normalizeSearchText(source);
  const languages = [
    [['hindi', 'hin'], 'hin'],
    [['english', 'eng', 'en'], 'en'],
    [['tamil', 'tam'], 'tam'],
    [['telugu', 'tel'], 'tel'],
    [['malayalam', 'mal'], 'mal'],
    [['kannada', 'kan'], 'kan'],
    [['marathi', 'mar'], 'mar'],
    [['bengali', 'ben'], 'ben'],
    [['punjabi', 'pun'], 'pun'],
    [['gujarati', 'guj'], 'guj'],
    [['urdu', 'urd'], 'urd'],
    [['korean', 'kor'], 'kor'],
    [['japanese', 'jpn', 'japanese'], 'jpn'],
    [['spanish', 'spa'], 'spa'],
    [['french', 'fre'], 'fre'],
    [['german', 'ger'], 'ger'],
  ];
  return languages
    .filter(([names]) => names.some(name => new RegExp(`\\b${name}\\b`).test(text)))
    .map(([, code]) => code);
}

function streamLabel(provider, quality, link) {
  const resolution = quality > 0 ? `${quality}p` : 'Stream';
  const size = displaySize(link);
  const host = cleanHostLabel(link.source);
  const labelText = `${link.source || ''} ${link.labelSource || ''}`;
  const langs = languageTags(labelText);
  const langDisplay = langs.length ? langs.map(l => LANG_DISPLAY[l] || l.toUpperCase()).join('+') : '';
  const details = releaseTags(labelText);
  const titleParts = [
    details.length ? details.join(' ') : null,
    size,
    langDisplay,
    host !== 'Stream' ? host : null,
  ].filter(Boolean);
  return {
    name: resolution ? `${provider} ${resolution}` : provider,
    title: titleParts.length ? titleParts.join(' • ') : (resolution || provider),
  };
}

function cleanTitle(title) {
  const parts = title.split(/[.\-_]/);
  const quality = ['WEBRip','WEB-DL','WEB','BluRay','HDRip','DVDRip','HDTV','CAM','TS','BRRip','BDRip','DVD','HD'];
  const audio   = ['AAC','AC3','DTS','MP3','FLAC','DD5','EAC3','Atmos'];
  const subs    = ['ESub','ESubs','Subs','MultiSub','NoSub'];
  const codec   = ['x264','x265','H264','H265','265','HEVC','AVC','HDR','DV'];
  const si = parts.findIndex(p => quality.some(t => p.toLowerCase().includes(t.toLowerCase())));
  const ei = parts.findLastIndex(p => [...audio,...subs,...codec].some(t => p.toLowerCase().includes(t.toLowerCase())));
  if (si !== -1 && ei >= si) return parts.slice(si, ei+1).join('.');
  if (si !== -1) return parts.slice(si).join('.');
  return parts.slice(-3).join('.');
}

function streamFilename(url, name, title, year) {
  let ext = 'mp4';
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.(mp4|mkv|m3u8|ts|webm|avi|mov)(\?|$)/i);
    if (m) ext = m[1].toLowerCase();
  } catch (_) {}
  const titleSlug = (title || 'stream').replace(/[^\w\s-]/g, '').replace(/\s+/g, '.').substring(0, 30);
  const resMatch = name.match(/(\d+)p/);
  const quality = resMatch ? resMatch[1] : '';
  return `${titleSlug}${year ? '.' + year : ''}${quality ? '.' + quality + 'p' : ''}.${ext}`;
}

/** Returns false for HTML landing pages (hubcloud, sid proxies) that Stremio cannot play directly. */
function isPlayableStreamUrl(url) {
  if (!url || url.includes('.zip')) return false;
  try {
    const u = new URL(url);
    const pathQuery = `${u.pathname}${u.search}`;
    if (/\.(mp4|mkv|m3u8|webm|avi|mov)(\?|$|#)/i.test(pathQuery)) return true;
    if (u.hostname.includes('pixeldrain.com')) return true;
    if (u.hostname.includes('streamtape.com') && u.pathname.includes('get_video')) return true;
    const htmlOnlyHosts = [
      'hubcloud', 'hubdrive', 'drivehub', 'linkshub', 'gadgetsweb',
      'hubcdn', 'hdstream4u', 'hubstream', 'extralink',
    ];
    if (htmlOnlyHosts.some(h => u.hostname.includes(h))) return false;
    if (u.hostname.includes('unblockedgames') && u.search.includes('sid=')) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function buildStreams(allStreams, meta, maxPerSource = 2) {
  const groups = {};
  for (const s of allStreams) {
    if (!s.url || !isPlayableStreamUrl(s.url)) continue;
    const q = parseInt(s.name.match(/(\d+)p/)?.[1]||0);
    if (q > 0 && q < 1080) continue;
    const nameStr = s.name || '';
    const suffixMatch = nameStr.match(/(\d+)p$/);
    let provider = suffixMatch ? nameStr.slice(0, nameStr.lastIndexOf(' ')).trim() : nameStr;
    if (!provider) provider = 'Unknown';
    const key = `${provider}::${q || 'other'}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }
  const selected = [];
  for (const streams of Object.values(groups)) {
    selected.push(...streams.slice(0, maxPerSource));
  }
  selected.sort((a, b) => {
    const qa = parseInt(a.name.match(/(\d+)p/)?.[1]||0);
    const qb = parseInt(b.name.match(/(\d+)p/)?.[1]||0);
    return qb - qa;
  });
  return selected.map(s => {
    const resMatch = s.name.match(/(\d+)p/);
    return {
      ...s,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: resMatch ? `res-${resMatch[1]}` : 'default',
        filename: streamFilename(s.url, s.name, meta?.title, meta?.year),
      },
    };
  });
}

function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function slugify(s) {
  return s.toLowerCase().replace(/[\u2019'"\.:,!()\[\]]+/g,'')
    .replace(/[^a-z0-9\s-]/g,'')
    .trim().replace(/\s+/g,'-');
}

function bestMatch(title, results, season, type) {
  if (type==='series'&&season) {
    const p = new RegExp(`season\\s*${season}|s0*${season}\\b`,'i');
    const m = results.filter(r=>p.test(r.title));
    if (m.length) return m[0];
  }
  const tokens = normalizeSearchText(title).split(' ').filter(t => t.length > 2);
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    const url = r.url || '';
    const haystack = normalizeSearchText(`${r.title || ''} ${url}`);
    let score = 0;
    for (const token of tokens) if (haystack.includes(token)) score += 10;
    if (url.includes(slugify(title))) score += 40;
    if (normalizeSearchText(r.title).startsWith(normalizeSearchText(title))) score += 20;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

module.exports = {
  rot13, atob, btoa, formatBytes, displaySize, cleanHostLabel,
  releaseTags, languageTags, streamLabel, cleanTitle,
  normalizeSearchText, streamFilename, buildStreams, isPlayableStreamUrl,
  withTimeout, slugify, bestMatch, TAG_ORDER, LANG_DISPLAY
};
