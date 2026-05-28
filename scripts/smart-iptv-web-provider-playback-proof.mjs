import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE_URL = process.env.SMART_IPTV_WEB_URL || 'https://smart-iptv-web.daveai.tech';
const AUTH_STATE = process.env.AUTH_STATE || 'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR = process.env.OUT_DIR || 'C:/Users/Admin/Downloads/VPS/_visual_artifacts/smart-iptv-web-provider-proof-20260528';
const PROVIDERS = (process.argv.slice(2).length ? process.argv.slice(2) : ['apollo', 'xtremehd', 'combined'])
  .map((value) => value.toLowerCase());

const providerNames = {
  apollo: 'Apollo Group TV',
  xtremehd: 'XtremeHD',
  combined: 'Combined Tagged Catalog',
};

const forbiddenNonEnglish = [
  'Bem-vindo',
  'Insira',
  'Conectar',
  'Usuário',
  'Senha',
  'Compatível',
  'Ocorreu um erro',
  'Recarregar App',
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

function itemQueryName(item) {
  return String(item?.name || '')
    .replace(/^\|EN\|\s*/i, '')
    .replace(/^\|US\|\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fillSmartSearch(page, query) {
  const inputs = page.getByRole('textbox');
  const count = await inputs.count();
  assert(count > 0, 'Smart search input not found');
  await inputs.nth(count - 1).fill(query);
  await page.waitForTimeout(900);
}

async function clickTextCard(page, expectedName) {
  const clicked = await page.evaluate((name) => {
    const normalizedName = name.toLowerCase();
    const candidates = [...document.querySelectorAll('button, [role="button"], div')]
      .map((element) => {
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
        const rect = element.getBoundingClientRect();
        return { element, text, rect };
      })
      .filter(({ text, rect }) => {
        if (!text || rect.width < 60 || rect.height < 40) return false;
        if (/Home|Live TV|Movies|Series|Settings|Logout|Search|Favorites|Bouquets/i.test(text)) return false;
        return text.toLowerCase().includes(normalizedName) || normalizedName.includes(text.toLowerCase());
      })
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    const target = candidates[0];
    if (!target) return null;
    target.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return target.text.slice(0, 200);
  }, expectedName);
  assert(clicked, `Could not click a card matching "${expectedName}"`);
  return clicked;
}

async function cardStats(page, label) {
  const stats = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, [role="button"], div')]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
        const img = element.querySelector('img');
        return {
          text,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.width > 50 && rect.height > 50,
          img: img ? {
            src: img.currentSrc || img.src,
            alt: img.alt,
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
          } : null,
        };
      })
      .filter((item) => item.visible && item.text && !/Home|Live TV|Movies|Series|Settings|Logout|Search|Favorites|Bouquets/i.test(item.text));
    return {
      visibleCards: nodes.length,
      cardsWithText: nodes.filter((item) => item.text.length > 2).length,
      cardsWithLoadedImages: nodes.filter((item) => item.img && item.img.complete && item.img.naturalWidth > 0 && item.img.naturalHeight > 0).length,
      sample: nodes.slice(0, 8),
    };
  });
  assert(stats.visibleCards > 0, `${label} rendered no visible cards`);
  assert(stats.cardsWithText > 0, `${label} rendered cards without text data`);
  return stats;
}

async function waitForDashboard(page, providerId) {
  await page.waitForFunction(() => !/Loading your channels/i.test(document.body.innerText), { timeout: 120_000 });
  await page.waitForFunction(() => /Welcome Back|Live TV/i.test(document.body.innerText), { timeout: 30_000 });
  const text = await page.locator('body').innerText();
  for (const forbidden of forbiddenNonEnglish) {
    assert(!text.includes(forbidden), `${providerId} rendered non-English UI text: ${forbidden}`);
  }
  assert(text.includes('Welcome Back'), `${providerId} dashboard missing Welcome Back`);
  assert(text.includes('Live TV'), `${providerId} dashboard missing Live TV`);
  assert(text.includes('Movies'), `${providerId} dashboard missing Movies`);
  assert(text.includes('Series'), `${providerId} dashboard missing Series`);
}

async function openProvider(browser, providerId) {
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
  const mediaResponses = [];

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
    if (/provider-vault\/(stream|aac-hls|segment)/i.test(url)) {
      mediaResponses.push({ status: response.status(), url });
    }
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
    localStorage.setItem('stream_quality', 'auto');
  }, providerId);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForDashboard(page, providerId);

  const sessionShape = await page.evaluate(() => {
    const raw = localStorage.getItem('iptv_session');
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      type: data?.type || null,
      providerId: data?.data?.providerId || null,
      providers: data?.data?.providers || null,
      hasUsername: Boolean(data?.data?.username),
      hasPassword: Boolean(data?.data?.password),
      hasHost: Boolean(data?.data?.host),
      userInfoKeys: data?.userInfo ? Object.keys(data.userInfo).sort() : [],
    };
  });

  assert(sessionShape?.type === 'vault', `${providerId} did not store a vault session`);
  assert(sessionShape.providerId === providerId, `${providerId} stored wrong provider id (${sessionShape?.providerId})`);
  assert(!sessionShape.hasUsername && !sessionShape.hasPassword && !sessionShape.hasHost, `${providerId} leaked credentials into localStorage`);

  await page.screenshot({ path: path.join(OUT_DIR, `smart-${providerId}-dashboard.png`), fullPage: true });
  return { context, page, pageErrors, consoleErrors, badResponses, browserUrls, mediaResponses, sessionShape };
}

async function proveProvider(browser, providerId) {
  if (providerId === 'combined') return proveCombined(browser);

  const providerName = providerNames[providerId];
  assert(providerName, `Unknown provider ${providerId}`);
  const run = await openProvider(browser, providerId);
  const { context, page, pageErrors, consoleErrors, badResponses, browserUrls, mediaResponses, sessionShape } = run;

  const providerList = await fetchJson(page, '/api/provider-vault/providers');
  assert(providerList.ok, `/api/provider-vault/providers failed with ${providerList.status}`);
  assert(providerList.json?.providers?.some((provider) => provider.id === providerId && provider.configured), `${providerId} missing from configured provider list`);

  const catalog = await fetchJson(page, `/api/provider-vault/catalog?provider=${providerId}&profile=english&liveLimit=1200&movieLimit=800&seriesLimit=800`);
  assert(catalog.ok, `${providerId} catalog failed with ${catalog.status}`);
  for (const key of ['live', 'movies', 'series']) {
    assert(Array.isArray(catalog.json?.[key]) && catalog.json[key].length > 0, `${providerId} catalog ${key} returned no rows`);
  }
  assert(catalog.json?.profile === 'english', `${providerId} catalog did not use English profile`);

  const cardProof = {};
  for (const section of ['Movies', 'Series']) {
    await page.getByRole('button', { name: section }).click();
    await page.waitForTimeout(900);
    const key = section === 'Movies' ? 'movies' : 'series';
    const queryName = itemQueryName(catalog.json[key][0]).slice(0, 32);
    await fillSmartSearch(page, queryName);
    cardProof[key] = await cardStats(page, `${providerId} ${section}`);
    assert(cardProof[key].cardsWithLoadedImages > 0, `${providerId} ${section} cards did not load artwork`);
    await page.screenshot({ path: path.join(OUT_DIR, `smart-${providerId}-${key}-cards.png`), fullPage: true });
  }

  await page.getByRole('button', { name: 'Live TV' }).click();
  await page.waitForTimeout(900);
  const liveName = itemQueryName(catalog.json.live.find((item) => item?.tvg?.logo) || catalog.json.live[0]).slice(0, 40);
  await fillSmartSearch(page, liveName);
  const liveCards = await cardStats(page, `${providerId} Live TV`);
  await page.screenshot({ path: path.join(OUT_DIR, `smart-${providerId}-live-cards.png`), fullPage: true });

  const start = Date.now();
  const clickedName = await clickTextCard(page, liveName);
  await page.waitForSelector('video', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.currentSrc && video.readyState >= 2 && !video.error);
  }, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && !video.paused && !video.muted && video.volume > 0);
  }, { timeout: 45_000 });
  await page.waitForTimeout(5000);
  const playbackMs = Date.now() - start;

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
      muted: video.muted,
      volume: video.volume,
      currentSrc: video.currentSrc,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
      currentTime: video.currentTime,
      buffered,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    };
  });

  assert(videoState?.readyState >= 2, `${providerId} video never prepared`);
  assert(!videoState?.error, `${providerId} video error ${JSON.stringify(videoState?.error)}`);
  assert(videoState.paused === false, `${providerId} video is paused`);
  assert(videoState.muted === false && videoState.volume > 0, `${providerId} video is muted or volume is zero`);
  assert(videoState.currentTime >= 0, `${providerId} video currentTime invalid`);
  assert(mediaResponses.some((response) => response.status >= 200 && response.status < 300), `${providerId} did not request provider-vault media successfully`);

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
    sessionShape,
    catalog: {
      profile: catalog.json.profile,
      live: catalog.json.live.length,
      movies: catalog.json.movies.length,
      series: catalog.json.series.length,
    },
    cards: {
      live: liveCards,
      movies: cardProof.movies,
      series: cardProof.series,
    },
    playback: {
      clickedName,
      playbackMs,
      mediaStatus: mediaResponses.map((response) => response.status).slice(0, 12),
      videoState: {
        readyState: videoState.readyState,
        paused: videoState.paused,
        muted: videoState.muted,
        volume: videoState.volume,
        error: videoState.error,
        bufferedRanges: videoState.buffered.length,
        currentSrcIsVault: String(videoState.currentSrc || '').includes('/api/provider-vault/'),
        videoSize: [videoState.videoWidth, videoState.videoHeight],
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

async function proveCombined(browser) {
  const run = await openProvider(browser, 'combined');
  const { context, page, pageErrors, consoleErrors, badResponses, sessionShape } = run;

  await page.getByRole('button', { name: 'Live TV' }).click();
  await page.waitForTimeout(900);
  await fillSmartSearch(page, 'USA');
  const text = await page.locator('body').innerText();
  assert(text.includes('Apollo Group TV') || text.includes('XtremeHD'), 'Combined mode did not render provider tags');
  assert(sessionShape.providerId === 'combined', 'Combined mode session did not persist combined provider id');
  assert(Array.isArray(sessionShape.providers) && sessionShape.providers.includes('apollo') && sessionShape.providers.includes('xtremehd'), 'Combined mode did not persist separate provider list');
  const cards = await cardStats(page, 'combined tagged live');
  await page.screenshot({ path: path.join(OUT_DIR, 'smart-combined-tagged-cards.png'), fullPage: true });
  await context.close();

  const filteredBadResponses = badResponses.filter((response) => {
    const url = response.url;
    if (/provider-vault\/image/i.test(url) && [400, 404, 502].includes(response.status)) return false;
    return true;
  });

  return {
    provider: 'combined',
    sessionShape,
    cards,
    diagnostics: {
      pageErrors,
      consoleErrors,
      badResponses: filteredBadResponses.slice(0, 20),
    },
    ok: pageErrors.length === 0 && consoleErrors.length === 0 && filteredBadResponses.length === 0,
  };
}

mkdirp(OUT_DIR);

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
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
