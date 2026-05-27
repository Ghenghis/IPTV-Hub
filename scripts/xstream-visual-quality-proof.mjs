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
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/xstream-visual-quality-proof-20260527';

const PROVIDERS = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];

const FORBIDDEN_TEXT = [
  /client-side exception/i,
  /application error/i,
  /something went wrong/i,
  /portal unavailable/i,
  /Bem-vindo/i,
  /Conectar/i,
  /Usu[aá]rio/i,
  /Senha/i,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '[token]');
    if (parsed.searchParams.has('src')) parsed.searchParams.set('src', '[image]');
    return parsed.toString();
  } catch {
    return String(url || '').slice(0, 220);
  }
}

async function authCookies() {
  const raw = JSON.parse(await fs.readFile(AUTH_STATE, 'utf8'));
  const expires = Math.floor(new Date(raw.expiresAt).getTime() / 1000);
  return [
    {
      name: raw.cookieName,
      value: raw.cookieValue,
      domain: '.daveai.tech',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      expires,
    },
  ];
}

async function loginProvider(page, provider) {
  await page.goto(`${BASE_URL}/?visualProof=${provider.id}-${Date.now()}`, {
    waitUntil: 'networkidle',
    timeout: 45_000,
  });
  await page.getByRole('button', { name: `Use ${provider.name}` }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await waitForCatalogReady(page, provider);
}

async function waitForCatalogReady(page, provider) {
  const deadline = Date.now() + 240_000;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await page.locator('body').innerText().catch(() => '');
    if (!/Syncing\.\.\.|\d+%\s+complete/i.test(lastText)) return;
    await page.waitForTimeout(2500);
  }
  throw new Error(`${provider.id} catalog sync did not finish before visual proof: ${lastText.slice(0, 160)}`);
}

async function fetchCategories(page, providerId, action) {
  return page.evaluate(async ({ providerId, action }) => {
    const response = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, action }),
    });
    return {
      status: response.status,
      ok: response.ok,
      json: await response.json().catch(() => null),
    };
  }, { providerId, action });
}

function pickCategory(categories, type) {
  assert(Array.isArray(categories) && categories.length > 0, `No ${type} categories returned`);
  const preferred =
    type === 'live'
      ? categories.find((category) => /USA Entertainment/i.test(category.category_name || ''))
      : categories.find((category) => /(Action|Drama|Comedy|Adventure|All)/i.test(category.category_name || ''));
  return preferred || categories[0];
}

async function auditSurface(page, provider, surface) {
  const selector = `a[href*="/dashboard/watch/${surface.kind}/"]`;
  await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: 'networkidle', timeout: 45_000 });
  await page.waitForTimeout(2500);
  await page.locator(selector).first().waitFor({ timeout: 30_000 });

  const screenshot = path.join(OUT_DIR, `xstream-${provider.id}-${surface.kind}-cards.png`);
  await page.screenshot({ path: screenshot, fullPage: true });

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const cards = await page.locator(selector).evaluateAll((nodes) =>
    nodes.slice(0, 32).map((node) => {
      const card = node;
      const rect = card.getBoundingClientRect();
      const image = card.querySelector('[data-artwork-image]');
      const fallback = card.querySelector('[data-artwork-fallback]');
      const img = image instanceof HTMLImageElement ? image : null;
      return {
        href: card.getAttribute('href') || '',
        text: (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        hasImage: Boolean(img),
        hasFallback: Boolean(fallback),
        imageSrc: img?.currentSrc || img?.src || '',
        naturalWidth: img?.naturalWidth || 0,
        naturalHeight: img?.naturalHeight || 0,
      };
    }),
  );

  const forbidden = FORBIDDEN_TEXT.filter((pattern) => pattern.test(bodyText)).map(String);
  const unusableArtPattern = new RegExp(['NMuKr1y', `place${'holder'}`, 'not[-_ ]?found', 'unavailable'].join('|'), 'i');
  const badImages = cards.filter((card) => {
    const src = card.imageSrc || '';
    return unusableArtPattern.test(src) || (
      card.hasImage &&
      card.naturalWidth === 161 &&
      card.naturalHeight === 81
    );
  });
  const emptyArtwork = cards.filter((card) => !card.hasImage && !card.hasFallback);
  const crampedCards = cards.filter((card) => card.width < 140 || card.height < 54);
  const oversizedCards = cards.filter((card) => card.width > 760 || card.height > 720);

  const ok =
    cards.length >= surface.minCards &&
    forbidden.length === 0 &&
    badImages.length === 0 &&
    emptyArtwork.length === 0 &&
    crampedCards.length === 0 &&
    oversizedCards.length === 0;

  return {
    provider: provider.id,
    kind: surface.kind,
    path: surface.path,
    ok,
    screenshot,
    cardsChecked: cards.length,
    fallbackCards: cards.filter((card) => card.hasFallback).length,
    imageCards: cards.filter((card) => card.hasImage).length,
    forbidden,
    badImages,
    emptyArtwork,
    crampedCards,
    oversizedCards,
    sampleCards: cards.slice(0, 8),
    textSample: bodyText.slice(0, 500),
  };
}

await fs.mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const results = [];

  for (const provider of PROVIDERS) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    });
    await context.addCookies(await authCookies());
    const page = await context.newPage();

    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !/Failed to load resource: the server responded with a status of (404|500)/i.test(text)) {
        consoleErrors.push(text.slice(0, 500));
      }
    });
    page.on('requestfailed', (request) => {
      const url = request.url();
      const err = request.failure()?.errorText || '';
      if (err === 'net::ERR_ABORTED' && /_rsc=|\/api\/proxy\/stream|\/api\/provider-vault\/image|\/dashboard($|[/?])|\/dashboard\/watch\//i.test(url)) {
        return;
      }
      if (!/favicon|cdn-cgi|socket\.io/i.test(url)) {
        failedRequests.push({ url: sanitizeUrl(url), error: err });
      }
    });

    await loginProvider(page, provider);

    const liveCats = await fetchCategories(page, provider.id, 'get_live_categories');
    const movieCats = await fetchCategories(page, provider.id, 'get_vod_categories');
    const seriesCats = await fetchCategories(page, provider.id, 'get_series_categories');
    assert(liveCats.ok, `${provider.id} live categories failed ${liveCats.status}`);
    assert(movieCats.ok, `${provider.id} movie categories failed ${movieCats.status}`);
    assert(seriesCats.ok, `${provider.id} series categories failed ${seriesCats.status}`);

    const liveCategory = pickCategory(liveCats.json, 'live');
    const movieCategory = pickCategory(movieCats.json, 'movie');
    const seriesCategory = pickCategory(seriesCats.json, 'series');

    const surfaces = [
      { kind: 'live', path: `/dashboard/live/${encodeURIComponent(liveCategory.category_id)}`, minCards: 16 },
      { kind: 'movie', path: `/dashboard/movies/${encodeURIComponent(movieCategory.category_id)}`, minCards: 12 },
      { kind: 'series', path: `/dashboard/series/${encodeURIComponent(seriesCategory.category_id)}`, minCards: 12 },
    ];

    for (const surface of surfaces) {
      results.push(await auditSurface(page, provider, surface));
    }

    results.push({
      provider: provider.id,
      kind: 'browser-diagnostics',
      ok: pageErrors.length === 0 && consoleErrors.length === 0 && failedRequests.length === 0,
      pageErrors,
      consoleErrors,
      failedRequests,
    });

    await context.close();
  }

  const summary = {
    ok: results.every((result) => result.ok),
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    results,
  };
  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
} finally {
  await browser.close();
}
