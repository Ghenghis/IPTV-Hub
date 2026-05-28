import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE_URL = process.env.XSTREAM_URL || 'https://xstream-player.daveai.tech';
const AUTH_STATE =
  process.env.AUTH_STATE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/xstream-watch-playback-proof-20260528';

const PROVIDERS = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function itemId(item) {
  return String(item?.series_id || item?.stream_id || item?.id || '').trim();
}

function itemTitle(item) {
  return String(item?.name || item?.title || '').replace(/\s+/g, ' ').trim();
}

function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of ['token', 'src', 'id']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, `[${key}]`);
    }
    return url.toString();
  } catch {
    return String(raw || '').slice(0, 260);
  }
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
  await page.goto(`${BASE_URL}/?watchProof=${provider.id}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.getByRole('button', { name: `Use ${provider.name}` }).click();
  await page.waitForFunction(() => location.pathname.includes('/dashboard') || Boolean(localStorage.getItem('xstream_auth')), {
    timeout: 60_000,
  });
  if (!page.url().includes('/dashboard')) {
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function proxy(page, providerId, body) {
  return page.evaluate(
    async ({ providerId, body }) => {
      const response = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, ...body }),
      });
      const json = await response.json().catch(() => null);
      return { status: response.status, ok: response.ok, json };
    },
    { providerId, body },
  );
}

async function catalog(page, providerId, action, limit = 30) {
  const response = await proxy(page, providerId, { action, page: 1, limit });
  assert(response.ok, `${providerId} ${action} failed with ${response.status}`);
  const items = Array.isArray(response.json?.items) ? response.json.items : [];
  assert(items.length > 0, `${providerId} ${action} returned no items`);
  return { total: Number(response.json?.total || items.length), items };
}

async function seriesInfo(page, providerId, seriesId) {
  const response = await proxy(page, providerId, { action: 'get_series_info', series_id: seriesId });
  if (!response.ok || !response.json?.info) return null;
  const episodeMap =
    response.json.episodes && typeof response.json.episodes === 'object' && !Array.isArray(response.json.episodes)
      ? response.json.episodes
      : {};
  const seasons = Object.keys(episodeMap).sort((a, b) => Number(a) - Number(b));
  for (const season of seasons) {
    const episode = Array.isArray(episodeMap[season]) ? episodeMap[season][0] : null;
    if (episode?.id) {
      return {
        info: response.json.info,
        season,
        episode,
      };
    }
  }
  return null;
}

async function state(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    const buffered = [];
    let bufferedAhead = 0;
    if (video) {
      for (let i = 0; i < video.buffered.length; i += 1) {
        const start = video.buffered.start(i);
        const end = video.buffered.end(i);
        buffered.push([start, end]);
        if (start <= video.currentTime && end >= video.currentTime) bufferedAhead = Math.max(bufferedAhead, end - video.currentTime);
      }
    }
    return {
      text: document.body.innerText.slice(0, 1800),
      video: video
        ? {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            muted: video.muted,
            volume: Number(video.volume || 0),
            currentTime: Number(video.currentTime || 0),
            duration: Number(video.duration || 0),
            width: video.videoWidth,
            height: video.videoHeight,
            audioDecodedBytes: Number(video.webkitAudioDecodedByteCount || 0),
            src: String(video.currentSrc || '').replace(/token=[^&]+/g, 'token=[token]'),
            error: video.error ? { code: video.error.code, message: video.error.message } : null,
            buffered,
            bufferedAhead,
          }
        : null,
    };
  });
}

async function waitForPlayable(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let previousTime = -1;
  while (Date.now() < deadline) {
    latest = await state(page);
    const text = latest.text || '';
    const video = latest.video;
    const rawPlaybackError = /DEMUXER|MEDIA_ELEMENT_ERROR|Format error|FFmpegDemuxer|Application Error/i.test(text);
    const timeMoved = video && (video.currentTime > 0.35 || (previousTime >= 0 && video.currentTime - previousTime > 0.2));
    if (
      video?.readyState >= 2 &&
      video.width > 0 &&
      video.height > 0 &&
      !video.error &&
      !rawPlaybackError &&
      !video.paused &&
      !video.muted &&
      video.volume > 0.05 &&
      timeMoved &&
      video.audioDecodedBytes > 0
    ) {
      return latest;
    }
    if (video?.readyState >= 2) previousTime = video.currentTime;
    await page.waitForTimeout(1500);
  }
  return latest;
}

async function clickFirstEpisode(page) {
  const candidates = [
    page.locator('button').filter({ hasText: /S\d+E\d+/i }).first(),
    page.locator('button').filter({ hasText: /^\s*\d+\./ }).first(),
    page.locator('button').filter({ hasText: /Episode|Ep\s*\d+/i }).first(),
  ];
  for (const locator of candidates) {
    if ((await locator.count().catch(() => 0)) > 0) {
      await locator.click({ timeout: 20_000 });
      return true;
    }
  }
  return false;
}

async function proveSeriesProvider(browser, provider) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await context.addCookies(await readAuthCookies(new URL(BASE_URL).hostname));

  const page = await context.newPage();
  const diagnostics = {
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    providerResponses: [],
  };

  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error.message || error).slice(0, 600)));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !/Autoplay|ERR_ABORTED|cdn-cgi|Failed to load resource|^\[VideoPlayer\] HLS Error:/i.test(text)) {
      diagnostics.consoleErrors.push(text.slice(0, 800));
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const failure = request.failure()?.errorText || '';
    if (
      failure === 'net::ERR_ABORTED' &&
      (/\/api\/provider-vault\/(?:stream|transcode-hls)|\/api\/proxy(?:\/stream)?|\/_next\/static\/chunks\//i.test(url) || /[?&]_rsc=/i.test(url))
    ) {
      return;
    }
    if (!/favicon|cdn-cgi|socket\.io/i.test(url)) diagnostics.failedRequests.push({ url: sanitizeUrl(url), failure });
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/provider-vault/')) diagnostics.providerResponses.push({ status: response.status(), url: sanitizeUrl(url) });
  });

  await login(page, provider);
  const seriesCatalog = await catalog(page, provider.id, 'get_series', 35);
  const attempts = [];
  let selected = null;
  let playable = null;

  for (const item of seriesCatalog.items.slice(0, 12)) {
    const seriesId = itemId(item);
    if (!seriesId) continue;
    const info = await seriesInfo(page, provider.id, seriesId);
    if (!info) {
      attempts.push({ seriesId, title: itemTitle(item), reason: 'no episode data' });
      continue;
    }

    await page.goto(`${BASE_URL}/dashboard/watch/series/${encodeURIComponent(seriesId)}?seriesProof=${provider.id}-${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const clicked = await clickFirstEpisode(page);
    if (!clicked) {
      attempts.push({ seriesId, title: itemTitle(item), episodeId: info.episode.id, reason: 'no episode button visible' });
      continue;
    }
    const result = await waitForPlayable(page);
    const screenshot = path.join(OUT_DIR, `xstream-${provider.id}-series-${seriesId}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    const ok = Boolean(result?.video?.readyState >= 2 && result.video.width > 0 && result.video.audioDecodedBytes > 0 && !result.video.paused);
    const attempt = {
      seriesId,
      seriesTitle: itemTitle(item),
      episodeId: String(info.episode.id),
      episodeTitle: String(info.episode.title || ''),
      extension: String(info.episode.container_extension || ''),
      screenshot,
      ok,
      video: result?.video || null,
      textSample: String(result?.text || '').slice(0, 500),
    };
    attempts.push(attempt);
    if (ok) {
      selected = attempt;
      playable = result;
      break;
    }
  }

  await context.close();
  return {
    provider: provider.id,
    catalogTotal: seriesCatalog.total,
    selected,
    attempts,
    diagnostics,
    ok:
      Boolean(selected && playable?.video) &&
      diagnostics.pageErrors.length === 0 &&
      diagnostics.consoleErrors.length === 0 &&
      diagnostics.failedRequests.length === 0,
  };
}

await fs.mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });
const providerResults = [];
try {
  for (const provider of PROVIDERS) {
    providerResults.push(await proveSeriesProvider(browser, provider));
  }
} finally {
  await browser.close();
}

const summary = {
  ok: providerResults.every((result) => result.ok),
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  providerResults,
};

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
assert(summary.ok, 'xstream provider-aware series playback proof failed');
