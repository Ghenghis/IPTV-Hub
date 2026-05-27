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
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/xstream-english-only-proof-20260527';

const PROVIDERS = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];

const ROUTES = [
  { label: 'dashboard', path: '/dashboard', waitFor: /Home|Movies|Series|Live/i },
  { label: 'live', path: '/dashboard/live', waitFor: /Live TV Categories|Live Categories|Sort|Channels/i },
  { label: 'movies', path: '/dashboard/movies', waitFor: /Movie Categories|Movies|Sort|Explore/i },
  { label: 'series', path: '/dashboard/series', waitFor: /Series Categories|Series|Sort/i },
  { label: 'movie-details', path: '/dashboard/watch/movie/3185383', waitFor: /Play Movie|Movie/i },
  { label: 'series-details', path: '/dashboard/watch/series/54163', waitFor: /Episode|Season|Series/i },
];

const FORBIDDEN = [
  /pt-BR/i,
  /Portuguese/i,
  /Ocorreu/i,
  /Recarregar/i,
  /Bem-vindo/i,
  /Conectar/i,
  /Senha/i,
  /Usu[aá]rio/i,
  /Erro ao/i,
  /Ordenar/i,
  /Abrir/i,
  /Fechar/i,
  /restantes/i,
  /Explorar/i,
  /Try another language/i,
  /legendas/i,
  /buscar categorias/i,
  /\bHindi\b/i,
  /\bArab(ic)?\b/i,
  /\bBangladesh\b/i,
  /\bFrench\b/i,
  /\bLatino?\b/i,
  /\bSpanish\b/i,
  /\bKurdish\b/i,
  /\bAlgeria\b/i,
  /\bBahrain\b/i,
  /\bEgypt\b/i,
  /\bEmirates\b/i,
  /\bAsian\b/i,
  /\bEuropean\b/i,
  /\bCentral America\b/i,
  /\bSouth America\b/i,
  /\bARG\b/i,
  /\bArgentina\b/i,
  /\bAfrica\b/i,
  /\bBG\b/,
  /\bBIH\b/,
  /\bFR\b/,
  /\bBulgaria\b/i,
  /\bBosnia\b/i,
  /\bIraq\b/i,
  /\bJordan\b/i,
  /\bKuwait\b/i,
  /\bLebanon\b/i,
  /\bMorocco\b/i,
  /\bNetherland\b/i,
  /\bPalestine\b/i,
  /\bPortugal\b/i,
  /\bQatar\b/i,
  /\bRamadan\b/i,
  /\bSaudi\b/i,
  /\bSyria\b/i,
  /\bMulti[\s-]*(Lang|Sub)\b/i,
  /\bTranslated?\b/i,
  /\bKung[\s-]*Fu\b/i,
  /\bLocal\b/i,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readAuthCookies(host) {
  const raw = JSON.parse(await fs.readFile(AUTH_STATE, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt ? Math.floor(new Date(raw.expiresAt).getTime() / 1000) : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: host, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

async function login(page, provider) {
  await page.goto(`${BASE_URL}/?englishOnly=${provider.id}-${Date.now()}`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('button', { name: new RegExp(`(?:Use|Load) ${provider.name}`, 'i') }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function inspectRoute(page, provider, route) {
  await page.goto(`${BASE_URL}${route.path}?englishOnly=${provider.id}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const text = await page.locator('body').innerText({ timeout: 30_000 }).catch(() => '');
  const htmlLang = await page.evaluate(() => document.documentElement.lang || '');
  const tracks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('track')).map((track) => ({
      srcLang: track.getAttribute('srclang') || '',
      label: track.getAttribute('label') || '',
    })),
  );
  const forbiddenHits = FORBIDDEN.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern));
  const screenshot = path.join(OUT_DIR, `xstream-english-${provider.id}-${route.label}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });

  assert(htmlLang === 'en', `${provider.id} ${route.label} html lang was ${htmlLang || '[blank]'}`);
  assert(route.waitFor.test(text), `${provider.id} ${route.label} did not render expected English route content`);
  assert(!/Application Error|Something went wrong|Failed to load chunk/i.test(text), `${provider.id} ${route.label} rendered an app/chunk error`);
  assert(forbiddenHits.length === 0, `${provider.id} ${route.label} had non-English markers: ${forbiddenHits.join(', ')}`);
  for (const track of tracks) {
    assert(!/pt-BR|Portuguese/i.test(`${track.srcLang} ${track.label}`), `${provider.id} ${route.label} exposed Portuguese subtitle track`);
  }

  return {
    provider: provider.id,
    route: route.label,
    ok: true,
    htmlLang,
    screenshot,
    sample: text.slice(0, 500),
  };
}

await fs.mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });
const host = new URL(BASE_URL).hostname;
const allResults = [];
const diagnostics = [];

try {
  for (const provider of PROVIDERS) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });
    await context.addCookies(await readAuthCookies(host));
    const page = await context.newPage();
    page.on('pageerror', (error) => diagnostics.push({ provider: provider.id, type: 'pageerror', text: String(error.message || error).slice(0, 800) }));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !/Autoplay|ERR_ABORTED|cdn-cgi|watch-progress/i.test(text)) {
        diagnostics.push({ provider: provider.id, type: 'console', text: text.slice(0, 1000) });
      }
    });

    await login(page, provider);
    for (const route of ROUTES) {
      allResults.push(await inspectRoute(page, provider, route));
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const summary = {
  baseUrl: BASE_URL,
  generatedAt: new Date().toISOString(),
  passed: allResults.length,
  diagnostics,
  results: allResults,
};

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

assert(diagnostics.length === 0, `Browser diagnostics contained errors: ${JSON.stringify(diagnostics.slice(0, 5), null, 2)}`);

console.log(JSON.stringify(summary, null, 2));
