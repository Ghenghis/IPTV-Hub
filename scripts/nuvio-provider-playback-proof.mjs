import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/nuvio-provider-playback-proof-20260527';
const cookiePath =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const baseUrl = process.env.NUVIO_URL || 'https://nuvio.daveai.tech';
const resetState = process.env.NUVIO_RESET_STATE === '1';
const providers = [
  { id: 'apollo', label: 'Apollo Group TV' },
  { id: 'xtremehd', label: 'XtremeHD', liveIndex: 3 },
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

async function resetAppState(page, provider) {
  await page.goto(`${baseUrl}/?reset=${provider.id}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {}
  });
}

async function waitForProviderHome(page, provider) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.waitForFunction(
        (providerId) =>
          Boolean(document.querySelector(`[data-action="openDetail"][data-item-id^="daveai:${providerId}:live:"]`)),
        provider.id,
        { timeout: 60000 },
      );
      return;
    } catch (error) {
      lastError = error;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
    }
  }
  throw lastError;
}

async function waitForProviderVaultPlayback(page) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('video')).some((video) => {
        const source = String(video.currentSrc || video.src || video.dataset?.daveaiProviderVaultSrc || '');
        return (
          video.readyState >= 2 &&
          source.includes('/api/provider-vault') &&
          video.paused === false &&
          video.muted === false &&
          video.volume > 0 &&
          video.currentTime > 0 &&
          (video.webkitAudioDecodedByteCount || 0) > 0 &&
          !video.error
        );
      }),
    null,
    { timeout: 60000 },
  );
}

async function auditLiveLogoLayout(page, provider) {
  const layout = await page.evaluate((providerId) => {
    const card = document.querySelector(
      `[data-action="openDetail"][data-item-id^="daveai:${providerId}:live:"]`,
    );
    const poster = card?.querySelector('.content-poster');
    const hero = document.querySelector(
      `.home-hero-card[data-item-id^="daveai:${providerId}:live:"] .home-hero-backdrop`,
    );
    const heroLogo = document.querySelector(
      `.home-hero-card[data-item-id^="daveai:${providerId}:live:"] .home-hero-logo`,
    );
    function imgInfo(node) {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        display: style.display,
        objectFit: style.objectFit,
        naturalWidth: node.naturalWidth || 0,
        naturalHeight: node.naturalHeight || 0,
      };
    }
    const cardRect = card?.getBoundingClientRect();
    return {
      providerId,
      card: cardRect
        ? { width: Math.round(cardRect.width), height: Math.round(cardRect.height) }
        : null,
      poster: imgInfo(poster),
      hero: imgInfo(hero),
      heroLogo: imgInfo(heroLogo),
    };
  }, provider.id);

  assert(layout.card && layout.card.height <= 260, `${provider.label} live card still too tall: ${JSON.stringify(layout)}`);
  assert(
    layout.poster && layout.poster.objectFit === 'contain',
    `${provider.label} live poster is not contained: ${JSON.stringify(layout)}`,
  );
  assert(
    !layout.hero || layout.hero.display === 'none' || layout.hero.width <= 260,
    `${provider.label} live hero backdrop is still oversized: ${JSON.stringify(layout)}`,
  );
  assert(
    !layout.heroLogo || (layout.heroLogo.width <= 220 && layout.heroLogo.height <= 150),
    `${provider.label} live hero logo bounds are wrong: ${JSON.stringify(layout)}`,
  );
  return layout;
}

async function runProvider(page, provider) {
  if (resetState) await resetAppState(page, provider);
  await page.goto(`${baseUrl}/?proof=${provider.id}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await waitForProviderHome(page, provider);
  await page.waitForTimeout(3000);

  const liveIndex = provider.liveIndex || 0;
  const card = page
    .locator(`[data-action="openDetail"][data-item-id^="daveai:${provider.id}:live:${liveIndex}:"]`)
    .first();
  await card.waitFor({ timeout: 60000 });
  const cardName = await card.evaluate((node) => (node.textContent || '').replace(/\s+/g, ' ').trim());
  assert(cardName.length > 0, `${provider.label} first live card has no text`);
  const layout = await auditLiveLogoLayout(page, provider);

  await page.screenshot({
    path: path.join(outDir, `nuvio-${provider.id}-home.png`),
    fullPage: true,
  });
  await card.click({ timeout: 15000 });
  const playButton = page.locator('[data-action="playDefault"], button:has-text("Play")').first();
  await playButton.waitFor({ timeout: 60000 });

  const detailText = await pageText(page);
  const cardWords = cardName.split(/\s+/).filter((word) => word.length >= 3).slice(0, 3);
  assert(
    cardWords.some((word) => detailText.toLowerCase().includes(word.toLowerCase())),
    `${provider.label} detail did not match selected card ${cardName}`,
  );

  await page.screenshot({
    path: path.join(outDir, `nuvio-${provider.id}-detail.png`),
    fullPage: true,
  });

  await page.screenshot({
    path: path.join(outDir, `nuvio-${provider.id}-stream-source.png`),
    fullPage: true,
  });

  await playButton.click({ timeout: 15000 });
  await page
    .waitForFunction(
      () => Array.from(document.querySelectorAll('video')).some((video) => video.readyState >= 2),
      null,
      { timeout: 60000 },
    )
    .catch(() => null);
  await page.waitForTimeout(10000);

  await page.evaluate(() => {
    for (const video of Array.from(document.querySelectorAll('video'))) {
      video.muted = false;
      video.volume = 1;
      if (video.paused) video.play().catch(() => {});
    }
  });
  await waitForProviderVaultPlayback(page).catch(() => null);
  await page.waitForTimeout(2000);

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
      muted: video.muted,
      volume: video.volume,
      currentTime: video.currentTime,
      width: video.videoWidth,
      height: video.videoHeight,
      webkitAudioDecodedByteCount: video.webkitAudioDecodedByteCount || 0,
      providerVaultSource: video.dataset?.daveaiProviderVaultSrc || '',
      currentSrcIsVault:
        String(video.currentSrc || '').includes('/api/provider-vault') ||
        String(video.dataset?.daveaiProviderVaultSrc || '').includes('/api/provider-vault'),
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
    })),
  }));

  assert(
    state.videos.some(
      (video) =>
        video.readyState >= 2 &&
        video.currentSrcIsVault &&
        video.paused === false &&
        video.muted === false &&
        video.volume > 0 &&
        video.currentTime > 0 &&
        (video.webkitAudioDecodedByteCount || 0) > 0,
    ),
    `${provider.label} did not reach provider-vault video playback`,
  );
  assert(
    !state.text.includes('Infinity:NaN:NaN'),
    `${provider.label} live duration polish failed: ${state.text.slice(0, 220).replace(/\s+/g, ' ')}`,
  );
  return { ...state, selectedCard: cardName, layout };
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const seen = {
  pageErrors: [],
  consoleErrors: [],
  consoleWarnings: [],
  providerResponses: [],
};

function attachObservers(page) {
  page.on('pageerror', (error) => {
    seen.pageErrors.push(String(error.message || error).slice(0, 300));
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      seen.consoleErrors.push({ type: message.type(), text: message.text().slice(0, 300) });
    } else if (message.type() === 'warning') {
      seen.consoleWarnings.push({ type: message.type(), text: message.text().slice(0, 300) });
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/provider-vault/') || url.includes('/daveai-provider-vault-addon/')) {
      seen.providerResponses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
  });
}

const results = [];
try {
  for (const provider of providers) {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      ignoreHTTPSErrors: true,
    });
    await context.addCookies(await readAuthCookies('nuvio.daveai.tech'));
    const page = await context.newPage();
    attachObservers(page);
    try {
      results.push({ provider: provider.id, playback: await runProvider(page, provider) });
    } finally {
      await context.close().catch(() => {});
    }
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
      result.playback.videos.some(
        (video) =>
          video.readyState >= 2 &&
          video.currentSrcIsVault &&
          video.paused === false &&
          video.muted === false &&
          video.volume > 0 &&
          video.currentTime > 0 &&
          (video.webkitAudioDecodedByteCount || 0) > 0,
      ),
    ) &&
    stream200 >= providers.length,
  generatedAt: new Date().toISOString(),
  results,
  stream200,
  pageErrorCount: seen.pageErrors.length,
  consoleErrorCount: seen.consoleErrors.length,
  consoleWarningCount: seen.consoleWarnings.length,
  pageErrors: seen.pageErrors,
  consoleErrors: seen.consoleErrors,
  consoleWarnings: seen.consoleWarnings,
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
