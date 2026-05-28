import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
const OUT_DIR =
  process.env.OUT_DIR ||
  `C:/Users/Admin/Downloads/VPS/_visual_artifacts/iptv-fleet-critical-audit-${STAMP}`;
const AUTH_STATE =
  process.env.DAVETV_AUTH_COOKIE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';

const APPS = [
  { id: 'zero', url: 'https://apps.daveai.tech/iptv-player-zero/?audit=fleet' },
  { id: 'xstream', url: 'https://xstream-player.daveai.tech/dashboard' },
  { id: 'iptvnator', url: 'https://iptvnator.daveai.tech/' },
  { id: 'smart-iptv-web', url: 'https://smart-iptv-web.daveai.tech/' },
  { id: 'wizju', url: 'https://wizju-iptv-player.daveai.tech/#/media' },
  { id: 'ynotv', url: 'https://ynotv.daveai.tech/' },
  { id: 'iptv-restream', url: 'https://iptv-restream.daveai.tech/' },
  { id: 'stalker-ui', url: 'https://stalker-ui.daveai.tech/' },
  { id: 'extreme-infinitv', url: 'https://extreme-infinitv.daveai.tech/movies/' },
  { id: 'nuvio', url: 'https://nuvio.daveai.tech/' },
  { id: 'iptv-stream', url: 'https://iptv-stream.daveai.tech/' },
  { id: 'open-tv', url: 'https://open-tv.daveai.tech/' },
  { id: 'tvapp', url: 'https://tvapp.daveai.tech/' },
];

const FORBIDDEN_TEXT = [
  /application error/i,
  /client-side exception/i,
  /something went wrong/i,
  /failed to load chunk/i,
  /portal unavailable/i,
  /typeerror/i,
  /cannot read properties/i,
  /playback error/i,
  /media_element_error/i,
  /demuxer_error/i,
  /ffmpegdemuxer/i,
  /\bBem-vindo\b/i,
  /\bConectar\b/i,
  /\bOcorreu\b/i,
  /\bRecarregar\b/i,
  /\bSenha\b/i,
  /\bUsu[aá]rio\b/i,
  /\bMensagem\b/i,
  /\bComprar\b/i,
  /\bAssinatura\b/i,
  /\bLicen[cç]a\b/i,
  /upgrade to pro/i,
  /stripe/i,
  /\$\s*12\.99/i,
];

const STUCK_TEXT = [
  /no playlist selected/i,
  /no movies\b/i,
  /no matching categories/i,
  /no playlists imported/i,
  /loading all movies/i,
  /loading categories/i,
  /fetching your library/i,
  /connecting\.\.\./i,
  /restart the app to continue/i,
  /no sound/i,
];

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of ['token', 'src', 'url', 'username', 'password', 'file', 'id']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, `[${key}]`);
    }
    return url.toString();
  } catch {
    return String(rawUrl || '').replace(
      /([?&](?:token|src|url|username|password|file|id)=)[^&]*/gi,
      '$1[redacted]',
    );
  }
}

async function authCookies(host) {
  const raw = JSON.parse(await fs.readFile(AUTH_STATE, 'utf8'));
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt ? Math.floor(new Date(raw.expiresAt).getTime() / 1000) : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: host, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

async function collectVisualState(page) {
  return page.evaluate(() => {
    const viewport = { width: innerWidth, height: innerHeight };
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();

    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 20 &&
        rect.height > 20 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || 1) > 0.01
      );
    };

    const cardNodes = Array.from(
      document.querySelectorAll(
        [
          '[data-action]',
          '[data-item-id]',
          '[role="listitem"]',
          'a[href*="watch"]',
          'a[href*="movie"]',
          'a[href*="series"]',
          'button',
          '.card',
          '[class*="card"]',
          '[class*="poster"]',
          '[class*="tile"]',
          '[class*="item"]',
        ].join(','),
      ),
    )
      .filter(visible)
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width >= 70 && rect.height >= 42 && rect.top < viewport.height * 1.8;
      })
      .slice(0, 120);

    const cards = cardNodes.map((el) => {
      const rect = el.getBoundingClientRect();
      const imgs = Array.from(el.querySelectorAll('img')).map((img) => ({
        src: img.currentSrc || img.src || '',
        alt: img.alt || '',
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        width: Math.round(img.getBoundingClientRect().width),
        height: Math.round(img.getBoundingClientRect().height),
        objectFit: getComputedStyle(img).objectFit,
      }));
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        className: String(el.className || '').slice(0, 180),
        text: text.slice(0, 140),
        textLength: text.length,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        imgs,
        bg: style.backgroundImage && style.backgroundImage !== 'none' ? style.backgroundImage.slice(0, 160) : '',
      };
    });

    const allImages = Array.from(document.querySelectorAll('img')).filter(visible).map((img) => {
      const rect = img.getBoundingClientRect();
      return {
        src: img.currentSrc || img.src || '',
        alt: img.alt || '',
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        objectFit: getComputedStyle(img).objectFit,
      };
    });

    const videos = Array.from(document.querySelectorAll('video')).map((video) => ({
      readyState: video.readyState,
      networkState: video.networkState,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      currentTime: Number(video.currentTime || 0),
      duration: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      currentSrcKind: video.currentSrc
        ? video.currentSrc.includes('/api/provider-vault')
          ? 'provider-vault'
          : video.currentSrc.startsWith('blob:')
            ? 'blob'
            : 'other'
        : '',
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
    }));

    return { bodyText, cards, allImages, videos };
  });
}

function scoreApp(app, state, telemetry) {
  const text = state.bodyText || '';
  const forbidden = FORBIDDEN_TEXT.filter((pattern) => pattern.test(text)).map(String);
  const stuck = STUCK_TEXT.filter((pattern) => pattern.test(text)).map(String);
  const cards = state.cards || [];
  const contentCards = cards.filter((card) => card.textLength >= 4);
  const blankCards = cards.filter(
    (card) =>
      card.width >= 100 &&
      card.height >= 80 &&
      card.textLength < 4 &&
      card.imgs.every((img) => img.naturalWidth === 0 || img.naturalHeight === 0),
  );
  const cardImages = cards.flatMap((card) => card.imgs);
  const loadedImages = cardImages.filter((img) => img.naturalWidth >= 16 && img.naturalHeight >= 16);
  const brokenImages = cardImages.filter((img) => img.src && (img.naturalWidth === 0 || img.naturalHeight === 0));
  const stretchedImages = loadedImages.filter((img) => {
    if (img.width < 120 || img.height < 80 || img.naturalWidth <= 0 || img.naturalHeight <= 0) return false;
    const displayRatio = img.width / img.height;
    const naturalRatio = img.naturalWidth / img.naturalHeight;
    return Math.max(displayRatio, naturalRatio) / Math.min(displayRatio, naturalRatio) > 1.9 && img.objectFit !== 'contain';
  });
  const hugeCards = cards.filter((card) => card.width > 900 || card.height > 820);
  const videos = state.videos || [];
  const readyVideos = videos.filter((video) => !video.error && video.readyState >= 2 && video.width > 0 && video.height > 0);
  const forcedMutedVideos = readyVideos.filter((video) => video.muted || video.volume === 0);
  const providerResponses200 = telemetry.providerResponses.filter((item) => item.status === 200).length;
  const rawMediaErrors = videos.filter((video) => video.error);

  const seriousFailures = [];
  if (forbidden.length) seriousFailures.push('forbidden-error-or-non-english-text');
  if (stuck.length && contentCards.length < 8) seriousFailures.push('stuck-loading-or-empty-library');
  if (contentCards.length < 6) seriousFailures.push('too-few-populated-cards');
  if (blankCards.length >= 4) seriousFailures.push('blank-card-shells');
  if (brokenImages.length >= 4) seriousFailures.push('broken-card-images');
  if (stretchedImages.length >= 2) seriousFailures.push('stretched-artwork');
  if (hugeCards.length >= 1) seriousFailures.push('oversized-card-layout');
  if (rawMediaErrors.length) seriousFailures.push('raw-video-error');
  if (readyVideos.length && forcedMutedVideos.length === readyVideos.length) seriousFailures.push('forced-muted-video');
  if (providerResponses200 === 0 && /provider vault|apollo|xtreme|daveai/i.test(text)) {
    seriousFailures.push('no-provider-vault-successes-observed');
  }

  return {
    id: app.id,
    url: app.url,
    ok: seriousFailures.length === 0,
    seriousFailures,
    metrics: {
      forbidden,
      stuck,
      cardCount: cards.length,
      contentCardCount: contentCards.length,
      blankCardCount: blankCards.length,
      loadedImageCount: loadedImages.length,
      brokenImageCount: brokenImages.length,
      stretchedImageCount: stretchedImages.length,
      hugeCardCount: hugeCards.length,
      videoCount: videos.length,
      readyVideoCount: readyVideos.length,
      forcedMutedVideoCount: forcedMutedVideos.length,
      providerResponses200,
      pageErrorCount: telemetry.pageErrors.length,
      consoleErrorCount: telemetry.consoleErrors.length,
      requestFailedCount: telemetry.failedRequests.length,
    },
    samples: {
      text: text.slice(0, 900),
      cards: cards.slice(0, 12),
      videos,
      consoleErrors: telemetry.consoleErrors.slice(0, 8),
      pageErrors: telemetry.pageErrors.slice(0, 8),
      failedRequests: telemetry.failedRequests.slice(0, 8),
      providerResponses: telemetry.providerResponses.slice(0, 20),
    },
  };
}

async function auditApp(browser, app) {
  const host = new URL(app.url).hostname;
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.addCookies(await authCookies(host));
  const page = await context.newPage();
  const telemetry = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    providerResponses: [],
  };

  page.on('pageerror', (error) => telemetry.pageErrors.push(String(error.message || error).slice(0, 500)));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      const text = message.text();
      if (!/favicon|ResizeObserver loop|cdn-cgi|ERR_ABORTED/i.test(text)) {
        telemetry.consoleErrors.push(text.slice(0, 500));
      }
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const failure = request.failure()?.errorText || 'unknown';
    if (failure === 'net::ERR_ABORTED' && /provider-vault|_next|\.js|\.css|\.png|\.jpg|\.webp|\.svg/i.test(url)) return;
    telemetry.failedRequests.push({ url: sanitizeUrl(url), failure });
  });
  page.on('response', (response) => {
    const url = response.url();
    if (/\/api\/provider-vault\/|\/daveai-provider-vault-addon\//i.test(url)) {
      telemetry.providerResponses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
  });

  let navError = null;
  try {
    await page.goto(`${app.url}${app.url.includes('?') ? '&' : '?'}criticalAudit=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(18_000);

    await page.mouse.click(960, 540).catch(() => {});
    await page.keyboard.press('Space').catch(() => {});
    await page.evaluate(() => {
      for (const video of document.querySelectorAll('video')) {
        video.muted = false;
        video.volume = 1;
        video.play?.().catch(() => {});
      }
    }).catch(() => {});
    await page.waitForTimeout(5_000);
  } catch (error) {
    navError = String(error && error.message ? error.message : error);
  }

  const state = await collectVisualState(page).catch((error) => ({
    bodyText: `STATE_COLLECTION_FAILED ${String(error.message || error)}`,
    cards: [],
    allImages: [],
    videos: [],
  }));
  const screenshot = path.join(OUT_DIR, `${app.id}.png`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  await context.close();

  const result = scoreApp(app, state, telemetry);
  if (navError) {
    result.ok = false;
    result.seriousFailures.unshift('navigation-or-audit-error');
    result.samples.navError = navError;
  }
  result.screenshot = screenshot;
  return result;
}

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const app of APPS) {
    console.log(`AUDIT ${app.id} ${app.url}`);
    results.push(await auditApp(browser, app));
  }
} finally {
  await browser.close();
}

const summary = {
  ok: results.every((result) => result.ok),
  generatedAt: new Date().toISOString(),
  outDir: OUT_DIR,
  results,
};

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
await fs.writeFile(
  path.join(OUT_DIR, 'summary.md'),
  [
    '# IPTV Fleet Critical Visual Audit',
    '',
    `Generated: ${summary.generatedAt}`,
    '',
    '| App | Status | Failures | Cards | Images | Videos | Screenshot |',
    '| --- | --- | --- | ---: | ---: | ---: | --- |',
    ...results.map((result) => {
      const status = result.ok ? 'PASS' : 'FAIL';
      const failures = result.seriousFailures.join(', ') || '-';
      const m = result.metrics;
      return `| ${result.id} | ${status} | ${failures} | ${m.contentCardCount}/${m.cardCount} | ${m.loadedImageCount} loaded, ${m.brokenImageCount} broken | ${m.readyVideoCount}/${m.videoCount} ready | ${path.basename(result.screenshot)} |`;
    }),
    '',
  ].join('\n'),
);

console.log(JSON.stringify({
  ok: summary.ok,
  outDir: OUT_DIR,
  failures: results.filter((result) => !result.ok).map((result) => ({
    id: result.id,
    failures: result.seriousFailures,
    metrics: result.metrics,
    screenshot: result.screenshot,
  })),
}, null, 2));

if (!summary.ok) process.exitCode = 1;
