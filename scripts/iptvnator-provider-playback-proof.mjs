import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/iptvnator-provider-proof-20260528';
const cookiePath =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const baseUrl = 'https://iptvnator.daveai.tech';
const staleXtreamId = '0c911b96-4d88-45f4-bcf9-c71586cf0428';
const expectedBuildId = '20260528-v15';

const providers = [
  {
    id: 'xtremehd',
    title: 'XtremeHD',
    route: '/workspace/playlists/daveai-provider-vault-xtremehd/all',
    readyPattern: /USA AMC/i,
    playPatterns: [/USA AMC/i, /USA A&E UHD/i, /USA AccuWeather/i],
    requiresUiPlayback: true,
  },
  {
    id: 'apollo',
    title: 'Apollo Group TV',
    route: '/workspace/playlists/daveai-provider-vault-apollo/all',
    readyPattern: /\|US\| NBC|\|US\| FOX|\|US\| ABC|\|US\| CBS/i,
    playPatterns: [/\|US\| FOX 15/i, /\|US\| NBC 9/i, /\|US\| ABC 10/i, /\|US\| CBS 6/i],
    requiresUiPlayback: true,
  },
];

const mediaProbeTargets = [
  {
    id: 'xtremehd-live-amc',
    provider: 'xtremehd',
    kind: 'live',
    streamId: '175787',
    ext: 'm3u8',
    expectOk: true,
    expectMediaType: 'mpegts',
  },
  {
    id: 'xtremehd-movie-first',
    provider: 'xtremehd',
    kind: 'movie',
    streamId: '821352',
    ext: 'mp4',
    expectOk: true,
    expectMediaType: 'mp4',
  },
  {
    id: 'apollo-movie-guardians',
    provider: 'apollo',
    kind: 'movie',
    streamId: '8479',
    ext: 'mkv',
    expectOk: true,
    expectMediaType: 'mp4',
  },
  {
    id: 'apollo-live-english-fox-local',
    provider: 'apollo',
    kind: 'live',
    streamId: '829780',
    ext: 'm3u8',
    expectOk: true,
    expectMediaType: 'mpegts',
  },
];

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('provider')) parsed.searchParams.set('provider', '[provider]');
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '[token]');
    return parsed.toString();
  } catch {
    return String(url || '').slice(0, 120);
  }
}

async function readAuthCookie() {
  const raw = JSON.parse(await fs.readFile(cookiePath, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt ? Math.floor(new Date(raw.expiresAt).getTime() / 1000) : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: 'iptvnator.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

async function apiGetJson(context, pathAndQuery) {
  const response = await context.request.get(`${baseUrl}${pathAndQuery}`, { timeout: 45000 });
  const bodyText = await response.text();
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText.slice(0, 600) };
  }
  return {
    status: response.status(),
    ok: response.ok(),
    body,
  };
}

async function runMediaProbes(context) {
  const results = [];
  for (const target of mediaProbeTargets) {
    const params = new URLSearchParams({
      provider: target.provider,
      kind: target.kind,
      id: target.streamId,
      ext: target.ext,
    });
    const started = Date.now();
    const result = await apiGetJson(context, `/api/provider-vault/probe?${params.toString()}`);
    results.push({
      ...target,
      elapsedMs: Date.now() - started,
      status: result.status,
      body: result.body,
      pass:
        result.status === 200 &&
        result.body &&
        result.body.ok === target.expectOk &&
        (!target.expectMediaType || result.body.mediaType === target.expectMediaType) &&
        (!target.expectReason || result.body.reason === target.expectReason),
    });
  }
  return results;
}

async function seedStaleXtreamState(page) {
  await page.goto(`${baseUrl}/?proof-seed=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(1200);
  await page.evaluate(async ({ staleXtreamId, expectedBuildId }) => {
    localStorage.setItem(
      'xtream-playlists',
      JSON.stringify([
        {
          id: staleXtreamId,
          title: 'XtremeHD',
          serverUrl: 'http://example.invalid',
          username: 'redacted',
          password: 'redacted',
        },
      ])
    );
    localStorage.setItem('iptvnator_provider_vault_seeded', expectedBuildId);
    sessionStorage.clear();

    await new Promise((resolve, reject) => {
      const request = indexedDB.open('iptvnator');
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('playlists')) {
          db.createObjectStore('playlists', { keyPath: '_id', autoIncrement: false });
        }
      };
      request.onerror = () => reject(request.error || new Error('open failed'));
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('playlists', 'readwrite');
        const store = tx.objectStore('playlists');
        [
          ['daveai-provider-vault-xtremehd', 'XtremeHD'],
          ['daveai-provider-vault-apollo', 'Apollo Group TV'],
        ].forEach(([id, title]) => {
          store.put({
            _id: id,
            title: `${title} - DaveAI Vault`,
            filename: `${title} - DaveAI Vault`,
            source: 'daveai-provider-vault',
            providerId: id.replace('daveai-provider-vault-', ''),
            daveaiBuildId: expectedBuildId,
            count: 0,
            playlist: { items: [] },
          });
        });
        store.put({
          _id: staleXtreamId,
          title: 'XtremeHD',
          filename: 'XtremeHD',
          source: 'xtream',
          serverUrl: 'http://example.invalid',
          count: 0,
          playlist: { items: [] },
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error || new Error('tx failed'));
        };
      };
    });
  }, { staleXtreamId, expectedBuildId });
}

async function wipeBrowserState(page) {
  await page.goto(`${baseUrl}/?proof-wipe=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('iptvnator');
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  });
}

async function readState(page) {
  return page.evaluate(async ({ staleXtreamId }) => {
    const dbRows = await new Promise((resolve) => {
      const request = indexedDB.open('iptvnator');
      request.onerror = () => resolve({ error: String(request.error || 'open failed') });
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('playlists')) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction('playlists', 'readonly');
        const get = tx.objectStore('playlists').getAll();
        get.onsuccess = () => {
          const rows = (get.result || []).map((row) => ({
            id: row._id || row.id,
            title: row.title || row.filename,
            source: row.source,
            providerId: row.providerId,
            daveaiBuildId: row.daveaiBuildId,
            hasServerUrl: Boolean(row.serverUrl),
            count: row.count,
            itemCount: row.playlist && Array.isArray(row.playlist.items) ? row.playlist.items.length : 0,
            firstNames: row.playlist && Array.isArray(row.playlist.items)
              ? row.playlist.items.slice(0, 20).map((item) => item.name || item.title || '').filter(Boolean)
              : [],
          }));
          db.close();
          resolve(rows);
        };
        get.onerror = () => {
          db.close();
          resolve({ error: String(get.error || 'get failed') });
        };
      };
    });

    return {
      href: location.href,
      buildId: window.IPTVnatorDaveAIProviderVault && window.IPTVnatorDaveAIProviderVault.buildId,
      text: document.body.innerText.slice(0, 3000),
      seeded: localStorage.getItem('iptvnator_provider_vault_seeded'),
      xtreamPlaylists: localStorage.getItem('xtream-playlists'),
      preempted: sessionStorage.getItem('iptvnator_provider_vault_preempted_xtream'),
      dbRows,
      hasStaleId: JSON.stringify(dbRows).includes(staleXtreamId),
    };
  }, { staleXtreamId });
}

async function waitForColdProviderSeed(page, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    try {
      latest = await readState(page);
    } catch (error) {
      await page.waitForTimeout(1000);
      continue;
    }
    const rows = Array.isArray(latest.dbRows) ? latest.dbRows : [];
    const apollo = rows.find((item) => item.id === 'daveai-provider-vault-apollo');
    const xtremehd = rows.find((item) => item.id === 'daveai-provider-vault-xtremehd');
    if (
      latest.buildId === expectedBuildId &&
      latest.seeded === expectedBuildId &&
      apollo &&
      apollo.itemCount > 0 &&
      xtremehd &&
      xtremehd.itemCount > 0 &&
      !/Portal unavailable/i.test(latest.text)
    ) {
      return latest;
    }
    await page.waitForTimeout(2000);
  }
  return latest || readState(page);
}

async function waitForProviderReady(page, provider, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  const expectedTitle = `${provider.title} - DaveAI Vault`;
  const expectedId = `daveai-provider-vault-${provider.id}`;
  while (Date.now() < deadline) {
    try {
      latest = await readState(page);
    } catch (error) {
      await page.waitForTimeout(1000);
      continue;
    }
    const rows = Array.isArray(latest.dbRows) ? latest.dbRows : [];
    const row = rows.find((item) => item.id === expectedId && item.itemCount > 0);
    if (
      latest.buildId === expectedBuildId &&
      latest.seeded === expectedBuildId &&
      row &&
      latest.xtreamPlaylists === '[]' &&
      !latest.hasStaleId &&
      latest.text.includes(expectedTitle) &&
      provider.readyPattern.test(latest.text)
    ) {
      return latest;
    }
    await page.waitForTimeout(2000);
  }
  return latest || readState(page);
}

async function playFirstVisibleChannel(page, provider) {
  const before = Date.now();
  const attempts = [];

  async function readVideo() {
    return page.evaluate(() => {
    const el = document.querySelector('video');
    return el
      ? {
          readyState: el.readyState,
          networkState: el.networkState,
          paused: el.paused,
          muted: el.muted,
          volume: el.volume,
          currentSrcKind: el.currentSrc ? (el.currentSrc.startsWith('blob:') ? 'blob' : 'url') : '',
          error: el.error ? { code: el.error.code, message: el.error.message } : null,
        }
      : null;
    });
  }

  for (const pattern of provider.playPatterns) {
    const target = page.getByText(pattern).first();
    const count = await target.count().catch(() => 0);
    if (!count) {
      attempts.push({ pattern: String(pattern), found: false });
      continue;
    }

    await target.click({ timeout: 30000 });
    let video = null;
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(1000);
      video = await readVideo();
      if (video?.readyState >= 2 && !video.error && video.muted === false && video.volume > 0) {
        return {
          provider: provider.id,
          target: String(pattern),
          attempts,
          elapsedMs: Date.now() - before,
          video,
        };
      }
      if (video?.error) break;
    }
    attempts.push({ pattern: String(pattern), found: true, video });
  }

  return {
    provider: provider.id,
    target: '',
    attempts,
    elapsedMs: Date.now() - before,
    video: await readVideo(),
  };
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, ignoreHTTPSErrors: true });
await context.addCookies(await readAuthCookie());
const mediaProbes = await runMediaProbes(context);

const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
const streamResponses = [];

page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 600));
});
page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/api/provider-vault/stream') || url.includes('/api/provider-vault/aac-hls')) {
    streamResponses.push({ status: response.status(), url: sanitizeUrl(url) });
  }
  if (response.status() >= 400 && /iptvnator\.daveai\.tech/.test(url)) {
    badResponses.push({ status: response.status(), url: sanitizeUrl(url) });
  }
});

await wipeBrowserState(page);
await page.goto(`${baseUrl}/?cold-proof=${Date.now()}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
const coldSeed = await waitForColdProviderSeed(page);
await page.screenshot({ path: path.join(outDir, 'iptvnator-cold-provider-seed.png'), fullPage: true });

await wipeBrowserState(page);
await seedStaleXtreamState(page);
await page.goto(`${baseUrl}/workspace/xtreams/${staleXtreamId}/vod?proof=${Date.now()}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForURL(/\/workspace\/playlists\/daveai-provider-vault-xtremehd\/all/, { timeout: 60000 });
const staleMigration = await waitForProviderReady(page, providers[0]);
await page.screenshot({ path: path.join(outDir, 'iptvnator-xtremehd-v5-migration.png'), fullPage: true });

const playback = [];
for (const provider of providers) {
  await page.goto(`${baseUrl}${provider.route}?proof=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  const state = await waitForProviderReady(page, provider);
  await page.screenshot({
    path: path.join(outDir, `iptvnator-${provider.id}-catalog.png`),
    fullPage: true,
  });
  const play = await playFirstVisibleChannel(page, provider);
  await page.screenshot({
    path: path.join(outDir, `iptvnator-${provider.id}-playback.png`),
    fullPage: true,
  });
  playback.push({ provider: provider.id, state, play });
}

const visibleText = `${staleMigration.text}\n${playback.map((item) => item.state.text).join('\n')}`;
const hasCredentialText = /https?:\/\/[^ \n]*(username|password|type=m3u|player_api|live\/[^/\s]+\/[^/\s]+)/i.test(visibleText);
function rowSignature(rows, providerId) {
  const row = Array.isArray(rows)
    ? rows.find((item) => item.id === `daveai-provider-vault-${providerId}`)
    : null;
  return row && Array.isArray(row.firstNames) ? row.firstNames.join('|') : '';
}
const apolloSignature = rowSignature(playback.find((item) => item.provider === 'apollo')?.state.dbRows, 'apollo');
const xtremeSignature = rowSignature(playback.find((item) => item.provider === 'xtremehd')?.state.dbRows, 'xtremehd');
const separatedProviders = Boolean(apolloSignature && xtremeSignature && apolloSignature !== xtremeSignature);
const ok =
  coldSeed.buildId === expectedBuildId &&
  coldSeed.seeded === expectedBuildId &&
  Array.isArray(coldSeed.dbRows) &&
  coldSeed.dbRows.filter((item) => item.source === 'daveai-provider-vault' && item.itemCount > 0).length >= 2 &&
  staleMigration.buildId === expectedBuildId &&
  staleMigration.seeded === expectedBuildId &&
  staleMigration.xtreamPlaylists === '[]' &&
  !staleMigration.hasStaleId &&
  !/Portal unavailable/i.test(visibleText) &&
  !hasCredentialText &&
  playback.every((item) =>
    new RegExp(`${item.provider === 'xtremehd' ? 'XtremeHD' : 'Apollo Group TV'} - DaveAI Vault`, 'i').test(item.state.text) &&
    providers.find((provider) => provider.id === item.provider)?.readyPattern.test(item.state.text) &&
    (
      !providers.find((provider) => provider.id === item.provider)?.requiresUiPlayback ||
      (
        item.play.video &&
        item.play.video.readyState >= 2 &&
        !item.play.video.error
      )
    )
  ) &&
  mediaProbes.every((item) => item.pass) &&
  separatedProviders &&
  streamResponses.filter((item) => item.status === 200).length >= 1 &&
  pageErrors.length === 0 &&
  consoleErrors.length === 0;

const summary = {
  ok,
  generatedAt: new Date().toISOString(),
  expectedBuildId,
  coldSeed,
  staleMigration,
  playback,
  mediaProbes,
  streamResponses,
  badResponses,
  pageErrors,
  consoleErrors,
  hasCredentialText,
  separatedProviders,
  providerSignatures: {
    apollo: apolloSignature,
    xtremehd: xtremeSignature,
  },
  artifacts: {
    coldSeed: path.join(outDir, 'iptvnator-cold-provider-seed.png'),
    migration: path.join(outDir, 'iptvnator-xtremehd-v5-migration.png'),
    xtremeCatalog: path.join(outDir, 'iptvnator-xtremehd-catalog.png'),
    xtremePlayback: path.join(outDir, 'iptvnator-xtremehd-playback.png'),
    apolloCatalog: path.join(outDir, 'iptvnator-apollo-catalog.png'),
    apolloPlayback: path.join(outDir, 'iptvnator-apollo-playback.png'),
  },
};

await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    {
      ok,
      expectedBuildId,
      finalUrl: staleMigration.href,
      stream200: streamResponses.filter((item) => item.status === 200).length,
      pageErrors: pageErrors.length,
      consoleErrors: consoleErrors.length,
      hasCredentialText,
      outDir,
    },
    null,
    2
  )
);

await browser.close();
process.exit(ok ? 0 : 1);
