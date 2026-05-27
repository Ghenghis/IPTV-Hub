import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/nuvio-provider-playback-proof-20260527';
const cookiePath =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const baseUrl = 'https://nuvio.daveai.tech';
const providers = [
  { id: 'apollo', label: 'Apollo Group TV' },
  { id: 'xtremehd', label: 'XtremeHD' },
];

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of ['src', 'token', 'url', 'username', 'password']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, `[${key}]`);
    }
    return parsed.toString();
  } catch {
    return String(url || '').slice(0, 160);
  }
}

async function readAuthCookies(host) {
  const raw = JSON.parse(await fs.readFile(cookiePath, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt
    ? Math.floor(new Date(raw.expiresAt).getTime() / 1000)
    : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: host, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function pageText(page) {
  return page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
}

async function runProvider(page, provider) {
  await page.goto(`${baseUrl}/?proof=${provider.id}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(25000);

  const text = await pageText(page);
  assert(text.includes(`${provider.label} - Live TV`), `${provider.label} live catalog missing`);
  assert(text.includes('USA AMC'), `${provider.label} first live channel missing`);

  await page.screenshot({
    path: path.join(outDir, `nuvio-${provider.id}-home.png`),
    fullPage: true,
  });

  const card = page
    .locator(`[data-action="openDetail"][data-item-id^="daveai:${provider.id}:live:0"]`)
    .first();
  await card.waitFor({ timeout: 60000 });
  await card.click({ timeout: 15000 });
  await page.waitForTimeout(5000);

  const detailText = await pageText(page);
  assert(detailText.includes('Next S1E1'), `${provider.label} live meta did not expose playable episode`);
  assert(detailText.includes('USA AMC'), `${provider.label} detail did not open USA AMC`);

  await page.screenshot({
    path: path.join(outDir, `nuvio-${provider.id}-detail.png`),
    fullPage: true,
  });

  await page.keyboard.press('Enter');
  const streamCard = page.locator('[data-action="playStream"]').first();
  await streamCard.waitFor({ timeout: 60000 });
  await page.screenshot({
    path: path.join(outDir, `nuvio-${provider.id}-stream-source.png`),
    fullPage: true,
  });

  await page.keyboard.press('Enter');
  await page
    .waitForFunction(
      () => Array.from(document.querySelectorAll('video')).some((video) => video.readyState >= 2),
      null,
      { timeout: 60000 },
    )
    .catch(() => null);
  await page.waitForTimeout(10000);

  await page.screenshot({
    path: path.join(outDir, `nuvio-${provider.id}-player.png`),
    fullPage: true,
  });

  const state = await page.evaluate(() => ({
    text: document.body.innerText.slice(0, 1200),
    videos: Array.from(document.querySelectorAll('video')).map((video) => ({
      readyState: video.readyState,
      networkState: video.networkState,
      paused: video.paused,
      width: video.videoWidth,
      height: video.videoHeight,
      currentSrcIsVault: String(video.currentSrc || '').includes('/api/provider-vault'),
    })),
  }));

  assert(
    state.videos.some((video) => video.readyState >= 2 && video.currentSrcIsVault),
    `${provider.label} did not reach provider-vault video playback`,
  );
  assert(
    !state.text.includes('Infinity:NaN:NaN'),
    `${provider.label} live duration polish failed: ${state.text.slice(0, 220).replace(/\s+/g, ' ')}`,
  );
  return state;
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
await context.addCookies(await readAuthCookies('nuvio.daveai.tech'));

const page = await context.newPage();
const seen = {
  pageErrors: [],
  consoleErrors: [],
  providerResponses: [],
};

page.on('pageerror', (error) => {
  seen.pageErrors.push(String(error.message || error).slice(0, 300));
});
page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type())) {
    seen.consoleErrors.push({ type: message.type(), text: message.text().slice(0, 300) });
  }
});
page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/api/provider-vault/') || url.includes('/daveai-provider-vault-addon/')) {
    seen.providerResponses.push({ status: response.status(), url: sanitizeUrl(url) });
  }
});

const results = [];
try {
  for (const provider of providers) {
    results.push({ provider: provider.id, playback: await runProvider(page, provider) });
  }
} finally {
  await browser.close();
}

const stream200 = seen.providerResponses.filter(
  (response) =>
    response.status === 200 &&
    (response.url.includes('/api/provider-vault/stream') ||
      response.url.includes('/api/provider-vault/segment') ||
      response.url.includes('/api/provider-vault/aac-hls')),
).length;

const summary = {
  ok:
    results.length === providers.length &&
    results.every((result) =>
      result.playback.videos.some((video) => video.readyState >= 2 && video.currentSrcIsVault),
    ) &&
    stream200 >= providers.length,
  generatedAt: new Date().toISOString(),
  results,
  stream200,
  pageErrorCount: seen.pageErrors.length,
  consoleErrorCount: seen.consoleErrors.length,
  providerResponses: seen.providerResponses,
  artifacts: {
    apolloPlayer: path.join(outDir, 'nuvio-apollo-player.png'),
    xtremehdPlayer: path.join(outDir, 'nuvio-xtremehd-player.png'),
  },
};

await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

assert(summary.ok, 'Nuvio provider playback proof failed');
assert(seen.pageErrors.length === 0, 'Nuvio emitted page errors');
assert(seen.consoleErrors.length === 0, 'Nuvio emitted console errors');
