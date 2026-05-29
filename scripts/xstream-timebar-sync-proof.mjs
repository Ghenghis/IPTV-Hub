import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.XSTREAM_BASE || 'https://xstream-player.daveai.tech';
const AUTH_STATE =
  process.env.AUTH_STATE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/xstream-timebar-sync-proof';

const CASES = [
  {
    name: 'apollo-movie-vod',
    providerButton: /Use Apollo Group TV/i,
    url: '/dashboard/watch/movie/8479',
    action: 'movie',
    minDuration: 60 * 60,
  },
  {
    name: 'xtremehd-movie-vod',
    providerButton: /Use XtremeHD/i,
    url: '/dashboard/watch/movie/2016459',
    action: 'movie',
    minDuration: 60 * 60,
  },
  {
    name: 'apollo-series-episode',
    providerButton: /Use Apollo Group TV/i,
    url: '/dashboard/watch/series/10553',
    action: 'series',
    minDuration: 20 * 60,
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function addAuthCookie(context) {
  const raw = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt ? Math.floor(new Date(raw.expiresAt).getTime() / 1000) : undefined;
  await context.addCookies([
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: 'xstream-player.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ]);
}

async function login(page, providerButton) {
  await page.goto(`${BASE}/?timebar=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('button', { name: providerButton }).click({ timeout: 30_000 });
  await page.waitForURL(/\/dashboard/, { timeout: 90_000 });
}

async function startPlayback(page, testCase) {
  await page.goto(`${BASE}${testCase.url}?timebar=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(4_000);

  if (testCase.action === 'series') {
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('button')].some((button) => {
        return /^Play episode/i.test(button.getAttribute('aria-label') || '');
      });
    }, { timeout: 60_000 });
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => {
        return /^Play episode/i.test(candidate.getAttribute('aria-label') || '');
      });
      button?.click();
    });
  } else {
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('button')].some((button) => {
        return /Play Movie|Resume Movie|Watch Movie/i.test(button.textContent || '');
      });
    }, { timeout: 60_000 });
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => {
        return /Play Movie|Resume Movie|Watch Movie/i.test(candidate.textContent || '');
      });
      button?.click();
    });
  }

  await page.waitForSelector('video', { timeout: 90_000 });
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return;
    video.muted = false;
    video.volume = 1;
    void video.play?.().catch(() => undefined);
  });
}

async function inspectPlayback(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    const range = document.querySelector('input[data-testid="video-progress-range"]');
    const fill = document.querySelector('[data-testid="video-progress-fill"]');
    const text = document.body.innerText || '';

    return {
      timebarText: text.match(/\d{1,2}:\d{2}(?=\s*\/)|\/\s*\d{1,2}:\d{2}|\/\s*\d+:\d{2}:\d{2}/g) || [],
      hasFakeTenSecondDuration: /\/\s*00:10\b|\/\s*0:10\b/.test(text),
      video: video
        ? {
            currentTime: video.currentTime,
            duration: video.duration,
            readyState: video.readyState,
            paused: video.paused,
            muted: video.muted,
            volume: video.volume,
            width: video.videoWidth,
            height: video.videoHeight,
            audioBytes: video.webkitAudioDecodedByteCount || 0,
            videoBytes: video.webkitVideoDecodedByteCount || 0,
            error: video.error ? { code: video.error.code, message: video.error.message } : null,
          }
        : null,
      range: range
        ? {
            min: Number(range.getAttribute('min') || 0),
            max: Number(range.getAttribute('max') || 0),
            value: Number(range.getAttribute('value') || 0),
          }
        : null,
      progressPercent: fill ? Number(fill.getAttribute('data-progress-percent') || 0) : null,
    };
  });
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

const results = [];
const diagnostics = { pageErrors: [], consoleMessages: [] };

try {
  for (const testCase of CASES) {
    console.log(`Running ${testCase.name}`);
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    await addAuthCookie(context);
    const page = await context.newPage();
    page.on('pageerror', (error) => diagnostics.pageErrors.push(`${testCase.name}: ${error.message || error}`));
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.consoleMessages.push(`${testCase.name}: ${message.text()}`);
    });

    await login(page, testCase.providerButton);
    await startPlayback(page, testCase);
    await page.waitForTimeout(24_000);
    const state = await inspectPlayback(page);

    assert(state.video?.readyState >= 2, `${testCase.name} did not reach playable readyState`);
    assert(!state.video?.error, `${testCase.name} video error: ${JSON.stringify(state.video?.error)}`);
    assert(state.video.currentTime > 5, `${testCase.name} currentTime did not advance`);
    assert(state.video.muted === false && state.video.volume > 0, `${testCase.name} is muted`);
    assert(state.video.audioBytes > 0, `${testCase.name} decoded no audio bytes`);
    assert(state.range?.max >= testCase.minDuration, `${testCase.name} range max too small: ${state.range?.max}`);
    assert(!state.hasFakeTenSecondDuration, `${testCase.name} still shows fake 10-second duration`);
    assert((state.progressPercent || 0) < 20, `${testCase.name} progress bar is implausibly full early`);

    await page.screenshot({ path: path.join(OUT_DIR, `${testCase.name}.png`), fullPage: true });
    results.push({ ...testCase, state });
    await context.close();
  }
} finally {
  await browser.close();
}

const summary = {
  ok: results.length === CASES.length && diagnostics.pageErrors.length === 0 && diagnostics.consoleMessages.length === 0,
  generatedAt: new Date().toISOString(),
  baseUrl: BASE,
  results,
  diagnostics,
};

fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;
