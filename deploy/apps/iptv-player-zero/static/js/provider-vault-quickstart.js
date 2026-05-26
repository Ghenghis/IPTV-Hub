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
    liveLimit: 1200,
    movieLimit: 500,
    seriesLimit: 500,
  };

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

  function normalizeChannel(providerId, playlistId, item, type, index) {
    var name = text(item && item.name, type + ' ' + (index + 1));
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
      tvg: item && item.tvg ? item.tvg : { name: name, logo: '' },
      http: item && item.http ? item.http : {},
      stream_icon: item && item.tvg ? item.tvg.logo : '',
      logo: item && item.tvg ? item.tvg.logo : '',
      raw: item && item.raw ? item.raw : '',
      provider_id: providerId,
      source: 'daveai-provider-vault',
    };
  }

  function importProvider(provider, setStatus) {
    if (!window.Store || !window.Store.savePlaylist || !window.Store.saveChannels) {
      setStatus('Player storage is still starting. Try again in a moment.', true);
      return Promise.resolve();
    }

    setStatus('Loading ' + provider.name + ' catalog...');

    return fetchJson(catalogUrl(provider.id))
      .then(function (catalog) {
        var playlistId = 'daveai-provider-' + provider.id;
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
          type: 'provider-vault',
          source: 'daveai-provider-vault',
          provider_id: provider.id,
          epg_url: '',
          created_at: Date.now(),
          updated_at: Date.now(),
        }).then(function () {
          return window.Store.saveChannels(playlistId, channels);
        }).then(function () {
          markPlaylistEnabled(playlistId);
        }).then(function () {
          setStatus('Imported ' + channels.length.toLocaleString() + ' safe entries for ' + provider.name + '. Reloading...');
          setTimeout(function () { window.location.reload(); }, 900);
        });
      })
      .catch(function (err) {
        setStatus('Could not import ' + provider.name + ': ' + (err && err.message ? err.message : 'check DaveTV sign-in'), true);
      });
  }

  function createPanel(providers) {
    if (!providers.length || document.getElementById('ipz-provider-vault-panel')) return;

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

    providers.forEach(function (provider) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Load ' + provider.name;
      button.addEventListener('click', function () {
        Array.prototype.forEach.call(actions.querySelectorAll('button'), function (item) { item.disabled = true; });
        importProvider(provider, setStatus).finally(function () {
          Array.prototype.forEach.call(actions.querySelectorAll('button'), function (item) { item.disabled = false; });
        });
      });
      actions.appendChild(button);
    });

    close.addEventListener('click', function () {
      panel.remove();
      try { window.localStorage.setItem('ipz_provider_quickstart_hidden', '1'); } catch (e) {}
    });

    document.body.appendChild(panel);
  }

  ready(function () {
    try {
      if (window.localStorage && window.localStorage.getItem('ipz_provider_quickstart_hidden') === '1') return;
    } catch (e) {}

    configuredProviders().then(createPanel);
  });

  window.IPZProviderVaultQuickstart = {
    importProvider: importProvider,
    configuredProviders: configuredProviders,
  };
}(window, document));
