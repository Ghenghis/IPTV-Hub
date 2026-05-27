import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir = 'C:/Users/Admin/Downloads/VPS/_visual_artifacts/zero-player-crash-recovery-proof-20260527';
const cookiePath =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const buildId = '20260527-free-provider16';
const appUrl = 'https://apps.daveai.tech/iptv-player-zero/?recovery_proof=' + Date.now();

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

async function readState(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    return {
      href: location.href,
      title: document.title,
      textSample: text.slice(0, 2200),
      hasFatalCard: /Something went wrong/i.test(text) && /Restart the app|100%/i.test(text),
      hasProviderPanel: /DaveAI Providers/i.test(text),
      hasNoPlaylistsState: /You have no playlists yet/i.test(text),
      hasPaidText: /\b(upgrade to pro|lifetime unlock|\$12\.99|stripe|purchase|72-hour pro trial|free mode)\b/i.test(text),
      buildId: localStorage.getItem('ipz_daveai_hosted_build_id'),
      recoveredBuild: sessionStorage.getItem('ipz_daveai_recovered_build'),
      recoveryReason: sessionStorage.getItem('ipz_daveai_recovery_reason'),
      dbNames: indexedDB.databases ? undefined : 'indexedDB.databases unavailable',
    };
  });
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
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 600));
});
page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));

await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__), { timeout: 30000 });

await page.evaluate(async (buildId) => {
  sessionStorage.removeItem('ipz_daveai_recovered_build');
  sessionStorage.removeItem('ipz_daveai_recovery_reason');
  localStorage.setItem('ipz_daveai_hosted_build_id', 'old-broken-build');
  await new Promise((resolve) => {
    const req = indexedDB.open('ipz-db', 2);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      try { req.result.close(); } catch {}
      resolve();
    };
    req.onerror = req.onblocked = () => resolve();
  });
  document.body.innerHTML = `
    <section style="font: 22px system-ui; color: #96a1b2; padding: 40px">
      <h1>Something went wrong</h1>
      <p>Restart the app to continue</p>
      <strong>Something went wrong 100%</strong>
      <small>${buildId}</small>
    </section>
  `;
}, buildId);

await page.waitForURL(new RegExp(`recovered=${buildId}`), { timeout: 10000 });
await page.waitForFunction(
  () => /DaveAI Providers|You have no playlists yet|Live TV/i.test(document.body.innerText || ''),
  { timeout: 40000 }
);

const state = await readState(page);
if (page.evaluate) {
  state.dbNames = await page.evaluate(async () => {
    if (!indexedDB.databases) return [];
    return (await indexedDB.databases()).map((db) => db.name).filter(Boolean).sort();
  });
}
const screenshot = path.join(outDir, 'zero-player-recovered-from-rendered-fatal.png');
await page.screenshot({ path: screenshot, fullPage: true });
await context.close();
await browser.close();

const summary = {
  ok:
    state.href.includes(`recovered=${buildId}`) &&
    state.recoveredBuild === buildId &&
    /rendered fatal state/i.test(state.recoveryReason || '') &&
    !state.hasFatalCard &&
    !state.hasPaidText &&
    (state.hasProviderPanel || state.hasNoPlaylistsState),
  generatedAt: new Date().toISOString(),
  buildId,
  state,
  pageErrors,
  consoleErrors,
  screenshot,
};

await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(
  {
    ok: summary.ok,
    href: state.href,
    recoveredBuild: state.recoveredBuild,
    recoveryReason: state.recoveryReason,
    hasFatalCard: state.hasFatalCard,
    hasPaidText: state.hasPaidText,
    hasProviderPanel: state.hasProviderPanel,
    hasNoPlaylistsState: state.hasNoPlaylistsState,
    pageErrors: pageErrors.length,
    consoleErrors: consoleErrors.length,
    screenshot,
    outDir,
  },
  null,
  2
));

process.exit(summary.ok ? 0 : 1);
