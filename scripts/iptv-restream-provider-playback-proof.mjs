import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const TARGET = process.env.IPTV_RESTREAM_URL || 'https://iptv-restream.daveai.tech/';
const COOKIE_FILE =
  process.env.DAVETV_AUTH_COOKIE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/iptv-restream-provider-playback-proof-20260527';

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('id')) {
      url.searchParams.set('id', url.searchParams.get('id') ? '<present>' : '<empty>');
    }
    if (url.searchParams.has('src')) url.searchParams.set('src', '<redacted>');
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return String(rawUrl).replace(/([?&](?:id|src)=)[^&]*/gi, '$1<redacted>');
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

async function selectPlaylist(page, name) {
  const header = page.getByRole('heading', { name: /All Channels|Apollo Group TV|XtremeHD/i }).first();
  await header.click({ timeout: 5000 });
  await page.getByRole('button', { name }).click({ timeout: 8000 });
}

async function clickFirstChannel(page) {
  const cards = page.locator('button').filter({ has: page.locator('p') });
  await cards.first().click({ timeout: 8000 });
}

async function waitForPlayback(page) {
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.readyState >= 2 && video.videoWidth > 0);
  }, { timeout: 35000 });
  return page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      readyState: video?.readyState ?? 0,
      currentTime: Number(video?.currentTime ?? 0),
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      currentSrcIsBlob: Boolean(video?.currentSrc?.startsWith('blob:')),
    };
  });
}

async function proveProvider(page, providerName, screenshotName, streamEvents, errors) {
  await page.goto(`${TARGET}?proof=${Date.now()}-${providerName.replace(/\W+/g, '-').toLowerCase()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await selectPlaylist(page, `${providerName} - DaveAI Vault`);
  await clickFirstChannel(page);
  const playback = await waitForPlayback(page);
  await page.screenshot({ path: path.join(OUT_DIR, screenshotName), fullPage: true });
  const matchingStreams = streamEvents.filter(
    (event) => event.provider === (providerName.startsWith('Apollo') ? 'apollo' : 'xtremehd'),
  );
  const badEmptyId = matchingStreams.some((event) => event.idState !== 'present');
  return {
    provider: providerName,
    playback,
    streamRequestCount: matchingStreams.length,
    stream200Count: matchingStreams.filter((event) => event.status >= 200 && event.status < 300).length,
    badEmptyId,
    errorsBeforeReturn: errors.length,
  };
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
const streamEvents = [];

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText || 'unknown';
  if (failure === 'net::ERR_ABORTED' && request.url().includes('/cdn-cgi/rum')) {
    return;
  }
  if (failure === 'net::ERR_ABORTED' && request.url().includes('/api/provider-vault/segment')) {
    return;
  }
  failedRequests.push({
    url: sanitizeUrl(request.url()),
    failure,
  });
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
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
await page.screenshot({ path: path.join(OUT_DIR, 'iptv-restream-home.png'), fullPage: true });

const visibleText = await page.locator('body').innerText({ timeout: 10000 });
const chromeChecks = {
  streamHub: visibleText.includes('StreamHub'),
  searchChannels: await page.getByPlaceholder('Search channels...').isVisible().catch(() => false),
  noPortugueseWelcome: !/bem-vindo|conectar/i.test(visibleText),
};

const apollo = await proveProvider(page, 'Apollo Group TV', 'iptv-restream-apollo-player.png', streamEvents, [
  ...consoleErrors,
  ...pageErrors,
]);
const xtremehd = await proveProvider(page, 'XtremeHD', 'iptv-restream-xtremehd-player.png', streamEvents, [
  ...consoleErrors,
  ...pageErrors,
]);

const summary = {
  generatedAt: new Date().toISOString(),
  target: TARGET,
  chromeChecks,
  providers: [apollo, xtremehd],
  streamEvents,
  consoleErrors,
  pageErrors,
  failedRequests,
  pass:
    chromeChecks.streamHub &&
    chromeChecks.searchChannels &&
    chromeChecks.noPortugueseWelcome &&
    [apollo, xtremehd].every(
      (proof) =>
        proof.playback.readyState >= 2 &&
        proof.playback.currentSrcIsBlob &&
        proof.streamRequestCount > 0 &&
        proof.stream200Count > 0 &&
        !proof.badEmptyId,
    ) &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    failedRequests.length === 0,
};

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

await browser.close();
process.exit(summary.pass ? 0 : 1);
