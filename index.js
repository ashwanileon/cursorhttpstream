'use strict';

const express = require('express');
const axios = require('axios');
const { CONFIG, fetchDomain, getMeta, getDeploymentStatus, agent } = require('./src/config');
const { buildStreams, withTimeout, streamLabel, bestMatch } = require('./src/utils');
const {
  searchHDHub4u, findDirectPage, search4KHDHub4u, searchExtraFlix,
  searchUHDRodeo, getUHDRodeoLinks, searchMoviesDrives, getMoviesDrivesLinks,
  searchMWSDb, getMWSDbStreams, getDownloadLinks
} = require('./src/providers');

const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  next();
});
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.sendStatus(204);
});

const TOTAL_BUDGET = CONFIG.IS_SERVERLESS ? 115000 : 19000;

app.get('/manifest.json', (_, res) => res.json({
  id: 'community.httpstreams.stremio',
  version: '2.3.1',
  name: 'http streams',
  description: 'Multi-source streams from HDHub4u, 4KHDHub, ExtraFlix, MoviesDrives & UHDRodeo',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { adult: false, p2p: false },
}));

app.get('/stream/:type/:id.json', async (req, res) => {
  const [imdbId, season, episode] = req.params.id.split(':');
  const { type } = req.params;
  const sn = season ? parseInt(season) : null;
  const en = episode ? parseInt(episode) : null;
  let allStreams = [];

  let responded = false;
  const safeRespond = (payload) => {
    if (!responded) {
      responded = true;
      clearTimeout(deadlineTimer);
      res.json(payload);
    }
  };

  const deadlineTimer = setTimeout(() => {
    console.warn('[stream] deadline reached, sending partial result');
    const streams = buildStreams(allStreams, meta);
    safeRespond({ streams });
  }, TOTAL_BUDGET);

  let meta;
  try {
    meta = (await Promise.all([
      withTimeout(fetchDomain(), 3000),
      withTimeout(getMeta(imdbId, type), 5000),
    ]))[1];

    if (!meta) { return safeRespond({ streams: [] }); }

    // Start searches concurrently
    const searchPromises = [
      withTimeout(searchHDHub4u(meta.title), 8000, []),
      withTimeout(search4KHDHub4u(meta.title), 8000, []),
      withTimeout(searchExtraFlix(meta.title), 8000, []),
      withTimeout(searchUHDRodeo(meta.title), 5000, []),
      withTimeout(searchMoviesDrives(meta.title), 6000, []),
      withTimeout(searchMWSDb(meta.title), 8000, []),
    ];

    const [hdResults, fourKResults, extraResults, uhdSearchRes, mdSearchRes, mwsResults] = await Promise.all(searchPromises);

    // Prepare link extraction promises
    const extractionPromises = [];

    // ── 4KHDHub4u streams
    let fourKHandled = false;
    if (fourKResults.length) {
      const match = bestMatch(meta.title, fourKResults, sn, type);
      if (match) {
        fourKHandled = true;
        extractionPromises.push((async () => {
          try {
            const { finalLinks, isMovie } = await withTimeout(getDownloadLinks(match.url), 14000, { finalLinks:[], isMovie:true });
            let filtered = finalLinks;
            if (!isMovie && en !== null) filtered = finalLinks.filter(l => l.episode === en);
            filtered.slice(0, 15).forEach(l => {
              const q = typeof l.quality === 'number' ? l.quality : parseInt(l.quality) || 0;
              const label = streamLabel('4KHDHub', q, l);
              allStreams.push({ name: label.name, title: label.title, url: l.url });
            });
          } catch (e) { console.error('[4kResult]', e.message); }
        })());
      }
    }

    // ── HDHub4u streams
    extractionPromises.push((async () => {
      let hdList = hdResults.length ? hdResults : (meta.year ? await withTimeout(searchHDHub4u(`${meta.title} ${meta.year}`), 8000, []) : []);
      if (!hdList.length) {
        const direct = await withTimeout(findDirectPage(meta.title, meta.year), 5000, null);
        if (direct) hdList = [{ title: `${meta.title} (direct)`, url: direct }];
      }
      if (hdList.length) {
        const match = bestMatch(meta.title, hdList, sn, type);
        if (match) {
          try {
            const { finalLinks, isMovie } = await withTimeout(getDownloadLinks(match.url), 14000, { finalLinks:[], isMovie:true });
            let filtered = finalLinks;
            if (!isMovie && en !== null) filtered = finalLinks.filter(l => l.episode === en);
            filtered.forEach(l => {
              const q = typeof l.quality === 'number' ? l.quality : parseInt(l.quality) || 0;
              const label = streamLabel('HDHub4u', q, l);
              allStreams.push({ name: label.name, title: label.title, url: l.url });
            });
          } catch (e) { console.error('[hdResult]', e.message); }
        }
      }
    })());

    // ── ExtraFlix streams
    extractionPromises.push((async () => {
      let extraList = extraResults.length ? extraResults : (meta.year ? await withTimeout(searchExtraFlix(`${meta.title} ${meta.year}`), 8000, []) : []);
      if (extraList.length) {
        const match = bestMatch(meta.title, extraList, sn, type);
        if (match) {
          try {
            const { finalLinks, isMovie } = await withTimeout(getDownloadLinks(match.url), 14000, { finalLinks:[], isMovie:true });
            let filtered = finalLinks;
            if (!isMovie && en !== null) filtered = finalLinks.filter(l => l.episode === en);
            filtered.slice(0, 20).forEach(l => {
              const q = typeof l.quality === 'number' ? l.quality : parseInt(l.quality) || 0;
              const label = streamLabel('ExtraFlix', q, l);
              allStreams.push({ name: label.name, title: label.title, url: l.url });
            });
          } catch (e) { console.error('[extraResult]', e.message); }
        }
      }
    })());

    // ── UHDRodeo streams
    extractionPromises.push((async () => {
      let uhdResults = uhdSearchRes;
      if (!uhdResults.length && meta.year) uhdResults = await withTimeout(searchUHDRodeo(`${meta.title} ${meta.year}`), 5000, []);
      if (uhdResults.length) {
        const uhdMatch = bestMatch(meta.title, uhdResults, sn, type);
        if (uhdMatch) {
          try {
            const uhdLinks = await withTimeout(getUHDRodeoLinks(uhdMatch.url), 10000, []);
            uhdLinks.slice(0, 12).forEach(l => {
              const q = typeof l.quality === 'number' ? l.quality : parseInt(l.quality) || 0;
              const label = streamLabel('UHDRodeo', q, l);
              allStreams.push({ name: label.name, title: label.title, url: l.url });
            });
          } catch (e) { console.error('[uhdResult]', e.message); }
        }
      }
    })());

    // ── MoviesDrives streams
    extractionPromises.push((async () => {
      let mdResults = mdSearchRes;
      if (!mdResults.length && meta.year) mdResults = await withTimeout(searchMoviesDrives(`${meta.title} ${meta.year}`), 6000, []);
      if (mdResults.length) {
        const mdMatch = bestMatch(meta.title, mdResults, sn, type);
        if (mdMatch) {
          try {
            const mdLinks = await withTimeout(getMoviesDrivesLinks(mdMatch.url), 14000, []);
            mdLinks.slice(0, 12).forEach(l => {
              const q = typeof l.quality === 'number' ? l.quality : parseInt(l.quality) || 0;
              const label = streamLabel('MoviesDrives', q, l);
              allStreams.push({ name: label.name, title: label.title, url: l.url });
            });
          } catch (e) { console.error('[mdResult]', e.message); }
        }
      }
    })());

    // ── MWSDb streams (direct extraction, no getDownloadLinks needed)
    extractionPromises.push((async () => {
      if (mwsResults && mwsResults.length) {
        const match = bestMatch(meta.title, mwsResults, sn, type);
        if (match) {
          try {
            const mwsLinks = await withTimeout(getMWSDbStreams(match.url, en), 10000, []);
            mwsLinks.slice(0, 10).forEach(l => {
              const q = typeof l.quality === 'number' ? l.quality : parseInt(l.quality) || 0;
              const name = q > 0 ? `MWSDb ${q}p` : 'MWSDb';
              allStreams.push({ name, title: l.source || 'MWSDb', url: l.url });
            });
          } catch (e) { console.error('[mwsResult]', e.message); }
        }
      }
    })());

    // Run all extractors concurrently
    await Promise.allSettled(extractionPromises);

    const streams = buildStreams(allStreams, meta);
    safeRespond({ streams });
  } catch (e) {
    console.error('[stream]', e.message);
    safeRespond({ streams: [] });
  }
});

app.get('/health', (_, res) => {
  const deployment = getDeploymentStatus();
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    version: '2.3.1',
    ready: deployment.cfWorker || deployment.flareSolverr,
    deployment,
    hint: (!deployment.cfWorker && !deployment.flareSolverr)
      ? 'Set CF_WORKER_URL (deploy cf-worker/) on Koyeb so HubCloud links can be resolved.'
      : undefined,
  });
});

app.get('/livetest', async (req, res) => {
  const out = { steps: {}, fixes: [], version: '2.3.1', deployment: getDeploymentStatus() };
  if (!out.deployment.cfWorker && !out.deployment.flareSolverr) {
    out.fixes.push('⚠️ CF_WORKER_URL and FLARESOLVERR_ENDPOINT are unset — stream extraction will fail for HubCloud links');
  }
  try {
    try {
      const domain = await fetchDomain();
      out.steps.domain_used = domain;
      out.fixes.push(`✅ Domain resolved: ${domain}`);
    } catch (e) {
      out.steps.domain_error = e.message;
    }

    try {
      const hdResults = await searchHDHub4u('Superman');
      out.steps.hdhub4u_results = hdResults.length;
      if (hdResults.length) out.steps.hdhub4u_sample = hdResults.slice(0,3);
      out.fixes.push(`${hdResults.length ? '✅' : '❌'} HDHub4u search: ${hdResults.length} results`);
    } catch (e) { out.steps.hdhub4u_error = e.message; }

    try {
      const fourKResults = await search4KHDHub4u('Superman');
      out.steps.fourth_k_results = fourKResults.length;
      out.fixes.push(`${fourKResults.length ? '✅' : '❌'} 4KHDHub4u search: ${fourKResults.length} results`);
    } catch (e) { out.steps.fourth_k_error = e.message; }

    try {
      const extraResults = await searchExtraFlix('Superman');
      out.steps.extraflix_results = extraResults.length;
      out.fixes.push(`${extraResults.length ? '✅' : '❌'} ExtraFlix search: ${extraResults.length} results`);
    } catch (e) { out.steps.extraflix_error = e.message; }

    try {
      const uhdResults = await searchUHDRodeo('Superman');
      out.steps.uhdrodeo_results = uhdResults.length;
      out.fixes.push(`${uhdResults.length ? '✅' : '❌'} UHDRodeo search: ${uhdResults.length} results`);
    } catch (e) { out.steps.uhdrodeo_error = e.message; }

    try {
      const mdResults = await searchMoviesDrives('Superman');
      out.steps.moviesdrives_results = mdResults.length;
      out.fixes.push(`${mdResults.length ? '✅' : '❌'} MoviesDrives search: ${mdResults.length} results`);
    } catch (e) { out.steps.moviesdrives_error = e.message; }

    try {
      const mwsResults = await searchMWSDb('Superman');
      out.steps.mwsdb_results = mwsResults ? mwsResults.length : 0;
      out.fixes.push(`${(mwsResults && mwsResults.length) ? '✅' : '❌'} MWSDb search: ${mwsResults ? mwsResults.length : 0} results`);
    } catch (e) { out.steps.mwsdb_error = e.message; }
  } catch (e) {
    out.error = e.message;
  }
  res.json(out);
});

// Debug endpoint: fetches raw HTML from search URLs for diagnostics
app.get('/debug-search', async (req, res) => {
  const { url, source } = req.query;
  if (!url) return res.json({ error: 'Provide ?url= to fetch' });
  try {
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': source ? new URL(source).origin + '/' : url,
    };
    const { data, status, headers: respHeaders } = await axios.get(url, {
      headers: browserHeaders,
      httpsAgent: agent,
      timeout: 15000,
      responseType: 'text',
    });
    const snippet = typeof data === 'string' ? data.substring(0, 10000) : String(data).substring(0, 10000);
    res.json({
      status,
      content_type: respHeaders['content-type'],
      length: typeof data === 'string' ? data.length : 'non-string',
      snippet,
    });
  } catch (e) {
    res.json({
      error: e.message,
      status: e.response?.status,
      headers: e.response?.headers,
    });
  }
});

app.get('/', (req, res) => {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = `${proto}://${req.get('host')}`;
  res.send(`<!DOCTYPE html><html><head><meta charset=UTF-8><meta name=viewport content="width=device-width,initial-scale=1"><title>http streams</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#111827;border:1px solid #1f2937;border-radius:20px;padding:40px;max-width:580px;width:100%;text-align:center}h1{font-size:2rem;background:linear-gradient(135deg,#f97316,#dc2626);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}.sub{color:#6b7280;font-size:.85rem;margin:10px 0 20px}.btn{display:inline-block;margin:6px 4px;padding:11px 22px;border-radius:9px;font-weight:700;font-size:.88rem;text-decoration:none}.bp{background:linear-gradient(135deg,#f97316,#dc2626);color:#fff}.bs{background:#1f2937;color:#d1d5db;border:1px solid #374151}.url{margin-top:16px;background:#0f172a;border:1px solid #1e3a5f;border-radius:8px;padding:10px;font-size:.72rem;color:#64748b;word-break:break-all}.dbg{margin-top:16px;padding:14px;background:#0f172a;border-radius:10px;text-align:left}.dbg h3{color:#f97316;margin-bottom:8px;font-size:.78rem;text-transform:uppercase}.dbg a{color:#7dd3fc;font-size:.78rem;word-break:break-all;display:block;margin:5px 0;text-decoration:none}.badge{display:inline-block;background:#1e3a5f;color:#7dd3fc;border-radius:4px;font-size:.7rem;padding:2px 6px;margin:2px}</style>
</head><body><div class=card>
<h1>🎬 http streams</h1>
<p class=sub>Multi-source Stremio Addon · HubCloud · DriveHub · Hindi/Multi</p>
<div><span class=badge>v2.3.1</span><span class=badge>HDHub4u</span><span class=badge>4KHDHub</span><span class=badge>ExtraFlix</span><span class=badge>MoviesDrives</span><span class=badge>UHDRodeo</span></div><br>
<a class="btn bp" href="stremio://${host.replace(/^https?:\/\//, '')}/manifest.json">⚡ Install in Stremio</a>
<a class="btn bs" href="/manifest.json">Manifest</a>
<div class=url>${host}/manifest.json</div>
<div class=dbg><h3>🔬 Diagnostics</h3>
<a href="/livetest">🚨 /livetest — Full source health check</a>
<a href="/stream/movie/tt5950044.json">/stream/movie/tt5950044.json (Superman)</a>
</div></div></body></html>`);
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    const deployment = getDeploymentStatus();
    console.log(`Addon → http://localhost:${PORT}`);
    console.log('[startup] deployment:', JSON.stringify(deployment));
    if (!deployment.cfWorker && !deployment.flareSolverr) {
      console.warn('[startup] HubCloud bypass is not configured. Set CF_WORKER_URL on Koyeb (see cf-worker/ and .env.example).');
    }
  });
}

module.exports = app;
