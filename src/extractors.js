'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, agent } = require('./config');
const { atob, btoa, rot13, cleanTitle, withTimeout } = require('./utils');

async function getRedirectLinks(url) {
  try {
    const { data: doc } = await axios.get(url, { headers: HEADERS, httpsAgent: agent, timeout: 10000 });
    if (doc.trim() === 'Invalid Link !!') return null;
    const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
    let combined = '', m;
    while ((m = regex.exec(doc)) !== null) combined += (m[1] || m[2]);
    if (!combined) return null;
    const json = JSON.parse(atob(rot13(atob(atob(combined)))));
    const encodedUrl = atob(json.o || '').trim();
    if (encodedUrl) return encodedUrl;
    const data2 = btoa(json.data || '').trim();
    const wp    = (json.blog_url || '').trim();
    if (wp && data2) {
      const { data: resp } = await axios.get(`${wp}?re=${data2}`, { headers: HEADERS, httpsAgent: agent, timeout: 8000 });
      const $ = cheerio.load(resp);
      return $('body').text().trim();
    }
    return null;
  } catch (_) { return null; }
}

async function pixelDrainExtractor(link) {
  try {
    const m = link.match(/(?:file|u)\/([A-Za-z0-9]+)/);
    const id = m ? m[1] : link.split('/').pop();
    let quality = 'Unknown', name = '', size = 0;
    try {
      const { data } = await axios.get(`https://pixeldrain.com/api/file/${id}/info`, { httpsAgent: agent, timeout: 6000 });
      if (data.name) { name = data.name; size = data.size||0; const qm = data.name.match(/(\d{3,4})p/); if (qm) quality = qm[0]; }
    } catch (_) {}
    return [{ source:'Pixeldrain', quality, url:`https://pixeldrain.com/api/file/${id}?download`, name, size }];
  } catch (_) { return [{ source:'Pixeldrain', quality:'Unknown', url:link }]; }
}

async function hubCdnExtractor(url, referer) {
  try {
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const m = data.match(/[?&]r=([A-Za-z0-9+/=]+)/) || data.match(/var\s+reurl\s*=\s*["'][^"']*[?&]r=([A-Za-z0-9+/=]+)["']/);
    if (m) {
      const d = atob(m[1]);
      const link = d.includes('link=') ? d.substring(d.lastIndexOf('link=')+5) : d;
      return [{ source:'HubCdn', quality:'M3U8', url: decodeURIComponent(link) }];
    }
    return [];
  } catch (_) { return []; }
}

async function hubDriveExtractor(url, referer) {
  try {
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const $ = cheerio.load(data);
    const candidates = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (!href) return;
      if (
        href.includes('hubcloud') ||
        href.includes('hubcdn') ||
        href.includes('pixeldrain') ||
        href.includes('hdstream4u') ||
        href.includes('streamtape') ||
        /download|server|hubcloud/i.test(text)
      ) {
        candidates.push(href.startsWith('http') ? href : new URL(href, url).toString());
      }
    });
    for (const href of candidates) {
      const links = await loadExtractor(href, url);
      if (links.length) return links;
    }
    return [];
  } catch (_) { return []; }
}

async function hbLinksExtractor(url, referer) {
  try {
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const $ = cheerio.load(data);
    const links = $('h3 a, div.entry-content p a').map((_,el) => $(el).attr('href')).get();
    const results = [];
    for (const l of links) { const ex = await loadExtractor(l, url); results.push(...ex); }
    return results;
  } catch (_) { return []; }
}

async function streamTapeExtractor(link) {
  try {
    const u = new URL(link); u.hostname = 'streamtape.com';
    const { data } = await axios.get(u.toString(), { headers:HEADERS, httpsAgent:agent, timeout:8000 });
    const m = data.match(/'(\/\/streamtape\.com\/get_video[^']+)'/);
    if (m) return [{ source:'StreamTape', quality:'Stream', url:'https:'+m[1] }];
    return [];
  } catch (_) { return []; }
}

async function driveHubExtractor(url, referer) {
  try {
    const id = new URL(url).pathname.match(/\/file\/([^/]+)/)?.[1];
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const $ = cheerio.load(data);
    const title = $('title').text().replace(/^Drivehub\s*\|\s*/i, '').trim();
    const playHref = $('a[href*="play.php?id="]').first().attr('href') || (id ? `/play.php?id=${id}` : '');
    if (!playHref) return [];
    const playUrl = new URL(playHref, url).toString();
    const { data: playData } = await axios.get(playUrl, { headers:{...HEADERS,Referer:url}, httpsAgent:agent, timeout:8000 });
    const $$ = cheerio.load(playData);
    const src = $$('source[src], video[src]').first().attr('src');
    if (!src) return [];
    const qm = title.match(/(\d{3,4})p/i);
    const sm = title.match(/-\s*([\d.]+\s*(?:GB|MB|KB))\s*$/i);
    return [{
      source: `DriveHub${title ? ` [${cleanTitle(title)}]` : ''}${sm ? ` [${sm[1]}]` : ''}`,
      quality: qm ? parseInt(qm[1]) : 'Unknown',
      url: src,
      size: sm ? sm[1] : 0,
    }];
  } catch (e) { return []; }
}

async function linkshubExtractor(url, referer) {
  try {
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const $ = cheerio.load(data);
    const title = $('title').text().trim();
    const qm = title.match(/(\d{3,4})p/i);
    const sm = title.match(/-\s*([\d.]+\s*(?:GB|MB|KB))\s*$/i);
    const targets = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (
        href.includes('drivehub.') || href.includes('hubdrive.') || href.includes('hubcloud.') ||
        href.includes('pixeldrain') || href.includes('streamtape') || /\.(mp4|mkv|m3u8)(?:$|\?)/i.test(href)
      ) {
        targets.push(href);
      }
    });
    const out = [];
    for (const target of [...new Set(targets)].slice(0, 3)) {
      const links = await loadExtractor(target, url);
      links.forEach(link => {
        out.push({
          ...link,
          quality: link.quality && !['Unknown', 'Stream'].includes(String(link.quality)) ? link.quality : (qm ? parseInt(qm[1]) : link.quality),
          size: link.size || (sm ? sm[1] : 0),
          labelSource: `${title}${sm ? ` [${sm[1]}]` : ''}`,
        });
      });
    }
    return out;
  } catch (e) { return []; }
}

// Cache of working hubcloud domains (avoid retrying all TLDs on every request)
let workingHubCloudDomain = null;

// Nav headers for hubcloud requests
function hubCloudNavHeaders(ref) {
  return { ...HEADERS, Referer: ref, 'Upgrade-Insecure-Requests': '1', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
}

const MAX_HUBCLOUD_CANDIDATES = 3;

function isUsableHtml(html) {
  return html && typeof html === 'string' && html.length > 200 && !html.includes('Just a moment...');
}

// Per URL: direct → CF worker (with Referer) → FlareSolverr (serial, one at a time)
async function fetchHubCloudPage(pageUrl, ref) {
  const navHeaders = hubCloudNavHeaders(ref);

  try {
    const resp = await axios.get(pageUrl, { headers: navHeaders, httpsAgent: agent, timeout: 12000 });
    if (isUsableHtml(resp.data) && !resp.data.includes('cloudflare')) {
      return { html: resp.data, headers: navHeaders };
    }
  } catch (_) {}

  try {
    const { fetchViaCfProxy } = require('./cf-proxy');
    const proxyHtml = await fetchViaCfProxy(pageUrl, { headers: navHeaders });
    if (isUsableHtml(proxyHtml) && !proxyHtml.includes('cloudflare')) {
      return { html: proxyHtml, headers: navHeaders };
    }
  } catch (_) {}

  const { CONFIG } = require('./config');
  if (CONFIG.FLARESOLVERR_ENDPOINT) {
    try {
      const { solveViaFlareSolverr } = require('./flaresolverr');
      const solution = await solveViaFlareSolverr(pageUrl, { headers: navHeaders });
      if (solution?.body && isUsableHtml(solution.body) && !solution.body.includes('cloudflare')) {
        return { html: solution.body, headers: solution.headers || navHeaders };
      }
    } catch (_) {}
  }

  return null;
}

function buildHubCloudCandidates(url) {
  let hostname, path;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    path = parsed.pathname + parsed.search + parsed.hash;
  } catch (_) {
    return [url];
  }

  const candidates = [url];
  if (!hostname.includes('hubcloud')) return candidates;

  const { CONFIG } = require('./config');
  const currentTld = hostname.split('.').slice(-1)[0];
  for (const domain of CONFIG.HUB_CLOUD_DOMAINS) {
    if (candidates.length >= MAX_HUBCLOUD_CANDIDATES) break;
    if (domain === hostname || domain.endsWith(`.${currentTld}`)) continue;
    const candidate = `https://${domain}${path}`;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

// Try a few hubcloud TLDs sequentially (avoids 20+ parallel CF/FS calls per link)
async function resolveHubCloudUrl(url, referer) {
  let path;
  try {
    path = new URL(url).pathname + new URL(url).search + new URL(url).hash;
  } catch (_) {
    return { html: null };
  }

  if (workingHubCloudDomain && url.includes('hubcloud')) {
    const cachedUrl = `https://${workingHubCloudDomain}${path}`;
    const cached = await fetchHubCloudPage(cachedUrl, referer);
    if (cached) return { html: cached.html, finalUrl: cachedUrl };
    workingHubCloudDomain = null;
  }

  for (const candidate of buildHubCloudCandidates(url)) {
    const page = await fetchHubCloudPage(candidate, referer);
    if (page) {
      try { workingHubCloudDomain = new URL(candidate).hostname; } catch (_) {}
      return { html: page.html, finalUrl: candidate };
    }
  }

  return { html: null };
}

async function hubCloudExtractor(url, referer) {
  try {
    // Resolve hubcloud URL with domain fallbacks
    const { html, finalUrl } = await resolveHubCloudUrl(url, referer);
    if (!html) {
      console.warn(`[hubcloud] All hubcloud domain variants failed for: ${url.substring(0, 80)}`);
      return [];
    }

    let curHtml = html;
    let curFinalUrl = finalUrl;
    let curReferer = referer;

    // Handle redirect pages (hubcloud.php pattern)
    if (!curFinalUrl.includes('hubcloud.php')) {
      const m = curHtml.match(/var url = '([^']*)'/);
      if (m && m[1]) {
        const previousUrl = curFinalUrl;
        curFinalUrl = m[1];
        const nextPage = await fetchHubCloudPage(curFinalUrl, previousUrl);
        if (nextPage) {
          curHtml = nextPage.html;
          curReferer = previousUrl;
        }
      }
    }

    const $ = cheerio.load(curHtml);
    const size   = $('i#size').text().trim();
    const header = $('div.card-header').text().trim();
    const qm     = (header||'').match(/(\d{3,4})[pP]/);
    const quality= qm ? parseInt(qm[1]) : 2160;
    const details= cleanTitle(header);
    const label  = `${details?`[${details}]`:''}${size?`[${size}]`:''}`;
    const bytes  = (() => {
      const m = size.match(/([\d.]+)\s*(GB|MB|KB)/i);
      if (!m) return 0;
      return parseFloat(m[1]) * (m[2].toUpperCase()==='GB'?1073741824:m[2].toUpperCase()==='MB'?1048576:1024);
    })();
    const links = [];
    for (const el of $('div.card-body h2 a.btn').get()) {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (!href) continue;
      if (text.includes('Download File')) links.push({ source:`HubCloud ${label}`, quality, url:href, size:bytes });
      else if (text.includes('FSL Server')) links.push({ source:`HubCloud FSL ${label}`, quality, url:href, size:bytes });
      else if (text.includes('S3 Server')) links.push({ source:`HubCloud S3 ${label}`, quality, url:href, size:bytes });
      else if (text.includes('BuzzServer')) {
        try {
          const br = await axios.get(`${href}/download`, { headers:{...HEADERS,Referer:href}, maxRedirects:0, validateStatus:s=>s<400, httpsAgent:agent, timeout:8000 });
          const dl = br.headers['hx-redirect'];
          if (dl) links.push({ source:`HubCloud BuzzServer ${label}`, quality, url:new URL(href).origin+dl, size:bytes });
        } catch (e) {
          const dl = e.response?.headers?.['hx-redirect'];
          if (dl) links.push({ source:`HubCloud BuzzServer ${label}`, quality, url:new URL(href).origin+dl, size:bytes });
        }
      } else if (href.includes('pixeldra')) {
        links.push({ source:`Pixeldrain ${label}`, quality, url:href, size:bytes });
      } else if (text.includes('10Gbps')) {
        let c = href, fl = null;
        for (let i=0; i<5; i++) {
          try {
            const r = await axios.get(c, { maxRedirects:0, validateStatus:null, httpsAgent:agent, timeout:6000 });
            const loc = r.headers.location;
            if (!loc) break;
            if (loc.includes('link=')) { fl = loc.substring(loc.indexOf('link=')+5); break; }
            c = new URL(loc,c).toString();
          } catch (e) {
            const loc = e.response?.headers?.location;
            if (!loc) break;
            if (loc.includes('link=')) { fl = loc.substring(loc.indexOf('link=')+5); break; }
            c = new URL(loc,c).toString();
          }
        }
        if (fl) links.push({ source:`HubCloud 10Gbps ${label}`, quality, url:fl, size:bytes });
      } else {
        const ex = await loadExtractor(href, curFinalUrl);
        links.push(...ex);
      }
    }
    return links;
  } catch (e) { return []; }
}

async function extralinkInkExtractor(url, referer) {
  try {
    const pageUrl = url.endsWith('/') ? url : url + '/';
    const { data } = await axios.get(pageUrl, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent, timeout: 15000 });
    const extractLink = (key) => {
      const pattern = new RegExp(`\\"${key}\\"\s*:\s*\\"([^\\"]+)\\"`);
      const m = data.match(pattern);
      if (m && m[1] && !m[1].includes('null') && m[1].length > 5) return m[1].replace(/\\\//g, '/');
      return null;
    };
    const linkValue = extractLink('pixeldrainLink');
    if (linkValue) return await pixelDrainExtractor(linkValue);
    const filepressValue = extractLink('filepressLink');
    if (filepressValue) return [{ source: 'FilePress', quality: 'Unknown', url: filepressValue }];
    const vikingValue = extractLink('vikingLink');
    if (vikingValue) return [{ source: 'VikingFile', quality: 'Unknown', url: vikingValue }];
    const streamhgValue = extractLink('streamhgLink');
    if (streamhgValue) return [{ source: 'StreamHG', quality: 'Unknown', url: streamhgValue }];
    const vidhideValue = extractLink('vidhideLink');
    if (vidhideValue) return [{ source: 'VidHide', quality: 'Unknown', url: vidhideValue }];
    return [{ source: 'ExtraLink', quality: 'Unknown', url: pageUrl }];
  } catch (_) { return []; }
}

// Extract playable URLs from cloud.unblockedgames.world proxy links
// The page serves an auto-submitting form that POSTs the sid to get the real video URL
async function unblockedGamesExtractor(url) {
  try {
    const sid = url.match(/[?&]sid=([^&]+)/)?.[1];
    if (sid) {
      // POST the sid, but DON'T follow redirects — catch the redirect URL
      try {
        const redirectResp = await axios.post('https://cloud.unblockedgames.world/',
          `sid=${sid}`,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': HEADERS['User-Agent'],
              'Referer': 'https://cloud.unblockedgames.world/',
            },
            httpsAgent: agent,
            timeout: 15000,
            maxRedirects: 0,
          }
        );
        // With maxRedirects:0, a redirect returns status 3xx without following
        // Check both the response status and headers for redirect location
        if (redirectResp.status >= 300 && redirectResp.status < 400) {
          const loc = redirectResp.headers?.location;
          if (loc) {
            const resolvedUrl = loc.startsWith('http') ? loc : new URL(loc, 'https://cloud.unblockedgames.world').toString();
            return [{ source: 'UnblockedGames', quality: 'Unknown', url: resolvedUrl }];
          }
        }
      } catch (redirectErr) {
        // Fallback: catch any errors and check for Location header
        const loc = redirectErr.response?.headers?.location;
        if (loc) {
          const resolvedUrl = loc.startsWith('http') ? loc : new URL(loc, 'https://cloud.unblockedgames.world').toString();
          return [{ source: 'UnblockedGames', quality: 'Unknown', url: resolvedUrl }];
        }
      }

      // If no redirect, try with redirect following to check response body
      try {
        const { data: postResp } = await axios.post('https://cloud.unblockedgames.world/',
          `sid=${sid}`,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': HEADERS['User-Agent'],
              'Referer': 'https://cloud.unblockedgames.world/',
            },
            httpsAgent: agent,
            timeout: 15000,
            maxRedirects: 5,
            responseType: 'text',
          }
        );
        if (typeof postResp === 'string') {
          // Only match URLs with actual video file extensions
          const m = postResp.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|m3u8)(?:[?#][^\s"'<>]*)?)/i);
          if (m) return [{ source: 'UnblockedGames', quality: 'Unknown', url: m[1] }];
        }
        const m = (typeof postResp === 'string') ? postResp.match(/<iframe[^>]+src=["']([^"']+)["']/i) : null;
        if (m) return [{ source: 'UnblockedGames', quality: 'Unknown', url: m[1] }];
      } catch (_) {}

      // Last resort: try via CF Proxy (bypasses Cloudflare on the proxy domain itself)
      try {
        const { fetchViaCfProxy } = require('./cf-proxy');
        const proxyResult = await fetchViaCfProxy('https://cloud.unblockedgames.world/', {
          method: 'POST',
          body: `sid=${sid}`,
          contentType: 'application/x-www-form-urlencoded',
        });
        if (proxyResult && typeof proxyResult === 'string') {
          // Only match URLs with actual video file extensions
          const m = proxyResult.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|m3u8)(?:[?#][^\s"'<>]*)?)/i);
          if (m) return [{ source: 'UnblockedGames', quality: 'Unknown', url: m[1] }];
          const iframeMatch = proxyResult.match(/<iframe[^>]+src=["']([^"']+)["']/i);
          if (iframeMatch) return [{ source: 'UnblockedGames', quality: 'Unknown', url: iframeMatch[1] }];
        }
      } catch (_) {}
    }
    return [];
  } catch (_) {
    return [];
  }
}

async function hubSearchRecoverExtractor(url, referer) {
  async function parseSearchPage(html) {
    const $ = cheerio.load(html);
    const link = $('.actions .open').first().attr('href') || $('.actions a[href]').first().attr('href') || $('a.open[href]').first().attr('href');
    if (link) {
      const fullUrl = link.startsWith('http') ? link : new URL(link, url).toString();
      return await hubCloudExtractor(fullUrl, url);
    }
    const anyLink = $('li.row a[href]').first().attr('href');
    if (anyLink) {
      const fullUrl = anyLink.startsWith('http') ? anyLink : new URL(anyLink, url).toString();
      return await hubCloudExtractor(fullUrl, url);
    }
    return [];
  }

  try {
    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Referer: referer },
      httpsAgent: agent,
      timeout: 12000,
    });
    if (data && typeof data === 'string' && data.length > 200) {
      const result = await parseSearchPage(data);
      if (result.length) return result;
    }
  } catch (e) {}

  // Fallback: try via CF Proxy
  try {
    const { fetchViaCfProxy } = require('./cf-proxy');
    const proxyHtml = await fetchViaCfProxy(url);
    if (proxyHtml && typeof proxyHtml === 'string' && proxyHtml.length > 200) {
      const result = await parseSearchPage(proxyHtml);
      if (result.length) return result;
    }
  } catch (_) {}
  return [];
}

async function mdriveLolExtractor(url, referer) {
  try {
    const { data } = await axios.get(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent, timeout: 15000 });
    const $ = cheerio.load(data);
    const candidates = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.startsWith('http')) return;
      const host = new URL(href).hostname;
      if (host.includes('mdrive.lol') || host.includes('facebook') || host.includes('twitter') || host.includes('youtube') || host.includes('t.me') || host.includes('wordpress')) return;
      if (
        host.includes('hubcloud') || host.includes('hubdrive') || host.includes('drivehub') ||
        host.includes('linkshub') || host.includes('hubcdn') || host.includes('pixeldrain') ||
        host.includes('streamtape') || host.includes('hdstream4u') || host.includes('gdflix') ||
        /\.(mp4|mkv|m3u8)(?:$|\?)/i.test(href)
      ) {
        candidates.push(href);
      }
    });
    if (!candidates.length) return [];
    const results = await Promise.allSettled(
      [...new Set(candidates)].slice(0, 3).map(href => withTimeout(loadExtractor(href, url), 15000, []))
    );
    const out = [];
    results.forEach(r => { if (r.status === 'fulfilled' && r.value.length) out.push(...r.value); });
    return out;
  } catch (e) { return []; }
}

async function loadExtractor(url, referer) {
  if (!url) return [];
  try {
    const host = new URL(url).hostname;
    if (url.includes('?id=') || host.includes('techyboy4u') || host.includes('gadgetsweb')) {
      const r = await getRedirectLinks(url);
      if (!r) return [];
      return loadExtractor(r, url);
    }
    if (url.includes('search-recover.php')) return hubSearchRecoverExtractor(url, referer);
    if (host.includes('hubcloud'))    return hubCloudExtractor(url, referer);
    if (host.includes('mdrive.lol'))  return mdriveLolExtractor(url, referer);
    if (host.includes('hubdrive'))   return hubDriveExtractor(url, referer);
    if (host.includes('drivehub'))   return driveHubExtractor(url, referer);
    if (host.includes('linkshub'))   return linkshubExtractor(url, referer);
    if (host.includes('hubcdn'))     return hubCdnExtractor(url, referer);
    if (host.includes('hblinks'))    return hbLinksExtractor(url, referer);
    if (host.includes('pixeldrain')) return pixelDrainExtractor(url);
    if (host.includes('streamtape')) return streamTapeExtractor(url);
    if (host.includes('unblockedgames') || host.includes('cloud.unblockedgames')) return unblockedGamesExtractor(url);
    if (host.includes('hdstream4u')) return [{ source:'HdStream4u', quality:'Unknown', url }];
    if (host.includes('linkrit'))    return [];
    if (host.includes('extralink'))  return extralinkInkExtractor(url, referer);
    return [{ source: host.replace(/^www\./,''), quality:'Unknown', url }];
  } catch (_) { return []; }
}

module.exports = { loadExtractor, getRedirectLinks };
