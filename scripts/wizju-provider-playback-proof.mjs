import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.WIZJU_BASE || 'https://wizju-iptv-player.daveai.tech/';
const AUTH_STATE =
  process.env.AUTH_STATE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/wizju-provider-playback-proof-20260527';

const PROVIDERS = [
  { id: 'apollo', name: 'Apollo Group TV', sourceId: 'daveai-vault-apollo' },
  { id: 'xtremehd', name: 'XtremeHD', sourceId: 'daveai-vault-xtremehd' },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizeUrl(value) {
  try {
    const parsed = new URL(value);
    for (const key of ['src', 'token', 'username', 'password', 'url']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, `[${key}]`);
    }
    return parsed.toString();
  } catch {
    return String(value || '').slice(0, 180);
  }
}

async function addAuthCookie(context) {
  const raw = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt
    ? Math.floor(new Date(raw.expiresAt).getTime() / 1000)
    : undefined;
  await context.addCookies([
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: 'wizju-iptv-player.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ]);
}

function isAllowedConsole(message) {
  const text = message.text();
  return (
    /Database is missing required stores/i.test(text) ||
    /favicon/i.test(text) ||
    /ResizeObserver/i.test(text)
  );
}

async function bodyText(page) {
  return page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
}

async function dbSnapshot(page) {
  return page.evaluate(async () => {
    const dbs = (await indexedDB.databases?.().catch(() => [])) || [];
    const target = dbs.find((db) => db.name === 'WizjuIPTVDB');
    if (!target?.name) return { found: false, sources: [], samples: [], itemCount: 0 };

    return new Promise((resolve) => {
      const request = indexedDB.open(target.name);
      request.onerror = () => resolve({ found: false, error: String(request.error || 'open failed') });
      request.onsuccess = () => {
        const db = request.result;
        const result = { found: true, sources: [], samples: [], itemCount: 0 };

        const tasks = [];
        if (db.objectStoreNames.contains('streamSources')) {
          tasks.push(new Promise((done) => {
            const tx = db.transaction('streamSources', 'readonly');
            const get = tx.objectStore('streamSources').getAll();
            get.onsuccess = () => {
              result.sources = (get.result || []).map((source) => ({
                id: source.id,
                name: source.name,
                url: source.url,
                isActive: source.isActive,
                categoryCount: Array.isArray(source.categories) ? source.categories.length : 0,
              }));
              done();
            };
            get.onerror = () => done();
          }));
        }

        if (db.objectStoreNames.contains('m3uMediaItems')) {
          tasks.push(new Promise((done) => {
            const tx = db.transaction('m3uMediaItems', 'readonly');
            const store = tx.objectStore('m3uMediaItems');
            const count = store.count();
            const get = store.getAll();
            count.onsuccess = () => {
              result.itemCount = count.result || 0;
            };
            get.onsuccess = () => {
              result.samples = (get.result || []).map((item) => ({
                id: item.id,
                title: item.title,
                sourceId: item.sourceId,
                type: item.type,
                url: item.url,
                thumbnail: item.thumbnail,
              }));
              done();
            };
            get.onerror = () => done();
          }));
        }

        Promise.all(tasks).then(() => {
          db.close();
          resolve(result);
        });
      };
    });
  });
}

async function verifyImageFallback(context) {
  const response = await context.request.get(
    `${BASE}api/provider-vault/image?src=https%3A%2F%2Fexample.com%2Fmissing-davetv-artwork.png`,
    { timeout: 30_000 },
  );
  return {
    status: response.status(),
    contentType: response.headers()['content-type'] || '',
    fallback: response.headers()['x-davetv-image-fallback'] || '',
    textStart: (await response.text()).slice(0, 80),
  };
}

async function runProvider(page, provider, seen) {
  await page.goto(`${BASE}?provider=${provider.id}&proof=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(18_000);

  await page.getByRole('button', { name: provider.name }).click({ timeout: 20_000 });
  await page.waitForURL(/#\/live/, { timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const text = await bodyText(page);
  assert(text.includes(`Source: ${provider.name}`), `${provider.name} source did not load`);
  assert(text.includes('USA AMC'), `${provider.name} did not show USA AMC`);
  assert(!/No media|No results|Something went wrong|Application Error/i.test(text), `${provider.name} rendered an error state`);

  const snapshot = await dbSnapshot(page);
  assert(snapshot.found, 'Wizju IndexedDB not found');
  assert(
    snapshot.sources.some((source) => source.id === provider.sourceId && source.isActive),
    `${provider.name} source not persisted as active`,
  );
  assert(
    snapshot.samples.some((item) => item.sourceId === provider.sourceId && item.url?.startsWith('/api/provider-vault/stream')),
    `${provider.name} samples do not use safe provider-vault stream URLs`,
  );

  await page.screenshot({
    path: path.join(OUT_DIR, `wizju-${provider.id}-catalog.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Watch Live' }).first().click({ timeout: 20_000 });
  await page.waitForURL(/#\/media/, { timeout: 30_000 });
  await page.waitForTimeout(2_000);

  const detailText = await bodyText(page);
  assert(detailText.includes('USA AMC'), `${provider.name} media detail did not open USA AMC`);
  assert(detailText.includes('/api/provider-vault/stream?'), `${provider.name} detail source is not provider-vault`);
  assert(!/player_api|username=|password=|\/live\/[^/\s]+\/[^/\s]+/i.test(detailText), `${provider.name} leaked raw provider URL text`);

  await page.screenshot({
    path: path.join(OUT_DIR, `wizju-${provider.id}-detail.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: /Play Now|Play/i }).first().click({ timeout: 20_000 });
  await page.waitForSelector('video', { timeout: 30_000 });
  await page
    .waitForFunction(() => {
      const video = document.querySelector('video');
      return Boolean(video && video.readyState >= 2 && !video.error);
    }, null, { timeout: 75_000 });
  await page.waitForTimeout(5_000);

  const video = await page.evaluate(() => {
    const el = document.querySelector('video');
    if (!el) return null;
    const buffered = [];
    for (let index = 0; index < el.buffered.length; index += 1) {
      buffered.push([el.buffered.start(index), el.buffered.end(index)]);
    }
    return {
      readyState: el.readyState,
      networkState: el.networkState,
      paused: el.paused,
      currentSrcKind: el.currentSrc?.startsWith('blob:') ? 'blob' : 'url',
      width: el.videoWidth,
      height: el.videoHeight,
      buffered,
      error: el.error ? { code: el.error.code, message: el.error.message } : null,
    };
  });

  assert(video?.readyState >= 2, `${provider.name} video never became playable`);
  assert(!video.error, `${provider.name} video error: ${JSON.stringify(video.error)}`);
  assert(video.width >= 640 && video.height >= 360, `${provider.name} video dimensions too small`);
  assert(
    seen.providerResponses.some((response) =>
      response.status === 200 &&
      response.url.includes('/api/provider-vault/stream') &&
      response.url.includes(`provider=${provider.id}`),
    ),
    `${provider.name} did not request provider-vault stream successfully`,
  );
  assert(
    seen.providerResponses.some((response) =>
      response.status === 200 &&
      (response.url.includes('/api/provider-vault/segment') || response.url.includes('/api/provider-vault/aac-hls')),
    ),
    `${provider.name} did not request provider-vault media segments successfully`,
  );

  await page.screenshot({
    path: path.join(OUT_DIR, `wizju-${provider.id}-player.png`),
    fullPage: true,
  });

  return {
    provider: provider.id,
    source: provider.name,
    snapshot: {
      sourceCount: snapshot.sources.length,
      itemCount: snapshot.itemCount,
      samples: snapshot.samples.filter((item) => item.sourceId === provider.sourceId).slice(0, 3),
    },
    video,
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
});
await addAuthCookie(context);

const page = await context.newPage();
const seen = {
  pageErrors: [],
  consoleMessages: [],
  providerResponses: [],
  badResponses: [],
};

page.on('pageerror', (error) => {
  seen.pageErrors.push(String(error.message || error).slice(0, 500));
});
page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type()) && !isAllowedConsole(message)) {
    seen.consoleMessages.push({ type: message.type(), text: message.text().slice(0, 700) });
  }
});
page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/api/provider-vault/')) {
    seen.providerResponses.push({ status: response.status(), url: sanitizeUrl(url) });
  }
  if (response.status() >= 400 && /wizju-iptv-player\.daveai\.tech/.test(url)) {
    seen.badResponses.push({ status: response.status(), url: sanitizeUrl(url) });
  }
});

const results = [];
let imageFallback = null;
try {
  imageFallback = await verifyImageFallback(context);
  assert(imageFallback.status === 200, `image fallback returned ${imageFallback.status}`);
  assert(imageFallback.fallback === '1', 'image fallback header missing');
  assert(/image\/svg\+xml/i.test(imageFallback.contentType), 'image fallback did not return SVG');

  for (const provider of PROVIDERS) {
    results.push(await runProvider(page, provider, seen));
  }
} finally {
  await browser.close();
}

const blockingBadResponses = seen.badResponses.filter((response) => {
  if (/favicon/i.test(response.url)) return false;
  return true;
});

const summary = {
  ok:
    results.length === PROVIDERS.length &&
    results.every((result) => result.video?.readyState >= 2 && !result.video?.error) &&
    seen.pageErrors.length === 0 &&
    seen.consoleMessages.length === 0 &&
    blockingBadResponses.length === 0,
  generatedAt: new Date().toISOString(),
  baseUrl: BASE,
  imageFallback,
  results,
  providerResponses: seen.providerResponses,
  pageErrors: seen.pageErrors,
  consoleMessages: seen.consoleMessages,
  badResponses: blockingBadResponses,
  artifacts: {
    apolloCatalog: path.join(OUT_DIR, 'wizju-apollo-catalog.png'),
    apolloPlayer: path.join(OUT_DIR, 'wizju-apollo-player.png'),
    xtremehdCatalog: path.join(OUT_DIR, 'wizju-xtremehd-catalog.png'),
    xtremehdPlayer: path.join(OUT_DIR, 'wizju-xtremehd-player.png'),
  },
};

fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

if (!summary.ok) process.exitCode = 1;
