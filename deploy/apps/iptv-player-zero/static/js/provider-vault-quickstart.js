/**
 * provider-vault-quickstart.js
 * Adds DaveAI one-click Apollo/XtremeHD imports to the static IPTV Player Zero
 * web build. It imports server-side provider-vault catalog rows into IndexedDB
 * with safe /api/provider-vault/stream URLs only; raw provider credentials never
 * enter the browser.
 */
(function (window, document) {
  'use strict';

  var PROVIDERS = [
    { id: 'apollo', name: 'Apollo Group TV' },
    { id: 'xtremehd', name: 'XtremeHD' },
  ];

  var LIMITS = {
    liveLimit: 20000,
    movieLimit: 500,
    seriesLimit: 500,
  };
  var QUICKSTART_BUILD_ID = '20260528-provider-vault-direct24';
  var PROVIDER_PLAYLIST_PREFIX = 'daveai-provider-';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function text(value, fallback) {
    var out = String(value || '').trim();
    return out || fallback || '';
  }

  function safeId(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  function fetchJson(url) {
    return fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function readJson(key, fallback) {
    try {
      var raw = window.localStorage && window.localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      if (window.localStorage) window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function providerPlaylistId(providerId) {
    return PROVIDER_PLAYLIST_PREFIX + providerId;
  }

  function storeIsReady() {
    return Boolean(
      window.Store &&
      window.Store.savePlaylist &&
      window.Store.saveChannels &&
      window.Store.getPlaylists &&
      window.Store.getChannels
    );
  }

  function waitForStore(timeoutMs) {
    timeoutMs = Number(timeoutMs || 10000);
    var startedAt = Date.now();
    return new Promise(function (resolve, reject) {
      function check() {
        if (storeIsReady()) {
          if (window.__IPZ_DB_READY__ && typeof window.__IPZ_DB_READY__.then === 'function') {
            window.__IPZ_DB_READY__.then(function () { resolve(); }).catch(function () { resolve(); });
          } else {
            resolve();
          }
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('Player storage did not become ready'));
          return;
        }
        window.setTimeout(check, 150);
      }
      check();
    });
  }

  function getProviderPlaylistStatus(providers) {
    if (!window.Store || !window.Store.getPlaylists || !window.Store.getChannels) {
      return Promise.resolve({
        ready: false,
        hasAny: false,
        hasPlayable: false,
        hasAllPlayable: false,
        providers: [],
      });
    }

    return window.Store.getPlaylists().then(function (playlists) {
      playlists = Array.isArray(playlists) ? playlists : [];
      return Promise.all(providers.map(function (provider) {
        var playlistId = providerPlaylistId(provider.id);
        var playlist = playlists.find(function (item) {
          return item && item.id === playlistId;
        });
        if (!playlist) {
          return {
            provider: provider,
            playlistId: playlistId,
            exists: false,
            channelCount: 0,
          };
        }
        return window.Store.getChannels(playlistId).then(function (channels) {
          channels = Array.isArray(channels) ? channels : [];
          return {
            provider: provider,
            playlistId: playlistId,
            exists: true,
            channelCount: channels.length,
          };
        }).catch(function () {
          return {
            provider: provider,
            playlistId: playlistId,
            exists: true,
            channelCount: 0,
          };
        });
      }));
    }).then(function (rows) {
      return {
        ready: true,
        hasAny: rows.some(function (row) { return row.exists; }),
        hasPlayable: rows.some(function (row) { return row.channelCount > 0; }),
        hasAllPlayable: rows.length === providers.length && rows.every(function (row) {
          return row.exists && row.channelCount > 0;
        }),
        providers: rows,
      };
    }).catch(function () {
      return {
        ready: false,
        hasAny: false,
        hasPlayable: false,
        hasAllPlayable: false,
        providers: [],
      };
    });
  }

  function markPlaylistEnabled(playlistId) {
    var enabledKeys = [
      'ipz_playlist_enabled_by_id',
      'ipz_playlist_enabled_by_id_premium',
    ];
    enabledKeys.forEach(function (key) {
      var map = readJson(key, {});
      if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
      map[playlistId] = true;
      writeJson(key, map);
    });

    var orderKeys = [
      'ipz_playlist_display_order_ids',
      'ipz_playlist_display_order_ids_premium',
    ];
    orderKeys.forEach(function (key) {
      var ids = readJson(key, []);
      if (!Array.isArray(ids)) ids = [];
      ids = ids.filter(function (id) { return id !== playlistId; });
      ids.unshift(playlistId);
      writeJson(key, ids);
    });

    try {
      window.localStorage.setItem('ipz_default_playlist_id', playlistId);
      window.localStorage.setItem('ipz_provider_quickstart_last_playlist_id', playlistId);
      window.localStorage.setItem('ipz_provider_quickstart_hidden', '1');
    } catch (e) {}
  }

  function configuredProviders() {
    if (window.localStorage && window.localStorage.getItem('ipz_provider_quickstart_demo') === '1') {
      return Promise.resolve(PROVIDERS.map(function (provider) {
        return { id: provider.id, name: provider.name, configured: true };
      }));
    }

    return fetchJson('/api/provider-vault/providers')
      .then(function (data) {
        return (Array.isArray(data.providers) ? data.providers : [])
          .filter(function (provider) { return provider && provider.configured; });
      })
      .catch(function () { return []; });
  }

  function catalogUrl(providerId) {
    var params = new URLSearchParams({
      provider: providerId,
      liveLimit: String(LIMITS.liveLimit),
      movieLimit: String(LIMITS.movieLimit),
      seriesLimit: String(LIMITS.seriesLimit),
    });
    return '/api/provider-vault/catalog?' + params.toString();
  }

  function safeLogoUrl(value) {
    var logo = text(value);
    if (!logo) return '';
    if (/^\/api\/provider-vault\/image\b/i.test(logo)) return logo;
    if (/^https?:\/\//i.test(logo)) {
      return '/api/provider-vault/image?src=' + encodeURIComponent(logo);
    }
    return logo;
  }

  function normalizeChannel(providerId, playlistId, item, type, index) {
    var name = text(item && item.name, type + ' ' + (index + 1));
    var logo = safeLogoUrl(
      (item && item.tvg && item.tvg.logo) ||
      (item && item.logo) ||
      (item && item.stream_icon) ||
      (item && item.cover)
    );
    var groupTitle = text(
      item && item.group && (item.group.title || item.group.name || item.group),
      type === 'live' ? 'Live TV' : type === 'movie' ? 'Movies' : 'Series'
    );
    var idSeed = [
      playlistId,
      type,
      index,
      safeId(name),
      safeId(item && item.url),
    ].filter(Boolean).join('_');

    return {
      id: idSeed,
      playlist_id: playlistId,
      name: name,
      url: text(item && item.url),
      type: type,
      stream_type: type === 'live' ? 'live' : type === 'movie' ? 'movie' : 'series',
      category_id: safeId(groupTitle) || type,
      group: groupTitle,
      group_title: groupTitle,
      tvg: Object.assign({}, item && item.tvg ? item.tvg : { name: name }, { name: name, logo: logo }),
      http: item && item.http ? item.http : {},
      stream_icon: logo,
      logo: logo,
      raw: item && item.raw ? item.raw : '',
      provider_id: providerId,
      source: 'daveai-provider-vault',
    };
  }

  function importProvider(provider, setStatus, options) {
    options = options || {};
    var shouldReload = options.reload !== false;
    if (!storeIsReady()) {
      setStatus('Player storage is starting...');
      return waitForStore(12000).then(function () {
        return importProvider(provider, setStatus, options);
      }).catch(function (err) {
        setStatus('Player storage is still starting. Try again in a moment.', true);
        if (options.throwOnError) throw err;
        return { error: true, message: err && err.message ? err.message : 'storage_not_ready' };
      });
    }

    setStatus('Loading ' + provider.name + ' catalog...');

    return fetchJson(catalogUrl(provider.id))
      .then(function (catalog) {
        var playlistId = providerPlaylistId(provider.id);
        var live = Array.isArray(catalog.live) ? catalog.live : [];
        var movies = Array.isArray(catalog.movies) ? catalog.movies : [];
        var series = Array.isArray(catalog.series) ? catalog.series : [];
        var channels = []
          .concat(live.map(function (item, index) { return normalizeChannel(provider.id, playlistId, item, 'live', index); }))
          .concat(movies.map(function (item, index) { return normalizeChannel(provider.id, playlistId, item, 'movie', index); }))
          .concat(series.map(function (item, index) { return normalizeChannel(provider.id, playlistId, item, 'series', index); }));

        if (!channels.length) throw new Error('Provider catalog returned no playable rows');

        return window.Store.savePlaylist({
          id: playlistId,
          name: provider.name,
          url: catalogUrl(provider.id),
          path: playlistId + '.channels.json',
          type: 'xtream',
          source: 'daveai-provider-vault',
          provider_id: provider.id,
          daveai_provider_vault: true,
          epg_url: '',
          created_at: Date.now(),
          updated_at: Date.now(),
        }).then(function () {
          return window.Store.saveChannels(playlistId, channels);
        }).then(function () {
          markPlaylistEnabled(playlistId);
        }).then(function () {
          setStatus('Imported ' + channels.length.toLocaleString() + ' safe entries for ' + provider.name + (shouldReload ? '. Reloading...' : '.'));
          if (shouldReload) setTimeout(function () { window.location.reload(); }, 900);
          return { playlistId: playlistId, channelCount: channels.length };
        });
      })
      .catch(function (err) {
        setStatus('Could not import ' + provider.name + ': ' + (err && err.message ? err.message : 'check DaveTV sign-in'), true);
        if (options.throwOnError) throw err;
        return { error: true, message: err && err.message ? err.message : 'import_failed' };
      });
  }

  function autoloadProviders(providers, setStatus) {
    var key = 'ipz_provider_autoload_build_id';
    try {
      if (window.localStorage) {
        var prior = window.localStorage.getItem(key);
        window.localStorage.setItem(key, QUICKSTART_BUILD_ID + ':running:' + Date.now());
        if (prior === QUICKSTART_BUILD_ID) {
          setStatus('Repairing DaveAI provider playlists...');
        }
      }
    } catch (e) {}

    setStatus('Setting up Apollo Group TV and XtremeHD...');
    return providers.reduce(function (chain, provider) {
      return chain.then(function () {
        return importProvider(provider, setStatus, { reload: false, throwOnError: true }).then(function (result) {
          if (!result || result.error || Number(result.channelCount || 0) <= 0) {
            throw new Error('No playable rows saved for ' + provider.name);
          }
          return result;
        });
      });
    }, Promise.resolve()).then(function () {
      try {
        if (window.localStorage) window.localStorage.setItem(key, QUICKSTART_BUILD_ID);
      } catch (e) {}
      setStatus('Providers loaded. Reloading...');
      setTimeout(function () { window.location.reload(); }, 900);
    }).catch(function (err) {
      try {
        if (window.localStorage) window.localStorage.removeItem(key);
      } catch (e) {}
      setStatus('Provider setup paused: ' + (err && err.message ? err.message : 'try a provider button'), true);
      throw err;
    });
  }

  function createPanel(providers, options) {
    options = options || {};
    if (!providers.length || document.getElementById('ipz-provider-vault-panel')) return null;

    var style = document.createElement('style');
    style.textContent = [
      '#ipz-provider-vault-panel{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:min(360px,calc(100vw - 36px));padding:14px;border:1px solid rgba(148,163,184,.28);border-radius:8px;background:rgba(7,12,20,.94);box-shadow:0 22px 70px rgba(0,0,0,.42);color:#f8fafc;font:13px/1.35 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;backdrop-filter:blur(18px)}',
      '#ipz-provider-vault-panel h2{margin:0 0 4px;font-size:14px;font-weight:800;letter-spacing:0;color:#fff}',
      '#ipz-provider-vault-panel p{margin:0 0 10px;color:#a8b3c7;font-size:12px}',
      '#ipz-provider-vault-panel .ipz-provider-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '#ipz-provider-vault-panel button{border:0;border-radius:8px;padding:10px 9px;background:#2563eb;color:#fff;font-weight:800;cursor:pointer}',
      '#ipz-provider-vault-panel button:hover{background:#1d4ed8}',
      '#ipz-provider-vault-panel button:disabled{opacity:.58;cursor:wait}',
      '#ipz-provider-vault-panel .ipz-provider-status{margin-top:10px;min-height:18px;color:#cbd5e1;font-size:12px}',
      '#ipz-provider-vault-panel .ipz-provider-status.error{color:#fecaca}',
      '#ipz-provider-vault-panel .ipz-provider-close{position:absolute;right:7px;top:5px;width:26px;height:26px;border-radius:999px;padding:0;background:transparent;color:#94a3b8;font-size:18px}',
      '@media (max-width:700px){#ipz-provider-vault-panel{right:10px;bottom:10px;width:calc(100vw - 20px)}#ipz-provider-vault-panel .ipz-provider-actions{grid-template-columns:1fr}}',
    ].join('');
    document.head.appendChild(style);

    var panel = document.createElement('section');
    panel.id = 'ipz-provider-vault-panel';
    panel.setAttribute('aria-label', 'DaveAI provider quickstart');
    panel.innerHTML = '<button type="button" class="ipz-provider-close" aria-label="Hide provider quickstart">&times;</button><h2>DaveAI Providers</h2><p>Load Apollo Group TV or XtremeHD without exposing credentials in the browser.</p><div class="ipz-provider-actions"></div><div class="ipz-provider-status" role="status"></div>';

    var actions = panel.querySelector('.ipz-provider-actions');
    var status = panel.querySelector('.ipz-provider-status');
    var close = panel.querySelector('.ipz-provider-close');

    function setStatus(message, error) {
      status.textContent = message || '';
      status.classList.toggle('error', Boolean(error));
    }

    function setBusy(busy) {
      panel.toggleAttribute('aria-busy', Boolean(busy));
      Array.prototype.forEach.call(actions.querySelectorAll('button'), function (item) {
        item.disabled = Boolean(busy);
      });
    }

    providers.forEach(function (provider) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Load ' + provider.name;
      button.addEventListener('click', function () {
        if (button.disabled || panel.hasAttribute('aria-busy')) return;
        setBusy(true);
        importProvider(provider, setStatus).finally(function () {
          setBusy(false);
        });
      });
      actions.appendChild(button);
    });

    close.addEventListener('click', function () {
      panel.remove();
      try { window.localStorage.setItem('ipz_provider_quickstart_hidden', '1'); } catch (e) {}
    });

    document.body.appendChild(panel);
    if (options.autoload) {
      window.setTimeout(function () {
        setBusy(true);
        autoloadProviders(providers, setStatus).finally(function () {
          setBusy(false);
        });
      }, 250);
    }
    return panel;
  }

  ready(function () {
    configuredProviders().then(function (providers) {
      if (!providers.length) return;
      getProviderPlaylistStatus(providers).then(function (status) {
        var hidden = false;
        try {
          hidden = window.localStorage && window.localStorage.getItem('ipz_provider_quickstart_hidden') === '1';
        } catch (e) {}

        if (status.hasAllPlayable && hidden) return;

        var shouldAutoload = !status.hasAllPlayable;
        createPanel(providers, { autoload: shouldAutoload });
      });
    });
  });

  window.IPZProviderVaultQuickstart = {
    importProvider: importProvider,
    configuredProviders: configuredProviders,
    getProviderPlaylistStatus: getProviderPlaylistStatus,
  };
}(window, document));
