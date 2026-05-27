/**
 * iptvnator-daveai-vault-bootstrap.js
 * Seeds IPTVnator's PWA playlist database with DaveAI provider-vault rows.
 *
 * Raw Apollo/XtremeHD credentials stay server-side. Browser rows use only
 * authenticated /api/provider-vault/stream URLs returned by DaveTV.
 */
(function (window, document) {
  'use strict';

  var BUILD_ID = '20260527-v6';
  var DB_NAME = 'iptvnator';
  var STORE_NAME = 'playlists';
  var SETTINGS_KEY = 'settings';
  var SEED_MARKER = 'iptvnator_provider_vault_seeded';
  var RELOAD_MARKER = 'iptvnator_provider_vault_reloaded';
  var PENDING_ROUTE_KEY = 'iptvnator_provider_vault_pending_route';

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

  function disableHostedServiceWorker() {
    try {
      if (window.navigator && navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        navigator.serviceWorker.getRegistrations().then(function (registrations) {
          registrations.forEach(function (registration) {
            registration.unregister().catch(function () {});
          });
        }).catch(function () {});
      }
    } catch (ignored) {}

    try {
      if (window.caches && caches.keys) {
        caches.keys().then(function (names) {
          names
            .filter(function (name) {
              return /^ngsw:/i.test(name);
            })
            .forEach(function (name) {
              caches.delete(name).catch(function () {});
            });
        }).catch(function () {});
      }
    } catch (ignored) {}
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

  function dbGetAll(db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readonly');
      var request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = function () {
        resolve(Array.isArray(request.result) ? request.result : []);
      };
      request.onerror = function () {
        reject(request.error || new Error('Could not read playlists'));
      };
    });
  }

  function dbDeleteMany(db, ids) {
    return new Promise(function (resolve, reject) {
      if (!ids.length) {
        resolve();
        return;
      }
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      ids.forEach(function (id) {
        store.delete(id);
      });
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error || new Error('Could not delete legacy playlists'));
      };
      tx.onabort = tx.onerror;
    });
  }

  function playlistId(providerId) {
    return 'daveai-provider-vault-' + safeId(providerId);
  }

  function playlistRoute(providerId) {
    return '/workspace/playlists/' + encodeURIComponent(playlistId(providerId)) + '/all';
  }

  function providerFromText(value) {
    var haystack = String(value || '').toLowerCase();
    if (haystack.indexOf('apollo') !== -1) return PROVIDERS[0];
    if (haystack.indexOf('xtreme') !== -1 || haystack.indexOf('xhd') !== -1) return PROVIDERS[1];
    return null;
  }

  function readJsonStorage(key, fallback) {
    try {
      var raw = window.localStorage && window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (ignored) {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (ignored) {
      return false;
    }
  }

  function legacyXtreamProvider(row) {
    if (!row || typeof row !== 'object') return null;
    if (isDaveAiVaultPlaylist(row)) return null;
    return (
      providerFromText(row.title) ||
      providerFromText(row.name) ||
      providerFromText(row.filename) ||
      providerFromText(row.serverUrl)
    );
  }

  function isDaveAiVaultPlaylist(row) {
    var id = String((row && (row._id || row.id)) || '');
    var source = String((row && row.source) || '');
    return (
      id.indexOf('daveai-provider-vault-') === 0 ||
      source === 'daveai-provider-vault' ||
      Boolean(row && row.providerId && row.daveaiBuildId)
    );
  }

  function currentXtreamPlaylistId() {
    var match = window.location.pathname.match(/\/workspace\/xtreams\/([^/]+)/i);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch (ignored) {
      return match[1] || '';
    }
  }

  function migrateLegacyXtreamProviders(setStatus) {
    var playlists = readJsonStorage('xtream-playlists', []);
    if (!Array.isArray(playlists) || !playlists.length) {
      return null;
    }

    var currentId = currentXtreamPlaylistId();
    var removed = [];
    var currentProvider = null;
    var kept = playlists.filter(function (row) {
      var provider = legacyXtreamProvider(row);
      if (!provider) return true;
      removed.push({
        id: row.id,
        title: row.title || row.name || row.filename || provider.name,
        providerId: provider.id,
        hadServerUrl: Boolean(row.serverUrl),
      });
      if (currentId && String(row.id || '') === currentId) {
        currentProvider = provider;
      }
      return false;
    });

    if (!removed.length) {
      return null;
    }

    writeJsonStorage('iptvnator_provider_vault_legacy_xtream_backup', {
      buildId: BUILD_ID,
      backedUpAt: new Date().toISOString(),
      entries: removed,
    });
    writeJsonStorage('xtream-playlists', kept);
    if (typeof setStatus === 'function') {
      setStatus('Moved Apollo/XtremeHD to safe DaveAI vault playlists.');
    }
    return currentProvider || removed.map(function (entry) {
      return PROVIDERS.find(function (provider) {
        return provider.id === entry.providerId;
      });
    }).filter(Boolean)[0] || null;
  }

  function providerFromLegacyBackup() {
    var backup = readJsonStorage('iptvnator_provider_vault_legacy_xtream_backup', null);
    var entries = backup && Array.isArray(backup.entries) ? backup.entries : [];
    for (var index = 0; index < entries.length; index += 1) {
      var provider = PROVIDERS.find(function (item) {
        return item.id === entries[index].providerId;
      });
      if (provider) return provider;
    }
    return null;
  }

  function migrateLegacyIndexedDbXtreamProviders(setStatus) {
    return openDb()
      .then(function (db) {
        return dbGetAll(db).then(function (rows) {
          var currentId = currentXtreamPlaylistId();
          var removed = [];
          var deleteIds = [];
          var currentProvider = null;

          rows.forEach(function (row) {
            var provider = legacyXtreamProvider(row);
            var id = row && (row._id || row.id);
            if (!provider || !id) return;
            deleteIds.push(id);
            removed.push({
              id: id,
              title: row.title || row.name || row.filename || provider.name,
              providerId: provider.id,
              hadServerUrl: Boolean(row.serverUrl),
              source: row.source || '',
            });
            if (currentId && String(id) === currentId) {
              currentProvider = provider;
            }
          });

          if (!deleteIds.length) {
            db.close();
            return null;
          }

          return dbDeleteMany(db, deleteIds).then(function () {
            db.close();
            writeJsonStorage('iptvnator_provider_vault_legacy_indexeddb_backup', {
              buildId: BUILD_ID,
              backedUpAt: new Date().toISOString(),
              entries: removed,
            });
            if (typeof setStatus === 'function') {
              setStatus('Moved saved Apollo/XtremeHD workspaces to safe DaveAI vault playlists.');
            }
            return currentProvider || removed.map(function (entry) {
              return PROVIDERS.find(function (provider) {
                return provider.id === entry.providerId;
              });
            }).filter(Boolean)[0] || null;
          });
        });
      })
      .catch(function () {
        return null;
      });
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
      playlistId: playlist._id,
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
          var pendingRoute = '';
          try {
            pendingRoute = window.sessionStorage.getItem(PENDING_ROUTE_KEY) || '';
            window.sessionStorage.removeItem(PENDING_ROUTE_KEY);
          } catch (ignored) {}
          if (window.sessionStorage.getItem(RELOAD_MARKER) !== BUILD_ID) {
            window.sessionStorage.setItem(RELOAD_MARKER, BUILD_ID);
            setStatus('Provider playlists are ready. Reloading once...');
            window.setTimeout(function () {
              if (pendingRoute) {
                window.location.replace(pendingRoute);
              } else {
                reloadAppRoot();
              }
            }, 800);
          } else {
            setStatus('DaveAI provider playlists are ready.');
          }
          return true;
        });
    });
  }

  function redirectLegacyXtreamRoute(provider) {
    if (!provider || !currentXtreamPlaylistId()) return false;
    var target = playlistRoute(provider.id);
    if (window.location.pathname === target) return false;
    try {
      window.sessionStorage.setItem(PENDING_ROUTE_KEY, target);
      window.sessionStorage.setItem('iptvnator_provider_vault_preempted_xtream', BUILD_ID);
    } catch (ignored) {}
    window.location.replace(target);
    return true;
  }

  function preemptLegacyXtreamRoute() {
    if (!currentXtreamPlaylistId()) return null;
    var provider = PROVIDERS[1];
    var playlists = readJsonStorage('xtream-playlists', []);
    if (Array.isArray(playlists)) {
      var currentId = currentXtreamPlaylistId();
      playlists.some(function (row) {
        if (String(row && row.id || '') !== currentId) return false;
        provider = legacyXtreamProvider(row) || provider;
        return true;
      });
    }
    var target = playlistRoute(provider.id);
    if (window.location.pathname === target) return provider;
    try {
      window.sessionStorage.setItem(PENDING_ROUTE_KEY, target);
      window.sessionStorage.setItem('iptvnator_provider_vault_preempted_xtream', BUILD_ID);
    } catch (ignored) {}
    window.location.replace(target);
    return provider;
  }

  function installLegacyXtreamRouteWatchdog(defaultProvider) {
    var stopped = false;
    var attempts = 0;

    function providerForCurrentRoute() {
      return (
        providerFromLegacyBackup() ||
        defaultProvider ||
        (currentXtreamPlaylistId() ? PROVIDERS[1] : null)
      );
    }

    function repair(reason) {
      if (stopped) return;
      attempts += 1;
      if (attempts > 80) {
        stopped = true;
        return;
      }

      var provider = providerForCurrentRoute();
      if (!provider || !currentXtreamPlaylistId()) return;
      try {
        window.sessionStorage.setItem('iptvnator_provider_vault_route_repair', BUILD_ID + ':' + reason);
      } catch (ignored) {}
      redirectLegacyXtreamRoute(provider);
    }

    ['pushState', 'replaceState'].forEach(function (name) {
      var original = window.history && window.history[name];
      if (typeof original !== 'function') return;
      try {
        window.history[name] = function () {
          var result = original.apply(this, arguments);
          window.setTimeout(function () {
            repair(name);
          }, 0);
          return result;
        };
      } catch (ignored) {}
    });

    window.addEventListener('popstate', function () {
      repair('popstate');
    });
    window.addEventListener('hashchange', function () {
      repair('hashchange');
    });

    var interval = window.setInterval(function () {
      if (stopped || !currentXtreamPlaylistId()) {
        window.clearInterval(interval);
        stopped = true;
        return;
      }
      repair('interval');
    }, 500);

    ready(function () {
      var observer = null;
      try {
        observer = new MutationObserver(function () {
          if (!currentXtreamPlaylistId()) {
            if (observer) observer.disconnect();
            return;
          }
          if (/Portal unavailable/i.test(document.body && document.body.innerText || '')) {
            repair('portal-unavailable');
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      } catch (ignored) {}
      repair('ready');
    });

    repair('install');
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

  disableHostedServiceWorker();
  forceEnglishSettings();
  var preemptedLegacyProvider = preemptLegacyXtreamRoute();
  installLegacyXtreamRouteWatchdog(preemptedLegacyProvider);

  ready(function () {
    configuredProviders().then(function (providers) {
      var hidden = false;
      try {
        hidden =
          window.localStorage.getItem('iptvnator_provider_vault_panel_hidden') ===
          '1';
      } catch (ignored) {}
      var panel = hidden ? { setStatus: function () {} } : createPanel(providers);
      var localLegacyProvider = migrateLegacyXtreamProviders(panel.setStatus);
      migrateLegacyIndexedDbXtreamProviders(panel.setStatus).then(function (dbLegacyProvider) {
        var legacyProvider =
          localLegacyProvider ||
          dbLegacyProvider ||
          preemptedLegacyProvider ||
          providerFromLegacyBackup() ||
          (currentXtreamPlaylistId() ? PROVIDERS[1] : null);

        autoSeed(providers, panel.setStatus).catch(function (error) {
          panel.setStatus(
            'DaveAI provider setup needs attention: ' +
              (error && error.message ? error.message : 'unknown error'),
            true
          );
        }).then(function () {
          redirectLegacyXtreamRoute(legacyProvider);
        });
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
