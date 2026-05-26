import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE_URL = process.env.SMART_IPTV_WEB_URL || 'https://smart-iptv-web.daveai.tech';
const AUTH_STATE = process.env.AUTH_STATE || 'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR = process.env.OUT_DIR || 'C:/Users/Admin/Downloads/VPS/_visual_artifacts/smart-iptv-web-provider-proof-20260526';
const PROVIDERS = (process.argv.slice(2).length ? process.argv.slice(2) : ['apollo', 'xtremehd'])
  .map((value) => value.toLowerCase());

const providerNames = {
  apollo: 'Apollo Group TV',
  xtremehd: 'XtremeHD',
};

const requiredEnglish = [
  'Smart IPTV',
  'Securely connect to your provider',
  'Xtream',
  'M3U',
  'Stalker',
  'Server URL',
  'Username',
  'Password',
  'Private provider accounts stay server-side',
];

const forbiddenNonEnglish = [
  'Bem-vindo',
  'Insira',
  'Conectar',
  'Usuário',
  'Senha',
  'Compatível',
];

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function fetchJson(page, url) {
  return page.evaluate(async (target) => {
    const response = await fetch(target);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { status: response.status, ok: response.ok, json };
  }, url);
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

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => {
    const text = msg.text();
    if (['error', 'warning'].includes(msg.type()) && !/Autoplay|favicon|AbortError|ResizeObserver/i.test(text)) {
      consoleErrors.push({ type: msg.type(), text: text.slice(0, 700) });
    }
  });
  page.on('request', (request) => browserUrls.push(request.url()));
  page.on('response', (response) => {
    const url = response.url();
    browserUrls.push(url);
    if (response.status() >= 400 && !/favicon|_next\/image/i.test(url)) {
      badResponses.push({ status: response.status(), url });
    }
  });

  await page.addInitScript((id) => {
    localStorage.clear();
    localStorage.setItem('iptv_default_provider', id);
    localStorage.setItem('iptv_setting_maxBufferLength', '300');
    localStorage.setItem('iptv_setting_bufferSize', '256');
    localStorage.setItem('iptv_setting_liveBufferLatencyChasing', 'false');
  }, providerId);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  let loginText = await page.locator('body').innerText({ timeout: 15_000 });
  for (const text of forbiddenNonEnglish) assert(!loginText.includes(text), `Non-English text leaked on login: ${text}`);

  if (!loginText.includes('Welcome Back')) {
    for (const text of requiredEnglish) assert(loginText.includes(text), `Missing English text on login: ${text}`);
    await page.screenshot({ path: path.join(OUT_DIR, `smart-${providerId}-login.png`), fullPage: true });

    await page.getByRole('button', { name: providerName }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Welcome Back'), { timeout: 60_000 });
  } else {
    await page.screenshot({ path: path.join(OUT_DIR, `smart-${providerId}-auto-login.png`), fullPage: true });
  }

  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const dashboardText = await page.locator('body').innerText();
  assert(dashboardText.includes('Welcome Back'), `${providerId} dashboard did not load`);
  assert(dashboardText.includes('Live TV'), `${providerId} dashboard missing Live TV`);
  assert(dashboardText.includes('Movies'), `${providerId} dashboard missing Movies`);
  assert(dashboardText.includes('Series'), `${providerId} dashboard missing Series`);

  const sessionShape = await page.evaluate(() => {
    const raw = localStorage.getItem('iptv_session');
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      type: data?.type || null,
      providerId: data?.data?.providerId || null,
      hasUsername: Boolean(data?.data?.username),
      hasPassword: Boolean(data?.data?.password),
      hasHost: Boolean(data?.data?.host),
      userInfoKeys: data?.userInfo ? Object.keys(data.userInfo).sort() : [],
    };
  });
  assert(sessionShape?.type === 'vault', `${providerId} did not store vault session`);
  assert(sessionShape.providerId === providerId, `${providerId} stored wrong provider id`);
  assert(!sessionShape.hasUsername && !sessionShape.hasPassword && !sessionShape.hasHost, `${providerId} leaked credentials into localStorage`);

  const providerList = await fetchJson(page, '/api/provider-vault/providers');
  assert(providerList.ok, `/api/provider-vault/providers failed with ${providerList.status}`);
  assert(
    providerList.json?.providers?.some((provider) => provider.id === providerId && provider.configured),
    `${providerId} missing from configured provider list`,
  );

  const catalog = await fetchJson(page, `/api/provider-vault/catalog?provider=${providerId}&liveLimit=1200&movieLimit=500&seriesLimit=500`);
  assert(catalog.ok, `${providerId} catalog failed with ${catalog.status}`);
  for (const key of ['live', 'movies', 'series']) {
    assert(Array.isArray(catalog.json?.[key]) && catalog.json[key].length > 0, `${providerId} catalog ${key} returned no rows`);
  }

  await page.screenshot({ path: path.join(OUT_DIR, `smart-${providerId}-dashboard.png`), fullPage: true });

  await page.getByText(/\d+\s+Channels/i).first().click();
  await page.waitForTimeout(1000);
  const clickedCategory = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button')]
      .filter((element) => {
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
        return text.length < 80 && (/United States/i.test(text) || /24\/7/i.test(text));
      });
    const target = candidates.find((element) => /United States/i.test(element.textContent || '')) || candidates[0];
    if (!target) return null;
    const name = (target.textContent || '').replace(/\s+/g, ' ').trim();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return name;
  });
  assert(clickedCategory, `${providerId} could not select a live category`);
  await page.waitForFunction(() => {
    const elements = [...document.querySelectorAll('[role="button"], div')];
    return elements.some((element) => /USA|AMC|CNN|FOX|ESPN|NBC|ABC|CH\s+\d+/i.test(element.textContent || ''));
  }, { timeout: 45_000 }).catch(() => {});

  const beforeClickText = await page.locator('body').innerText();
  assert(!/No channels found/i.test(beforeClickText), `${providerId} live tab showed no channels`);

  const streamResponses = [];
  const segmentResponses = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/provider-vault/stream')) {
      streamResponses.push({ status: response.status(), url });
    }
    if (url.includes('/api/provider-vault/segment') || url.includes('/api/provider-vault/aac-hls')) {
      segmentResponses.push({ status: response.status(), url });
    }
  });

  const clickedName = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button, [role="button"]')]
      .filter((element) => {
        const text = element.textContent || '';
        return text.trim().length > 2 &&
          /USA|AMC|CNN|FOX|ESPN|NBC|ABC|CH\s+\d+/i.test(text) &&
          !/Home|Movies|Series|Settings|Logout|Search|Favorites|BOUQUETS/i.test(text);
      });
    const target = candidates.find((element) => /USA|AMC|CNN|FOX|ESPN|NBC|ABC/i.test(element.textContent || '')) || candidates[0];
    if (!target) return null;
    const name = (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return name;
  });
  assert(clickedName, `${providerId} could not select a live channel`);

  await page.waitForSelector('video', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && (video.readyState >= 2 || video.currentSrc));
  }, { timeout: 60_000 });
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

  await page.screenshot({ path: path.join(OUT_DIR, `smart-${providerId}-playback.png`), fullPage: true });

  const visibleText = await page.locator('body').innerText().catch(() => '');
  const credentialLeakPatterns = [
    /player_api\.php/i,
    /username=/i,
    /password=/i,
    /\/live\/[^/]+\/[^/]+\//i,
    /\/movie\/[^/]+\/[^/]+\//i,
    /\/series\/[^/]+\/[^/]+\//i,
  ];
  const textLeaks = credentialLeakPatterns.filter((pattern) => pattern.test(visibleText)).map(String);
  const urlLeaks = browserUrls
    .filter((url) => credentialLeakPatterns.some((pattern) => pattern.test(url)))
    .slice(0, 10);
  assert(textLeaks.length === 0, `${providerId} visible text contains credential-shaped leak: ${textLeaks.join(', ')}`);
  assert(urlLeaks.length === 0, `${providerId} browser requested credential-shaped URL: ${urlLeaks.join(' | ')}`);

  await context.close();

  const filteredBadResponses = badResponses.filter((response) => {
    const url = response.url;
    if (/provider-vault\/image/i.test(url) && [400, 404, 502].includes(response.status)) return false;
    return true;
  });

  return {
    provider: providerId,
    loginTextOk: true,
    sessionShape,
    catalog: {
      live: catalog.json.live.length,
      movies: catalog.json.movies.length,
      series: catalog.json.series.length,
    },
    playback: {
      clickedName,
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
      badResponses: filteredBadResponses.slice(0, 20),
      browserRequestCount: browserUrls.length,
    },
    ok: pageErrors.length === 0 && consoleErrors.length === 0 && filteredBadResponses.length === 0,
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
