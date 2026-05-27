import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir = 'C:/Users/Admin/Downloads/VPS/_visual_artifacts/zero-player-free-pro-settings-proof-20260527';
const cookiePath =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const appUrl = 'https://apps.daveai.tech/iptv-player-zero/?free_pro_settings_proof=' + Date.now();

const PAID_TEXT =
  /\b(upgrade to pro|lifetime unlock|\$12\.99|stripe|purchase|forgot password|refresh license|72-hour pro trial|free mode|low price)\b/i;

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

async function inspect(page) {
  return page.evaluate((paidPatternSource) => {
    const paidText = new RegExp(paidPatternSource, 'i');
    const text = document.body.innerText || '';
    const visibleUpgradeShells = Array.from(document.querySelectorAll('.ipz-upgrade-modal-shell')).filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
    }).length;
    return {
      href: location.href,
      textSample: text.slice(0, 2500),
      hasFreeProBadge: /FREE PRO/i.test(text),
      hasPaidText: paidText.test(text),
      visibleUpgradeShells,
      hasFatal: /Something went wrong|Cannot read properties|TypeError/i.test(text),
      hasSettings: /\bSettings\b/i.test(text),
    };
  }, PAID_TEXT.source);
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
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error.message || error).slice(0, 800)));
page.on('console', (message) => {
  if (message.type() === 'error' && !/set_preview_bounds/.test(message.text())) {
    consoleErrors.push(message.text().slice(0, 800));
  }
});

await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => /FREE PRO/i.test(document.body.innerText || '') && !/Something went wrong/i.test(document.body.innerText || ''),
  undefined,
  { timeout: 90000 },
);
await page.getByRole('button', { name: 'Got it' }).click({ force: true, timeout: 3000 }).catch(() => {});
await page.getByRole('button', { name: 'Settings', exact: true }).click({ force: true, timeout: 30000 });
await page.waitForFunction(() => /\bSettings\b/i.test(document.body.innerText || ''), undefined, { timeout: 30000 });
await page.waitForTimeout(2500);

const state = await inspect(page);
const screenshot = path.join(outDir, 'zero-player-free-pro-settings.png');
await page.screenshot({ path: screenshot, fullPage: true });

await context.close();
await browser.close();

const ok =
  state.hasFreeProBadge &&
  state.hasSettings &&
  !state.hasPaidText &&
  state.visibleUpgradeShells === 0 &&
  !state.hasFatal &&
  pageErrors.length === 0 &&
  consoleErrors.length === 0;

const summary = {
  ok,
  generatedAt: new Date().toISOString(),
  state,
  pageErrors,
  consoleErrors,
  screenshot,
};
await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  ok,
  hasFreeProBadge: state.hasFreeProBadge,
  hasPaidText: state.hasPaidText,
  visibleUpgradeShells: state.visibleUpgradeShells,
  hasFatal: state.hasFatal,
  pageErrors: pageErrors.length,
  consoleErrors: consoleErrors.length,
  screenshot,
  outDir,
}, null, 2));

process.exit(ok ? 0 : 1);
