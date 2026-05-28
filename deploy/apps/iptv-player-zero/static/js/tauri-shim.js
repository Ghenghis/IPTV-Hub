/**
 * tauri-shim.js — Full Tauri IPC shim for IPTV Player Zero 1.7.99.
 * Replaces window.__TAURI_INTERNALS__.invoke() with browser implementations.
 * Depends on: store.js, player-shim.js, m3u-parser.js, xmltv-parser.js, xtream-client.js
 * Must load before the React bundle (index-DUfsF0mF.js).
 */
(function (window) {
  'use strict';

  var DAVEAI_HOSTED_BUILD_ID = '20260528-provider-vault-direct31';

  // ── Helper: emit event the React app listens to via Tauri events ──────────
  function emitTauriEvent(event, payload) {
    window.dispatchEvent(new CustomEvent('tauri:' + event, { detail: payload }));
  }

  var eventPluginNextId = 1;
  var eventPluginListeners = {};

  function callPluginEventHandler(handlerId, event, eventId, payload) {
    var cb = window[handlerId];
    if (typeof cb === 'function') {
      cb({ event: event, id: eventId, payload: payload });
    }
  }

  function registerPluginEventListener(payload) {
    payload = payload || {};
    var event = String(payload.event || '');
    var handlerId = payload.handler;
    var eventId = eventPluginNextId++;
    var listener = function (e) {
      callPluginEventHandler(handlerId, event, eventId, e && e.detail);
    };
    eventPluginListeners[eventId] = { event: event, listener: listener };
    window.addEventListener('tauri:' + event, listener);
    return eventId;
  }

  function unregisterPluginEventListener(eventId) {
    eventId = Number(eventId);
    var row = eventPluginListeners[eventId];
    if (!row) return null;
    window.removeEventListener('tauri:' + row.event, row.listener);
    delete eventPluginListeners[eventId];
    return null;
  }

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function (_event, eventId) {
    unregisterPluginEventListener(eventId);
  };

  // ── App window / OS detection ─────────────────────────────────────────────
  var isMac = /Mac/.test(navigator.userAgent);
  var isWindows = /Win/.test(navigator.userAgent);
  var isLinux = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);

  // ── Settings backed by localStorage ───────────────────────────────────────
  function getSettings() {
    try { return JSON.parse(localStorage.getItem('ipz_settings') || '{}'); } catch (e) { return {}; }
  }
  function saveSettings(s) { localStorage.setItem('ipz_settings', JSON.stringify(s)); }

  // ── Safe array/object wrappers — prevent .map() on null crashes ──────────
  function safeArr(p) { return p instanceof Promise ? p.then(function(v){ return Array.isArray(v) ? v : []; }) : (Array.isArray(p) ? Promise.resolve(p) : Promise.resolve([])); }
  function safeObj(p) { return p instanceof Promise ? p.then(function(v){ return (v != null && typeof v === 'object') ? v : {}; }) : Promise.resolve((p != null && typeof p === 'object') ? p : {}); }
  function hostedFullLicenseStatus() {
    return {
      status: 'active',
      plan: 'lifetime',
      license_type: 'lifetime',
      tier: 'pro',
      expiry: null,
      trial_days: 0,
      lifetimeUnlocked: true,
      premiumActive: true,
      purchaseRequired: false,
      isTrial: false,
      source: 'daveai_hosted_full_free',
      features: {
        unlimited_playlists: true,
        full_tv_guide: true,
        recording: true,
        downloads: true,
        reminders: true,
        vod: true,
        favorites: true,
      },
    };
  }

  function clearHostedProviderState() {
    var keys = [
      'ipz_provider_quickstart_hidden',
      'ipz_default_playlist_id',
      'ipz_provider_quickstart_last_playlist_id',
      'ipz_playlist_enabled_by_id',
      'ipz_playlist_enabled_by_id_premium',
      'ipz_playlist_display_order_ids',
      'ipz_playlist_display_order_ids_premium',
      'ipz_playlist_health_by_id',
      'ipz_playlist_health_by_id_premium',
    ];
    keys.forEach(function (key) {
      try { window.localStorage.removeItem(key); } catch (e) {}
    });
  }

  function deleteHostedDatabase() {
    var names = ['ipz-db', 'iptv_player_zero', 'iptv-player-zero'];
    var storeReset = window.Store && typeof window.Store.deleteDb === 'function'
      ? window.Store.deleteDb()
      : Promise.resolve();

    return storeReset.then(function () {
      return Promise.all(names.map(function (name) {
        return new Promise(function (resolve) {
          try {
            var request = window.indexedDB && window.indexedDB.deleteDatabase(name);
            if (!request) {
              resolve();
              return;
            }
            request.onsuccess = request.onerror = request.onblocked = function () { resolve(); };
          } catch (e) {
            resolve();
          }
        });
      }));
    });
  }

  function clearHostedCaches() {
    try {
      if (window.caches && window.caches.keys) {
        window.caches.keys().then(function (keys) {
          keys.forEach(function (key) {
            if (/ipz|iptv-player-zero|vite|workbox/i.test(key)) {
              window.caches.delete(key).catch(function () {});
            }
          });
        }).catch(function () {});
      }
    } catch (e) {}

    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        navigator.serviceWorker.getRegistrations().then(function (registrations) {
          registrations.forEach(function (registration) {
            var scope = registration && registration.scope || '';
            if (/iptv-player-zero|apps\.daveai\.tech/i.test(scope)) {
              registration.unregister().catch(function () {});
            }
          });
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function recoverHostedStateAfterFatalError(reason) {
    try {
      var attemptKey = 'ipz_daveai_runtime_recoveries_' + DAVEAI_HOSTED_BUILD_ID;
      var attempts = Number(window.sessionStorage.getItem(attemptKey) || '0');
      if (attempts >= 3) {
        return;
      }
      window.sessionStorage.setItem(attemptKey, String(attempts + 1));
      window.sessionStorage.setItem('ipz_daveai_recovered_build', DAVEAI_HOSTED_BUILD_ID);
      window.sessionStorage.setItem('ipz_daveai_recovery_reason', String(reason || 'unknown').slice(0, 220));
    } catch (e) {}
    clearHostedProviderState();
    clearHostedCaches();
    deleteHostedDatabase().finally(function () {
      window.setTimeout(function () {
        window.location.replace('/iptv-player-zero/?recovered=' + encodeURIComponent(DAVEAI_HOSTED_BUILD_ID));
      }, 100);
    });
  }

  function installHostedCrashRecovery() {
    function shouldRecover(message) {
      var text = String(message || '');
      return (
        /Cannot read properties of (?:undefined|null) \(reading '(?:map|filter|forEach|length)'\)/i.test(text) ||
        /Something went wrong/i.test(text) ||
        /TypeError/i.test(text) && /map|filter|forEach/i.test(text)
      );
    }

    window.addEventListener('error', function (event) {
      var message = event && (event.message || (event.error && event.error.message));
      if (shouldRecover(message)) recoverHostedStateAfterFatalError(message);
    });

    window.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason;
      var message = reason && (reason.message || reason.stack) || reason;
      if (shouldRecover(message)) recoverHostedStateAfterFatalError(message);
    });

    function inspectRenderedFatalState() {
      try {
        var text = document && document.body ? document.body.innerText || '' : '';
        if (/Something went wrong/i.test(text) && /Restart the app|100%/i.test(text)) {
          recoverHostedStateAfterFatalError('rendered fatal state');
        }
      } catch (e) {}
    }

    [1200, 3000, 6000].forEach(function (delay) {
      window.setTimeout(inspectRenderedFatalState, delay);
    });

    try {
      var priorBuild = window.localStorage.getItem('ipz_daveai_hosted_build_id');
      if (priorBuild && priorBuild !== DAVEAI_HOSTED_BUILD_ID) {
        clearHostedProviderState();
        clearHostedCaches();
        deleteHostedDatabase();
      }
      window.localStorage.setItem('ipz_daveai_hosted_build_id', DAVEAI_HOSTED_BUILD_ID);
    } catch (e) {}
  }

  function licenseResponseBody() {
    return {
      ok: true,
      active: true,
      device_id: getDeviceId(),
      deviceId: getDeviceId(),
      status: hostedFullLicenseStatus(),
      license: hostedFullLicenseStatus(),
      token: null,
      source: 'daveai_hosted_full_free',
    };
  }

  if (!window.__IPZ_DAVEAI_LICENSE_FETCH_PATCHED__) {
    window.__IPZ_DAVEAI_LICENSE_FETCH_PATCHED__ = true;
    var originalFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/^https:\/\/(www\.)?(iptvplayerzero\.com|ipzcore\.com)\/api\/licenses\//i.test(url)) {
        return Promise.resolve(new Response(JSON.stringify(licenseResponseBody()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (/^https:\/\/(www\.)?(iptvplayerzero\.com|ipzcore\.com)\/api\/updater\//i.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ available: false, should_update: false, version: '1.7.99' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      return originalFetch ? originalFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
    };
  }

  function getDeviceId() {
    var key = 'ipz_web_device_id';
    var id = localStorage.getItem(key);
    if (!id) {
      id = 'web-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
      localStorage.setItem(key, id);
    }
    return id;
  }

  function readJsonStorage(keys, fallback) {
    keys = Array.isArray(keys) ? keys : [keys];
    for (var i = 0; i < keys.length; i++) {
      try {
        var raw = localStorage.getItem(keys[i]);
        if (!raw) continue;
        return JSON.parse(raw);
      } catch (e) {}
    }
    return fallback;
  }

  function preferredPlaylistId() {
    try {
      var direct = localStorage.getItem('ipz_default_playlist_id') || localStorage.getItem('ipz_provider_quickstart_last_playlist_id');
      if (direct) return String(direct).trim();
      var order = readJsonStorage(['ipz_playlist_display_order_ids_premium', 'ipz_playlist_display_order_ids'], []);
      if (Array.isArray(order) && order.length) return String(order[0] || '').trim();
    } catch (e) {}
    return '';
  }

  function getPlaylistId(payload) {
    return String((payload && (payload.playlist_id || payload.playlistId || payload.id)) || preferredPlaylistId() || '').trim();
  }

  function applyPlaylistPrefs(playlists) {
    playlists = Array.isArray(playlists) ? playlists.slice() : [];
    var enabled = readJsonStorage(['ipz_playlist_enabled_by_id_premium', 'ipz_playlist_enabled_by_id'], null);
    var order = readJsonStorage(['ipz_playlist_display_order_ids_premium', 'ipz_playlist_display_order_ids'], []);
    var preferred = preferredPlaylistId();

    if (enabled && typeof enabled === 'object' && !Array.isArray(enabled)) {
      var enabledIds = Object.keys(enabled).filter(function (id) { return enabled[id]; });
      if (enabledIds.length) {
        playlists = playlists.filter(function (playlist) { return enabled[playlist && playlist.id]; });
      }
    }

    var index = {};
    if (Array.isArray(order)) {
      order.forEach(function (id, i) { index[id] = i; });
    }
    playlists.sort(function (a, b) {
      var aid = a && a.id;
      var bid = b && b.id;
      if (preferred && aid === preferred && bid !== preferred) return -1;
      if (preferred && bid === preferred && aid !== preferred) return 1;
      var ai = Object.prototype.hasOwnProperty.call(index, aid) ? index[aid] : 9999;
      var bi = Object.prototype.hasOwnProperty.call(index, bid) ? index[bid] : 9999;
      if (ai !== bi) return ai - bi;
      return String(a && a.name || '').localeCompare(String(b && b.name || ''));
    });
    return playlists;
  }

  function defaultPlaylistPrefs() {
    return {
      epg_sources: [],
      epg_url: null,
      epg_fuzzy_matching: true,
      epg_url_from_playlist: null,
      xtream_provider_epg_enabled: true,
      epg_manual_channel_ids: [],
      epg_manual_mappings: [],
      epg_update_interval_hours: 24,
      epg_time_offset_minutes: 0,
      catchup_time_offset_minutes: 0,
      epg_prefer_channel_logos: false,
      playlist_update_interval_hours: 24,
      hls_user_agent: null,
      hls_referer: null,
      hls_origin: null,
      xtream_live_stream_preference: 'hls',
      channel_name_prefixes_to_remove: [],
      channel_name_suffixes_to_remove: [],
      hidden_live_groups: [],
      hidden_live_channel_ids: [],
      hidden_movie_category_ids: [],
      hidden_series_category_ids: [],
      live_category_sort: 'name',
      movie_category_sort: 'name',
      series_category_sort: 'name',
      live_category_custom_order: [],
      movie_category_custom_order: [],
      series_category_custom_order: [],
      trakt_manual_mappings: [],
    };
  }

  function channelStats(channels) {
    channels = Array.isArray(channels) ? channels : [];
    return {
      status: 'ready',
      ok: true,
      stage: 'complete',
      channel_count: channels.length,
      live_count: channels.filter(function (c) { return c.type === 'live' || c.stream_type === 'live'; }).length,
      movie_count: channels.filter(function (c) { return c.type === 'movie' || c.stream_type === 'movie'; }).length,
      series_count: channels.filter(function (c) { return c.type === 'series' || c.stream_type === 'series'; }).length,
      updated_at: Date.now(),
      source: 'daveai-provider-vault',
    };
  }

  // ── Wait for Store to be ready (max 5s) ────────────────────────────────────
  function waitForStore() {
    if (typeof window.Store !== 'undefined') return Promise.resolve();
    return new Promise(function(resolve) {
      var attempts = 0;
      var t = setInterval(function() {
        attempts++;
        if (typeof window.Store !== 'undefined' || attempts > 50) {
          clearInterval(t);
          resolve();
        }
      }, 100);
    });
  }

  // ── Main invoke handler ────────────────────────────────────────────────────
  async function invoke(cmd, payload) {
    payload = payload || {};
    // Wait for Store if not yet ready — never return null
    if (typeof window.Store === 'undefined') {
      await waitForStore();
    }
    // Guard: if Store still not ready, return safe defaults per command type
    var _Store = window.Store;
    if (!_Store) {
      var _arrCmds = ['get_playlists','get_playlist_summaries','get_channels','get_epg_programs_window','get_watched_movies','get_continue_watching','get_watched_episodes','get_favorite_channel_order','get_vod_downloads','get_recordings','list_recordings','get_cast_devices','get_subtitle_tracks','trakt_get_watched','trakt_get_ratings','trakt_sync','get_scheduled_recordings','list_scheduled_recordings','get_upcoming_sports','get_sports_leagues','get_quality_levels','get_player_quality_levels'];
      return _arrCmds.indexOf(cmd) >= 0 ? [] : {};
    }

    switch (cmd) {

      // ── Licensing — DaveAI hosted build is full/free; payment UI is disabled.
      case 'load_recovery_token':
      case 'validate_license':
      case 'check_license':
      case 'get_license_status':
      case 'activate_license':
      case 'restore_license':
      case 'sideload_get_cached_license_status':
      case 'sideload_get_license_status':
        return hostedFullLicenseStatus();

      case 'sideload_get_checkout_availability':
        return { available: false, checkout_url: null, source: 'daveai_hosted_full_free' };

      case 'local_trial_get_snapshot':
        return { active: false, expired: false, days_remaining: null, source: 'daveai_hosted_full_free' };

      case 'sideload_get_or_create_device_id':
        return { id: getDeviceId(), device_id: getDeviceId(), platform: 'web' };

      // ── App info ───────────────────────────────────────────────────────────
      case 'get_app_version':
        return { version: '1.7.99' };

      case 'plugin:app|version':
        return '1.7.99';

      case 'delta_check_update':
      case 'plugin:updater|check':
        return {
          status: 'up_to_date',
          available: false,
          should_update: false,
          current_version: '1.7.99',
          version: '1.7.99',
          update: null,
          source: 'daveai_hosted_full_free',
        };

      case 'plugin:updater|download_and_install':
      case 'plugin:updater|install':
      case 'install_update':
        return { ok: false, skipped: true, reason: 'hosted_browser_build' };

      case 'get_platform_info':
        return {
          os: isMac ? 'macos' : isWindows ? 'windows' : 'linux',
          arch: 'x86_64', is_web: true,
        };

      case 'is_mac':     return isMac;
      case 'is_windows': return isWindows;
      case 'is_linux':   return isLinux;
      case 'is_web':     return true;

      // ── Window management (no-ops in browser) ─────────────────────────────
      case 'minimize_window':
      case 'toggle_maximize':
      case 'close_window':
      case 'set_always_on_top':
      case 'set_frameless':
      case 'set_window_decoration':
      case 'remember_window_position':
      case 'restore_window_position':
      case 'drag_window':
      case 'set_main_window_theme_win32':
      case 'set_mpv_auto_subtitle_languages':
      case 'set_system_tray_enabled':
      case 'consume_native_crash_marker':
        return null;

      case 'get_window_state':
        return { always_on_top: false, frameless: false, maximized: true, remember_position: false };

      case 'plugin:window|get_all_windows':
        return [{ label: 'main' }];

      case 'plugin:window|is_minimized':
        return false;

      case 'plugin:window|is_visible':
        return false;

      case 'plugin:window|outer_position':
      case 'plugin:window|inner_position':
        return { x: 0, y: 0 };

      case 'plugin:window|outer_size':
      case 'plugin:window|inner_size':
        return { width: window.innerWidth || 1280, height: window.innerHeight || 720 };

      case 'plugin:window|scale_factor':
        return window.devicePixelRatio || 1;

      case 'plugin:webview|create_webview_window':
      case 'plugin:window|set_always_on_top':
      case 'plugin:window|hide':
      case 'plugin:window|show':
      case 'plugin:window|set_position':
      case 'plugin:window|set_size':
      case 'plugin:window|set_shadow':
      case 'attach_overlay_to_main_window_win32':
      case 'set_preview_bounds':
      case 'set_mpv_window_visible':
      case 'multiview_set_visible':
        return null;

      case 'plugin:event|listen':
        return registerPluginEventListener(payload);

      case 'plugin:event|unlisten':
        return unregisterPluginEventListener(payload.eventId || payload.id);

      case 'plugin:event|emit':
      case 'plugin:event|emit_to':
        emitTauriEvent(payload.event, payload.payload);
        return null;

      case 'hls_proxy_get_base_url':
        return { base_url: '', source: 'provider-vault-urls' };

      // ── Settings ───────────────────────────────────────────────────────────
      case 'get_settings':
        return safeObj(Promise.resolve(getSettings()));

      case 'save_settings':
        saveSettings(payload.settings || payload);
        return null;

      case 'get_pref':
        return Store.getPref(payload.key, payload.default_value);

      case 'set_pref':
        return Store.setPref(payload.key, payload.value);

      // ── Playlists ──────────────────────────────────────────────────────────
      case 'get_playlists':
      case 'list_playlists':
        return safeArr(Store.getPlaylists().then(applyPlaylistPrefs));

      case 'get_playlist_summaries':
      case 'list_playlist_summaries':
        return safeArr(Store.getPlaylistSummaries().then(applyPlaylistPrefs));

      case 'add_playlist': {
        var pl = { id: Store.genId(), name: payload.name, url: payload.url || '', type: payload.type || 'm3u', created_at: Date.now(), updated_at: Date.now() };
        await Store.savePlaylist(pl);
        return { id: pl.id };
      }

      case 'update_playlist':
        return Store.savePlaylist(payload);

      case 'remove_playlist':
        return Store.removePlaylist(payload.playlist_id || payload.id);

      case 'rename_playlist':
        return Store.renamePlaylist(payload.playlist_id || payload.id, payload.name);

      // ── Import M3U ────────────────────────────────────────────────────────
      case 'import_playlist_from_url': {
        var parsed = M3UParser.fetchAndParseDetailed
          ? await M3UParser.fetchAndParseDetailed(payload.url)
          : { channels: await M3UParser.fetchAndParse(payload.url), epg_url: '' };
        var pid = await Store.savePlaylist({
          id: Store.genId(),
          name: payload.name || 'Imported',
          url: payload.url,
          type: 'm3u',
          epg_url: payload.epg_url || parsed.epg_url || '',
          created_at: Date.now(),
          updated_at: Date.now(),
        });
        await Store.saveChannels(pid, parsed.channels);
        return { id: pid, channel_count: parsed.channels.length, epg_url: payload.epg_url || parsed.epg_url || '' };
      }

      case 'import_playlist_from_text': {
        var parsed = M3UParser.parseDetailed
          ? M3UParser.parseDetailed(payload.text)
          : { channels: M3UParser.parse(payload.text), epg_url: '' };
        var pid = await Store.savePlaylist({
          id: Store.genId(),
          name: payload.name || 'Pasted Playlist',
          url: '',
          type: 'm3u',
          epg_url: payload.epg_url || parsed.epg_url || '',
          created_at: Date.now(),
          updated_at: Date.now(),
        });
        await Store.saveChannels(pid, parsed.channels);
        return { id: pid, channel_count: parsed.channels.length, epg_url: payload.epg_url || parsed.epg_url || '' };
      }

      case 'refresh_playlist': {
        var existing = await Store.getPlaylists().then(function (pls) { return pls.find(function (p) { return p.id === payload.playlist_id; }); });
        if (existing && existing.url) {
          var parsed = M3UParser.fetchAndParseDetailed
            ? await M3UParser.fetchAndParseDetailed(existing.url)
            : { channels: await M3UParser.fetchAndParse(existing.url), epg_url: '' };
          if (parsed.epg_url && !existing.epg_url) {
            existing.epg_url = parsed.epg_url;
            await Store.savePlaylist(existing);
          }
          await Store.saveChannels(existing.id, parsed.channels);
          return { channel_count: parsed.channels.length, epg_url: parsed.epg_url || existing.epg_url || '' };
        }
        return { channel_count: 0 };
      }

      // ── Channels ───────────────────────────────────────────────────────────
      case 'load_channels':
        return safeArr(Store.getChannels(getPlaylistId(payload)));

      case 'get_channels':
        return safeArr(Store.getChannels(getPlaylistId(payload)));

      case 'save_channels':
        return Store.saveChannels(getPlaylistId(payload), payload.channels);

      case 'get_playlist_prefs':
        return defaultPlaylistPrefs();

      case 'save_playlist_prefs':
      case 'set_playlist_prefs':
        return defaultPlaylistPrefs();

      case 'get_playlist_status': {
        var statusChannels = await Store.getChannels(getPlaylistId(payload));
        return channelStats(statusChannels);
      }

      // ── EPG ────────────────────────────────────────────────────────────────
      case 'get_epg_programs_window':
        return safeArr(Store.getEpgProgramsWindow(payload));

      case 'refresh_epg':
      case 'restore_epg_for_playlist':
        return { ok: true, channel_count: 0, program_count: 0, source: 'web_no_epg' };

      case 'get_epg_coverage':
        return { total_channels: 0, mapped_channels: 0, coverage_pct: 0, source: 'web_no_epg' };

      case 'import_epg_from_url': {
        var result = await XmlTvParser.fetchAndParse(payload.url);
        await Store.saveEpgPrograms(result.programs);
        return { channel_count: result.channels.length, program_count: result.programs.length };
      }

      case 'clear_epg':
        return Store.clearEpg(payload.playlist_id);

      case 'set_channel_epg_mapping':
        return Store.setChannelEpgMapping(payload);

      case 'get_channel_epg_mapping':
        return Store.getChannelEpgMapping(payload.channel_id);

      case 'suggest_epg_channel_ids': {
        var xmltvChannels = await Store.getChannels(payload.playlist_id);
        return XmlTvParser.suggestEpgChannelIds(payload.channel_name, xmltvChannels);
      }

      // ── Live playback ──────────────────────────────────────────────────────
      case 'play_url':
        return PlayerShim.play(payload.url || payload.stream_url, {
          type: payload.mode || payload.type || 'live',
          live: (payload.mode || payload.type) !== 'vod',
          userAgent: payload.user_agent || payload.userAgent,
          referer: payload.referer || payload.referrer,
        });

      case 'play_live_channel': {
        var liveUrl = payload.url || payload.stream_url;
        if (!liveUrl && XtreamClient.isProviderVaultPlaylist && XtreamClient.isProviderVaultPlaylist(payload.playlist_id) && (payload.stream_id || payload.channel_id)) {
          var liveProvider = String(payload.playlist_id || '').replace(/^daveai-provider-/, '');
          liveUrl = XtreamClient.providerVaultStreamUrl(liveProvider, 'live', payload.stream_id || payload.channel_id, payload.container_extension || payload.output || 'm3u8');
        }
        if (!liveUrl && XtreamClient.getAuth(payload.playlist_id) && (payload.stream_id || payload.channel_id)) {
          var auth = XtreamClient.getAuth(payload.playlist_id);
          liveUrl = XtreamClient.buildStreamUrl(auth, payload.stream_id || payload.channel_id, payload.container_extension || payload.output || 'm3u8');
        }
        return PlayerShim.play(liveUrl, {
          type: 'live',
          live: true,
          channelId: payload.channel_id,
          userAgent: payload.user_agent || payload.userAgent,
          referer: payload.referer || payload.referrer,
        });
      }

      case 'stop_player':
      case 'stop':
      case 'vod_stop':
        return PlayerShim.stop();

      case 'toggle_pause_player':
      case 'pause':
        return PlayerShim.togglePause();

      case 'resume':
      case 'vod_resume':
        return PlayerShim.togglePause();

      case 'seek_player':
      case 'seek':
        return PlayerShim.seek(payload.time);

      case 'set_player_volume':
      case 'set_volume':
      case 'vod_set_volume':
        return PlayerShim.setVolume(Number(payload.volume) > 1 ? Number(payload.volume) / 100 : payload.volume);

      case 'set_player_mute':
      case 'set_mute':
      case 'vod_set_mute':
        return PlayerShim.setMute(payload.muted);

      case 'get_player_state':
      case 'get_state':
      case 'vod_get_stats':
        return PlayerShim.getPlayerState();

      case 'get_socks5_proxy_settings':
        return { enabled: false, host: '', port: null, username: '', password: '' };

      case 'set_mpv_user_agent':
      case 'set_mpv_http_headers':
      case 'set_mpv_playback_owner':
        return null;

      case 'set_player_quality':
        return PlayerShim.setQualityLevel(payload.level !== undefined ? payload.level : -1);

      case 'get_player_quality_levels':
        return PlayerShim.getQualityLevels();

      case 'download_stream':
        return PlayerShim.downloadStream(payload.url, payload.filename, {
          durationSecs: payload.duration_secs,
          qualityLevel: payload.quality_level,
          bitrate: payload.bitrate,
        });

      // ── VOD ────────────────────────────────────────────────────────────────
      case 'play_vod': {
        var url = payload.stream_url || payload.url;
        if (!url && XtreamClient.isProviderVaultPlaylist && XtreamClient.isProviderVaultPlaylist(payload.playlist_id)) {
          var movieProvider = String(payload.playlist_id || '').replace(/^daveai-provider-/, '');
          url = XtreamClient.providerVaultStreamUrl(movieProvider, 'movie', payload.stream_id || payload.movie_id || payload.vod_id, payload.container_extension || 'mp4');
        }
        if (!url && XtreamClient.getAuth(payload.playlist_id)) {
          var auth = XtreamClient.getAuth(payload.playlist_id);
          url = XtreamClient.buildVodUrl(auth, payload.stream_id, payload.container_extension || 'mp4');
        }
        return PlayerShim.play(url, { type: 'vod', userAgent: payload.user_agent || payload.userAgent, referer: payload.referer || payload.referrer });
      }

      case 'play_series_episode': {
        var url = payload.stream_url || payload.url;
        if (!url && XtreamClient.isProviderVaultPlaylist && XtreamClient.isProviderVaultPlaylist(payload.playlist_id)) {
          var seriesProvider = String(payload.playlist_id || '').replace(/^daveai-provider-/, '');
          url = XtreamClient.providerVaultStreamUrl(seriesProvider, 'series', payload.stream_id || payload.episode_id || payload.id, payload.container_extension || 'mkv');
        }
        if (!url && XtreamClient.getAuth(payload.playlist_id)) {
          var auth = XtreamClient.getAuth(payload.playlist_id);
          url = XtreamClient.buildSeriesUrl(auth, payload.stream_id, payload.container_extension || 'mkv');
        }
        return PlayerShim.play(url, { type: 'series', userAgent: payload.user_agent || payload.userAgent, referer: payload.referer || payload.referrer });
      }

      // ── Xtream API ─────────────────────────────────────────────────────────
      case 'xtream_authenticate': {
        var auth = XtreamClient.normalizeAuth({ url: payload.url, username: payload.username, password: payload.password, output: payload.output });
        XtreamClient.saveAuth(payload.playlist_id, auth);
        var login = await XtreamClient.authenticate(auth);
        if (payload.playlist_id) {
          var playlists = await Store.getPlaylists();
          var existing = playlists.find(function (p) { return p.id === payload.playlist_id; });
          await Store.savePlaylist(Object.assign({}, existing || {}, {
            id: payload.playlist_id,
            name: payload.name || (existing && existing.name) || 'Xtream Provider',
            url: auth.url,
            type: 'xtream',
            output: auth.output || 'm3u8',
            epg_url: XtreamClient.buildXmltvUrl(auth),
            created_at: existing && existing.created_at || Date.now(),
            updated_at: Date.now(),
          }));
        }
        return login;
      }

      case 'xtream_get_live_categories':
        return XtreamClient.getLiveCategories(payload.playlist_id);

      case 'xtream_get_live_streams':
        return XtreamClient.getLiveStreams(payload);

      case 'xtream_get_movie_categories':
        return XtreamClient.getMovieCategories(payload.playlist_id);

      case 'xtream_list_movies':
        return XtreamClient.listMovies(payload);

      case 'xtream_get_movie_details':
        return XtreamClient.getMovieDetails(payload);

      case 'xtream_get_series_categories':
        return XtreamClient.getSeriesCategories(payload.playlist_id);

      case 'xtream_list_series':
        return XtreamClient.listSeries(payload);

      case 'xtream_get_series_details':
        return XtreamClient.getSeriesDetails(payload);

      // ── Watch state ────────────────────────────────────────────────────────
      case 'get_watched_movies':
        return safeArr(Store.getWatchedMovies(payload.playlist_id));

      case 'get_continue_watching':
        return safeArr(Store.getContinueWatching ? Store.getContinueWatching(payload.playlist_id) : []);

      case 'get_watched_episodes':
        return safeArr(Store.getWatchedEpisodes ? Store.getWatchedEpisodes(payload.playlist_id) : []);

      case 'get_favorite_channel_order':
        return { channel_ids: [], movie_ids: [], series_ids: [] };

      case 'get_recently_watched':
      case 'get_favorites':
        return [];

      case 'mark_recently_watched':
      case 'record_playlist_diagnostic':
        return [];

      case 'mark_movie_watched':
        return Store.markMovieWatched(payload);

      case 'upsert_continue_watching':
        return Store.upsertContinueWatching(payload);

      case 'remove_continue_watching':
        return Store.removeContinueWatching(payload);

      case 'toggle_movie_favorite':
        return Store.toggleMovieFavorite(payload);

      case 'toggle_series_favorite':
        return Store.toggleSeriesFavorite(payload);

      case 'mark_episode_viewed':
        return Store.markEpisodeViewed(payload);

      case 'mark_episodes_viewed_bulk':
        return Store.markEpisodesViewedBulk(payload);

      case 'unmark_episodes_viewed_bulk':
        return Store.unmarkEpisodesViewedBulk(payload);

      // ── VOD Downloads (stubs — no file system access in browser) ──────────
      case 'get_vod_downloads':
        return safeArr(Store.getVodDownloads());

      case 'start_vod_download':
        return Store.saveVodDownload({ id: Store.genId(), url: payload.url, title: payload.title, status: 'unsupported', created_at: Date.now() });

      case 'cancel_vod_download':
      case 'delete_vod_download':
        return Store.deleteVodDownload(payload.id);

      // ── Recordings (no filesystem) ─────────────────────────────────────────
      case 'get_recordings':
      case 'list_recordings':
        return [];

      case 'start_recording':
      case 'stop_recording':
      case 'delete_recording':
        return {};

      // ── Catchup ────────────────────────────────────────────────────────────
      case 'get_catchup_url': {
        var catchupUrl = payload.url || payload.stream_url || '';
        if (!catchupUrl && XtreamClient.getAuth(payload.playlist_id) && (payload.stream_id || payload.channel_id)) {
          var auth = XtreamClient.getAuth(payload.playlist_id);
          catchupUrl = XtreamClient.buildCatchupUrl(
            auth,
            payload.stream_id || payload.channel_id,
            payload.start || payload.start_time || payload.start_timestamp || '',
            payload.duration_minutes || payload.duration || 120,
            payload.container_extension || payload.output || 'm3u8'
          );
        }
        return { url: catchupUrl };
      }

      case 'play_catchup':
        return PlayerShim.play(payload.url, { type: 'catchup', userAgent: payload.user_agent || payload.userAgent, referer: payload.referer || payload.referrer });

      // ── Multi-view ─────────────────────────────────────────────────────────
      case 'get_multiview_state':
        return { active: false, streams: [] };

      case 'set_multiview_streams':
      case 'toggle_multiview':
      case 'multiview_close_all':
      case 'multiview_close':
        return {};

      // ── Google Cast (no-op) ────────────────────────────────────────────────
      case 'cast_to_device':
      case 'stop_cast':
      case 'get_cast_devices':
        return [];

      // ── Subtitles ──────────────────────────────────────────────────────────
      case 'get_subtitle_tracks':
        return [];

      case 'set_subtitle_track':
        return null;

      case 'search_opensubtitles':
        return [];

      // ── Trakt.tv (passthrough via browser fetch) ───────────────────────────
      case 'trakt_auth_url':
        return { url: 'https://trakt.tv/oauth/authorize' };

      case 'trakt_proxy_status':
        return { configured: false, authenticated: false, connected: false, source: 'web_shim' };

      case 'trakt_exchange_code':
      case 'trakt_refresh_token':
        return {};

      case 'trakt_get_watched':
      case 'trakt_get_ratings':
      case 'trakt_sync':
        return [];

      // ── Diagnostics ────────────────────────────────────────────────────────
      case 'get_diagnostics':
        return { version: '1.7.99', platform: 'web', uptime: Math.floor(performance.now() / 1000), storage: 'indexeddb' };

      case 'get_recording_settings':
        return { enabled: false, path: '', quality: 'source', format: 'webm' };

      case 'log_diagnostic':
        console.log('[IPZ diag]', payload);
        return null;

      case 'open_logs_folder':
      case 'copy_logs':
        return null;

      // ── Backup/restore (localStorage export) ──────────────────────────────
      case 'export_backup': {
        var playlists = await Store.getPlaylists();
        var blob = new Blob([JSON.stringify({ playlists: playlists, settings: getSettings() }, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ipz-backup-' + Date.now() + '.json';
        a.click();
        return null;
      }

      case 'import_backup': {
        try {
          var data = JSON.parse(payload.json);
          if (data.settings) saveSettings(data.settings);
          if (data.playlists) {
            for (var i = 0; i < data.playlists.length; i++) {
              await Store.savePlaylist(data.playlists[i]);
            }
          }
        } catch (e) { console.error('[tauri-shim] Backup import failed', e); }
        return null;
      }

      // ── Scheduled recordings (no-op) ──────────────────────────────────────
      case 'get_scheduled_recordings':
      case 'list_scheduled_recordings':
        return [];

      case 'add_scheduled_recording':
      case 'remove_scheduled_recording':
        return null;

      // ── Sports / upcoming ──────────────────────────────────────────────────
      case 'get_upcoming_sports':
      case 'get_sports_leagues':
        return [];

      // ── Keyboard shortcuts ─────────────────────────────────────────────────
      case 'get_keyboard_shortcuts':
        return {};

      case 'set_keyboard_shortcut':
        return {};

      // ── Default: smart return — [] for list/get-many cmds, {} otherwise ────
      default:
        console.warn('[tauri-shim] Unhandled command:', cmd, payload);
        return /^(get_|list_|fetch_|search_|xtream_get|xtream_list)/.test(cmd) ? [] : {};
    }
  }

  // ── Expose as window.__TAURI_INTERNALS__ ──────────────────────────────────
  // The React bundle checks for BOTH invoke + ipc.postMessage (or convertFileSrc)
  // to enter Tauri mode. All three must be present.
  window.__TAURI_INTERNALS__ = {
    invoke: invoke,
    transformCallback: function (cb, once) {
      var id = '_tc_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      window[id] = function (val) { cb(val); if (once) delete window[id]; };
      return id;
    },
    ipc: {
      postMessage: function (msg) {
        // Intercept IPC postMessage — parse cmd and route through invoke
        try {
          var data = typeof msg === 'string' ? JSON.parse(msg) : msg;
          var cmd = data.cmd || (data.payload && data.payload.cmd) || '';
          var callbackId = data.callback || (data.payload && data.payload.callback);
          var errorId = data.error || (data.payload && data.payload.error);
          var args = data.payload || data;
          invoke(cmd, args).then(function (result) {
            if (callbackId && window[callbackId]) window[callbackId](result);
          }).catch(function (err) {
            if (errorId && window[errorId]) window[errorId](err);
          });
        } catch (e) { console.warn('[tauri-shim] ipc.postMessage parse error', e); }
      },
    },
    convertFileSrc: function (src) { return src; },
    sendIpcMessage: function (msg) {
      if (window.__TAURI_INTERNALS__.ipc) window.__TAURI_INTERNALS__.ipc.postMessage(msg);
    },
    metadata: { currentWindow: { label: 'main' } },
  };

  // ── Also expose as window.__TAURI__ for older import paths ────────────────
  window.__TAURI__ = {
    core: { invoke: invoke },
    event: {
      emit: function (event, payload) { emitTauriEvent(event, payload); return Promise.resolve(); },
      listen: function (event, cb) {
        var handler = function (e) { cb({ event: event, payload: e.detail }); };
        window.addEventListener('tauri:' + event, handler);
        return Promise.resolve(function () { window.removeEventListener('tauri:' + event, handler); });
      },
      once: function (event, cb) {
        var handler = function (e) { cb({ event: event, payload: e.detail }); window.removeEventListener('tauri:' + event, handler); };
        window.addEventListener('tauri:' + event, handler);
        return Promise.resolve(function () { window.removeEventListener('tauri:' + event, handler); });
      },
    },
    window: {
      appWindow: {
        minimize: function () { return invoke('minimize_window'); },
        toggleMaximize: function () { return invoke('toggle_maximize'); },
        close: function () { return invoke('close_window'); },
      },
    },
    app: { getVersion: function () { return Promise.resolve('1.7.99'); } },
  };

  // ── Emit initial licensing_channel status event ──────────────────────────
  function bootLicenseStatus() {
    emitTauriEvent('licensing_channel', hostedFullLicenseStatus());
  }

  function textOf(node) {
    return String(node && node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function removeClosest(node, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var target = node.closest && node.closest(selectors[i]);
      if (target && target.parentNode) {
        target.parentNode.removeChild(target);
        return true;
      }
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node);
      return true;
    }
    return false;
  }

  function polishHostedFullFreeUi() {
    var paidPattern = /\b(upgrade to pro|upgrade|lifetime unlock|\$12\.99|stripe|purchase|forgot password|refresh license|72-hour pro trial|free mode|low price)\b/i;
    var replacePattern = /3h\s*\(free\)/ig;
    var proOnlyPattern = /^\s*PRO\s*$/i;
    var nodes = Array.prototype.slice.call(document.querySelectorAll('button,a,section,div,span,p'));
    nodes.forEach(function (node) {
      var text = textOf(node);
      if (!text) return;
      if (proOnlyPattern.test(text) && node.childElementCount === 0) {
        node.textContent = 'FREE PRO';
        return;
      }
      if (replacePattern.test(text) && node.childElementCount === 0) {
        node.textContent = text.replace(replacePattern, 'Full guide');
        return;
      }
      if (!paidPattern.test(text)) return;

      var ownText = text.length < 180;
      var isAction = /^(upgrade to pro|upgrade|refresh license|forgot password|\$12\.99|low price)$/i.test(text);
      var isPaymentSection = /\b(lifetime unlock|stripe|purchase|72-hour pro trial|free mode)\b/i.test(text);
      var upgradeShell = node.closest && node.closest('.ipz-upgrade-modal-shell');
      if (upgradeShell && upgradeShell.parentNode) {
        upgradeShell.parentNode.removeChild(upgradeShell);
        return;
      }
      if (isAction || (isPaymentSection && ownText)) {
        removeClosest(node, ['.ipz-upgrade-modal-shell', '[role="dialog"] section', 'section', '.rounded-2xl', '.rounded-xl', 'button', 'a']);
      }
    });
  }

  function installHostedFullFreeUiPolish() {
    try {
      if (!document.getElementById('ipz-daveai-free-pro-style')) {
        var style = document.createElement('style');
        style.id = 'ipz-daveai-free-pro-style';
        style.textContent = [
          '.ipz-upgrade-modal-shell{display:none!important}',
          '.ipz-upgrade-buy-btn,.ipz-keep-pro-forever-btn{display:none!important}',
        ].join('\n');
        document.head.appendChild(style);
      }
    } catch (e) {}

    var run = function () {
      try { polishHostedFullFreeUi(); } catch (e) {}
    };
    run();
    setTimeout(run, 500);
    setTimeout(run, 1500);
    setTimeout(run, 3500);
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () { run(); }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
  }

  bootLicenseStatus();
  installHostedCrashRecovery();
  setTimeout(bootLicenseStatus, 500);
  setTimeout(bootLicenseStatus, 1500);
  setTimeout(bootLicenseStatus, 3000);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installHostedFullFreeUiPolish, { once: true });
  } else {
    installHostedFullFreeUiPolish();
  }

  console.log('[tauri-shim] IPTV Player Zero 1.7.99 web shim loaded');

}(window));
