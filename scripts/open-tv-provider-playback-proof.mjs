import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.OPEN_TV_BASE || 'https://open-tv.daveai.tech/';
const COOKIE_FILE =
  process.env.DAVETV_AUTH_COOKIE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/open-tv-provider-playback-proof-20260527';

const providers = [
  { id: 'apollo', label: 'Apollo Group TV' },
  { id: 'xtremehd', label: 'XtremeHD' },
];

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of ['id', 'file', 'token', 'src', 'url', 'username', 'password']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, `[${key}]`);
    }
    return url.toString();
  } catch {
    return String(rawUrl || '').replace(/([?&](?:id|file|token|src|url|username|password)=)[^&]*/gi, '$1[redacted]');
  }
}

async function readAuthCookies(host) {
  const raw = JSON.parse(await fs.readFile(COOKIE_FILE, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt
    ? Math.floor(new Date(raw.expiresAt).getTime() / 1000)
    : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: host, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runProvider(browser, provider) {
  const host = new URL(BASE).hostname;
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  await context.addCookies(await readAuthCookies(host));
  const page = await context.newPage();

  const seen = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    ignoredRequestFailures: [],
    providerResponses: [],
  };

  page.on('console', (message) => {
    if (message.type() === 'error') seen.consoleErrors.push(message.text().slice(0, 400));
  });
  page.on('pageerror', (error) => {
    seen.pageErrors.push(String(error.message || error).slice(0, 400));
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const failure = request.failure()?.errorText || 'unknown';
    const record = { url: sanitizeUrl(url), failure };
    if (failure === 'net::ERR_ABORTED' && url.includes('/cdn-cgi/rum')) {
      seen.ignoredRequestFailures.push(record);
      return;
    }
    seen.failedRequests.push(record);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/provider-vault/')) {
      seen.providerResponses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
  });

  try {
    await page.goto(`${BASE}?proof=${provider.id}-${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    const providerTile = page.locator('app-channel-tile').filter({ hasText: provider.label }).first();
    await providerTile.waitFor({ timeout: 70000 });
    const firstChannel = (await providerTile.innerText()).replace(/\s+/g, ' ').trim();

    await page.screenshot({
      path: path.join(OUT_DIR, `open-tv-${provider.id}-home.png`),
      fullPage: true,
    });

    await providerTile.click({ timeout: 15000 });
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return Boolean(video && video.readyState >= 2 && video.videoWidth > 0);
    }, { timeout: 70000 });
    await page.waitForTimeout(3000);

    await page.screenshot({
      path: path.join(OUT_DIR, `open-tv-${provider.id}-player.png`),
      fullPage: true,
    });

    const state = await page.evaluate(() => {
      const video = document.querySelector('video');
      return {
        title: document.title,
        body: document.body.innerText.slice(0, 1600),
        video: {
          readyState: video?.readyState ?? 0,
          networkState: video?.networkState ?? 0,
          paused: video?.paused ?? null,
          currentTime: Number(video?.currentTime ?? 0),
          width: video?.videoWidth ?? 0,
          height: video?.videoHeight ?? 0,
          currentSrcIsBlob: Boolean(video?.currentSrc?.startsWith('blob:')),
        },
      };
    });

    const providerStreams = seen.providerResponses.filter((response) =>
      response.url.includes(`/api/provider-vault/stream?provider=${provider.id}`) ||
      response.url.includes('/api/provider-vault/segment'),
    );

    const result = {
      provider: provider.id,
      label: provider.label,
      firstChannel,
      state,
      seen,
      checks: {
        english: /All|Categories|Livestreams|Movies|Provider vault|Close/i.test(state.body),
        firstChannelCurated: /USA AMC/i.test(firstChannel),
        providerVisible: firstChannel.includes(provider.label),
        videoReady: state.video.readyState >= 2 && state.video.width > 0 && state.video.height > 0,
        sameOriginPlayback: providerStreams.some((response) => response.status === 200),
        noRawCredentials: !/(username=|password=|server url|xtreme codes password)/i.test(state.body),
        noConsoleErrors: seen.consoleErrors.length === 0,
        noPageErrors: seen.pageErrors.length === 0,
        noFailedRequests: seen.failedRequests.length === 0,
      },
    };
    result.ok = Object.values(result.checks).every(Boolean);
    return result;
  } finally {
    await context.close();
  }
}

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const provider of providers) {
    results.push(await runProvider(browser, provider));
  }
} finally {
  await browser.close();
}

const summary = {
  ok: results.every((result) => result.ok),
  generatedAt: new Date().toISOString(),
  target: BASE,
  results,
  artifacts: {
    apolloHome: path.join(OUT_DIR, 'open-tv-apollo-home.png'),
    apolloPlayer: path.join(OUT_DIR, 'open-tv-apollo-player.png'),
    xtremehdHome: path.join(OUT_DIR, 'open-tv-xtremehd-home.png'),
    xtremehdPlayer: path.join(OUT_DIR, 'open-tv-xtremehd-player.png'),
  },
};

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

assert(summary.ok, 'Open TV provider playback proof failed');
