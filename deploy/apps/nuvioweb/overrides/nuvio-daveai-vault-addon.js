/**
 * DaveAI provider-vault virtual addon for NuvioWeb.
 *
 * Nuvio is a Stremio-style player, so Apollo/XtremeHD are exposed as a local
 * Stremio-compatible addon. Catalog and stream rows come from DaveTV's
 * authenticated provider vault; raw provider credentials never enter the page.
 */
(function (window, document) {
  'use strict';

  var ADDON_BASE = '/daveai-provider-vault-addon';
  var ADDON_URLS_KEY = 'installedAddonUrls';
  var THEME_KEY = 'themeSettings';
  var PROVIDERS = [
    { id: 'apollo', name: 'Apollo Group TV' },
    { id: 'xtremehd', name: 'XtremeHD' },
  ];
  var BUCKETS = {
    live: { type: 'tv', title: 'Live TV', limit: 1200 },
    movie: { type: 'movie', title: 'Movies', limit: 500 },
    series: { type: 'series', title: 'Series', limit: 500 },
  };
  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  var originalXhrOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype
    ? window.XMLHttpRequest.prototype.open
    : null;
  var CATALOG_CACHE_MS = 60000;
  var catalogCache = {};
  var catalogInflight = {};

  function readJson(key, fallback) {
    try {
      var raw = window.localStorage && window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      if (window.localStorage) window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {}
  }

  function ensureEnglish() {
    var settings = readJson(THEME_KEY, null);
    if (settings && settings.__profileScoped && settings.profiles) {
      settings.profiles['1'] = Object.assign({}, settings.profiles['1'] || {}, { language: 'en' });
      writeJson(THEME_KEY, settings);
      return;
    }

    var next = settings && typeof settings === 'object' ? settings : {};
    next.language = 'en';
    writeJson(THEME_KEY, next);
  }

  function ensureAddonInstalled() {
    var urls = readJson(ADDON_URLS_KEY, null);
    var changed = false;
    if (!Array.isArray(urls)) {
      urls = [ADDON_BASE];
      changed = true;
    } else {
      var before = urls.length;
      urls = urls.filter(function (url) {
        return typeof url === 'string' &&
          url.indexOf('apps.daveai.tech/api/provider-vault') === -1 &&
          url.indexOf('apps.daveai.tech/daveai-provider-vault-addon') === -1;
      });
      if (urls.length !== before) changed = true;
    }
    if (urls.indexOf(ADDON_BASE) === -1) {
      urls.unshift(ADDON_BASE);
      changed = true;
    }
    if (changed) writeJson(ADDON_URLS_KEY, urls);
  }

  function ensureDaveTvGuestMode() {
    writeJson('skipAuthQrGate', true);
    writeJson('hasSeenAuthQrOnFirstLaunch', true);
  }

  function jsonResponse(data, status) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status: status || 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
    }));
  }

  function providerApiBase() {
    return '/api/provider-vault';
  }

  function vaultCatalogUrl(providerId) {
    var params = new URLSearchParams({
      provider: providerId,
      profile: 'english',
      liveLimit: String(BUCKETS.live.limit),
      movieLimit: String(BUCKETS.movie.limit),
      seriesLimit: String(BUCKETS.series.limit),
    });
    return providerApiBase() + '/catalog?' + params.toString();
  }

  function providerById(providerId) {
    return PROVIDERS.find(function (provider) { return provider.id === providerId; }) || PROVIDERS[0];
  }

  function catalogId(providerId, bucket) {
    return providerId + '-' + bucket;
  }

  function parseCatalogId(value) {
    var raw = String(value || '');
    var provider = PROVIDERS.find(function (item) { return raw.indexOf(item.id + '-') === 0; }) || PROVIDERS[0];
    var bucket = raw.slice(provider.id.length + 1) || 'live';
    if (!BUCKETS[bucket]) bucket = 'live';
    return { provider: provider, bucket: bucket };
  }

  function parseItemId(value) {
    var parts = String(value || '').split(':');
    if (parts.length < 5 || parts[0] !== 'daveai') return null;
    var provider = providerById(parts[1]);
    var bucket = BUCKETS[parts[2]] ? parts[2] : 'live';
    var index = Math.max(0, Number(parts[3] || 0));
    return { provider: provider, bucket: bucket, index: index };
  }

  function bucketItems(catalog, bucket) {
    if (bucket === 'live') return Array.isArray(catalog.live) ? catalog.live : [];
    if (bucket === 'movie') return Array.isArray(catalog.movies) ? catalog.movies : [];
    return Array.isArray(catalog.series) ? catalog.series : [];
  }

  function isPlayableCatalogItem(item) {
    var name = safeText(item && item.name, '');
    if (!name) return false;
    if (/^#{2,}.*#{2,}$/.test(name)) return false;
    return true;
  }

  function safeText(value, fallback) {
    var out = String(value || '').trim();
    return out || fallback || '';
  }

  function itemMeta(provider, bucket, item, index) {
    var bucketInfo = BUCKETS[bucket] || BUCKETS.live;
    var name = safeText(item && item.name, bucketInfo.title + ' ' + (index + 1));
    var groupTitle = safeText(item && item.group && item.group.title, bucketInfo.title);
    var logo = safeText(item && item.tvg && item.tvg.logo, '');
    var id = ['daveai', provider.id, bucket, index, encodeURIComponent(name).slice(0, 80)].join(':');
    var isLive = bucket === 'live';
    var meta = {
      id: id,
      type: bucketInfo.type,
      name: name,
      poster: logo || null,
      background: isLive ? null : (logo || null),
      logo: logo || null,
      description: provider.name + ' - ' + groupTitle + ' via DaveAI provider vault.',
      genres: [groupTitle],
      releaseInfo: '',
    };
    if (isLive) {
      meta.posterShape = 'landscape';
      meta.videos = [{
        id: id,
        title: name,
        season: 1,
        episode: 1,
        thumbnail: logo || null,
        description: meta.description,
      }];
    }
    return meta;
  }

  function fetchCatalog(providerId) {
    if (!originalFetch) return Promise.reject(new Error('fetch unavailable'));
    var cached = catalogCache[providerId];
    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.data);
    }
    if (catalogInflight[providerId]) return catalogInflight[providerId];

    catalogInflight[providerId] = originalFetch(vaultCatalogUrl(providerId), {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).then(function (response) {
      if (!response.ok) throw new Error('Provider vault HTTP ' + response.status);
      return response.json();
    }).then(function (data) {
      catalogCache[providerId] = {
        data: data,
        expiresAt: Date.now() + CATALOG_CACHE_MS,
      };
      delete catalogInflight[providerId];
      return data;
    }).catch(function (error) {
      delete catalogInflight[providerId];
      throw error;
    });
    return catalogInflight[providerId];
  }

  function manifest() {
    var catalogs = [];
    PROVIDERS.forEach(function (provider) {
      Object.keys(BUCKETS).forEach(function (bucket) {
        catalogs.push({
          type: BUCKETS[bucket].type,
          id: catalogId(provider.id, bucket),
          name: provider.name + ' - ' + BUCKETS[bucket].title,
          extra: [{ name: 'skip' }],
        });
      });
    });

    return {
      id: 'tech.daveai.provider-vault',
      version: '1.0.0',
      name: 'DaveAI IPTV',
      description: 'Apollo Group TV and XtremeHD through DaveAI provider vault.',
      resources: [
        { name: 'catalog', types: ['tv', 'movie', 'series'] },
        { name: 'meta', types: ['tv', 'movie', 'series'] },
        { name: 'stream', types: ['tv', 'movie', 'series'] },
      ],
      types: ['tv', 'movie', 'series'],
      catalogs: catalogs,
    };
  }

  function handleCatalog(match) {
    var catalog = parseCatalogId(decodeURIComponent(match.catalogId));
    var skip = Math.max(0, Number(match.skip || 0));
    return fetchCatalog(catalog.provider.id).then(function (data) {
      var metas = bucketItems(data, catalog.bucket)
        .map(function (item, index) { return { item: item, index: index }; })
        .filter(function (entry) { return isPlayableCatalogItem(entry.item); })
        .slice(skip, skip + 100)
        .map(function (entry) {
          return itemMeta(catalog.provider, catalog.bucket, entry.item, entry.index);
        });
      return jsonResponse({ metas: metas });
    }).catch(function () {
      return jsonResponse({ metas: [] });
    });
  }

  function handleMeta(match) {
    var parsed = parseItemId(decodeURIComponent(match.id));
    if (!parsed) return jsonResponse({ meta: null }, 404);
    return fetchCatalog(parsed.provider.id).then(function (data) {
      var item = bucketItems(data, parsed.bucket)[parsed.index];
      if (!item) return jsonResponse({ meta: null }, 404);
      return jsonResponse({ meta: itemMeta(parsed.provider, parsed.bucket, item, parsed.index) });
    }).catch(function () {
      return jsonResponse({ meta: null }, 404);
    });
  }

  function handleStream(match) {
    var parsed = parseItemId(decodeURIComponent(match.id));
    if (!parsed) return jsonResponse({ streams: [] });
    return fetchCatalog(parsed.provider.id).then(function (data) {
      var item = bucketItems(data, parsed.bucket)[parsed.index];
      var url = safeText(item && item.url, '');
      if (!url || url.indexOf('/api/provider-vault/') !== 0) {
        return jsonResponse({ streams: [] });
      }
      var meta = itemMeta(parsed.provider, parsed.bucket, item, parsed.index);
      return jsonResponse({
        streams: [{
          name: parsed.provider.name,
          title: meta.name,
          description: meta.description,
          url: url,
          behaviorHints: { notWebReady: false },
        }],
      });
    }).catch(function () {
      return jsonResponse({ streams: [] });
    });
  }

  function currentDaveAiItemId() {
    return window.__daveAiNuvioSelectedItemId || '';
  }

  function rememberDaveAiItem(node) {
    if (!node || !node.getAttribute) return;
    var itemId = node.getAttribute('data-item-id') || '';
    if (itemId.indexOf('daveai:') !== 0) return;
    window.__daveAiNuvioSelectedItemId = itemId;
  }

  function activeVideoHasSource() {
    return Array.prototype.some.call(document.querySelectorAll('video'), function (video) {
      return Boolean(video.currentSrc || video.src || video.dataset.daveaiProviderVaultSrc);
    });
  }

  function removeDaveAiFallbackPlayer() {
    var existing = document.getElementById('daveai-nuvio-provider-player');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function resolveVaultItem(itemId) {
    var parsed = parseItemId(decodeURIComponent(itemId || ''));
    if (!parsed) return Promise.reject(new Error('Missing DaveAI item id'));
    return fetchCatalog(parsed.provider.id).then(function (data) {
      var item = bucketItems(data, parsed.bucket)[parsed.index];
      if (!item) throw new Error('DaveAI item not found');
      var meta = itemMeta(parsed.provider, parsed.bucket, item, parsed.index);
      return {
        provider: parsed.provider,
        bucket: parsed.bucket,
        item: item,
        meta: meta,
        url: safeText(item && item.url, ''),
      };
    });
  }

  function playWithHls(video, url) {
    if (!url) throw new Error('Missing stream URL');
    video.dataset.daveaiProviderVaultSrc = url;
    video.controls = true;
    video.autoplay = true;
    video.muted = false;
    video.volume = 1;
    video.playsInline = true;

    if (window.Hls && window.Hls.isSupported && window.Hls.isSupported() && /\.m3u8|aac-hls|\/stream\?/.test(url)) {
      if (video.__daveAiHls) {
        try { video.__daveAiHls.destroy(); } catch (error) {}
      }
      var hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
      });
      video.__daveAiHls = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
        video.play().catch(function () {});
      });
      return;
    }

    video.src = url;
    video.play().catch(function () {});
  }

  function mountDaveAiFallbackPlayer(details) {
    removeDaveAiFallbackPlayer();
    var overlay = document.createElement('div');
    overlay.id = 'daveai-nuvio-provider-player';
    overlay.innerHTML = [
      '<div class="daveai-nuvio-player-bar">',
      '  <div>',
      '    <div class="daveai-nuvio-player-provider"></div>',
      '    <div class="daveai-nuvio-player-title"></div>',
      '  </div>',
      '  <button type="button" class="daveai-nuvio-player-close" aria-label="Close player">Close</button>',
      '</div>',
      '<video class="daveai-nuvio-player-video" controls autoplay playsinline></video>',
      '<div class="daveai-nuvio-player-status">Starting provider-vault stream...</div>',
    ].join('');
    document.body.appendChild(overlay);

    var title = overlay.querySelector('.daveai-nuvio-player-title');
    var provider = overlay.querySelector('.daveai-nuvio-player-provider');
    var status = overlay.querySelector('.daveai-nuvio-player-status');
    var video = overlay.querySelector('video');
    var close = overlay.querySelector('.daveai-nuvio-player-close');
    if (title) title.textContent = details.meta.name;
    if (provider) provider.textContent = details.provider.name + ' - DaveAI Vault';
    if (close) close.addEventListener('click', removeDaveAiFallbackPlayer);
    if (video) {
      video.addEventListener('playing', function () {
        if (status) status.textContent = 'Playing';
      });
      video.addEventListener('waiting', function () {
        if (status) status.textContent = 'Buffering...';
      });
      video.addEventListener('error', function () {
        if (status) status.textContent = 'Stream error. Try another channel or reload.';
      });
      playWithHls(video, details.url);
    }
  }

  function startDaveAiFallbackPlayback(itemId) {
    if (!itemId) return;
    resolveVaultItem(itemId).then(function (details) {
      if (!details.url || details.url.indexOf('/api/provider-vault/') !== 0) return;
      mountDaveAiFallbackPlayer(details);
    }).catch(function (error) {
      console.warn('DaveAI Nuvio fallback playback failed', error);
    });
  }

  function installPlaybackFallback() {
    if (window.__daveAiNuvioPlaybackFallbackInstalled) return;
    window.__daveAiNuvioPlaybackFallbackInstalled = true;
    document.addEventListener('click', function (event) {
      var detailTarget = event.target && event.target.closest
        ? event.target.closest('[data-action="openDetail"][data-item-id^="daveai:"]')
        : null;
      if (detailTarget) rememberDaveAiItem(detailTarget);

      var playTarget = event.target && event.target.closest
        ? event.target.closest('[data-action="playDefault"]')
        : null;
      if (!playTarget) return;
      var itemId = currentDaveAiItemId();
      if (!itemId) return;
      window.setTimeout(function () {
        if (!activeVideoHasSource()) startDaveAiFallbackPlayback(itemId);
      }, 500);
    }, true);
  }

  function routeVirtualAddon(input) {
    var raw = typeof input === 'string' ? input : input && input.url;
    if (!raw) return null;
    var url;
    try {
      url = new URL(raw, window.location.origin);
    } catch (error) {
      return null;
    }
    if (url.pathname === ADDON_BASE + '/manifest.json') {
      return jsonResponse(manifest());
    }
    var catalogMatch = url.pathname.match(new RegExp('^' + ADDON_BASE + '/catalog/([^/]+)/([^/.]+)(?:/(?:skip=)?([0-9]+))?\\.json$'));
    if (catalogMatch) {
      return handleCatalog({
        type: catalogMatch[1],
        catalogId: catalogMatch[2],
        skip: catalogMatch[3] || '0',
      });
    }
    var metaMatch = url.pathname.match(new RegExp('^' + ADDON_BASE + '/meta/([^/]+)/(.+)\\.json$'));
    if (metaMatch) {
      return handleMeta({ type: metaMatch[1], id: metaMatch[2] });
    }
    var streamMatch = url.pathname.match(new RegExp('^' + ADDON_BASE + '/stream/([^/]+)/(.+)\\.json$'));
    if (streamMatch) {
      return handleStream({ type: streamMatch[1], id: streamMatch[2] });
    }
    return null;
  }

  function rewriteLegacyProviderVaultRequest(input) {
    var raw = typeof input === 'string' ? input : input && input.url;
    if (!raw || raw.indexOf('https://apps.daveai.tech/api/provider-vault') !== 0) return null;
    var rewritten = raw.replace('https://apps.daveai.tech/api/provider-vault', providerApiBase());
    if (typeof input === 'string') return rewritten;
    try {
      return new Request(rewritten, input);
    } catch (error) {
      return rewritten;
    }
  }

  function routeHostedRpcNoise(input) {
    var raw = typeof input === 'string' ? input : input && input.url;
    if (!raw) return null;
    try {
      var url = new URL(raw, window.location.origin);
      if (url.pathname === '/rest/v1/rpc/get_avatar_catalog') {
        return jsonResponse([]);
      }
    } catch (error) {}
    return null;
  }

  function rewriteLegacyUrl(raw) {
    if (!raw || raw.indexOf('https://apps.daveai.tech/api/provider-vault') !== 0) return raw;
    return raw.replace('https://apps.daveai.tech/api/provider-vault', providerApiBase());
  }

  function installXhrShim() {
    if (!originalXhrOpen || window.__daveAiNuvioVaultXhrInstalled) return;
    window.__daveAiNuvioVaultXhrInstalled = true;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      var nextMethod = method;
      var nextUrl = url;
      try {
        var parsed = new URL(String(url || ''), window.location.origin);
        if (parsed.pathname === '/rest/v1/rpc/get_avatar_catalog') {
          nextMethod = 'GET';
          nextUrl = '/daveai-avatar-catalog.json';
        } else {
          nextUrl = rewriteLegacyUrl(String(url || ''));
        }
      } catch (error) {
        nextUrl = rewriteLegacyUrl(String(url || ''));
      }
      var args = Array.prototype.slice.call(arguments);
      args[0] = nextMethod;
      args[1] = nextUrl;
      return originalXhrOpen.apply(this, args);
    };
  }

  function installFetchShim() {
    if (!originalFetch || window.__daveAiNuvioVaultFetchInstalled) return;
    window.__daveAiNuvioVaultFetchInstalled = true;
    window.fetch = function (input, init) {
      var routed = routeVirtualAddon(input);
      if (routed) return routed;
      routed = routeHostedRpcNoise(input);
      if (routed) return routed;
      var rewritten = rewriteLegacyProviderVaultRequest(input);
      return originalFetch(rewritten || input, init);
    };
  }

  function cleanLiveDurationText(root) {
    var scope = root || document.body;
    if (!scope) return;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && /Infinity:NaN:NaN|NaN:NaN/.test(node.nodeValue)) {
        node.nodeValue = node.nodeValue
          .replace(/Infinity:NaN:NaN/g, 'Live')
          .replace(/NaN:NaN/g, 'Live');
      }
    }
  }

  function installLiveDurationPolish() {
    if (window.__daveAiNuvioLiveDurationPolishInstalled || !window.MutationObserver) return;
    window.__daveAiNuvioLiveDurationPolishInstalled = true;
    var rafActive = false;
    var startRafSweep = function () {
      if (rafActive || !window.requestAnimationFrame) return;
      rafActive = true;
      var startedAt = Date.now();
      var tick = function () {
        cleanLiveDurationText(document.body);
        if (Date.now() - startedAt < 120000) window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    };
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        if (mutation.type === 'characterData') {
          cleanLiveDurationText(mutation.target.parentNode || document.body);
        } else {
          Array.prototype.forEach.call(mutation.addedNodes || [], function (node) {
            if (node.nodeType === 1) cleanLiveDurationText(node);
          });
        }
      });
    });
    if (document.body) {
      cleanLiveDurationText(document.body);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.setInterval(function () { cleanLiveDurationText(document.body); }, 250);
      startRafSweep();
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        cleanLiveDurationText(document.body);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.setInterval(function () { cleanLiveDurationText(document.body); }, 250);
        startRafSweep();
      }, { once: true });
    }
  }

  function installLiveLogoPolish() {
    if (window.__daveAiNuvioLiveLogoPolishInstalled) return;
    window.__daveAiNuvioLiveLogoPolishInstalled = true;
    var style = document.createElement('style');
    style.id = 'daveai-nuvio-live-logo-polish';
    style.textContent = [
      '.home-hero-card[data-item-type="tv"] .home-hero-backdrop{display:none!important;}',
      '.home-hero-card[data-item-type="tv"] .home-hero-backdrop-wrap{background:radial-gradient(circle at 72% 44%,rgba(255,255,255,.08),transparent 34%),linear-gradient(90deg,rgba(0,0,0,.88),rgba(0,0,0,.42) 48%,rgba(0,0,0,.9))!important;}',
      '.home-hero-card[data-item-type="tv"] .home-hero-logo{max-width:180px!important;max-height:112px!important;width:auto!important;height:auto!important;object-fit:contain!important;}',
      '.home-hero-card[data-item-type="tv"] .home-hero-title-text{display:block!important;position:static!important;width:auto!important;height:auto!important;opacity:1!important;clip:auto!important;overflow:visible!important;font-size:clamp(32px,4vw,64px)!important;line-height:1.05!important;}',
      '.home-content-card[data-item-type="tv"]{height:220px!important;min-height:220px!important;}',
      '.home-content-card[data-item-type="tv"] .content-poster{height:142px!important;object-fit:contain!important;padding:18px!important;box-sizing:border-box!important;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.02))!important;}',
      '.home-content-card[data-item-type="tv"] .home-poster-expanded-backdrop{object-fit:contain!important;padding:18px!important;box-sizing:border-box!important;background:rgba(255,255,255,.04)!important;}',
      '.home-content-card[data-item-type="tv"] .home-poster-copy{height:auto!important;min-height:62px!important;}',
      '.home-content-card[data-item-type="tv"] .home-poster-title{white-space:normal!important;line-height:1.18!important;}',
      '#daveai-nuvio-provider-player{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#05070f;color:#fff;}',
      '#daveai-nuvio-provider-player .daveai-nuvio-player-bar{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:18px 24px;background:linear-gradient(180deg,rgba(12,17,31,.98),rgba(8,11,22,.9));border-bottom:1px solid rgba(255,255,255,.12);}',
      '#daveai-nuvio-provider-player .daveai-nuvio-player-provider{font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8fb7ff;}',
      '#daveai-nuvio-provider-player .daveai-nuvio-player-title{margin-top:4px;font-size:20px;font-weight:800;color:#fff;}',
      '#daveai-nuvio-provider-player .daveai-nuvio-player-close{border:1px solid rgba(255,255,255,.22);border-radius:999px;background:rgba(255,255,255,.08);color:#fff;padding:10px 18px;font:inherit;font-weight:700;cursor:pointer;}',
      '#daveai-nuvio-provider-player .daveai-nuvio-player-video{flex:1;width:100%;height:100%;background:#000;object-fit:contain;}',
      '#daveai-nuvio-provider-player .daveai-nuvio-player-status{position:absolute;left:24px;bottom:20px;padding:8px 12px;border-radius:999px;background:rgba(0,0,0,.62);color:#dbe7ff;font-size:13px;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  ensureEnglish();
  ensureDaveTvGuestMode();
  ensureAddonInstalled();
  installXhrShim();
  installFetchShim();
  installPlaybackFallback();
  installLiveDurationPolish();
  installLiveLogoPolish();
  window.__DAVEAI_NUVIO_VAULT_ADDON__ = {
    addonBase: ADDON_BASE,
    providers: PROVIDERS.slice(),
    manifest: manifest,
  };
}(window, document));
