import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
const outDir =
  process.env.OUT_DIR ||
  `C:/Users/Admin/Downloads/VPS/_visual_artifacts/zero-player-full-provider-proof-${stamp}`;
const cookiePath =
  'C:/Users/Admin/Downloads/VPS/_visual_artifacts/apps-provider-ready-sweep-20260526/auth-cookie.json';
const buildId = '20260529-provider-vault-direct32';
const appUrl = `${process.env.ZERO_PLAYER_URL || 'https://apps.daveai.tech/iptv-player-zero/'}?full_provider_proof=${Date.now()}`;
const providers = [
  { id: 'apollo', name: 'Apollo Group TV', minChannels: 4000, minMovies: 1000, minSeries: 700 },
  { id: 'xtremehd', name: 'XtremeHD', minChannels: 4000, minMovies: 1000, minSeries: 700 },
];

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of ['provider', 'token', 'src']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, `[${key}]`);
    }
    return parsed.toString();
  } catch {
    return String(url || '').slice(0, 180);
  }
}

async function authCookies() {
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(cookiePath, 'utf8'));
  } catch {
    return [];
  }
  const name = raw.cookieName || raw.name || '__Secure-daveai_session';
  const value = raw.cookieValue || raw.value;
  const expires = raw.expiresAt ? Math.floor(new Date(raw.expiresAt).getTime() / 1000) : undefined;
  return [
    { name, value, domain: '.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
    { name, value, domain: 'apps.daveai.tech', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires },
  ];
}

async function resetState(page) {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(async (buildIdForReset) => {
    for (const key of Object.keys(localStorage)) {
      if (
        key.startsWith('ipz_') ||
        key.includes('playlist') ||
        key.includes('provider') ||
        key.includes('i18next')
      ) {
        localStorage.removeItem(key);
      }
    }
    sessionStorage.clear();
    localStorage.setItem(`ipz_daveai_repair_attempts_${buildIdForReset}`, '0');
    for (const dbName of ['ipz-db', 'iptv_player_zero', 'iptv-player-zero']) {
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    }
    for (const registration of await navigator.serviceWorker.getRegistrations().catch(() => [])) {
      if (String(registration.scope || '').includes('iptv-player-zero')) {
        await registration.unregister().catch(() => {});
      }
    }
  }, buildId);
}

async function state(page, includeApiForProvider = '') {
  return page.evaluate(async ({ providersForEval, includeApiForProvider }) => {
    const text = document.body.innerText || '';
    const playlists =
      window.Store && window.Store.getPlaylists
        ? await window.Store.getPlaylists().catch(() => [])
        : [];
    const counts = {};
    const samples = {};
    for (const provider of providersForEval) {
      const playlistId = `daveai-provider-${provider.id}`;
      const rows =
        window.Store && window.Store.getChannels
          ? await window.Store.getChannels(playlistId).catch(() => [])
          : [];
      counts[playlistId] = Array.isArray(rows) ? rows.length : 0;
      samples[playlistId] = Array.isArray(rows)
        ? rows.slice(0, 8).map((row) => ({
            name: row.name,
            originalName: row.original_name,
            type: row.type,
            category: row.category,
            group: row.group || row.group_title,
            providerId: row.provider_id,
            providerName: row.provider_name,
            providerTag: row.daveai_provider_tag,
            quality: row.quality,
            logo: Boolean(row.logo || row.icon || row.tvg_logo),
            urlKind: String(row.url || row.stream_url || '').includes('/api/provider-vault')
              ? 'provider-vault'
              : row.url || row.stream_url
                ? 'other'
                : 'missing',
          }))
        : [];
    }
    const combinedRows =
      window.Store && window.Store.getChannels
        ? await window.Store.getChannels('daveai-provider-combined-tagged').catch(() => [])
        : [];
    const videos = Array.from(document.querySelectorAll('video')).map((video) => ({
      readyState: video.readyState,
      networkState: video.networkState,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      width: video.videoWidth,
      height: video.videoHeight,
      currentSrcKind: String(video.currentSrc || '').includes('/api/provider-vault')
        ? 'provider-vault'
        : String(video.currentSrc || '').startsWith('blob:')
          ? 'blob'
          : video.currentSrc
            ? 'other'
            : '',
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
    }));
    const api = {};
    if (includeApiForProvider && window.XtreamClient) {
      for (const provider of providersForEval) {
        if (provider.id !== includeApiForProvider) continue;
        const playlistId = `daveai-provider-${provider.id}`;
        const [movieCats, movies, seriesCats, series] = await Promise.all([
          window.XtreamClient.getMovieCategories(playlistId).catch((error) => ({ error: String(error && error.message || error) })),
          window.XtreamClient.listMovies({ playlist_id: playlistId }).catch((error) => ({ error: String(error && error.message || error) })),
          window.XtreamClient.getSeriesCategories(playlistId).catch((error) => ({ error: String(error && error.message || error) })),
          window.XtreamClient.listSeries({ playlist_id: playlistId }).catch((error) => ({ error: String(error && error.message || error) })),
        ]);
        const movieRows = Array.isArray(movies) ? movies : [];
        const seriesRows = Array.isArray(series) ? series : [];
        api[playlistId] = {
          movieCategories: Array.isArray(movieCats) ? movieCats.length : 0,
          movies: movieRows.length,
          movies2026: movieRows.filter((item) => /2026/.test(String(item && item.name || ''))).slice(0, 10).map((item) => item.name),
          movieArtwork: movieRows.filter((item) => Boolean(item && (item.stream_icon || item.cover))).length,
          seriesCategories: Array.isArray(seriesCats) ? seriesCats.length : 0,
          series: seriesRows.length,
          seriesArtwork: seriesRows.filter((item) => Boolean(item && (item.stream_icon || item.cover))).length,
          errors: [movieCats, movies, seriesCats, series].filter((item) => item && item.error).map((item) => item.error),
        };
      }
    }
    return {
      href: location.href,
      title: document.title,
      textSample: text.slice(0, 5000),
      build: localStorage.getItem('ipz_provider_autoload_build_id'),
      defaultPlaylist: localStorage.getItem('ipz_default_playlist_id'),
      providerLast: localStorage.getItem('ipz_provider_quickstart_last_playlist_id'),
      displayMode: localStorage.getItem('ipz_provider_display_mode'),
      selectedLive: window.__ZERO_PROOF_SELECTED_LIVE__ || null,
      language: {
        html: document.documentElement.lang,
        i18next: localStorage.getItem('i18nextLng'),
        ipz: localStorage.getItem('ipz_ui_language'),
      },
      hasFatal: /Something went wrong|Cannot read properties|client-side exception|TypeError/i.test(text),
      hasPaid: /Upgrade to Pro|Lifetime Unlock|Stripe|\$12\.99|purchase|72-hour PRO trial|premium features/i.test(text),
      hasNonEnglishUi: /Bem-vindo|Conectar|Senha|Usu[aá]rio|Ocorreu|Mensagem|Recarregar App/i.test(text),
      hasLimitedCopy: /1 playlist|3 hours|free mode|trial starts/i.test(text),
      hasProviderPanel: /DaveAI Providers/i.test(text),
      playlists: playlists.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        type: playlist.type,
        source: playlist.source,
        mode: playlist.daveai_provider_mode,
      })),
      combined: {
        count: Array.isArray(combinedRows) ? combinedRows.length : 0,
        hasApolloTag: Array.isArray(combinedRows) && combinedRows.some((row) => row.provider_id === 'apollo'),
        hasXtremeTag: Array.isArray(combinedRows) && combinedRows.some((row) => row.provider_id === 'xtremehd'),
        sample: Array.isArray(combinedRows)
          ? combinedRows.slice(0, 8).map((row) => ({
              name: row.name,
              providerId: row.provider_id,
              providerName: row.provider_name,
              group: row.group || row.group_title,
              quality: row.quality,
            }))
          : [],
      },
      counts,
      samples,
      videos,
      api,
    };
  }, { providersForEval: providers, includeApiForProvider });
}

async function waitForFullProviderRows(page) {
  await page.waitForFunction(
    () => window.Store && typeof window.Store.getChannels === 'function',
    undefined,
    { timeout: 60000 }
  );
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < 180000) {
    last = await state(page);
    const ready =
      last.build === buildId &&
      providers.every(
        (provider) => last.counts[`daveai-provider-${provider.id}`] >= provider.minChannels
      );
    if (ready) return last;
    if (last.hasFatal) throw new Error(`Zero fatal screen while importing: ${last.textSample.slice(0, 300)}`);
    await page.waitForTimeout(3000);
  }
  throw new Error(
    `Timed out waiting for full provider rows: ${JSON.stringify({
      build: last && last.build,
      counts: last && last.counts,
      sample: last && last.textSample && last.textSample.slice(0, 220),
    })}`
  );
}

async function importSeparatedForProof(page) {
  await page.waitForFunction(
    () =>
      window.Store &&
      typeof window.Store.getChannels === 'function' &&
      window.IPZProviderVaultQuickstart &&
      typeof window.IPZProviderVaultQuickstart.importSeparatedProviders === 'function',
    undefined,
    { timeout: 60000 }
  );
  return page.evaluate(async ({ providersForEval, buildIdForEval }) => {
    const messages = [];
    const result = await window.IPZProviderVaultQuickstart.importSeparatedProviders(
      providersForEval,
      (message) => messages.push(message),
      { reload: false }
    );
    localStorage.setItem('ipz_provider_autoload_build_id', buildIdForEval);
    return { result, messages };
  }, { providersForEval: providers, buildIdForEval: buildId });
}

async function waitForProviderReloadToSettle(page) {
  await page.waitForTimeout(3500);
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await page.waitForFunction(
    (buildIdForWait) =>
      window.Store &&
      typeof window.Store.getChannels === 'function' &&
      localStorage.getItem('ipz_provider_autoload_build_id') === buildIdForWait,
    buildId,
    { timeout: 60000 }
  );
  await page.waitForTimeout(500);
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
  await page.waitForTimeout(2000);
}

async function ensureCombinedTaggedMode(page) {
  return page.evaluate(async ({ providersForEval }) => {
    if (!window.IPZProviderVaultQuickstart || !window.IPZProviderVaultQuickstart.importCombinedTaggedProviders) {
      throw new Error('Combined tagged importer is not exposed');
    }
    const messages = [];
    const result = await window.IPZProviderVaultQuickstart.importCombinedTaggedProviders(
      providersForEval,
      (message) => messages.push(message),
      { reload: false }
    );
    const rows = await window.Store.getChannels('daveai-provider-combined-tagged');
    return {
      result,
      messages,
      count: Array.isArray(rows) ? rows.length : 0,
      hasApolloTag: Array.isArray(rows) && rows.some((row) => row.provider_id === 'apollo' && /\[Apollo Group TV\]/.test(row.name || '')),
      hasXtremeTag: Array.isArray(rows) && rows.some((row) => row.provider_id === 'xtremehd' && /\[XtremeHD\]/.test(row.name || '')),
      hasTaggedGroups: Array.isArray(rows) && rows.some((row) => /Apollo Group TV \/|XtremeHD \//.test(row.group || row.group_title || '')),
      hasQualityTags: Array.isArray(rows) && rows.some((row) => Boolean(row.quality)),
    };
  }, { providersForEval: providers });
}

async function pickPlayableLiveChannel(page, provider) {
  return page.evaluate(async ({ providerForEval }) => {
    const playlistId = `daveai-provider-${providerForEval.id}`;
    const rows = await window.Store.getChannels(playlistId);
    const liveRows = (Array.isArray(rows) ? rows : []).filter((row) => {
      const url = String(row && (row.url || row.stream_url) || '');
      const name = String(row && row.name || '');
      return row && row.type === 'live' && /\/api\/provider-vault\/(stream|aac-hls)/.test(url) && !/^#+/.test(name.trim());
    });
    const preferences = providerForEval.id === 'apollo'
      ? [/SYFY HD/i, /ESPN HD/i, /AMC HD/i, /CNN HD/i, /FOX/i]
      : [/^USA AMC$/i, /USA A&E/i, /USA CNN/i, /USA FOX/i, /USA ESPN/i];
    const scored = liveRows
      .map((row, index) => {
        const name = String(row.name || '');
        const url = String(row.url || row.stream_url || '');
        const pref = preferences.findIndex((pattern) => pattern.test(name));
        const browserHlsScore = providerForEval.id === 'apollo' && /\/api\/provider-vault\/aac-hls\b/i.test(url) ? -20 : 0;
        const hevcRiskScore = /\b(4K|UHD|2160P?)\b/i.test(name) ? 25 : 0;
        return { row, score: (pref < 0 ? 50 : pref) + browserHlsScore + hevcRiskScore + index / 100000 };
      })
      .sort((a, b) => a.score - b.score);
    if (!scored.length) throw new Error('No provider-vault live rows found for ' + providerForEval.name);
    const row = scored[0].row;
    const parsed = new URL(row.url || row.stream_url, location.origin);
    return {
      playlistId,
      name: row.name,
      originalName: row.original_name,
      providerId: row.provider_id,
      providerName: row.provider_name,
      group: row.group || row.group_title,
      quality: row.quality,
      url: row.url || row.stream_url,
      probePath: `/api/provider-vault/probe?${parsed.searchParams.toString()}`,
    };
  }, { providerForEval: provider });
}

async function clickPlayableLiveChannel(page, provider) {
  await page.getByRole('button', { name: 'Got it' }).click({ force: true, timeout: 3000 }).catch(() => {});
  await page.mouse.click(80, 80).catch(() => {});
  const selected = await pickPlayableLiveChannel(page, provider);
  const probe = await page.evaluate(async (probePath) => {
    const response = await fetch(probePath, { cache: 'no-store', credentials: 'same-origin' });
    return response.json();
  }, selected.probePath);
  if (!probe || probe.ok !== true) {
    throw new Error(`Media probe failed for ${provider.name}: ${JSON.stringify(probe).slice(0, 500)}`);
  }
  await page.evaluate(async ({ selectedForEval, probeForEval }) => {
    window.__ZERO_PROOF_SELECTED_LIVE__ = Object.assign({}, selectedForEval, {
      probe: {
        ok: probeForEval.ok,
        sourceType: probeForEval.sourceType,
        contentType: probeForEval.contentType,
        mediaType: probeForEval.mediaType,
        firstBytes: probeForEval.firstBytes,
        playable: probeForEval.playable,
      },
    });
    if (!window.PlayerShim || !window.PlayerShim.play) {
      throw new Error('PlayerShim.play is not available');
    }
    await window.PlayerShim.play(selectedForEval.url, { type: 'live', live: true });
    for (const video of document.querySelectorAll('video')) {
      video.muted = false;
      video.volume = 1;
      video.play().catch(() => {});
    }
  }, { selectedForEval: selected, probeForEval: probe });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('video')).some(
        (video) =>
          !video.error &&
          video.readyState >= 1 &&
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          (String(video.currentSrc || '').includes('/api/provider-vault') || String(video.currentSrc || '').startsWith('blob:'))
      ),
    undefined,
    { timeout: 90000 }
  );
  await page.evaluate(() => {
    for (const video of document.querySelectorAll('video')) {
      video.muted = false;
      video.volume = 1;
      video.play().catch(() => {});
    }
  });
  await page.waitForTimeout(2500);
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];

for (const [providerIndex, provider] of providers.entries()) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.addCookies(await authCookies());
  await context.addInitScript(() => {
    window.__IPZ_PROVIDER_PROOF_DISABLE_AUTOLOAD__ = true;
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const streamResponses = [];
  const badResponses = [];

  page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !/set_preview_bounds|Autoplay/i.test(text)) {
      consoleErrors.push(text.slice(0, 800));
    }
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/provider-vault/stream') || url.includes('/api/provider-vault/segment') || url.includes('/api/provider-vault/aac-hls')) {
      streamResponses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
    if (response.status() >= 400 && /apps\.daveai\.tech/.test(url)) {
      badResponses.push({ status: response.status(), url: sanitizeUrl(url) });
    }
  });

  let actionError = null;
  let combinedProof = null;
  try {
    await resetState(page);
    await page.goto(appUrl + `&provider=${provider.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await importSeparatedForProof(page);
    await waitForFullProviderRows(page);
    await activateProvider(page, provider);
    await clickPlayableLiveChannel(page, provider);
  } catch (error) {
    actionError = String(error && error.message ? error.message : error);
  }

  const finalState = await state(page, provider.id);
  const screenshot = path.join(outDir, `zero-player-${provider.id}-full-provider.png`);
  let screenshotError = null;
  try {
    await page.screenshot({ path: screenshot, fullPage: true, timeout: 60000 });
  } catch (error) {
    screenshotError = String(error && error.message ? error.message : error);
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-viewport.png'), fullPage: false, timeout: 15000 }).catch(() => {});
  }
  await context.close();

  const playlistId = `daveai-provider-${provider.id}`;
  const videoReady = finalState.videos.some(
    (video) =>
      !video.error &&
      video.readyState >= 1 &&
      video.width > 0 &&
      video.height > 0 &&
      ['provider-vault', 'blob'].includes(video.currentSrcKind)
  );
  const providerSamples = finalState.samples[playlistId] || [];
  const taggedRows =
    providerSamples.length > 0 &&
    providerSamples.every((row) => row.providerId === provider.id && row.providerName === provider.name && row.providerTag === provider.name);
  const ok =
    !actionError &&
    finalState.build === buildId &&
    finalState.counts[playlistId] >= provider.minChannels &&
    finalState.api[playlistId] &&
    finalState.api[playlistId].movies >= provider.minMovies &&
    finalState.api[playlistId].series >= provider.minSeries &&
    finalState.api[playlistId].movieCategories > 0 &&
    finalState.api[playlistId].seriesCategories > 0 &&
    finalState.api[playlistId].movieArtwork > 100 &&
    finalState.api[playlistId].seriesArtwork > 100 &&
    finalState.api[playlistId].errors.length === 0 &&
    finalState.playlists.some((playlist) => playlist.id === playlistId) &&
    finalState.defaultPlaylist === playlistId &&
    taggedRows &&
    finalState.selectedLive &&
    finalState.selectedLive.providerId === provider.id &&
    finalState.selectedLive.probe &&
    finalState.selectedLive.probe.ok === true &&
    !finalState.hasFatal &&
    !finalState.hasPaid &&
    !finalState.hasLimitedCopy &&
    !finalState.hasNonEnglishUi &&
    videoReady &&
    streamResponses.some((item) => item.status === 200) &&
    pageErrors.length === 0 &&
    consoleErrors.length === 0;

  results.push({
    provider: provider.id,
    ok,
    actionError,
    state: finalState,
    streamResponses,
    combinedProof,
    badResponses,
    pageErrors,
    consoleErrors,
    screenshot,
    screenshotError,
  });
}

await browser.close();

const summary = {
  ok: results.every((result) => result.ok),
  generatedAt: new Date().toISOString(),
  buildId,
  results,
};

await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    {
      ok: summary.ok,
      buildId,
      results: results.map((result) => ({
        provider: result.provider,
        ok: result.ok,
        actionError: result.actionError,
        count: result.state.counts[`daveai-provider-${result.provider}`],
        api: result.state.api[`daveai-provider-${result.provider}`],
        build: result.state.build,
        defaultPlaylist: result.state.defaultPlaylist,
        hasFatal: result.state.hasFatal,
        hasPaid: result.state.hasPaid,
        hasLimitedCopy: result.state.hasLimitedCopy,
        hasNonEnglishUi: result.state.hasNonEnglishUi,
        videos: result.state.videos,
        selectedLive: result.state.selectedLive,
        combinedProof: result.combinedProof,
        stream200: result.streamResponses.filter((item) => item.status === 200).length,
        pageErrors: result.pageErrors.length,
        consoleErrors: result.consoleErrors.length,
        screenshotError: result.screenshotError,
        screenshot: result.screenshot,
      })),
      outDir,
    },
    null,
    2
  )
);

process.exit(summary.ok ? 0 : 1);
