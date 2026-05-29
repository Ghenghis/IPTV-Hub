import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.EXTREME_INFINITV_BASE || 'https://extreme-infinitv.daveai.tech/';
const TARGET = new URL('/livetv/', BASE).toString();
const COOKIE_FILE =
  process.env.DAVETV_AUTH_COOKIE ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const OUT_DIR =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/extreme-infinitv-provider-playback-proof-20260527';

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}${url.search}`
      .replace(/([?&]id=)[^&]*/i, (_, prefix) => `${prefix}${url.searchParams.get('id') ? '<present>' : '<empty>'}`)
      .replace(/([?&]token=)[^&]*/gi, '$1<redacted>')
      .replace(/([?&]src=)[^&]*/gi, '$1<redacted>');
  } catch {
    return String(rawUrl).replace(/([?&](?:id|token|src)=)[^&]*/gi, '$1<redacted>');
  }
}

async function addAuthCookies(context) {
  const auth = JSON.parse(await fs.readFile(COOKIE_FILE, 'utf8'));
  const cookie = {
    name: auth.cookieName,
    value: auth.cookieValue,
    domain: '.daveai.tech',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    expires: Math.floor(new Date(auth.expiresAt).getTime() / 1000),
  };
  await context.addCookies([
    cookie,
    { ...cookie, domain: new URL(BASE).hostname },
  ]);
}

async function seedProvider(page, provider) {
  await page.goto(`${BASE}?seed=${provider}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });

  await page.evaluate(async (selectedProvider) => {
    const now = Date.now();
    localStorage.setItem('xt_davetv_vault_profile_cache_v2', '1');
    localStorage.setItem('xt_locale', 'en');
    localStorage.setItem('xt_playlists', JSON.stringify({
      entries: [
        {
          _id: 'davetv-vault-apollo',
          type: 'davetv-vault',
          providerId: 'apollo',
          host: 'davetv-vault://apollo',
          title: 'Apollo Group TV',
          username: 'DaveTV',
          password: 'vault',
          addedAt: now,
          lastUsedAt: now,
        },
        {
          _id: 'davetv-vault-xtremehd',
          type: 'davetv-vault',
          providerId: 'xtremehd',
          host: 'davetv-vault://xtremehd',
          title: 'XtremeHD',
          username: 'DaveTV',
          password: 'vault',
          addedAt: now,
          lastUsedAt: now,
        },
      ],
      selectedId: selectedProvider === 'xtremehd'
        ? 'davetv-vault-xtremehd'
        : 'davetv-vault-apollo',
    }));

    try {
      await Promise.race([
        new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('xt_cache');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {}
  }, provider);
}

async function proveProvider(page, provider, screenshotName) {
  await seedProvider(page, provider);
  await page.goto(`${TARGET}?proof=${provider}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });

  const buttons = page.locator('.channel-row .play-btn');
  await buttons.first().waitFor({ timeout: 50000 });
  const candidateCount = Math.min(await buttons.count(), Number(process.env.EXTREME_PLAYBACK_ATTEMPTS || 10));
  const attempts = [];
  let selectedChannel = '';

  for (let index = 0; index < candidateCount; index += 1) {
    const button = buttons.nth(index);
    const channelText = (await button.innerText()).trim();
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 10000 });

    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) return;
      try {
        video.muted = false;
        video.volume = 1;
        void video.play?.();
      } catch {}
    });

    try {
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        if (!video) return false;
        try {
          video.muted = false;
          video.volume = 1;
          if (video.paused) void video.play?.();
        } catch {}
        return Boolean(
          video.readyState >= 2 &&
          video.videoWidth > 0 &&
          video.currentTime > 0.5 &&
          video.muted === false &&
          video.volume > 0
        );
      }, { timeout: Number(process.env.EXTREME_PLAYBACK_TIMEOUT_MS || 30000) });

      selectedChannel = channelText;
      attempts.push({
        index,
        channel: channelText,
        result: 'playable',
        video: await page.evaluate(() => {
          const video = document.querySelector('video');
          return {
            readyState: video?.readyState ?? 0,
            currentTime: Number(video?.currentTime ?? 0),
            videoWidth: video?.videoWidth ?? 0,
            videoHeight: video?.videoHeight ?? 0,
            muted: Boolean(video?.muted),
            volume: Number(video?.volume ?? 0),
            paused: Boolean(video?.paused),
            error: video?.error ? { code: video.error.code, message: video.error.message } : null,
          };
        }),
      });
      break;
    } catch {
      attempts.push({
        index,
        channel: channelText,
        result: 'skipped',
        video: await page.evaluate(() => {
          const video = document.querySelector('video');
          return {
            readyState: video?.readyState ?? 0,
            currentTime: Number(video?.currentTime ?? 0),
            videoWidth: video?.videoWidth ?? 0,
            videoHeight: video?.videoHeight ?? 0,
            muted: Boolean(video?.muted),
            volume: Number(video?.volume ?? 0),
            paused: Boolean(video?.paused),
            error: video?.error ? { code: video.error.code, message: video.error.message } : null,
          };
        }),
      });
    }
  }

  if (!selectedChannel) {
    selectedChannel = attempts[0]?.channel || '';
  }

  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, screenshotName), fullPage: true });

  return page.evaluate(({ selectedChannelText, attemptList }) => {
    const video = document.querySelector('video');
    const audioBytes = performance
      .getEntriesByType('resource')
      .filter((entry) => /provider-vault\/(?:segment|aac-hls|stream)/.test(entry.name))
      .reduce((sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0), 0);
    return {
      firstChannel: attemptList[0]?.channel || '',
      selectedChannel: selectedChannelText,
      attempts: attemptList,
      readyState: video?.readyState ?? 0,
      currentTime: Number(video?.currentTime ?? 0),
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      muted: Boolean(video?.muted),
      volume: Number(video?.volume ?? 0),
      paused: Boolean(video?.paused),
      mediaBytes: audioBytes,
      currentSrcIsBlob: Boolean(video?.currentSrc?.startsWith('blob:')),
      body: document.body.innerText.slice(0, 1500),
    };
  }, { selectedChannelText: selectedChannel, attemptList: attempts });
}

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  ignoreHTTPSErrors: true,
});
await addAuthCookies(context);
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const ignoredRequestFailures = [];
const streamEvents = [];

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
page.on('requestfailed', (request) => {
  const url = request.url();
  const failure = request.failure()?.errorText || 'unknown';
  const record = { url: sanitizeUrl(url), failure };

  if (
    failure === 'net::ERR_ABORTED' &&
    (
      url.includes('/api/provider-vault/catalog') ||
      url.includes('/api/provider-vault/image') ||
      url.includes('/api/provider-vault/segment') ||
      url.includes('/api/provider-vault/aac-hls') ||
      url.includes('/cdn-cgi/rum')
    )
  ) {
    ignoredRequestFailures.push(record);
    return;
  }

  failedRequests.push(record);
});
page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/api/provider-vault/stream') || url.includes('/api/provider-vault/aac-hls')) {
    const parsed = new URL(url);
    streamEvents.push({
      kind: url.includes('/api/provider-vault/aac-hls') ? 'aac-hls' : 'stream',
      provider: parsed.searchParams.get('provider') || '',
      idState: parsed.searchParams.get('id') ? 'present' : 'empty',
      status: response.status(),
      url: sanitizeUrl(url),
    });
  }
  if (url.includes('/api/provider-vault/segment')) {
    streamEvents.push({
      kind: 'segment',
      status: response.status(),
      url: sanitizeUrl(url),
    });
  }
});

const apollo = await proveProvider(page, 'apollo', 'extreme-infinitv-apollo-player.png');
const xtremehd = await proveProvider(page, 'xtremehd', 'extreme-infinitv-xtremehd-player.png');
const text = await page.locator('body').innerText();

const summary = {
  generatedAt: new Date().toISOString(),
  target: TARGET,
  apollo,
  xtremehd,
  streamEvents,
  consoleErrors,
  pageErrors,
  failedRequests,
  ignoredRequestFailures,
  textChecks: {
    english: text.includes('Live TV') && text.includes('Settings'),
    firstRowsCurated:
      (apollo.firstChannel.includes('USA') || apollo.firstChannel.includes('|US|')) &&
      (xtremehd.firstChannel.includes('USA') || xtremehd.firstChannel.includes('|US|')),
    noUnsupportedScheme: !text.includes('embedded player. Set up MPV'),
    noPortuguese: !/Bem-vindo|Conectar/i.test(text),
    noRawProviderMarkers: !/####|\|AR\||\|MULTI\|/.test(apollo.body + '\n' + xtremehd.body),
  },
};

summary.pass =
  apollo.readyState >= 2 &&
  xtremehd.readyState >= 2 &&
  apollo.currentTime > 1 &&
  xtremehd.currentTime > 1 &&
  apollo.videoWidth > 0 &&
  xtremehd.videoWidth > 0 &&
  apollo.muted === false &&
  xtremehd.muted === false &&
  apollo.volume > 0 &&
  xtremehd.volume > 0 &&
  streamEvents.some((event) =>
    (event.kind === 'stream' || event.kind === 'aac-hls') &&
    event.provider === 'apollo' &&
    event.status === 200 &&
    event.idState === 'present'
  ) &&
  streamEvents.some((event) =>
    (event.kind === 'stream' || event.kind === 'aac-hls') &&
    event.provider === 'xtremehd' &&
    event.status === 200 &&
    event.idState === 'present'
  ) &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0 &&
  failedRequests.length === 0 &&
  Object.values(summary.textChecks).every(Boolean);

await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

await browser.close();
process.exit(summary.pass ? 0 : 1);
