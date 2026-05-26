/**
 * iptvnator-daveai-vault-bootstrap.js
 * Seeds IPTVnator's PWA playlist database with DaveAI provider-vault rows.
 *
 * Raw Apollo/XtremeHD credentials stay server-side. Browser rows use only
 * authenticated /api/provider-vault/stream URLs returned by DaveTV.
 */
(function (window, document) {
  'use strict';

  var BUILD_ID = '20260526-v1';
  var DB_NAME = 'iptvnator';
  var STORE_NAME = 'playlists';
  var SETTINGS_KEY = 'settings';
  var SEED_MARKER = 'iptvnator_provider_vault_seeded';
  var RELOAD_MARKER = 'iptvnator_provider_vault_reloaded';

  var PROVIDERS = [
    { id: 'apollo', name: 'Apollo Group TV' },
    { id: 'xtremehd', name: 'XtremeHD' },
  ];

  var LIMITS = {
    liveLimit: 1200,
    movieLimit: 700,
    seriesLimit: 700,
  };

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function text(value, fallback) {
    var out = String(value == null ? '' : value).trim();
    return out || fallback || '';
  }

  function safeId(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96);
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

  function providersUrl() {
    return '/api/provider-vault/providers';
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

  function appRootUrl() {
    try {
      var script = document.currentScript;
      var src = script && script.src ? new URL(script.src, window.location.href) : null;
      if (src && src.pathname.endsWith('/iptvnator-daveai-vault-bootstrap.js')) {
        src.pathname = src.pathname.replace(/iptvnator-daveai-vault-bootstrap\.js$/, '');
        src.search = '';
        src.hash = '';
        return src.href;
      }
    } catch (ignored) {}
    return new URL('./', window.location.href).href;
  }

  var APP_ROOT_URL = appRootUrl();

  function reloadAppRoot() {
    window.location.assign(APP_ROOT_URL);
  }

  function configuredProviders() {
    if (
      window.localStorage &&
      window.localStorage.getItem('iptvnator_provider_vault_demo') === '1'
    ) {
      return Promise.resolve(
        PROVIDERS.map(function (provider) {
          return { id: provider.id, name: provider.name, configured: true };
        })
      );
    }

    return fetchJson(providersUrl())
      .then(function (data) {
        var configured = Array.isArray(data.providers) ? data.providers : [];
        return configured
          .filter(function (provider) {
            return provider && provider.configured;
          })
          .map(function (provider) {
            var known = PROVIDERS.find(function (item) {
              return item.id === provider.id;
            });
            return {
              id: provider.id,
              name: provider.name || (known && known.name) || provider.id,
              configured: true,
            };
          });
      })
      .catch(function () {
        return [];
      });
  }

  function forceEnglishSettings() {
    document.documentElement.lang = 'en';
    try {
      var existing = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
      window.localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify(Object.assign({}, existing, { language: 'en' }))
      );
    } catch (error) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ language: 'en' }));
      } catch (ignored) {}
    }
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = window.indexedDB.open(DB_NAME);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var store = db.createObjectStore(STORE_NAME, {
            keyPath: '_id',
            autoIncrement: false,
          });
          [
            '_id',
            'filename',
            'title',
            'count',
            'playlist',
            'importDate',
            'lastUsage',
            'favorites',
            'recentlyViewed',
            'autoRefresh',
            'url',
            'filePath',
          ].forEach(function (name) {
            try {
              store.createIndex(name, name, { unique: false });
            } catch (ignored) {}
          });
        }
      };
      request.onsuccess = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.close();
          reject(new Error('IPTVnator playlist store is unavailable'));
          return;
        }
        resolve(db);
      };
      request.onerror = function () {
        reject(request.error || new Error('Could not open IPTVnator database'));
      };
    });
  }

  function dbGet(db, id) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readonly');
      var request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = function () {
        resolve(request.result || null);
      };
      request.onerror = function () {
        reject(request.error || new Error('Could not read playlist'));
      };
    });
  }

  function dbPut(db, playlist) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(playlist);
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error || new Error('Could not save playlist'));
      };
      tx.onabort = tx.onerror;
    });
  }

  function playlistId(providerId) {
    return 'daveai-provider-vault-' + safeId(providerId);
  }

  function groupTitle(type, item) {
    var raw = item && item.group && item.group.title;
    var fallback =
      type === 'live'
        ? 'Live TV'
        : type === 'movie'
          ? 'Movies'
          : 'Series';
    return text(raw, fallback);
  }

  function normalizeItem(provider, playlist, item, type, index) {
    var name = text(
      item && (item.name || item.title || item.stream_display_name),
      provider.name + ' ' + type + ' ' + (index + 1)
    );
    var url = text(item && item.url, '');
    var logo = text(
      item && (item.logo || item.stream_icon || (item.tvg && item.tvg.logo)),
      ''
    );
    var group = groupTitle(type, item);
    var id = [
      playlist._id,
      type,
      index,
      safeId(name),
      safeId(url),
    ]
      .filter(Boolean)
      .join('-');

    return {
      id: id,
      url: url,
      name: name,
      title: name,
      type: type,
      stream_type: type === 'live' ? 'live' : type === 'movie' ? 'movie' : 'series',
      group: { title: provider.name + ' / ' + group },
      tvg: {
        id: text(item && item.tvg && item.tvg.id, ''),
        name: text(item && item.tvg && item.tvg.name, name),
        url: '',
        logo: logo,
        rec: '',
      },
      http: {
        referrer: '',
        'user-agent': '',
        origin: '',
      },
      radio: '',
      raw:
        '#EXTINF:-1 tvg-name="' +
        name.replace(/"/g, "'") +
        '" group-title="' +
        group.replace(/"/g, "'") +
        '",' +
        name +
        '\n' +
        url,
      source: 'daveai-provider-vault',
      provider_id: provider.id,
    };
  }

  function playlistFromCatalog(provider, catalog) {
    var id = playlistId(provider.id);
    var now = new Date().toISOString();
    var playlist = {
      _id: id,
      filename: provider.name + ' - DaveAI Vault',
      title: provider.name + ' - DaveAI Vault',
      count: 0,
      playlist: {
        header: { raw: '#EXTM3U', attrs: {} },
        items: [],
      },
      importDate: now,
      lastUsage: now,
      favorites: [],
      recentlyViewed: [],
      autoRefresh: true,
      updateDate: Date.now(),
      url: catalogUrl(provider.id),
      source: 'daveai-provider-vault',
      providerId: provider.id,
      daveaiBuildId: BUILD_ID,
    };

    var live = Array.isArray(catalog.live) ? catalog.live : [];
    var movies = Array.isArray(catalog.movies) ? catalog.movies : [];
    var series = Array.isArray(catalog.series) ? catalog.series : [];
    playlist.playlist.items = []
      .concat(
        live.map(function (item, index) {
          return normalizeItem(provider, playlist, item, 'live', index);
        })
      )
      .concat(
        movies.map(function (item, index) {
          return normalizeItem(provider, playlist, item, 'movie', index);
        })
      )
      .concat(
        series.map(function (item, index) {
          return normalizeItem(provider, playlist, item, 'series', index);
        })
      )
      .filter(function (item) {
        return Boolean(item.url);
      });
    playlist.count = playlist.playlist.items.length;
    return playlist;
  }

  function importProvider(provider, setStatus) {
    setStatus('Loading ' + provider.name + ' catalog...');
    return Promise.all([openDb(), fetchJson(catalogUrl(provider.id))])
      .then(function (parts) {
        var db = parts[0];
        var catalog = parts[1];
        var playlist = playlistFromCatalog(provider, catalog);
        if (!playlist.count) {
          db.close();
          throw new Error('Provider catalog returned no playable rows');
        }
        return dbPut(db, playlist).then(function () {
          db.close();
          setStatus(
            'Imported ' +
              playlist.count.toLocaleString() +
              ' safe rows for ' +
              provider.name +
              '. Reloading...'
          );
          window.localStorage.setItem(SEED_MARKER, BUILD_ID);
          window.setTimeout(function () {
            reloadAppRoot();
          }, 800);
          return playlist;
        });
      })
      .catch(function (error) {
        setStatus(
          'Could not import ' +
            provider.name +
            ': ' +
            (error && error.message ? error.message : 'check DaveTV sign-in'),
          true
        );
        throw error;
      });
  }

  function hasSeededPlaylists(providers) {
    return openDb()
      .then(function (db) {
        return Promise.all(
          providers.map(function (provider) {
            return dbGet(db, playlistId(provider.id)).then(Boolean);
          })
        ).then(function (flags) {
          db.close();
          return flags.every(Boolean);
        });
      })
      .catch(function () {
        return false;
      });
  }

  function autoSeed(providers, setStatus) {
    if (!providers.length) return Promise.resolve(false);
    var currentMarker = null;
    try {
      currentMarker = window.localStorage.getItem(SEED_MARKER);
    } catch (ignored) {}

    return hasSeededPlaylists(providers).then(function (hasAll) {
      if (currentMarker === BUILD_ID && hasAll) return false;
      setStatus('Preparing DaveAI provider playlists...');
      return providers
        .reduce(function (chain, provider) {
          return chain.then(function () {
            return importProviderNoReload(provider, setStatus);
          });
        }, Promise.resolve())
        .then(function () {
          try {
            window.localStorage.setItem(SEED_MARKER, BUILD_ID);
          } catch (ignored) {}
          if (window.sessionStorage.getItem(RELOAD_MARKER) !== BUILD_ID) {
            window.sessionStorage.setItem(RELOAD_MARKER, BUILD_ID);
            setStatus('Provider playlists are ready. Reloading once...');
            window.setTimeout(function () {
              reloadAppRoot();
            }, 800);
          } else {
            setStatus('DaveAI provider playlists are ready.');
          }
          return true;
        });
    });
  }

  function importProviderNoReload(provider, setStatus) {
    setStatus('Loading ' + provider.name + ' catalog...');
    return Promise.all([openDb(), fetchJson(catalogUrl(provider.id))]).then(function (parts) {
      var db = parts[0];
      var catalog = parts[1];
      var playlist = playlistFromCatalog(provider, catalog);
      if (!playlist.count) {
        db.close();
        throw new Error(provider.name + ' returned no playable rows');
      }
      return dbPut(db, playlist).then(function () {
        db.close();
        setStatus('Prepared ' + playlist.count.toLocaleString() + ' rows for ' + provider.name + '.');
        return playlist;
      });
    });
  }

  function createPanel(providers) {
    if (!providers.length || document.getElementById('iptvnator-daveai-provider-panel')) {
      return { setStatus: function () {} };
    }

    var style = document.createElement('style');
    style.textContent = [
      '#iptvnator-daveai-provider-panel{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:min(372px,calc(100vw - 36px));padding:14px;border:1px solid rgba(124,58,237,.28);border-radius:10px;background:rgba(18,18,24,.95);box-shadow:0 22px 70px rgba(0,0,0,.42);color:#f8fafc;font:13px/1.35 Inter,Roboto,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;backdrop-filter:blur(18px)}',
      '#iptvnator-daveai-provider-panel h2{margin:0 0 4px;font-size:14px;font-weight:800;letter-spacing:0;color:#fff}',
      '#iptvnator-daveai-provider-panel p{margin:0 0 10px;color:#bac4d7;font-size:12px}',
      '#iptvnator-daveai-provider-panel .iptvnator-provider-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '#iptvnator-daveai-provider-panel button{border:0;border-radius:8px;padding:10px 9px;background:#5b5cf6;color:#fff;font-weight:800;cursor:pointer}',
      '#iptvnator-daveai-provider-panel button:hover{background:#494ae0}',
      '#iptvnator-daveai-provider-panel button:disabled{opacity:.58;cursor:wait}',
      '#iptvnator-daveai-provider-panel .iptvnator-provider-status{margin-top:10px;min-height:18px;color:#dbe4f3;font-size:12px}',
      '#iptvnator-daveai-provider-panel .iptvnator-provider-status.error{color:#fecaca}',
      '#iptvnator-daveai-provider-panel .iptvnator-provider-close{position:absolute;right:7px;top:5px;width:26px;height:26px;border-radius:999px;padding:0;background:transparent;color:#94a3b8;font-size:18px}',
      '@media (max-width:700px){#iptvnator-daveai-provider-panel{right:10px;bottom:10px;width:calc(100vw - 20px)}#iptvnator-daveai-provider-panel .iptvnator-provider-actions{grid-template-columns:1fr}}',
    ].join('');
    document.head.appendChild(style);

    var panel = document.createElement('section');
    panel.id = 'iptvnator-daveai-provider-panel';
    panel.setAttribute('aria-label', 'DaveAI provider quickstart');
    panel.innerHTML =
      '<button type="button" class="iptvnator-provider-close" aria-label="Hide provider quickstart">&times;</button>' +
      '<h2>DaveAI Providers</h2>' +
      '<p>Apollo Group TV and XtremeHD are imported as safe IPTVnator playlists. Provider credentials stay server-side.</p>' +
      '<div class="iptvnator-provider-actions"></div>' +
      '<div class="iptvnator-provider-status" role="status"></div>';

    var actions = panel.querySelector('.iptvnator-provider-actions');
    var status = panel.querySelector('.iptvnator-provider-status');
    var close = panel.querySelector('.iptvnator-provider-close');

    function setStatus(message, error) {
      status.textContent = message || '';
      status.classList.toggle('error', Boolean(error));
    }

    providers.forEach(function (provider) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Refresh ' + provider.name;
      button.addEventListener('click', function () {
        Array.prototype.forEach.call(actions.querySelectorAll('button'), function (item) {
          item.disabled = true;
        });
        importProvider(provider, setStatus).finally(function () {
          Array.prototype.forEach.call(actions.querySelectorAll('button'), function (item) {
            item.disabled = false;
          });
        });
      });
      actions.appendChild(button);
    });

    close.addEventListener('click', function () {
      panel.remove();
      try {
        window.localStorage.setItem('iptvnator_provider_vault_panel_hidden', '1');
      } catch (ignored) {}
    });

    document.body.appendChild(panel);
    return { setStatus: setStatus };
  }

  forceEnglishSettings();

  ready(function () {
    configuredProviders().then(function (providers) {
      var hidden = false;
      try {
        hidden =
          window.localStorage.getItem('iptvnator_provider_vault_panel_hidden') ===
          '1';
      } catch (ignored) {}
      var panel = hidden ? { setStatus: function () {} } : createPanel(providers);
      autoSeed(providers, panel.setStatus).catch(function (error) {
        panel.setStatus(
          'DaveAI provider setup needs attention: ' +
            (error && error.message ? error.message : 'unknown error'),
          true
        );
      });
    });
  });

  window.IPTVnatorDaveAIProviderVault = {
    buildId: BUILD_ID,
    configuredProviders: configuredProviders,
    importProvider: importProvider,
    catalogUrl: catalogUrl,
    playlistId: playlistId,
  };
})(window, document);
