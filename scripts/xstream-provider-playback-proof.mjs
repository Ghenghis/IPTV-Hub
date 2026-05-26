import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE_URL = process.env.XSTREAM_URL || 'https://xstream-player.daveai.tech';
const AUTH_STATE = process.env.AUTH_STATE || 'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR = process.env.OUT_DIR || 'C:/Users/Admin/Downloads/VPS/_visual_artifacts/xstream-player-provider-proof-20260526';
const PROVIDERS = (process.argv.slice(2).length ? process.argv.slice(2) : ['apollo', 'xtremehd'])
  .map((value) => value.toLowerCase());

const providerNames = {
  apollo: 'Apollo Group TV',
  xtremehd: 'XtremeHD',
};

const requiredEnglish = [
  'Welcome',
  'Use Apollo Group TV',
  'Use XtremeHD',
  'MANUAL LOGIN',
  'SERVER URL',
  'USERNAME',
  'PASSWORD',
  'Connect',
];

const forbiddenPortuguese = [
  'Bem-vindo',
  'Insira',
  'Conectar',
  'Usuário',
  'Senha',
  'Compatível',
  'Bom dia',
  'Boa tarde',
  'Boa noite',
];

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchJson(page, url, body) {
  return page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { status: response.status, ok: response.ok, json };
  }, { url, body });
}

async function firstCatalogItem(page, providerId, action) {
  const response = await fetchJson(page, '/api/proxy', {
    providerId,
    action,
    page: 1,
    limit: 8,
  });
  assert(response.ok, `${providerId} ${action} failed with ${response.status}`);
  const items = Array.isArray(response.json?.items) ? response.json.items : [];
  assert(items.length > 0, `${providerId} ${action} returned no items`);
  return {
    status: response.status,
    total: response.json.total,
    count: items.length,
    item: items[0],
  };
}

async function addDaveTvAuthCookie(context) {
  if (!fs.existsSync(AUTH_STATE)) return;
  const raw = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
  if (raw?.cookieName && raw?.cookieValue) {
    await context.addCookies([{
      name: raw.cookieName,
      value: raw.cookieValue,
      domain: '.daveai.tech',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      expires: Math.floor((raw.expiresAt || Date.now() + 60 * 60 * 1000) / 1000),
    }]);
  }
}

async function proveProvider(browser, providerId) {
  const providerName = providerNames[providerId];
  assert(providerName, `Unknown provider ${providerId}`);

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await addDaveTvAuthCookie(context);

  const pageErrors = [];
  const consoleErrors = [];
  const badResponses = [];
  const browserUrls = [];

  context.on('page', (p) => {
    p.on('pageerror', (error) => pageErrors.push(error.message));
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => {
    const text = msg.text();
    if (['error', 'warning'].includes(msg.type()) && !/Autoplay|favicon|AbortError/i.test(text)) {
      consoleErrors.push({ type: msg.type(), text: text.slice(0, 500) });
    }
  });
  page.on('request', (request) => browserUrls.push(request.url()));
  page.on('response', (response) => {
    const url = response.url();
    browserUrls.push(url);
    if (response.status() >= 400 && !/favicon|tmdb\/config|subtitles\/config/i.test(url)) {
      badResponses.push({ status: response.status(), url });
    }
  });

  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 45_000 });
  await page.waitForLoadState('domcontentloaded');

  const loginText = await page.locator('body').innerText({ timeout: 15_000 });
  for (const text of requiredEnglish) assert(loginText.includes(text), `Missing English text on login: ${text}`);
  for (const text of forbiddenPortuguese) assert(!loginText.includes(text), `Portuguese text leaked on login: ${text}`);

  await page.screenshot({ path: path.join(OUT_DIR, `xstream-${providerId}-login.png`), fullPage: true });

  await page.getByRole('button', { name: `Use ${providerName}` }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const authShape = await page.evaluate(() => {
    const raw = localStorage.getItem('xstream_auth');
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      providerId: data?.credentials?.providerId || null,
      hasUsername: Boolean(data?.credentials?.username),
      hasPassword: Boolean(data?.credentials?.password),
      hasHostUrl: Boolean(data?.credentials?.hostUrl),
      user: data?.user?.username || null,
      protocol: data?.server?.server_protocol || null,
    };
  });
  assert(authShape?.providerId === providerId, `${providerId} did not persist provider-only auth`);
  assert(!authShape.hasUsername && !authShape.hasPassword && !authShape.hasHostUrl, `${providerId} leaked credentials into localStorage`);

  const providerList = await fetchJson(page, '/api/provider-vault/providers');
  assert(providerList.ok, `/api/provider-vault/providers failed with ${providerList.status}`);
  assert(
    providerList.json?.providers?.some((provider) => provider.id === providerId && provider.configured),
    `${providerId} missing from configured provider list`,
  );

  const liveCategories = await fetchJson(page, '/api/proxy', { providerId, action: 'get_live_categories' });
  const vodCategories = await fetchJson(page, '/api/proxy', { providerId, action: 'get_vod_categories' });
  const seriesCategories = await fetchJson(page, '/api/proxy', { providerId, action: 'get_series_categories' });
  for (const [label, response] of Object.entries({ liveCategories, vodCategories, seriesCategories })) {
    assert(response.ok, `${providerId} ${label} failed with ${response.status}`);
    assert(Array.isArray(response.json) && response.json.length > 0, `${providerId} ${label} returned no rows`);
  }

  const live = await firstCatalogItem(page, providerId, 'get_live_streams');
  const movies = await firstCatalogItem(page, providerId, 'get_vod_streams');
  const series = await firstCatalogItem(page, providerId, 'get_series');

  await page.screenshot({ path: path.join(OUT_DIR, `xstream-${providerId}-dashboard.png`), fullPage: true });

  const streamId = String(live.item.stream_id || live.item.id);
  assert(streamId && streamId !== 'undefined', `${providerId} live stream id missing`);

  const streamResponses = [];
  const segmentResponses = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/provider-vault/stream')) {
      streamResponses.push({ status: response.status(), url });
    }
    if (url.includes('/api/provider-vault/segment')) {
      segmentResponses.push({ status: response.status(), url });
    }
  });

  await page.goto(`${BASE_URL}/dashboard/watch/live/${encodeURIComponent(streamId)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForSelector('video', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && (video.readyState >= 2 || video.currentSrc));
  }, { timeout: 45_000 });
  await page.waitForTimeout(5000);

  const videoState = await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return null;
    const buffered = [];
    for (let i = 0; i < video.buffered.length; i += 1) {
      buffered.push([video.buffered.start(i), video.buffered.end(i)]);
    }
    return {
      readyState: video.readyState,
      paused: video.paused,
      currentSrc: video.currentSrc,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
      currentTime: video.currentTime,
      buffered,
    };
  });
  assert(videoState?.readyState >= 2 || videoState?.currentSrc, `${providerId} video never prepared`);
  assert(!videoState?.error, `${providerId} video error ${JSON.stringify(videoState?.error)}`);
  assert(streamResponses.some((response) => response.status >= 200 && response.status < 300), `${providerId} did not request provider-vault stream successfully`);

  await page.screenshot({ path: path.join(OUT_DIR, `xstream-${providerId}-playback.png`), fullPage: true });

  const visibleText = await page.locator('body').innerText().catch(() => '');
  const credentialLeakPatterns = [
    /player_api\.php/i,
    /username=/i,
    /password=/i,
    /\/live\/[^/]+\/[^/]+\//i,
    /\/movie\/[^/]+\/[^/]+\//i,
    /xtremehd\.cc/i,
  ];
  const textLeaks = credentialLeakPatterns.filter((pattern) => pattern.test(visibleText)).map(String);
  const urlLeaks = browserUrls
    .filter((url) => credentialLeakPatterns.some((pattern) => pattern.test(url)))
    .slice(0, 10);
  assert(textLeaks.length === 0, `${providerId} visible text contains credential-shaped leak: ${textLeaks.join(', ')}`);
  assert(urlLeaks.length === 0, `${providerId} browser requested credential-shaped URL: ${urlLeaks.join(' | ')}`);

  await context.close();

  return {
    provider: providerId,
    loginTextOk: true,
    authShape,
    categories: {
      live: liveCategories.json.length,
      vod: vodCategories.json.length,
      series: seriesCategories.json.length,
    },
    catalogs: {
      live: { count: live.count, total: live.total },
      movies: { count: movies.count, total: movies.total },
      series: { count: series.count, total: series.total },
    },
    playback: {
      streamStatus: streamResponses.map((response) => response.status),
      segmentStatus: segmentResponses.map((response) => response.status).slice(0, 10),
      videoState: {
        readyState: videoState.readyState,
        paused: videoState.paused,
        error: videoState.error,
        bufferedRanges: videoState.buffered.length,
        currentSrcIsVault: String(videoState.currentSrc || '').includes('/api/provider-vault/stream'),
      },
    },
    diagnostics: {
      pageErrors,
      consoleErrors,
      badResponses: badResponses.slice(0, 20),
      browserRequestCount: browserUrls.length,
    },
    ok: pageErrors.length === 0 && consoleErrors.length === 0,
  };
}

mkdirp(OUT_DIR);

const browser = await chromium.launch({ headless: true });
const results = {};
try {
  for (const provider of PROVIDERS) {
    results[provider] = await proveProvider(browser, provider);
  }
} finally {
  await browser.close();
}

const summary = {
  generated_utc: new Date().toISOString(),
  baseUrl: BASE_URL,
  providers: results,
  ok: Object.values(results).every((result) => result.ok),
};

fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;
