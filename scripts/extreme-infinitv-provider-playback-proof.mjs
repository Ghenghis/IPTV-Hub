import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.EXTREME_INFINITV_BASE || 'https://extreme-infinitv.daveai.tech/';
const TARGET = new URL('/livetv/', BASE).toString();
const COOKIE_FILE =
  process.env.DAVETV_AUTH_COOKIE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/extreme-infinitv-provider-playback-proof-20260527';

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}${url.search}`
      .replace(/([?&]id=)[^&]*/i, (_, prefix) => `${prefix}${url.searchParams.get('id') ? '<present>' : '<empty>'}`)
      .replace(/([?&]token=)[^&]*/gi, '$1<redacted>')
      .replace(/([?&]src=)[^&]*/gi, '$1<redacted>');
  } catch {
    return String(rawUrl).replace(/([?&](?:id|token|src)=)[^&]*/gi, '$1<redacted>');
  }
}

async function addAuthCookies(context) {
  const auth = JSON.parse(await fs.readFile(COOKIE_FILE, 'utf8'));
  const cookie = {
    name: auth.cookieName,
    value: auth.cookieValue,
    domain: '.daveai.tech',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    expires: Math.floor(new Date(auth.expiresAt).getTime() / 1000),
  };
  await context.addCookies([
    cookie,
    { ...cookie, domain: new URL(BASE).hostname },
  ]);
}

async function seedProvider(page, provider) {
  await page.goto(`${BASE}?seed=${provider}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });

  await page.evaluate((selectedProvider) => {
    const now = Date.now();
    localStorage.setItem('xt_locale', 'en');
    localStorage.setItem('xt_playlists', JSON.stringify({
      entries: [
        {
          _id: 'davetv-vault-apollo',
          type: 'davetv-vault',
          providerId: 'apollo',
          host: 'davetv-vault://apollo',
          title: 'Apollo Group TV',
          username: 'DaveTV',
          password: 'vault',
          addedAt: now,
          lastUsedAt: now,
        },
        {
          _id: 'davetv-vault-xtremehd',
          type: 'davetv-vault',
          providerId: 'xtremehd',
          host: 'davetv-vault://xtremehd',
          title: 'XtremeHD',
          username: 'DaveTV',
          password: 'vault',
          addedAt: now,
          lastUsedAt: now,
        },
      ],
      selectedId: selectedProvider === 'xtremehd'
        ? 'davetv-vault-xtremehd'
        : 'davetv-vault-apollo',
    }));
  }, provider);
}

async function proveProvider(page, provider, screenshotName) {
  await seedProvider(page, provider);
  await page.goto(`${TARGET}?proof=${provider}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });

  const firstButton = page.locator('.channel-row .play-btn').first();
  await firstButton.waitFor({ timeout: 50000 });
  const firstChannel = await firstButton.innerText();
  await firstButton.click();

  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.readyState >= 2 && video.videoWidth > 0);
  }, { timeout: 60000 });

  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT_DIR, screenshotName), fullPage: true });

  return page.evaluate((firstChannelText) => {
    const video = document.querySelector('video');
    return {
      firstChannel: firstChannelText,
      readyState: video?.readyState ?? 0,
      currentTime: Number(video?.currentTime ?? 0),
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      currentSrcIsBlob: Boolean(video?.currentSrc?.startsWith('blob:')),
      body: document.body.innerText.slice(0, 1500),
    };
  }, firstChannel);
}

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  ignoreHTTPSErrors: true,
});
await addAuthCookies(context);
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const ignoredRequestFailures = [];
const streamEvents = [];

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
page.on('requestfailed', (request) => {
  const url = request.url();
  const failure = request.failure()?.errorText || 'unknown';
  const record = { url: sanitizeUrl(url), failure };

  if (
    failure === 'net::ERR_ABORTED' &&
    (
      url.includes('/api/provider-vault/catalog') ||
      url.includes('/api/provider-vault/segment') ||
      url.includes('/cdn-cgi/rum')
    )
  ) {
    ignoredRequestFailures.push(record);
    return;
  }

  failedRequests.push(record);
});
page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/api/provider-vault/stream')) {
    const parsed = new URL(url);
    streamEvents.push({
      kind: 'stream',
      provider: parsed.searchParams.get('provider') || '',
      idState: parsed.searchParams.get('id') ? 'present' : 'empty',
      status: response.status(),
      url: sanitizeUrl(url),
    });
  }
  if (url.includes('/api/provider-vault/segment')) {
    streamEvents.push({
      kind: 'segment',
      status: response.status(),
      url: sanitizeUrl(url),
    });
  }
});

const apollo = await proveProvider(page, 'apollo', 'extreme-infinitv-apollo-player.png');
const xtremehd = await proveProvider(page, 'xtremehd', 'extreme-infinitv-xtremehd-player.png');
const text = await page.locator('body').innerText();

const summary = {
  generatedAt: new Date().toISOString(),
  target: TARGET,
  apollo,
  xtremehd,
  streamEvents,
  consoleErrors,
  pageErrors,
  failedRequests,
  ignoredRequestFailures,
  textChecks: {
    english: text.includes('Live TV') && text.includes('Settings'),
    firstRowsCurated: apollo.firstChannel.includes('USA') && xtremehd.firstChannel.includes('USA'),
    noUnsupportedScheme: !text.includes('embedded player. Set up MPV'),
    noPortuguese: !/Bem-vindo|Conectar/i.test(text),
  },
};

summary.pass =
  apollo.readyState >= 2 &&
  xtremehd.readyState >= 2 &&
  streamEvents.some((event) =>
    event.kind === 'stream' &&
    event.provider === 'apollo' &&
    event.status === 200 &&
    event.idState === 'present'
  ) &&
  streamEvents.some((event) =>
    event.kind === 'stream' &&
    event.provider === 'xtremehd' &&
    event.status === 200 &&
    event.idState === 'present'
  ) &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0 &&
  failedRequests.length === 0 &&
  Object.values(summary.textChecks).every(Boolean);

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

await browser.close();
process.exit(summary.pass ? 0 : 1);
