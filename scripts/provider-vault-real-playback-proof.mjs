import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir =
  process.env.DAVETV_PROOF_OUT ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/provider-vault-real-playback-proof-20260527';
const cookiePath =
  process.env.DAVETV_AUTH_COOKIE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const host = process.env.DAVETV_APPS_HOST || 'https://apps.daveai.tech';
const providers = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];

function hashRows(rows, field) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(rows.slice(0, 60).map((row) => row[field] || row.name || row.title || row.stream_id || row.id)))
    .digest('hex')
    .slice(0, 16);
}

function isVideoResponse(row) {
  const type = String(row.contentType || '').toLowerCase();
  return (
    (row.status === 200 || row.status === 206) &&
    row.bytes >= 1024 &&
    (type.includes('video') || type.includes('octet-stream') || type.includes('mpegurl') || row.first8 === '0000002066747970')
  );
}

async function authCookies() {
  const raw = JSON.parse(await fs.readFile(cookiePath, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt ? Math.floor(new Date(raw.expiresAt).getTime() / 1000) : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: 'apps.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

async function fetchJson(page, url) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { parse_error: text.slice(0, 160) };
    }
    return { status: response.status, data };
  }, url);
}

async function byteProbe(page, provider, movie) {
  const ext = String(movie.container_extension || movie.ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const id = String(movie.stream_id || movie.id || '');
  return page.evaluate(
    async ({ provider, id, ext }) => {
      const url = `/api/provider-vault/stream?provider=${encodeURIComponent(provider)}&kind=movie&id=${encodeURIComponent(
        id,
      )}&ext=${encodeURIComponent(ext)}`;
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Range: 'bytes=0-4095' },
      });
      const buf = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
      return {
        id,
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentRange: response.headers.get('content-range'),
        bytes: buf.byteLength,
        first8: Array.from(new Uint8Array(buf.slice(0, 8)))
          .map((value) => value.toString(16).padStart(2, '0'))
          .join(''),
      };
    },
    { provider, id, ext },
  );
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
await context.addCookies(await authCookies());
const page = await context.newPage();
await page.goto(`${host}/iptv-player-zero/?real-proof=${Date.now()}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});

const providerList = await fetchJson(page, '/api/provider-vault/providers');
const results = [];

for (const provider of providers) {
  const catalog = await fetchJson(
    page,
    `/api/provider-vault/catalog?provider=${provider.id}&liveLimit=80&movieLimit=80&seriesLimit=80`,
  );
  const vod = await fetchJson(page, `/api/provider-vault/xtream-api?provider=${provider.id}&action=get_vod_streams`);
  const movies = Array.isArray(vod.data?.data) ? vod.data.data : Array.isArray(vod.data) ? vod.data : [];
  const movies2026 = movies.filter((item) => /\b2026\b/.test(String(item.name || item.title || '')));
  const samples = movies2026.slice(0, 3);
  const probes = [];
  for (const movie of samples) probes.push(await byteProbe(page, provider.id, movie));

  results.push({
    provider: provider.id,
    configured: Boolean(providerList.data?.providers?.find((item) => item.id === provider.id && item.configured)),
    catalogStatus: catalog.status,
    liveCount: Array.isArray(catalog.data?.live) ? catalog.data.live.length : 0,
    movieCount: Array.isArray(catalog.data?.movies) ? catalog.data.movies.length : 0,
    seriesCount: Array.isArray(catalog.data?.series) ? catalog.data.series.length : 0,
    liveFingerprint: hashRows(catalog.data?.live || [], 'name'),
    movieFingerprint: hashRows(catalog.data?.movies || [], 'name'),
    vodStatus: vod.status,
    vodCount: movies.length,
    movies2026Count: movies2026.length,
    sampleTitles: samples.map((item) => String(item.name || item.title || '').replace(/\s+/g, ' ').slice(0, 80)),
    byteProbes: probes,
    ok:
      catalog.status === 200 &&
      vod.status === 200 &&
      movies2026.length >= 3 &&
      probes.length === 3 &&
      probes.every(isVideoResponse),
  });
}

await browser.close();

const distinct =
  results.length === 2 &&
  (results[0].vodCount !== results[1].vodCount ||
    results[0].liveFingerprint !== results[1].liveFingerprint ||
    results[0].movieFingerprint !== results[1].movieFingerprint);

const summary = {
  ok: providerList.status === 200 && distinct && results.every((item) => item.ok),
  generatedAt: new Date().toISOString(),
  host,
  providerListStatus: providerList.status,
  distinctProviders: distinct,
  results,
};

await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
