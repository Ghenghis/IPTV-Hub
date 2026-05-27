import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const TARGET = process.env.TVAPP_URL || 'https://tvapp.daveai.tech/';
const COOKIE_FILE =
  process.env.DAVETV_AUTH_COOKIE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/tvapp-provider-playback-proof-20260527';

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('id')) {
      url.searchParams.set('id', url.searchParams.get('id') ? '<present>' : '<empty>');
    }
    if (url.searchParams.has('token')) url.searchParams.set('token', '<redacted>');
    if (url.searchParams.has('src')) url.searchParams.set('src', '<redacted>');
    return `${url.origin}${url.pathname}${url.search}`;
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
    { ...cookie, domain: new URL(TARGET).hostname },
  ]);
}

async function waitForPlayback(page) {
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.readyState >= 2 && video.videoWidth > 0);
  }, { timeout: 45000 });

  return page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      readyState: video?.readyState ?? 0,
      currentTime: Number(video?.currentTime ?? 0),
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      currentSrcIsBlob: Boolean(video?.currentSrc?.startsWith('blob:')),
      status: document.querySelector('#statusText')?.textContent || '',
      channel: document.querySelector('#channelName')?.textContent || '',
    };
  });
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
  const failure = request.failure()?.errorText || 'unknown';
  const url = request.url();
  const record = { url: sanitizeUrl(url), failure };

  if (failure === 'net::ERR_ABORTED' && url.includes('/api/provider-vault/segment')) {
    ignoredRequestFailures.push(record);
    return;
  }

  failedRequests.push(record);
});
page.on('response', (response) => {
  const url = response.url();
  if (!url.includes('/api/provider-vault/stream')) return;
  const parsed = new URL(url);
  streamEvents.push({
    url: sanitizeUrl(url),
    provider: parsed.searchParams.get('provider') || '',
    idState: parsed.searchParams.get('id') ? 'present' : 'empty',
    status: response.status(),
  });
});

await page.goto(`${TARGET}?proof=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(
  () => document.body.innerText.includes('Apollo Group TV') && document.body.innerText.includes('XtremeHD'),
  { timeout: 30000 },
);

const apollo = await waitForPlayback(page);
await page.screenshot({ path: path.join(OUT_DIR, 'tvapp-apollo-player.png'), fullPage: true });

await page.fill('#searchInput', 'XtremeHD');
await page.waitForTimeout(500);
await page.locator('.channelItem[data-index]').first().click();
const xtremehd = await waitForPlayback(page);
await page.screenshot({ path: path.join(OUT_DIR, 'tvapp-xtremehd-player.png'), fullPage: true });

const textSample = (await page.locator('body').innerText()).slice(0, 1000);
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
  textSample,
  pass:
    apollo.readyState >= 2 &&
    xtremehd.readyState >= 2 &&
    streamEvents.some((event) => event.provider === 'apollo' && event.status === 200 && event.idState === 'present') &&
    streamEvents.some((event) => event.provider === 'xtremehd' && event.status === 200 && event.idState === 'present') &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    failedRequests.length === 0,
};

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

await browser.close();
process.exit(summary.pass ? 0 : 1);
