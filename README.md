# http streams — Stremio addon

Multi-source HTTP streams (HDHub4u, 4KHDHub, ExtraFlix, MoviesDrives, UHDRodeo) for Stremio.

## Why streams fail on Koyeb without extra setup

Search works from the server, but **download hosts (HubCloud, etc.) sit behind Cloudflare**. Datacenter IPs (Koyeb, Vercel) are blocked unless you route fetches through:

1. **Cloudflare Worker proxy** (recommended) — folder `../cf-worker/`
2. **FlareSolverr** (optional fallback) — `FLARESOLVERR_ENDPOINT`

## Deploy on Koyeb

1. Create a Koyeb service from this repo with **root directory** `httpstream` (or use the included `Dockerfile`).
2. **Build**: `npm ci` · **Run**: `npm start` (or Docker).
3. **Health check path**: `/health` — `ready: true` when `CF_WORKER_URL` is set.
4. **Environment variables** (service → Variables):

   | Variable | Required | Description |
   |----------|----------|-------------|
   | `CF_WORKER_URL` | Yes (for streams) | URL of deployed Cloudflare Worker, no trailing slash |
   | `FLARESOLVERR_ENDPOINT` | No | e.g. `http://host:8191` |
   | `TMDB_KEY` | No | Metadata fallback |

5. Install in Stremio: `https://YOUR-APP.koyeb.app/manifest.json`

## Deploy the Cloudflare Worker

```bash
cd cf-worker
npm install
npx wrangler deploy
```

Copy the `*.workers.dev` URL into Koyeb as `CF_WORKER_URL`.

## Local development

```bash
cd httpstream
cp .env.example .env
# edit .env — set CF_WORKER_URL after deploying the worker
npm install
npm start
```

Diagnostics:

- `GET /health` — config status
- `GET /livetest` — source search health
- `GET /stream/movie/tt5950044.json` — Superman test

## Project layout

- `index.js` — Express Stremio HTTP addon
- `src/providers/` — per-site search and link extraction
- `src/extractors.js` — HubCloud, Pixeldrain, DriveHub, etc.
- `src/cf-proxy.js` — Cloudflare Worker client
- `../cf-worker/` — edge proxy for Cloudflare bypass
