import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
const outDir =
  process.env.OUT_DIR ||
  `C:/Users/Admin/Downloads/VPS/_visual_artifacts/zero-player-provider-autoload-proof-${stamp}`;
const cookiePath =
  process.env.COOKIE_PATH ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const appUrl =
  (process.env.ZERO_PLAYER_URL || 'https://apps.daveai.tech/iptv-player-zero/') +
  (String(process.env.ZERO_PLAYER_URL || '').includes('?') ? '&' : '?') +
  'autoload_proof=' +
  Date.now();
const providerIds = ['apollo', 'xtremehd'];

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

async function resetToUserStuckState(page) {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(async () => {
    localStorage.setItem('ipz_provider_quickstart_hidden', '1');
    localStorage.removeItem('ipz_default_playlist_id');
    localStorage.removeItem('ipz_provider_quickstart_last_playlist_id');
    localStorage.removeItem('ipz_provider_autoload_build_id');
    localStorage.removeItem('ipz_playlist_enabled_by_id');
    localStorage.removeItem('ipz_playlist_enabled_by_id_premium');
    localStorage.removeItem('ipz_playlist_display_order_ids');
    localStorage.removeItem('ipz_playlist_display_order_ids_premium');
    for (const dbName of ['ipz-db', 'iptv_player_zero', 'iptv-player-zero']) {
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    }
  });
}

async function currentBuildId(page) {
  return page.evaluate(() => {
    const stored = localStorage.getItem('ipz_daveai_hosted_build_id');
    if (stored) return stored;
    const scripts = Array.from(document.scripts).map((script) => script.src || '').join('\n');
    return scripts.match(/v=([^&\s]+)/)?.[1] || 'unknown-build';
  });
}

async function inspect(page) {
  return page.evaluate(async (providerIds) => {
    const text = document.body.innerText || '';
    const playlists = window.Store && window.Store.getPlaylists
      ? await window.Store.getPlaylists().catch(() => [])
      : [];
    const counts = {};
    for (const id of providerIds) {
      const playlistId = `daveai-provider-${id}`;
      const channels = window.Store && window.Store.getChannels
        ? await window.Store.getChannels(playlistId).catch(() => [])
        : [];
      counts[playlistId] = channels.length;
    }
    return {
      href: location.href,
      textSample: text.slice(0, 2800),
      hasPanel: /DaveAI Providers/i.test(text),
      hasPaidText: /\b(upgrade to pro|lifetime unlock|\$12\.99|stripe|purchase|72-hour pro trial|free mode)\b/i.test(text),
      hasFatal: /Something went wrong|Cannot read properties|client-side exception/i.test(text),
      allChannelsVisible: /All channels/i.test(text),
      defaultPlaylist: localStorage.getItem('ipz_default_playlist_id'),
      autoloadBuild: localStorage.getItem('ipz_provider_autoload_build_id'),
      enabled: localStorage.getItem('ipz_playlist_enabled_by_id_premium') || localStorage.getItem('ipz_playlist_enabled_by_id'),
      order: localStorage.getItem('ipz_playlist_display_order_ids_premium') || localStorage.getItem('ipz_playlist_display_order_ids'),
      playlists: playlists.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        type: playlist.type,
        source: playlist.source,
      })),
      counts,
    };
  }, providerIds);
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true,
});
await context.addCookies(await authCookies());
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error' && !/set_preview_bounds/.test(message.text())) {
    consoleErrors.push(message.text().slice(0, 800));
  }
});
page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));

await resetToUserStuckState(page);
await page.goto(appUrl + '&after_reset=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
const buildId = await currentBuildId(page);
await page.waitForFunction(
  async (ids) => {
    if (!window.Store || !window.Store.getChannels || !window.Store.getPlaylists) return false;
    const text = document.body.innerText || '';
    if (/Something went wrong|Cannot read properties|client-side exception/i.test(text)) return false;
    const playlists = await window.Store.getPlaylists().catch(() => []);
    for (const id of ids) {
      const playlistId = `daveai-provider-${id}`;
      if (!playlists.some((playlist) => playlist && playlist.id === playlistId)) return false;
      const channels = await window.Store.getChannels(playlistId).catch(() => []);
      if (!Array.isArray(channels) || channels.length < 2000) return false;
    }
    return localStorage.getItem('ipz_default_playlist_id') === 'daveai-provider-apollo';
  },
  providerIds,
  { timeout: 120000 }
);
await page.waitForTimeout(2500);
const textAfterStoreReady = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
if (/You have no playlists yet|No playlists imported/i.test(textAfterStoreReady)) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
}
await page.waitForFunction(
  () => {
    const text = document.body.innerText || '';
    return /All channels/i.test(text) && !/You have no playlists yet|No playlists imported|Something went wrong/i.test(text);
  },
  undefined,
  { timeout: 45000 }
);

const state = await inspect(page);
const screenshot = path.join(outDir, 'zero-player-autoloaded-providers.png');
await page.screenshot({ path: screenshot, fullPage: true });

await context.close();
await browser.close();

const ok =
  !state.hasPaidText &&
  !state.hasFatal &&
  state.allChannelsVisible &&
  providerIds.every((id) => state.counts[`daveai-provider-${id}`] >= 2000) &&
  providerIds.every((id) => state.playlists.some((playlist) => playlist.id === `daveai-provider-${id}`)) &&
  pageErrors.length === 0 &&
  consoleErrors.length === 0;

const summary = {
  ok,
  generatedAt: new Date().toISOString(),
  buildId,
  state,
  pageErrors,
  consoleErrors,
  screenshot,
};
await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  ok,
  defaultPlaylist: state.defaultPlaylist,
  counts: state.counts,
  playlists: state.playlists,
  hasPanel: state.hasPanel,
  hasPaidText: state.hasPaidText,
  hasFatal: state.hasFatal,
  pageErrors: pageErrors.length,
  consoleErrors: consoleErrors.length,
  screenshot,
  outDir,
}, null, 2));

process.exit(ok ? 0 : 1);
