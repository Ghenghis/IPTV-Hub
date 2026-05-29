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
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/xstream-provider-mode-e2e-proof-20260528';

const PROVIDERS = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];
const COMBINED_PROVIDER = {
  id: 'combined-tagged',
  name: 'Apollo + XtremeHD',
  buttonName: 'Use Apollo + XtremeHD (Tagged)',
  expectedProviderIds: PROVIDERS.map((provider) => provider.id),
};

const ENABLED_SURFACES = new Set(
  String(process.env.XSTREAM_PROOF_SURFACES || 'live,movie,series')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const SKIP_PLAYBACK = /^(1|true|yes)$/i.test(String(process.env.XSTREAM_SKIP_PLAYBACK || ''));
const ONLY_COMBINED = /^(1|true|yes)$/i.test(String(process.env.XSTREAM_ONLY_COMBINED || ''));
const ONLY_SEPARATED = /^(1|true|yes)$/i.test(String(process.env.XSTREAM_ONLY_SEPARATED || ''));
const PLAYBACK_ATTEMPTS = Math.max(1, Math.min(24, Number(process.env.XSTREAM_PLAYBACK_ATTEMPTS || 8)));
const PLAYBACK_TIMEOUT_MS = Math.max(15_000, Number(process.env.XSTREAM_PLAYBACK_TIMEOUT_MS || 45_000));

const SURFACES = [
  { type: 'live', categoryAction: 'get_live_categories', listAction: 'get_live_streams', watchKind: 'live' },
  { type: 'movie', categoryAction: 'get_vod_categories', listAction: 'get_vod_streams', watchKind: 'movie' },
  { type: 'series', categoryAction: 'get_series_categories', listAction: 'get_series', watchKind: 'series' },
].filter((surface) => ENABLED_SURFACES.has(surface.type));

const FATAL_TEXT = [
  /client-side exception/i,
  /application error/i,
  /something went wrong/i,
  /portal unavailable/i,
  /Bem-vindo/i,
  /Conectar/i,
  /Usu[aá]rio/i,
  /Senha/i,
  /\bMULTI\b/i,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function titleOf(item) {
  return String(item?.name || item?.title || item?.movie_name || '').replace(/\s+/g, ' ').trim();
}

function idOf(item, type) {
  if (type === 'series') return String(item?.series_id || item?.id || '').trim();
  return String(item?.stream_id || item?.id || '').trim();
}

function extOf(item, fallback = 'mp4') {
  return String(item?.container_extension || item?.ext || fallback).replace(/[^a-z0-9]/gi, '') || fallback;
}

function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of ['token', 'src', 'id']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, `[${key}]`);
    }
    return url.toString();
  } catch {
    return String(raw || '').slice(0, 220);
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

async function freshPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.addCookies(await readAuthCookies(new URL(BASE_URL).hostname));
  const page = await context.newPage();
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [], badResponses: [] };
  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error.message || error).slice(0, 700)));
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      !/Autoplay|ERR_ABORTED|AbortError|favicon|Failed to load resource|Failed to (fetch|sync) (server config|favorites|watch progress)|Failed to load TMDb config|Failed to load config|^\[VideoPlayer\] HLS Error:/i.test(text)
    ) {
      diagnostics.consoleErrors.push(text.slice(0, 700));
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || '';
    const url = request.url();
    if (
      failure === 'net::ERR_ABORTED' &&
      /_rsc=|\/api\/watch-progress|\/api\/provider-vault|\/api\/config|\/api\/favorites|\/api\/tmdb\/config|\/api\/subtitles\/config/i.test(url)
    ) return;
    if (!/favicon|cdn-cgi|socket\.io/i.test(url)) diagnostics.failedRequests.push({ url: sanitizeUrl(url), failure });
  });
  page.on('response', (response) => {
    const url = response.url();
    if (response.status() >= 400 && !/favicon|cdn-cgi|\/api\/watch-progress|\/api\/config|\/api\/favorites|\/api\/tmdb\/config|\/api\/subtitles\/config/i.test(url)) {
      diagnostics.badResponses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
  });
  return { context, page, diagnostics };
}

async function loginProvider(page, provider) {
  await page.goto(`${BASE_URL}/?providerModeProof=${provider.id}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.evaluate(async () => {
    localStorage.clear();
    if ('indexedDB' in window) {
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('xstream_player_db');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    }
  });
  await page.reload({ waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
  await page.getByRole('button', { name: provider.buttonName || `Use ${provider.name}` }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function authStorageShape(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('xstream_auth');
    const data = raw ? JSON.parse(raw) : null;
    return {
      providerId: data?.credentials?.providerId || null,
      mode: data?.credentials?.providerMode || 'separated',
      providerIds: Array.isArray(data?.credentials?.providerIds) ? data.credentials.providerIds : [],
      hasHostUrl: Boolean(data?.credentials?.hostUrl),
      hasUsername: Boolean(data?.credentials?.username),
      hasPassword: Boolean(data?.credentials?.password),
    };
  });
}

async function waitForSyncIdle(page, providerId) {
  const deadline = Date.now() + 240_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await page.locator('body').innerText().catch(() => '');
    if (!/Syncing\.\.\.|\d+%\s+complete|Loading all movies|Fetching your library/i.test(last)) return last;
    await page.waitForTimeout(2500);
  }
  throw new Error(`${providerId} sync did not become idle: ${last.slice(0, 240)}`);
}

async function postProxy(page, body) {
  return page.evaluate(async (payload) => {
    const response = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  }, body);
}

async function listItems(page, providerId, action, params = {}) {
  const response = await postProxy(page, { providerId, action, page: 1, limit: 250, ...params });
  assert(response.ok, `${providerId} ${action} failed ${response.status}`);
  const items = Array.isArray(response.json?.items) ? response.json.items : [];
  assert(items.length > 0, `${providerId} ${action} returned no rows`);
  return { total: Number(response.json.total || items.length), items };
}

async function categories(page, providerId, action) {
  const response = await postProxy(page, { providerId, action });
  assert(response.ok, `${providerId} ${action} failed ${response.status}`);
  assert(Array.isArray(response.json) && response.json.length > 0, `${providerId} ${action} returned no categories`);
  return response.json;
}

function pickCategory(cats, type) {
  const nonEnglishCategory = /arab|ramadan|turkish|spanish|portugal|russian|french|german|italian|translated|sub|multi|hindi|kurdish|korean|japan|china|asian|european|pakistan|bangladesh|mexican|morocco|qatar|egypt|syria|lebanon|saudi|palestine|iran|iraq|kuwait|bahrain|emirates|yemen|tunisia|algeria/i;
  const candidates = cats.filter((cat) => !nonEnglishCategory.test(String(cat.category_name || '')));
  const preferred =
    type === 'live'
      ? [
          /\bUSA\s+Entertainment\b/i,
          /\bUS\|?\s*Entertainment\b/i,
          /\bEntertainment\b/i,
          /\bUSA\s+Movies?\b/i,
          /\bNews\b/i,
          /\bUSA\b/i,
          /\bUS\b/i,
        ]
      : type === 'movie'
        ? [/\bEN\b.*2026|2026.*\bEN\b/i, /\bEN\b/i, /Hollywood/i, /Action|Drama|Comedy/i, /2026/i]
        : [/^Series-(Drama|Action|Comedy|Crime|Documentary|Sci-Fi|Mystery|Thriller|Family|Animation)/i, /\bEN\b.*2026|2026.*\bEN\b/i, /\bEN\b/i, /Drama|Action|Comedy/i, /2026/i];
  for (const pattern of preferred) {
    const found = candidates.find((cat) => pattern.test(String(cat.category_name || '')));
    if (found) return found;
  }
  return candidates[0] || cats[0];
}

async function auditCards(page, provider, surface, category, options = {}) {
  const pathByType = {
    live: `/dashboard/live/${encodeURIComponent(category.category_id)}`,
    movie: `/dashboard/movies/${encodeURIComponent(category.category_id)}`,
    series: `/dashboard/series/${encodeURIComponent(category.category_id)}`,
  };
  const hrefByType = {
    live: '/dashboard/watch/live/',
    movie: '/dashboard/watch/movie/',
    series: '/dashboard/watch/series/',
  };

  const url = `${BASE_URL}${pathByType[surface.type]}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  await page.locator(`a[href*="${hrefByType[surface.type]}"]`).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);

  const screenshot = path.join(OUT_DIR, `xstream-${provider.id}-${surface.type}-cards.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const fatalText = FATAL_TEXT.filter((pattern) => pattern.test(bodyText)).map(String);
  const cards = await page.locator(`a[href*="${hrefByType[surface.type]}"]`).evaluateAll((nodes) =>
    nodes.slice(0, 30).map((node) => {
      const rect = node.getBoundingClientRect();
      const img = node.querySelector('img');
      const fallback = node.querySelector('[data-artwork-fallback]');
      const image = img instanceof HTMLImageElement ? img : null;
      const imageRect = image?.getBoundingClientRect();
      return {
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180),
        href: node.getAttribute('href') || '',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        imageWidth: Math.round(imageRect?.width || 0),
        imageHeight: Math.round(imageRect?.height || 0),
        objectFit: image ? getComputedStyle(image).objectFit : '',
        naturalWidth: image?.naturalWidth || 0,
        naturalHeight: image?.naturalHeight || 0,
        hasImage: Boolean(image),
        hasFallback: Boolean(fallback),
      };
    }),
  );

  const badCards = cards.filter((card) => (
    card.width < 110 ||
    card.height < 54 ||
    card.width > 780 ||
    card.height > 760 ||
    card.text.length < 2 ||
    (!card.hasImage && !card.hasFallback)
  ));
  const stretchedLive = surface.type === 'live'
    ? cards.filter((card) => card.hasImage && card.objectFit !== 'contain')
    : [];
  const providerTagCount = options.expectProviderTag
    ? cards.filter((card) => card.text.includes(options.expectedProviderName || '')).length
    : 0;
  const missingProviderTags = options.expectProviderTag && providerTagCount < Math.min(4, cards.length);

  return {
    provider: provider.id,
    surface: surface.type,
    category: category.category_name,
    categoryId: String(category.category_id),
    screenshot,
    ok:
      cards.length >= 8 &&
      fatalText.length === 0 &&
      badCards.length === 0 &&
      stretchedLive.length === 0 &&
      !missingProviderTags,
    providerTagCount,
    missingProviderTags,
    cardCount: cards.length,
    fatalText,
    badCards,
    stretchedLive,
    sampleCards: cards.slice(0, 8),
  };
}

async function videoState(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return null;
    let bufferedAhead = 0;
    for (let i = 0; i < video.buffered.length; i += 1) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (start <= video.currentTime && end > video.currentTime) bufferedAhead = Math.max(bufferedAhead, end - video.currentTime);
    }
    return {
      readyState: video.readyState,
      networkState: video.networkState,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      currentTime: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      bufferedAhead,
      webkitAudioDecodedByteCount: Number(video.webkitAudioDecodedByteCount || 0),
      currentSrcKind: String(video.currentSrc || '').startsWith('blob:')
        ? 'blob'
        : String(video.currentSrc || '').includes('/api/provider-vault/')
          ? 'provider-vault'
          : 'other',
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
      text: document.body.innerText.slice(0, 700),
    };
  });
}

async function tryPlayback(page, provider, surface, items) {
  const attempts = [];
  for (const item of items.slice(0, PLAYBACK_ATTEMPTS)) {
    const id = idOf(item, surface.type);
    if (!id) continue;
    const title = titleOf(item);
    const ext = extOf(item, surface.type === 'live' ? 'm3u8' : 'mp4');
    const url = `${BASE_URL}/dashboard/watch/${surface.watchKind}/${encodeURIComponent(id)}?proof=${provider.id}-${surface.type}-${Date.now()}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});

    if (surface.type !== 'live') {
      const playButton = surface.type === 'series'
        ? page.getByRole('button', { name: /^Play episode/i })
        : page.getByRole('button', { name: 'Play Movie' });
      await playButton.first().click({ timeout: 45_000 }).catch(() => {});
    } else {
      await page.locator('video').click({ timeout: 8000 }).catch(() => {});
    }

    const deadline = Date.now() + PLAYBACK_TIMEOUT_MS;
    let latest = null;
    let lastTime = -1;
    while (Date.now() < deadline) {
      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (!video) return;
        video.muted = false;
        video.volume = 1;
        if (video.paused) video.play().catch(() => {});
      }).catch(() => {});
      latest = await videoState(page);
      const moved = Number(latest?.currentTime || 0) > 0.3 || (lastTime >= 0 && Number(latest?.currentTime || 0) - lastTime > 0.15);
      const body = latest?.text || '';
      const hardError = /DEMUXER|MEDIA_ELEMENT_ERROR|Format error|FFmpegDemuxer|Application Error|Something went wrong|Stream error|bufferAddCodecError|No Sound/i.test(body);
      const audioDecoded = Number(latest?.webkitAudioDecodedByteCount || 0) > 0;
      if (
        latest?.readyState >= 2 &&
        latest.width > 0 &&
        !latest.error &&
        !hardError &&
        !latest.paused &&
        !latest.muted &&
        latest.volume > 0.05 &&
        audioDecoded &&
        moved
      ) break;
      if (latest?.readyState >= 2) lastTime = Number(latest.currentTime || 0);
      await page.waitForTimeout(1500);
    }
    latest = await videoState(page);
    const body = latest?.text || '';
    const hardError = /DEMUXER|MEDIA_ELEMENT_ERROR|Format error|FFmpegDemuxer|Application Error|Something went wrong|Stream error|bufferAddCodecError|No Sound/i.test(body);
    const audioDecoded = Number(latest?.webkitAudioDecodedByteCount || 0) > 0;
    const ok = Boolean(
      latest?.readyState >= 2 &&
      latest.width > 0 &&
      !latest.error &&
      !hardError &&
      !latest.paused &&
      !latest.muted &&
      latest.volume > 0.05 &&
      audioDecoded &&
      latest.currentTime > 0.25
    );
    attempts.push({ id, title, ext, ok, hardError, state: latest });
    if (ok) {
      await page.screenshot({ path: path.join(OUT_DIR, `xstream-${provider.id}-${surface.type}-playback.png`), fullPage: true });
      return { ok: true, provider: provider.id, surface: surface.type, selected: { id, title, ext }, attempts };
    }
  }

  await page.screenshot({ path: path.join(OUT_DIR, `xstream-${provider.id}-${surface.type}-playback-failed.png`), fullPage: true }).catch(() => {});
  return { ok: false, provider: provider.id, surface: surface.type, attempts };
}

async function readIndexedDbShape(page) {
  return page.evaluate(async () => {
    const openDatabase = () => new Promise((resolve, reject) => {
      const req = indexedDB.open('xstream_player_db');
      req.onerror = () => reject(req.error || new Error('failed to open xstream_player_db'));
      req.onsuccess = () => resolve(req.result);
    });
    const readStore = (db, storeName) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onerror = () => reject(req.error || new Error(`failed to read ${storeName}`));
      req.onsuccess = () => resolve(req.result || []);
    });
    const summarizeStreams = (db) => new Promise((resolve, reject) => {
      const byProvider = {};
      for (const providerId of ['apollo', 'xtremehd']) {
        byProvider[providerId] = { live: 0, movie: 0, series: 0 };
      }
      const missing = [];
      let total = 0;
      const tx = db.transaction('streams', 'readonly');
      const req = tx.objectStore('streams').openCursor();
      req.onerror = () => reject(req.error || new Error('failed to cursor streams'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve({ total, byProvider, missingProviderRows: missing });
          return;
        }
        total += 1;
        const stream = cursor.value || {};
        if (byProvider[stream.provider_id] && byProvider[stream.provider_id][stream.type] !== undefined) {
          byProvider[stream.provider_id][stream.type] += 1;
        } else if (!stream.provider_id && missing.length < 10) {
          missing.push({ store: 'streams', id: stream.id, type: stream.type, name: stream.name });
        }
        cursor.continue();
      };
    });
    const db = await openDatabase();
    try {
      const [categories, streamSummary] = await Promise.all([
        readStore(db, 'categories'),
        summarizeStreams(db),
      ]);
      const byProvider = {};
      for (const providerId of ['apollo', 'xtremehd']) {
        byProvider[providerId] = {
          categories: { live: 0, movie: 0, series: 0 },
          streams: streamSummary.byProvider[providerId],
        };
      }
      for (const category of categories) {
        if (byProvider[category.provider_id] && byProvider[category.provider_id].categories[category.type] !== undefined) {
          byProvider[category.provider_id].categories[category.type] += 1;
        }
      }
      const missingProviderRows = [
        ...categories.filter((category) => !category.provider_id).slice(0, 10).map((category) => ({ store: 'categories', id: category.category_id, type: category.type, name: category.category_name })),
        ...streamSummary.missingProviderRows,
      ];
      return {
        categories: categories.map((category) => ({
          category_id: String(category.category_id),
          raw_category_id: String(category.raw_category_id || ''),
          category_name: String(category.category_name || ''),
          type: category.type,
          provider_id: category.provider_id || null,
          provider_name: category.provider_name || null,
        })),
        counts: {
          categories: categories.length,
          streams: streamSummary.total,
          byProvider,
        },
        missingProviderRows,
      };
    } finally {
      db.close();
    }
  });
}

function pickCombinedCategory(snapshot, providerId, type) {
  const providerCategories = snapshot.categories.filter(
    (category) => category.provider_id === providerId && category.type === type,
  );
  return pickCategory(providerCategories, type);
}

async function writePartial(providerResults) {
  const summary = {
    ok: false,
    partial: true,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    config: {
      surfaces: [...ENABLED_SURFACES],
      skipPlayback: SKIP_PLAYBACK,
      onlyCombined: ONLY_COMBINED,
      onlySeparated: ONLY_SEPARATED,
      playbackAttempts: PLAYBACK_ATTEMPTS,
      playbackTimeoutMs: PLAYBACK_TIMEOUT_MS,
    },
    providerResults,
  };
  await fs.writeFile(path.join(OUT_DIR, 'summary.partial.json'), JSON.stringify(summary, null, 2));
}

await fs.mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  const providerResults = [];
  if (!ONLY_COMBINED) for (const provider of PROVIDERS) {
    const { context, page, diagnostics } = await freshPage(browser);
    await loginProvider(page, provider);
    await waitForSyncIdle(page, provider.id);

    const authShape = await authStorageShape(page);
    assert(authShape.providerId === provider.id, `${provider.id} auth selected wrong provider`);
    assert(authShape.mode === 'separated', `${provider.id} auth is not explicitly separated/default mode`);
    assert(!authShape.hasHostUrl && !authShape.hasUsername && !authShape.hasPassword, `${provider.id} leaked provider credentials to browser storage`);

    const surfaceResults = [];
    for (const surface of SURFACES) {
      const cats = await categories(page, provider.id, surface.categoryAction);
      const picked = pickCategory(cats, surface.type);
      const listed = await listItems(page, provider.id, surface.listAction, { category_id: picked.category_id });
      const cardAudit = await auditCards(page, provider, surface, picked);
      const playbackItems = listed.items
        .filter((item) => idOf(item, surface.type) && titleOf(item))
        .slice(0, surface.type === 'movie' ? 24 : 18);
      const playback = SKIP_PLAYBACK
        ? { ok: true, skipped: true, provider: provider.id, surface: surface.type, attempts: [] }
        : await tryPlayback(page, provider, surface, playbackItems);
      surfaceResults.push({
        surface: surface.type,
        category: picked.category_name,
        categoryId: String(picked.category_id),
        catalogTotal: listed.total,
        catalogSampleCount: listed.items.length,
        cardAudit,
        playback,
        ok: cardAudit.ok && playback.ok,
      });
      await writePartial([...providerResults, {
        provider: provider.id,
        authShape,
        surfaces: surfaceResults,
        diagnostics,
        ok: false,
      }]);
    }

    providerResults.push({
      provider: provider.id,
      authShape,
      surfaces: surfaceResults,
      diagnostics,
      ok:
        surfaceResults.every((surface) => surface.ok) &&
        diagnostics.pageErrors.length === 0 &&
        diagnostics.consoleErrors.length === 0,
    });

    await context.close();
  }

  let combinedTaggedResult = { ok: true, skipped: true };
  if (!ONLY_SEPARATED) {
    const { context: combinedContext, page: combinedPage, diagnostics: combinedDiagnostics } = await freshPage(browser);
    await loginProvider(combinedPage, COMBINED_PROVIDER);
    await waitForSyncIdle(combinedPage, COMBINED_PROVIDER.id);
    const combinedAuthShape = await authStorageShape(combinedPage);
    assert(combinedAuthShape.providerId === 'combined-tagged', 'combined mode did not store combined-tagged provider id');
    assert(combinedAuthShape.mode === 'combined-tagged', 'combined mode did not store combined-tagged provider mode');
    assert(
      COMBINED_PROVIDER.expectedProviderIds.every((providerId) => combinedAuthShape.providerIds.includes(providerId)),
      `combined mode providerIds missing expected providers: ${combinedAuthShape.providerIds.join(',')}`,
    );
    assert(
      !combinedAuthShape.hasHostUrl && !combinedAuthShape.hasUsername && !combinedAuthShape.hasPassword,
      'combined mode leaked provider credentials to browser storage',
    );

    const combinedDb = await readIndexedDbShape(combinedPage);
    assert(combinedDb.missingProviderRows.length === 0, 'combined mode stored rows without provider_id');
    for (const provider of PROVIDERS) {
      for (const surface of SURFACES) {
        assert(
          combinedDb.counts.byProvider[provider.id].categories[surface.type] > 0,
          `combined mode has no ${provider.id} ${surface.type} categories`,
        );
        assert(
          combinedDb.counts.byProvider[provider.id].streams[surface.type] > 0,
          `combined mode has no ${provider.id} ${surface.type} streams`,
        );
      }
    }

    const combinedSurfaceResults = [];
    for (const provider of PROVIDERS) {
      for (const surface of SURFACES) {
        const picked = pickCombinedCategory(combinedDb, provider.id, surface.type);
        assert(picked, `combined mode could not pick ${provider.id} ${surface.type} category`);
        assert(
          String(picked.category_name || '').includes(provider.name),
          `combined ${provider.id} ${surface.type} category is not provider-tagged: ${picked.category_name}`,
        );
        const cardAudit = await auditCards(
          combinedPage,
          { id: `combined-${provider.id}`, name: provider.name },
          surface,
          picked,
          { expectProviderTag: true, expectedProviderName: provider.name },
        );
        combinedSurfaceResults.push({
          provider: provider.id,
          surface: surface.type,
          category: picked.category_name,
          categoryId: String(picked.category_id),
          cardAudit,
          ok: cardAudit.ok,
        });
      }
    }
    await combinedContext.close();
    combinedTaggedResult = {
      provider: COMBINED_PROVIDER.id,
      authShape: combinedAuthShape,
      dbCounts: combinedDb.counts,
      missingProviderRows: combinedDb.missingProviderRows,
      surfaces: combinedSurfaceResults,
      diagnostics: combinedDiagnostics,
      ok:
        combinedSurfaceResults.every((result) => result.ok) &&
        combinedDiagnostics.pageErrors.length === 0 &&
        combinedDiagnostics.consoleErrors.length === 0 &&
        combinedDiagnostics.failedRequests.length === 0,
    };
  }

  const distinct = ONLY_COMBINED || (providerResults.length === 2 && (
    providerResults[0].surfaces[0].catalogTotal !== providerResults[1].surfaces[0].catalogTotal ||
    providerResults[0].surfaces[1].catalogTotal !== providerResults[1].surfaces[1].catalogTotal ||
    providerResults[0].surfaces[2].catalogTotal !== providerResults[1].surfaces[2].catalogTotal
  ));

  const summary = {
    ok: distinct && providerResults.every((result) => result.ok),
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    config: {
      surfaces: [...ENABLED_SURFACES],
      skipPlayback: SKIP_PLAYBACK,
      onlyCombined: ONLY_COMBINED,
      onlySeparated: ONLY_SEPARATED,
      playbackAttempts: PLAYBACK_ATTEMPTS,
      playbackTimeoutMs: PLAYBACK_TIMEOUT_MS,
    },
    contract: {
      separateProvidersDistinct: distinct,
      combinedTaggedMode: combinedTaggedResult.ok,
    },
    providerResults,
    combinedTaggedResult,
  };
  summary.ok = summary.ok && summary.combinedTaggedResult.ok;
  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
} finally {
  await browser.close();
}
