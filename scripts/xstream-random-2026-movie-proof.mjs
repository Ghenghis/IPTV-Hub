import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE_URL = process.env.XSTREAM_URL || 'https://xstream-player.daveai.tech';
const AUTH_STATE =
  process.env.AUTH_STATE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/xstream-random-2026-movie-proof-20260527';
const SAMPLE_COUNT = Number(process.env.SAMPLE_COUNT || 3);

const PROVIDERS = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function titleOf(item) {
  return String(item?.name || item?.title || item?.movie_name || '').replace(/\s+/g, ' ').trim();
}

function streamIdOf(item) {
  return String(item?.stream_id || item?.id || '').trim();
}

function extensionOf(item) {
  return String(item?.container_extension || item?.ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
}

function seededRank(providerId, item) {
  const hash = crypto.createHash('sha256').update(`${providerId}:${streamIdOf(item)}:${titleOf(item)}`).digest();
  return hash.readUInt32BE(0);
}

function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of ['token', 'src', 'id']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, `[${key}]`);
    }
    return url.toString();
  } catch {
    return String(raw || '').slice(0, 240);
  }
}

function isVideoProbe(probe) {
  const type = String(probe.contentType || '').toLowerCase();
  return (
    (probe.status === 200 || probe.status === 206) &&
    probe.bytes >= 1024 &&
    (type.includes('video') || type.includes('octet-stream') || type.includes('mpegurl') || probe.first8 === '0000002066747970')
  );
}

async function readAuthCookies(host) {
  const raw = JSON.parse(await fs.readFile(AUTH_STATE, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt ? Math.floor(new Date(raw.expiresAt).getTime() / 1000) : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: host, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

async function login(page, provider) {
  await page.goto(`${BASE_URL}/?random2026Proof=${provider.id}-${Date.now()}`, {
    waitUntil: 'networkidle',
    timeout: 45_000,
  });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle', timeout: 45_000 });
  await page.getByRole('button', { name: `Use ${provider.name}` }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function fetchVodPage(page, providerId, pageNum) {
  return page.evaluate(
    async ({ providerId, pageNum }) => {
      const response = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId,
          action: 'get_vod_streams',
          page: pageNum,
          limit: 5000,
        }),
      });
      const json = await response.json().catch(() => null);
      return { status: response.status, ok: response.ok, json };
    },
    { providerId, pageNum },
  );
}

async function collect2026Movies(page, providerId) {
  const movies = [];
  let total = 0;
  let totalPages = 1;

  for (let pageNum = 1; pageNum <= totalPages && pageNum <= 40; pageNum += 1) {
    const result = await fetchVodPage(page, providerId, pageNum);
    assert(result.ok, `${providerId} VOD page ${pageNum} failed with ${result.status}`);
    const items = Array.isArray(result.json?.items) ? result.json.items : [];
    total = Number(result.json?.total || total || items.length);
    totalPages = Number(result.json?.totalPages || totalPages || 1);
    movies.push(...items.filter((item) => /\b2026\b/.test(titleOf(item))));
    if (movies.length >= 40 && pageNum >= 2) break;
  }

  return {
    total,
    movies: movies
      .filter((item) => streamIdOf(item) && titleOf(item))
      .sort((a, b) => seededRank(providerId, a) - seededRank(providerId, b)),
  };
}

async function byteProbe(page, providerId, item) {
  return page.evaluate(
    async ({ providerId, id, ext }) => {
      const url = `/api/provider-vault/stream?provider=${encodeURIComponent(providerId)}&kind=movie&id=${encodeURIComponent(
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
    { providerId, id: streamIdOf(item), ext: extensionOf(item) },
  );
}

async function videoState(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    const buffered = [];
    let bufferedAhead = 0;
    if (video) {
      for (let i = 0; i < video.buffered.length; i += 1) {
        const start = video.buffered.start(i);
        const end = video.buffered.end(i);
        buffered.push([start, end]);
        if (start <= video.currentTime && end > video.currentTime) {
          bufferedAhead = Math.max(bufferedAhead, end - video.currentTime);
        }
      }
    }
    return {
      bodyText: document.body.innerText.slice(0, 1200),
      video: video
        ? {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            currentTime: Number(video.currentTime || 0),
            muted: video.muted,
            volume: Number(video.volume || 0),
            bufferedAhead: Number(bufferedAhead || 0),
            audioTracks:
              typeof video.audioTracks !== 'undefined' && video.audioTracks
                ? Array.from(video.audioTracks).map((track) => ({
                    enabled: track.enabled,
                    kind: track.kind,
                    label: track.label,
                    language: track.language,
                  }))
                : null,
            webkitAudioDecodedByteCount: Number(video.webkitAudioDecodedByteCount || 0),
            width: video.videoWidth,
            height: video.videoHeight,
            src: String(video.currentSrc || '').replace(/token=[^&]+/g, 'token=[token]'),
            error: video.error ? { code: video.error.code, message: video.error.message } : null,
            buffered,
          }
        : null,
    };
  });
}

async function playMovie(page, provider, item, sampleIndex) {
  const id = streamIdOf(item);
  const title = titleOf(item);
  const url = `${BASE_URL}/dashboard/watch/movie/${encodeURIComponent(id)}?random2026=${provider.id}-${sampleIndex}-${Date.now()}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Play Movie' }).waitFor({ timeout: 60_000 });
  const detailText = await page.locator('body').innerText({ timeout: 20_000 });
  assert(detailText.includes('Play Movie'), `${provider.id} ${title} details did not show Play Movie`);
  await page.screenshot({ path: path.join(OUT_DIR, `xstream-${provider.id}-2026-${sampleIndex}-details.png`), fullPage: true });
  await page.getByRole('button', { name: 'Play Movie' }).click();

  const deadline = Date.now() + 90_000;
  let latest = null;
  let previousTime = -1;
  while (Date.now() < deadline) {
    latest = await videoState(page);
    const text = latest.bodyText || '';
    const video = latest.video;
    const rawPlaybackError = /DEMUXER|MEDIA_ELEMENT_ERROR|Format error|FFmpegDemuxer/i.test(text);
    const audible = video && !video.muted && video.volume > 0.05;
    const currentTime = Number(video?.currentTime || 0);
    const timeMoved = currentTime > 0.35 || (previousTime >= 0 && currentTime - previousTime > 0.2);
    if (video?.readyState >= 2 && video.width > 0 && !video.error && !rawPlaybackError && !video.paused && audible && timeMoved) {
      break;
    }
    if (video?.readyState >= 2 && video.width > 0) previousTime = currentTime;
    await page.waitForTimeout(1500);
  }

  await page.screenshot({ path: path.join(OUT_DIR, `xstream-${provider.id}-2026-${sampleIndex}-playback.png`), fullPage: true });
  const text = latest?.bodyText || '';
  const video = latest?.video;
  const rawPlaybackError = /DEMUXER|MEDIA_ELEMENT_ERROR|Format error|FFmpegDemuxer/i.test(text);
  const ok = Boolean(
    video?.readyState >= 2 &&
      video.width > 0 &&
      !video.error &&
      !rawPlaybackError &&
      !video.paused &&
      !video.muted &&
      video.volume > 0.05 &&
      video.currentTime > 0.25,
  );

  return {
    provider: provider.id,
    id,
    title,
    ext: extensionOf(item),
    ok,
    rawPlaybackError,
    video,
    textSample: text.slice(0, 400),
  };
}

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const host = new URL(BASE_URL).hostname;
const providerResults = [];

try {
  for (const provider of PROVIDERS) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });
    await context.addCookies(await readAuthCookies(host));

    const page = await context.newPage();
    const seen = { pageErrors: [], consoleErrors: [], failedRequests: [], providerResponses: [] };
    page.on('pageerror', (error) => seen.pageErrors.push(String(error.message || error).slice(0, 500)));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !/Autoplay|ERR_ABORTED|cdn-cgi|Failed to load resource/i.test(text)) {
        seen.consoleErrors.push(text.slice(0, 700));
      }
    });
    page.on('requestfailed', (request) => {
      const url = request.url();
      const failure = request.failure()?.errorText || '';
      if (failure === 'net::ERR_ABORTED' && /\/api\/watch-progress\//i.test(url)) {
        return;
      }
      if (
        failure === 'net::ERR_ABORTED' &&
        (/\/api\/provider-vault\/stream|\/api\/proxy(?:\/stream)?|\/_next\/static\/chunks\//i.test(url) || /[?&]_rsc=/i.test(url))
      ) {
        return;
      }
      if (!/favicon|cdn-cgi|socket\.io/i.test(url)) seen.failedRequests.push({ url: sanitizeUrl(url), failure });
    });
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/api/provider-vault/')) {
        seen.providerResponses.push({ status: response.status(), url: sanitizeUrl(url) });
      }
    });

    await login(page, provider);
    const collection = await collect2026Movies(page, provider.id);
    assert(collection.movies.length >= SAMPLE_COUNT, `${provider.id} only found ${collection.movies.length} 2026 movies`);

    const selected = [];
    const byteProbes = [];
    for (const item of collection.movies) {
      const probe = await byteProbe(page, provider.id, item);
      byteProbes.push({ title: titleOf(item), id: streamIdOf(item), ...probe });
      if (isVideoProbe(probe)) selected.push(item);
      if (selected.length >= SAMPLE_COUNT) break;
    }
    assert(selected.length >= SAMPLE_COUNT, `${provider.id} did not have ${SAMPLE_COUNT} byte-playable 2026 movies`);

    const playback = [];
    for (const [index, item] of selected.entries()) {
      playback.push(await playMovie(page, provider, item, index + 1));
    }

    await context.close();
    providerResults.push({
      provider: provider.id,
      vodTotal: collection.total,
      movies2026Discovered: collection.movies.length,
      selectedTitles: selected.map(titleOf),
      byteProbes: byteProbes.slice(0, Math.max(SAMPLE_COUNT, 8)),
      playback,
      diagnostics: seen,
      ok:
        collection.movies.length >= SAMPLE_COUNT &&
        playback.length === SAMPLE_COUNT &&
        playback.every((result) => result.ok) &&
        seen.pageErrors.length === 0 &&
        seen.consoleErrors.length === 0 &&
        seen.failedRequests.length === 0,
    });
  }
} finally {
  await browser.close();
}

const distinctProviders =
  providerResults.length === 2 &&
  (providerResults[0].vodTotal !== providerResults[1].vodTotal ||
    providerResults[0].selectedTitles.join('|') !== providerResults[1].selectedTitles.join('|'));

const summary = {
  ok: distinctProviders && providerResults.every((result) => result.ok),
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  sampleCount: SAMPLE_COUNT,
  distinctProviders,
  providerResults,
};

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
assert(summary.ok, 'xstream random 2026 movie proof failed');
