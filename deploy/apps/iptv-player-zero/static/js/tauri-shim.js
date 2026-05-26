/**
 * tauri-shim.js — Full Tauri IPC shim for IPTV Player Zero 1.7.99.
 * Replaces window.__TAURI_INTERNALS__.invoke() with browser implementations.
 * Depends on: store.js, player-shim.js, m3u-parser.js, xmltv-parser.js, xtream-client.js
 * Must load before the React bundle (index-DUfsF0mF.js).
 */
(function (window) {
  'use strict';

  // ── Helper: emit event the React app listens to via Tauri events ──────────
  function emitTauriEvent(event, payload) {
    window.dispatchEvent(new CustomEvent('tauri:' + event, { detail: payload }));
  }

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
  function freeLicenseStatus() {
    return {
      status: 'inactive', plan: 'free',
      expiry: null, trial_days: 0,
      lifetimeUnlocked: false, premiumActive: false,
      purchaseRequired: true, isTrial: false,
      source: 'web_shim_no_license',
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
      var _arrCmds = ['get_playlists','get_playlist_summaries','get_channels','get_epg_programs_window','get_watched_movies','get_vod_downloads','get_recordings','list_recordings','get_cast_devices','get_subtitle_tracks','trakt_get_watched','trakt_get_ratings','trakt_sync','get_scheduled_recordings','list_scheduled_recordings','get_upcoming_sports','get_sports_leagues','get_quality_levels','get_player_quality_levels'];
      return _arrCmds.indexOf(cmd) >= 0 ? [] : {};
    }

    switch (cmd) {

      // ── Licensing — browser shim reports free mode; purchases stay upstream.
      case 'load_recovery_token':
      case 'validate_license':
      case 'check_license':
      case 'get_license_status':
      case 'activate_license':
      case 'restore_license':
      case 'sideload_get_cached_license_status':
      case 'sideload_get_license_status':
        return freeLicenseStatus();

      case 'sideload_get_checkout_availability':
        return { available: false, checkout_url: null, source: 'web_shim_no_checkout' };

      case 'local_trial_get_snapshot':
        return { active: false, expired: false, days_remaining: 0, source: 'web_shim_no_trial' };

      case 'sideload_get_or_create_device_id':
        return { id: getDeviceId(), device_id: getDeviceId(), platform: 'web' };

      // ── App info ───────────────────────────────────────────────────────────
      case 'get_app_version':
        return { version: '1.7.99' };

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

      case 'plugin:event|listen':
      case 'plugin:webview|create_webview_window':
      case 'plugin:window|set_always_on_top':
      case 'plugin:window|hide':
      case 'plugin:window|set_shadow':
      case 'attach_overlay_to_main_window_win32':
        return null;

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
        return safeArr(Store.getPlaylists());

      case 'get_playlist_summaries':
      case 'list_playlist_summaries':
        return safeArr(Store.getPlaylistSummaries());

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
      case 'get_channels':
        return safeArr(Store.getChannels(payload.playlist_id));

      case 'save_channels':
        return Store.saveChannels(payload.playlist_id, payload.channels);

      // ── EPG ────────────────────────────────────────────────────────────────
      case 'get_epg_programs_window':
        return safeArr(Store.getEpgProgramsWindow(payload));

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
      case 'play_live_channel': {
        var liveUrl = payload.url || payload.stream_url;
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
        return PlayerShim.stop();

      case 'toggle_pause_player':
        return PlayerShim.togglePause();

      case 'seek_player':
        return PlayerShim.seek(payload.time);

      case 'set_player_volume':
        return PlayerShim.setVolume(payload.volume);

      case 'set_player_mute':
        return PlayerShim.setMute(payload.muted);

      case 'get_player_state':
        return PlayerShim.getPlayerState();

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
        if (!url && XtreamClient.getAuth(payload.playlist_id)) {
          var auth = XtreamClient.getAuth(payload.playlist_id);
          url = XtreamClient.buildVodUrl(auth, payload.stream_id, payload.container_extension || 'mp4');
        }
        return PlayerShim.play(url, { type: 'vod', userAgent: payload.user_agent || payload.userAgent, referer: payload.referer || payload.referrer });
      }

      case 'play_series_episode': {
        var url = payload.stream_url || payload.url;
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

      case 'get_recently_watched':
      case 'get_favorites':
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
    emitTauriEvent('licensing_channel', freeLicenseStatus());
  }

  bootLicenseStatus();
  setTimeout(bootLicenseStatus, 500);
  setTimeout(bootLicenseStatus, 1500);
  setTimeout(bootLicenseStatus, 3000);

  console.log('[tauri-shim] IPTV Player Zero 1.7.99 web shim loaded');

}(window));
