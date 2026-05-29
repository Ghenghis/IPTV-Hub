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
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/xstream-timebar-sync-proof-20260529';

const CASES = [
  {
    label: 'apollo-movie-transcoded-vod',
    provider: { id: 'apollo', name: 'Apollo Group TV' },
    path: '/dashboard/watch/movie/817595',
    start: async (page) => {
      await page.getByRole('button', { name: /play movie|watch|resume|play/i }).first().click({ timeout: 30_000 });
    },
  },
  {
    label: 'apollo-series-episode-vod',
    provider: { id: 'apollo', name: 'Apollo Group TV' },
    path: '/dashboard/watch/series/10553',
    start: async (page) => {
      await page.getByRole('button', { name: /^play episode/i }).first().click({ timeout: 30_000 });
    },
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
  const value = raw.cookieValue || raw.value;
  if (!value) return [];
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const expires = raw.expiresAt ? Math.floor(new Date(raw.expiresAt).getTime() / 1000) : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: host, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

async function resetAndLogin(page, provider) {
  await page.goto(`${BASE_URL}/?timebarProof=${provider.id}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('xstream_player_db');
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.getByRole('button', { name: `Use ${provider.name}` }).click({ timeout: 30_000 });
  await page.waitForURL(/\/dashboard/, { timeout: 75_000 });
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
}

async function mediaState(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    const display = document.querySelector('[data-testid="video-time-display"]');
    const range = document.querySelector('[data-testid="video-progress-range"]');
    const fill = document.querySelector('[data-testid="video-progress-fill"]');
    return {
      bodyText: document.body.innerText.slice(0, 1600),
      timebar: display
        ? {
            text: display.textContent?.replace(/\s+/g, ' ').trim() || '',
            current: Number(display.getAttribute('data-current-time') || 0),
            duration: Number(display.getAttribute('data-duration') || 0),
            reliable: display.getAttribute('data-duration-reliable') === 'true',
            progressPercent: Number(fill?.getAttribute('data-progress-percent') || 0),
            rangeValue: Number(range?.getAttribute('value') || 0),
            rangeMax: Number(range?.getAttribute('max') || 0),
          }
        : null,
      video: video
        ? {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            muted: video.muted,
            volume: video.volume,
            currentTime: Number(video.currentTime || 0),
            duration: Number(video.duration || 0),
            width: video.videoWidth,
            height: video.videoHeight,
            audioDecodedBytes: Number(video.webkitAudioDecodedByteCount || 0),
            src: String(video.currentSrc || '').replace(/token=[^&]+/g, 'token=[token]').slice(0, 260),
            error: video.error ? { code: video.error.code, message: video.error.message } : null,
          }
        : null,
    };
  });
}

function isTimebarConsistent(state) {
  const { timebar, video, bodyText } = state;
  if (!timebar || !video) return false;
  if (/Playback Error|Application Error|client-side exception|Something went wrong/i.test(bodyText)) return false;
  if (video.readyState < 2 || video.paused || video.muted || video.volume <= 0.05 || video.width <= 0 || video.height <= 0) return false;
  if (timebar.reliable) {
    return (
      timebar.duration >= timebar.current - 0.25 &&
      timebar.progressPercent >= 0 &&
      timebar.progressPercent <= 100.25 &&
      timebar.rangeMax >= timebar.rangeValue - 0.25
    );
  }
  return /\/\s*--:--/.test(timebar.text);
}

async function waitForConsistentTimebar(page) {
  const deadline = Date.now() + 120_000;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await mediaState(page);
    if ((latest.video?.currentTime || 0) >= 12 && isTimebarConsistent(latest)) return latest;
    await page.waitForTimeout(1500);
  }
  return latest;
}

async function runCase(browser, spec) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    recordVideo: undefined,
    permissions: [],
    bypassCSP: false,
  });
  await context.addCookies(await readAuthCookies(new URL(BASE_URL).hostname));
  const page = await context.newPage();
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error.message || error).slice(0, 600)));
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      !/ERR_ABORTED|favicon|Failed to (fetch|sync) (favorites|watch progress|server config)|^\[VideoPlayer\] HLS Error:/i.test(text)
    ) {
      diagnostics.consoleErrors.push(text.slice(0, 600));
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || '';
    const url = request.url();
    if (
      !(failure === 'net::ERR_ABORTED' && /_rsc=|\/api\/watch-progress|\/api\/config|\/api\/favorites/i.test(url)) &&
      !/favicon|cdn-cgi|\/api\/watch-progress|\/api\/config|\/api\/favorites/i.test(url)
    ) {
      diagnostics.failedRequests.push({ url: sanitizeUrl(url), failure });
    }
  });

  await resetAndLogin(page, spec.provider);
  await page.goto(`${BASE_URL}${spec.path}?timebarCase=${spec.label}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  try {
    await spec.start(page);
  } catch (error) {
    await page.screenshot({ path: path.join(OUT_DIR, `${spec.label}-start-failed.png`), fullPage: true }).catch(() => {});
    throw error;
  }

  const finalState = await waitForConsistentTimebar(page);
  await page.screenshot({ path: path.join(OUT_DIR, `${spec.label}.png`), fullPage: true });
  await context.close();

  const ok = (
    isTimebarConsistent(finalState) &&
    diagnostics.pageErrors.length === 0 &&
    diagnostics.consoleErrors.length === 0 &&
    diagnostics.failedRequests.length === 0
  );
  return { label: spec.label, ok, path: spec.path, finalState, diagnostics };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const results = [];
  try {
    for (const spec of CASES) {
      results.push(await runCase(browser, spec));
    }
  } finally {
    await browser.close();
  }

  const summary = {
    ok: results.every((result) => result.ok),
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    results,
  };
  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  assert(summary.ok, 'XStream timebar sync proof failed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
