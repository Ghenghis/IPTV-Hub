import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/iptvnator-provider-proof-20260527';
const cookiePath =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const baseUrl = 'https://iptvnator.daveai.tech';
const staleXtreamId = '0c911b96-4d88-45f4-bcf9-c71586cf0428';
const expectedBuildId = '20260527-v7';

const providers = [
  { id: 'xtremehd', title: 'XtremeHD', route: '/workspace/playlists/daveai-provider-vault-xtremehd/all' },
  { id: 'apollo', title: 'Apollo Group TV', route: '/workspace/playlists/daveai-provider-vault-apollo/all' },
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

async function seedStaleXtreamState(page) {
  await page.goto(`${baseUrl}/?proof-seed=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(1200);
  await page.evaluate(async ({ staleXtreamId }) => {
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
    localStorage.removeItem('iptvnator_provider_vault_seeded');
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
  }, { staleXtreamId });
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

async function waitForProviderReady(page, provider, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  const expectedTitle = `${provider.title} - DaveAI Vault`;
  const expectedId = `daveai-provider-vault-${provider.id}`;
  while (Date.now() < deadline) {
    latest = await readState(page);
    const rows = Array.isArray(latest.dbRows) ? latest.dbRows : [];
    const row = rows.find((item) => item.id === expectedId && item.itemCount > 0);
    if (
      latest.buildId === expectedBuildId &&
      latest.seeded === expectedBuildId &&
      row &&
      latest.xtreamPlaylists === '[]' &&
      !latest.hasStaleId &&
      latest.text.includes(expectedTitle) &&
      /USA AMC/i.test(latest.text)
    ) {
      return latest;
    }
    await page.waitForTimeout(2000);
  }
  return latest || readState(page);
}

async function playFirstVisibleChannel(page, provider) {
  const before = Date.now();
  const target = page.getByText('USA AMC', { exact: false }).first();
  await target.click({ timeout: 30000 });
  await page.waitForTimeout(9000);
  const video = await page.evaluate(() => {
    const el = document.querySelector('video');
    return el
      ? {
          readyState: el.readyState,
          networkState: el.networkState,
          paused: el.paused,
          currentSrcKind: el.currentSrc ? (el.currentSrc.startsWith('blob:') ? 'blob' : 'url') : '',
          error: el.error ? { code: el.error.code, message: el.error.message } : null,
        }
      : null;
  });
  return { provider: provider.id, elapsedMs: Date.now() - before, video };
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, ignoreHTTPSErrors: true });
await context.addCookies(await readAuthCookie());

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
  if (url.includes('/api/provider-vault/stream')) {
    streamResponses.push({ status: response.status(), url: sanitizeUrl(url) });
  }
  if (response.status() >= 400 && /iptvnator\.daveai\.tech/.test(url)) {
    badResponses.push({ status: response.status(), url: sanitizeUrl(url) });
  }
});

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
const ok =
  staleMigration.buildId === expectedBuildId &&
  staleMigration.seeded === expectedBuildId &&
  staleMigration.xtreamPlaylists === '[]' &&
  !staleMigration.hasStaleId &&
  !/Portal unavailable/i.test(visibleText) &&
  !hasCredentialText &&
  playback.every((item) =>
    new RegExp(`${item.provider === 'xtremehd' ? 'XtremeHD' : 'Apollo Group TV'} - DaveAI Vault`, 'i').test(item.state.text) &&
    /USA AMC/i.test(item.state.text) &&
    item.play.video &&
    item.play.video.readyState >= 2 &&
    !item.play.video.error
  ) &&
  streamResponses.filter((item) => item.status === 200).length >= 2 &&
  pageErrors.length === 0 &&
  consoleErrors.length === 0;

const summary = {
  ok,
  generatedAt: new Date().toISOString(),
  expectedBuildId,
  staleMigration,
  playback,
  streamResponses,
  badResponses,
  pageErrors,
  consoleErrors,
  hasCredentialText,
  artifacts: {
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
