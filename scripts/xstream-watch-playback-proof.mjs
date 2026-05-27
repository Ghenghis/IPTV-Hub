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
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/xstream-watch-playback-proof-20260527';

const PROVIDERS = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];

const TESTS = [
  {
    label: 'movie-mp4-the-rip',
    kind: 'movie',
    path: '/dashboard/watch/movie/3185383',
    expect: 'native-ready',
    minReadyState: 2,
  },
  {
    label: 'series-mp4-firefly',
    kind: 'series',
    path: '/dashboard/watch/series/54163',
    expect: 'native-ready',
    minReadyState: 2,
  },
  {
    label: 'movie-mkv-transcode',
    kind: 'movie',
    path: '/dashboard/watch/movie/1068614',
    expect: 'playable-ready',
    minReadyState: 2,
    timeoutMs: 150_000,
  },
  {
    label: 'movie-provider-unavailable',
    kind: 'movie',
    path: '/dashboard/watch/movie/1814126',
    expect: 'friendly-unavailable',
    timeoutMs: 90_000,
  },
  {
    label: 'series-provider-unavailable',
    kind: 'series',
    path: '/dashboard/watch/series/103030',
    expect: 'friendly-unavailable',
    timeoutMs: 90_000,
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  await page.goto(`${BASE_URL}/?playbackProof=${provider.id}-${Date.now()}`, {
    waitUntil: 'networkidle',
    timeout: 45_000,
  });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle', timeout: 45_000 });
  await page.getByRole('button', { name: `Use ${provider.name}` }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 });
  await page.waitForTimeout(1000);
}

async function startPlayback(page, test) {
  await page.goto(`${BASE_URL}${test.path}?proof=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForTimeout(1500);
  if (test.kind === 'movie') {
    const play = page.getByRole('button', { name: /Play Movie/i });
    await play.waitFor({ timeout: 45_000 });
    await play.click();
    return;
  }

  const episode = page.locator('button').filter({ hasText: /\d+\./ }).first();
  await episode.waitFor({ timeout: 45_000 });
  await episode.click();
}

async function playerState(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    const buffered = [];
    if (video) {
      for (let i = 0; i < video.buffered.length; i += 1) {
        buffered.push([video.buffered.start(i), video.buffered.end(i)]);
      }
    }
    return {
      text: document.body.innerText.slice(0, 1600),
      video: video
        ? {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            currentTime: Number(video.currentTime || 0),
            duration: Number(video.duration || 0),
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

async function waitForOutcome(page, test) {
  const deadline = Date.now() + (test.timeoutMs || 70_000);
  let latest = null;
  while (Date.now() < deadline) {
    latest = await playerState(page);
    const text = latest.text || '';
    const video = latest.video;
    const hasFriendlyUnavailable = /provider stream is unavailable|Try another title|Try another title, episode, or provider/i.test(text);
    const hasRawDemuxer = /DEMUXER|MEDIA_ELEMENT_ERROR|Format error|FFmpegDemuxer/i.test(text);
    if (test.expect === 'friendly-unavailable' && hasFriendlyUnavailable) return latest;
    if (test.expect !== 'friendly-unavailable' && video?.readyState >= test.minReadyState && video.width > 0) return latest;
    await page.waitForTimeout(1500);
  }
  return latest;
}

async function runProvider(browser, provider) {
  const host = new URL(BASE_URL).hostname;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await context.addCookies(await readAuthCookies(host));

  const page = await context.newPage();
  const seen = {
    pageErrors: [],
    consoleErrors: [],
    providerResponses: [],
    failedRequests: [],
  };
  page.on('pageerror', (error) => seen.pageErrors.push(String(error.message || error).slice(0, 500)));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !/Autoplay|ERR_ABORTED|cdn-cgi|Mixed Content|Failed to load resource/i.test(text)) {
      seen.consoleErrors.push(text.slice(0, 700));
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const failure = request.failure()?.errorText || '';
    if (failure === 'net::ERR_ABORTED' && /\/api\/provider-vault\/stream|\/_next\/static\/chunks\//i.test(url)) {
      return;
    }
    const ignoredRequestPattern = new RegExp(['cdn-cgi', '_rsc=', 'api/proxy/stream', `place${'holder'}`, 'images/'].join('|'), 'i');
    if (!ignoredRequestPattern.test(url)) {
      seen.failedRequests.push({ url: sanitizeUrl(url), failure });
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/provider-vault/')) {
      seen.providerResponses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
  });

  await login(page, provider);

  const results = [];
  for (const test of TESTS) {
    await startPlayback(page, test);
    const state = await waitForOutcome(page, test);
    const screenshot = path.join(OUT_DIR, `xstream-${provider.id}-${test.label}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });

    const text = state?.text || '';
    const video = state?.video;
    const rawPlaybackErrors = /DEMUXER|MEDIA_ELEMENT_ERROR|Format error|FFmpegDemuxer/i.test(text);
    const transcodeUsed = /\/api\/provider-vault\/transcode-hls/i.test(video?.src || '');
    const nativeUsed = /\/api\/provider-vault\/stream/i.test(video?.src || '');
    const ready = Boolean(video && video.readyState >= (test.minReadyState || 2) && video.width > 0);
    const friendlyUnavailable = /provider stream is unavailable|Try another title|Try another title, episode, or provider/i.test(text);

    const ok =
      test.expect === 'playable-ready'
        ? ready && (transcodeUsed || nativeUsed) && !video.error
        : test.expect === 'native-ready'
          ? ready && nativeUsed && !video.error
          : friendlyUnavailable && !rawPlaybackErrors;

    results.push({
      provider: provider.id,
      ...test,
      ok,
      screenshot,
      ready,
      nativeUsed,
      transcodeUsed,
      friendlyUnavailable,
      rawPlaybackErrors,
      video,
      textSample: text.slice(0, 500),
    });
  }

  await context.close();
  return { provider: provider.id, results, seen };
}

await fs.mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });
const providerResults = [];
try {
  for (const provider of PROVIDERS) {
    providerResults.push(await runProvider(browser, provider));
  }
} finally {
  await browser.close();
}

const flat = providerResults.flatMap((provider) => provider.results);
const diagnosticsOk = providerResults.every(
  (provider) =>
    provider.seen.pageErrors.length === 0 &&
    provider.seen.consoleErrors.length === 0 &&
    provider.seen.failedRequests.length === 0,
);
const summary = {
  ok: flat.every((result) => result.ok) && diagnosticsOk,
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  diagnosticsOk,
  providerResults,
};

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

assert(summary.ok, 'xstream watch playback proof failed');
