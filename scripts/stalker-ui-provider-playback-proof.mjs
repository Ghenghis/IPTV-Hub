import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir =
  process.env.OUT_DIR ||
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/stalker-ui-provider-playback-proof-20260527';
const cookiePath =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const appUrl = 'https://stalker-ui.daveai.tech/?proof=' + Date.now();
const providers = [
  { id: 'apollo', name: 'Apollo Group TV', channelId: 'apollo-live-0', candidates: [/FOX 15 HD/i, /NBC 9 HD/i, /\|US\|/i] },
  { id: 'xtremehd', name: 'XtremeHD', channelId: 'xtremehd-live-3', candidates: [/USA American Heroes/i, /USA AMC/i, /USA A&E/i] },
];

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '[token]');
    if (parsed.searchParams.has('src')) parsed.searchParams.set('src', '[image]');
    return parsed.toString();
  } catch {
    return String(url || '').slice(0, 180);
  }
}

async function authCookies() {
  const raw = JSON.parse(await fs.readFile(cookiePath, 'utf8'));
  const storedExpires = Math.floor(new Date(raw.expiresAt).getTime() / 1000);
  const expires =
    Number.isFinite(storedExpires) && storedExpires > Math.floor(Date.now() / 1000) + 60
      ? storedExpires
      : Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  return [
    {
      name: raw.cookieName,
      value: raw.cookieValue,
      domain: '.daveai.tech',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      expires,
    },
  ];
}

async function waitForVideo(page) {
  const deadline = Date.now() + 35000;
  let last = [];
  while (Date.now() < deadline) {
    await page
      .locator('video')
      .evaluateAll((videos) => {
        for (const video of videos) {
          video.muted = false;
          video.volume = 1;
          if (video.paused) video.play().catch(() => {});
        }
      })
      .catch(() => {});
    last = await page.locator('video').evaluateAll((videos) =>
      videos.map((video) => ({
        readyState: video.readyState,
        paused: video.paused,
        currentTime: video.currentTime,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        muted: video.muted,
        volume: video.volume,
        audioDecodedByteCount: Number(video.webkitAudioDecodedByteCount || 0),
        src: video.currentSrc || video.src,
      })),
    );
    if (
      last.some(
        (video) =>
          video.readyState >= 3 &&
          video.videoWidth >= 640 &&
          video.videoHeight >= 360 &&
          video.currentTime > 0 &&
          video.muted === false &&
          video.volume > 0 &&
          video.audioDecodedByteCount > 0,
      )
    ) {
      return last;
    }
    await page.waitForTimeout(1000);
  }
  return last;
}

async function clickCandidateChannel(page, provider) {
  await page
    .waitForFunction(() => /channels available|All Channels/i.test(document.body.innerText || ''), {
      timeout: 60000,
    })
    .catch(() => {});

  for (const candidate of provider.candidates) {
    const match = page.getByText(candidate).first();
    if (await match.isVisible().catch(() => false)) {
      await match.click({ timeout: 8000 });
      return String(candidate);
    }
  }
  const clicked = await page.evaluate((providerId) => {
    const needle = providerId === 'apollo' ? /\|US\||FOX|NBC/i : /USA |AMC|A&E/i;
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, li'));
    const match = nodes.find((node) => needle.test((node.textContent || '').replace(/\s+/g, ' ')));
    if (!match) return '';
    const clickable = match.closest('button, [role="button"]') || match;
    clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return (match.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  }, provider.id);
  if (!clicked) throw new Error(`No visible ${provider.name} channel row found`);
  return clicked;
}

async function runProvider(browser, provider) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(await authCookies());
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const responses = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 400));
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const url = request.url();
    const err = request.failure()?.errorText || '';
    const ignorable =
      url.includes('/cdn-cgi/') ||
      url.includes('/socket.io/') ||
      url.includes('/api/provider-vault/providers') ||
      url.includes('/api/provider-vault/catalog') ||
      url.includes('/api/provider-vault/stream') ||
      url.includes('/api/provider-vault/segment') ||
      url.includes('/api/provider-vault/aac-hls');
    if (!ignorable || err !== 'net::ERR_ABORTED') {
      failedRequests.push({ url: sanitizeUrl(url), error: err });
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/provider-vault/')) {
      responses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
  });

  await page.goto(appUrl + '&provider=' + provider.id, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.evaluate((channelId) => {
    localStorage.setItem('preferredContentType', 'tv');
    localStorage.setItem('lastPlayedTvChannelId', channelId);
  }, provider.channelId);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByText(/^TV$/).first().click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  let clicked = provider.channelId;
  if (!(await page.locator('video').count().catch(() => 0))) {
    clicked = await clickCandidateChannel(page, provider);
  }
  const video = await waitForVideo(page);
  const text = await page.locator('body').innerText().catch(() => '');
  const screenshot = path.join(outDir, `stalker-ui-${provider.id}-player.png`);
  await page.screenshot({ path: screenshot, fullPage: true });

  const stream200 = responses.filter(
    (item) =>
      item.status === 200 &&
      (item.url.includes('/api/provider-vault/stream') ||
        item.url.includes('/api/provider-vault/aac-hls')) &&
      item.url.includes(`provider=${provider.id}`),
  ).length;
  const segment200 = responses.filter(
    (item) => item.status === 200 && item.url.includes('/api/provider-vault/segment'),
  ).length;
  const image200 = responses.filter(
    (item) => item.status === 200 && item.url.includes('/api/provider-vault/image'),
  ).length;

  await context.close();
  const ok =
    stream200 > 0 &&
      video.some(
        (item) =>
          item.readyState >= 3 &&
          item.videoWidth > 0 &&
          item.videoHeight > 0 &&
          item.muted === false &&
          item.volume > 0 &&
          item.audioDecodedByteCount > 0,
      ) &&
    !/something went wrong|client-side exception|portal unavailable/i.test(text) &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    failedRequests.length === 0;

  return {
    provider: provider.id,
    ok,
    clicked,
    stream200,
    segment200,
    image200,
    video,
    screenshot,
    consoleErrors,
    pageErrors,
    failedRequests,
    textSample: text.slice(0, 600),
  };
}

await fs.mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  for (const provider of providers) {
    results.push(await runProvider(browser, provider));
  }
  const summary = {
    ok: results.every((result) => result.ok),
    generatedAt: new Date().toISOString(),
    appUrl,
    results,
  };
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
} finally {
  await browser.close();
}
