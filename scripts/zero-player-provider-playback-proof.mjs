import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir = 'C:/Users/Admin/Downloads/VPS/_visual_artifacts/zero-player-provider-proof-20260527';
const cookiePath =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const appUrl = 'https://apps.daveai.tech/iptv-player-zero/?proof=' + Date.now();
const buildId = '20260527-free-provider22';
const providers = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('provider')) parsed.searchParams.set('provider', '[provider]');
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '[token]');
    if (parsed.searchParams.has('src')) parsed.searchParams.set('src', '[image]');
    return parsed.toString();
  } catch {
    return String(url || '').slice(0, 160);
  }
}

async function authCookies() {
  const raw = JSON.parse(await fs.readFile(cookiePath, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt ? Math.floor(new Date(raw.expiresAt).getTime() / 1000) : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: 'apps.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

async function resetPlayerState(page) {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(async (buildId) => {
    localStorage.removeItem('ipz_provider_quickstart_hidden');
    localStorage.removeItem('ipz_provider_autoload_build_id');
    localStorage.removeItem('ipz_default_playlist_id');
    localStorage.removeItem('ipz_provider_quickstart_last_playlist_id');
    localStorage.removeItem('ipz_playlist_enabled_by_id');
    localStorage.removeItem('ipz_playlist_enabled_by_id_premium');
    localStorage.removeItem('ipz_playlist_display_order_ids');
    localStorage.removeItem('ipz_playlist_display_order_ids_premium');
    const dbNames = ['ipz-db', 'iptv_player_zero', 'iptv-player-zero'];
    for (const dbName of dbNames) {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
    }
  }, buildId);
}

async function waitForBothProviderRows(page) {
  await page.waitForFunction(
    () => window.Store && typeof window.Store.getChannels === 'function',
    { timeout: 30000 }
  );
  await page.waitForFunction(
    async () => {
      const ids = ['daveai-provider-apollo', 'daveai-provider-xtremehd'];
      const counts = await Promise.all(ids.map(async (id) => {
        try {
          const channels = await window.Store.getChannels(id);
          return Array.isArray(channels) ? channels.length : 0;
        } catch (error) {
          return 0;
        }
      }));
      return counts.every((count) => count >= 1000);
    },
    { timeout: 120000 }
  );
}

async function waitForSetupIdle(page) {
  await page.waitForFunction(
    (id) => localStorage.getItem('ipz_provider_autoload_build_id') === id,
    buildId,
    { timeout: 120000 }
  );
  await page.waitForTimeout(2000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
}

async function waitForProviderVisible(page, provider) {
  await page.waitForFunction(
    (name) => {
      const text = document.body.innerText || '';
      return (
        text.includes(name) &&
        /All channels/i.test(text) &&
        /(?:^|\n)\s*(?:2,?200|2200)\s*(?:\n|$)/i.test(text) &&
        /USA Entertainment/i.test(text)
      );
    },
    provider.name,
    { timeout: 60000 }
  );
}

async function activateProvider(page, provider) {
  const playlistId = `daveai-provider-${provider.id}`;
  await page.evaluate((id) => {
    const enabled = { [id]: true };
    localStorage.setItem('ipz_default_playlist_id', id);
    localStorage.setItem('ipz_provider_quickstart_last_playlist_id', id);
    localStorage.setItem('ipz_provider_quickstart_hidden', '1');
    localStorage.setItem('ipz_playlist_enabled_by_id', JSON.stringify(enabled));
    localStorage.setItem('ipz_playlist_enabled_by_id_premium', JSON.stringify(enabled));
    localStorage.setItem('ipz_playlist_display_order_ids', JSON.stringify([id]));
    localStorage.setItem('ipz_playlist_display_order_ids_premium', JSON.stringify([id]));
  }, playlistId);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForProviderVisible(page, provider);
}

async function inspectPlayer(page) {
  return page.evaluate(async () => {
    const text = document.body.innerText;
    const videos = Array.from(document.querySelectorAll('video')).map((video) => ({
      readyState: video.readyState,
      networkState: video.networkState,
      paused: video.paused,
      currentSrcKind: video.currentSrc
        ? video.currentSrc.startsWith('/api/provider-vault') || video.currentSrc.includes('/api/provider-vault')
          ? 'provider-vault'
          : video.currentSrc.startsWith('blob:')
            ? 'blob'
            : 'other'
        : '',
      width: video.videoWidth,
      height: video.videoHeight,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
    }));
    const storage = {
      enabled: localStorage.getItem('ipz_playlist_enabled_by_id_premium') || localStorage.getItem('ipz_playlist_enabled_by_id'),
      order: localStorage.getItem('ipz_playlist_display_order_ids_premium') || localStorage.getItem('ipz_playlist_display_order_ids'),
      defaultPlaylist: localStorage.getItem('ipz_default_playlist_id'),
    };
    return {
      href: location.href,
      textSample: text.slice(0, 3500),
      hasUpgradeText: /\b(upgrade to pro|lifetime unlock|\$12\.99|stripe|purchase|72-hour pro trial|free mode)\b/i.test(text),
      hasFreePro: /FREE PRO|PRO/i.test(text),
      hasTypeError: /TypeError|Cannot read properties|client-side exception/i.test(text),
      hasAllChannelsZero: /All channels\s+0/i.test(text),
      hasProviderChannels: /All channels/i.test(text) && /(?:^|\n)\s*(?:2,?200|2200)\s*(?:\n|$)/i.test(text),
      hasLiveSelection: /LIVE:\s*USA AMC|USA AMC/i.test(text),
      storage,
      videos,
    };
  });
}

function videoReachedPlayback(video) {
  return (
    video &&
    !video.error &&
    video.currentSrcKind === 'provider-vault' &&
    video.width > 0 &&
    video.height > 0 &&
    video.readyState >= 1
  );
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];

for (const provider of providers) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.addCookies(await authCookies());
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const badResponses = [];
  const streamResponses = [];

  page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !/set_preview_bounds/.test(text)) {
      consoleErrors.push(text.slice(0, 600));
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/provider-vault/stream') || url.includes('/api/provider-vault/segment')) {
      streamResponses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
    if (response.status() >= 400 && /apps\.daveai\.tech/.test(url)) {
      badResponses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
  });

  let actionError = null;
  try {
    await resetPlayerState(page);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForBothProviderRows(page);
    await waitForSetupIdle(page);
    await activateProvider(page, provider);
    await page.getByRole('button', { name: 'Got it' }).click({ force: true, timeout: 3000 }).catch(() => {});
    await page.getByText('USA Entertainment', { exact: true }).first().click({ force: true, timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const row = page.locator('[role="listitem"]').filter({ hasText: /^USA AMC$/ }).first();
    await row.click({ force: true, timeout: 30000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('video')).some(
          (video) =>
            !video.error &&
            video.readyState >= 1 &&
            video.videoWidth > 0 &&
            video.videoHeight > 0 &&
            String(video.currentSrc || '').includes('/api/provider-vault'),
        ),
      { timeout: 90000 }
    );
  } catch (error) {
    actionError = String(error && error.message ? error.message : error);
  }

  const state = await inspectPlayer(page);
  const screenshot = path.join(outDir, `zero-player-${provider.id}-playback.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await context.close();

  const ok =
    !state.hasUpgradeText &&
    !state.hasTypeError &&
    !state.hasAllChannelsZero &&
    state.hasProviderChannels &&
    state.hasLiveSelection &&
    streamResponses.some((item) => item.status === 200) &&
    streamResponses.some((item) => item.status === 200 && item.url.includes('/segment')) &&
    state.videos.some(videoReachedPlayback) &&
    !actionError &&
    pageErrors.length === 0 &&
    consoleErrors.length === 0;

  results.push({
    provider: provider.id,
    ok,
    actionError,
    state,
    streamResponses,
    badResponses,
    pageErrors,
    consoleErrors,
    screenshot,
  });
}

await browser.close();

const summary = {
  ok: results.every((result) => result.ok),
  generatedAt: new Date().toISOString(),
  results,
};

await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  ok: summary.ok,
  results: results.map((result) => ({
    provider: result.provider,
    ok: result.ok,
    upgradeText: result.state.hasUpgradeText,
    typeError: result.state.hasTypeError,
    allChannelsZero: result.state.hasAllChannelsZero,
    stream200: result.streamResponses.filter((item) => item.status === 200).length,
    videoReady: result.state.videos.map((video) => video.readyState),
    pageErrors: result.pageErrors.length,
    consoleErrors: result.consoleErrors.length,
  })),
  outDir,
}, null, 2));

process.exit(summary.ok ? 0 : 1);
