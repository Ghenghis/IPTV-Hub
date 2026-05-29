/**
 * xtream-client.js — Xtream Codes API client replacing Rust xtream commands.
 * Credentials stored in localStorage per playlist_id.
 */
(function (window) {
  'use strict';

  function getAuth(playlistId) {
    var raw = localStorage.getItem('xtream_auth_' + playlistId);
    return raw ? JSON.parse(raw) : null;
  }

  var PROVIDER_PREFIX = 'daveai-provider-';

  function providerIdFromPlaylist(playlistId) {
    var id = String(playlistId || '');
    return id.indexOf(PROVIDER_PREFIX) === 0 ? id.slice(PROVIDER_PREFIX.length) : '';
  }

  function isProviderVaultPlaylist(playlistId) {
    return Boolean(providerIdFromPlaylist(playlistId));
  }

  function normalizeBaseUrl(url) {
    var raw = (url || '').trim();
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
    try {
      var parsed = new URL(raw);
      parsed.pathname = parsed.pathname
        .replace(/\/?(player_api|panel_api|get|xmltv)\.php\/?$/i, '')
        .replace(/\/+$/, '');
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    } catch (e) {
      return raw.replace(/\/?(player_api|panel_api|get|xmltv)\.php.*$/i, '').replace(/\/$/, '');
    }
  }

  function normalizeAuth(auth) {
    auth = auth || {};
    return {
      url: normalizeBaseUrl(auth.url || auth.server || auth.base_url || ''),
      username: (auth.username || auth.user || '').trim(),
      password: (auth.password || auth.pass || '').trim(),
      output: (auth.output || auth.stream_format || '').trim(),
    };
  }

  function saveAuth(playlistId, auth) {
    localStorage.setItem('xtream_auth_' + playlistId, JSON.stringify(normalizeAuth(auth)));
  }

  function proxyUrl(url) {
    return /^https?:\/\//i.test(url)
      ? '/api/iptv-proxy?url=' + encodeURIComponent(url)
      : url;
  }

  function providerVaultApi(providerId, action, extra) {
    var params = new URLSearchParams(Object.assign({ provider: providerId, action: action || '' }, extra || {}));
    if (!action) params.delete('action');
    return '/api/provider-vault/xtream-api?' + params.toString();
  }

  async function providerVaultFetch(providerId, action, extra) {
    var resp = await fetch(providerVaultApi(providerId, action, extra), {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json,text/plain,*/*' },
    });
    if (!resp.ok) throw new Error('Provider vault HTTP ' + resp.status);
    return resp.json();
  }

  function publicStreamUrl(providerId, kind, streamId, ext) {
    providerId = String(providerId || '').toLowerCase();
    kind = String(kind || '');
    if (providerId === 'apollo' && kind === 'live') {
      var hlsParams = new URLSearchParams({
        provider: providerId,
        kind: kind,
        id: String(streamId || ''),
        ext: 'ts',
      });
      return '/api/provider-vault/aac-hls?' + hlsParams.toString();
    }
    var params = new URLSearchParams({
      provider: providerId,
      kind: kind,
      id: String(streamId || ''),
      ext: ext || (kind === 'live' ? 'm3u8' : kind === 'movie' ? 'mp4' : 'mkv'),
    });
    return '/api/provider-vault/stream?' + params.toString();
  }

  function buildUrl(auth, action, extra) {
    auth = normalizeAuth(auth);
    if (!auth.url || !auth.username || !auth.password) throw new Error('Missing Xtream provider URL, username, or password');
    var base = auth.url.replace(/\/$/, '');
    var params = new URLSearchParams(Object.assign({ username: auth.username, password: auth.password, action: action }, extra || {}));
    if (!action) params.delete('action');
    return base + '/player_api.php?' + params.toString();
  }

  async function apiFetch(url) {
    var resp = await fetch(proxyUrl(url), {
      headers: { 'Accept': 'application/json,text/plain,*/*' },
    });
    if (!resp.ok) throw new Error('Xtream API HTTP ' + resp.status);
    var text = await resp.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Xtream API returned non-JSON data');
    }
  }

  function buildStreamUrl(auth, streamId, ext) {
    auth = normalizeAuth(auth);
    var base = auth.url.replace(/\/$/, '');
    return base + '/live/' + auth.username + '/' + auth.password + '/' + streamId + '.' + (ext || auth.output || 'ts');
  }

  function buildVodUrl(auth, streamId, ext) {
    auth = normalizeAuth(auth);
    var base = auth.url.replace(/\/$/, '');
    return base + '/movie/' + auth.username + '/' + auth.password + '/' + streamId + '.' + (ext || 'mp4');
  }

  function buildSeriesUrl(auth, streamId, ext) {
    auth = normalizeAuth(auth);
    var base = auth.url.replace(/\/$/, '');
    return base + '/series/' + auth.username + '/' + auth.password + '/' + streamId + '.' + (ext || 'mkv');
  }

  function buildM3uUrl(auth, output) {
    auth = normalizeAuth(auth);
    var base = auth.url.replace(/\/$/, '');
    var params = new URLSearchParams({
      username: auth.username,
      password: auth.password,
      type: 'm3u_plus',
      output: output || auth.output || 'm3u8',
    });
    return base + '/get.php?' + params.toString();
  }

  function buildXmltvUrl(auth) {
    auth = normalizeAuth(auth);
    var base = auth.url.replace(/\/$/, '');
    var params = new URLSearchParams({ username: auth.username, password: auth.password });
    return base + '/xmltv.php?' + params.toString();
  }

  function buildCatchupUrl(auth, streamId, start, durationMinutes, ext) {
    auth = normalizeAuth(auth);
    var base = auth.url.replace(/\/$/, '');
    var duration = Math.max(1, Math.round(Number(durationMinutes) || 120));
    var startText = String(start || '').replace(/[^0-9-: ]/g, '').trim();
    return base + '/timeshift/' + auth.username + '/' + auth.password + '/' + duration + '/' + encodeURIComponent(startText) + '/' + streamId + '.' + (ext || auth.output || 'ts');
  }

  window.XtreamClient = {
    saveAuth: saveAuth,
    getAuth: getAuth,
    normalizeAuth: normalizeAuth,
    proxyUrl: proxyUrl,
    authenticate: function (auth) {
      auth = normalizeAuth(auth);
      return apiFetch(buildUrl(auth)).then(function (result) {
        if (result && result.user_info && String(result.user_info.auth) === '0') {
          throw new Error('Xtream credentials were rejected by the provider');
        }
        return result;
      });
    },

    getLiveCategories: function (playlistId) {
      var providerId = providerIdFromPlaylist(playlistId);
      if (providerId) return providerVaultFetch(providerId, 'get_live_categories');
      var auth = getAuth(playlistId);
      if (!auth) return Promise.resolve([]);
      return apiFetch(buildUrl(auth, 'get_live_categories'));
    },
    getLiveStreams: function (payload) {
      var providerId = providerIdFromPlaylist(payload.playlist_id);
      if (providerId) {
        var pvExtra = payload.category_id ? { category_id: payload.category_id } : {};
        return providerVaultFetch(providerId, 'get_live_streams', pvExtra);
      }
      var auth = getAuth(payload.playlist_id);
      if (!auth) return Promise.resolve([]);
      var extra = payload.category_id ? { category_id: payload.category_id } : {};
      return apiFetch(buildUrl(auth, 'get_live_streams', extra));
    },
    getMovieCategories: function (playlistId) {
      var providerId = providerIdFromPlaylist(playlistId);
      if (providerId) return providerVaultFetch(providerId, 'get_vod_categories');
      var auth = getAuth(playlistId);
      if (!auth) return Promise.resolve([]);
      return apiFetch(buildUrl(auth, 'get_vod_categories'));
    },
    listMovies: function (payload) {
      var providerId = providerIdFromPlaylist(payload.playlist_id);
      if (providerId) {
        var pvExtra = payload.category_id ? { category_id: payload.category_id } : {};
        return providerVaultFetch(providerId, 'get_vod_streams', pvExtra);
      }
      var auth = getAuth(payload.playlist_id);
      if (!auth) return Promise.resolve([]);
      var extra = payload.category_id ? { category_id: payload.category_id } : {};
      return apiFetch(buildUrl(auth, 'get_vod_streams', extra));
    },
    getMovieDetails: function (payload) {
      var providerId = providerIdFromPlaylist(payload.playlist_id);
      if (providerId) return providerVaultFetch(providerId, 'get_vod_info', { vod_id: payload.movie_id });
      var auth = getAuth(payload.playlist_id);
      if (!auth) return Promise.resolve(null);
      return apiFetch(buildUrl(auth, 'get_vod_info', { vod_id: payload.movie_id }));
    },
    getSeriesCategories: function (playlistId) {
      var providerId = providerIdFromPlaylist(playlistId);
      if (providerId) return providerVaultFetch(providerId, 'get_series_categories');
      var auth = getAuth(playlistId);
      if (!auth) return Promise.resolve([]);
      return apiFetch(buildUrl(auth, 'get_series_categories'));
    },
    listSeries: function (payload) {
      var providerId = providerIdFromPlaylist(payload.playlist_id);
      if (providerId) {
        var pvExtra = payload.category_id ? { category_id: payload.category_id } : {};
        return providerVaultFetch(providerId, 'get_series', pvExtra);
      }
      var auth = getAuth(payload.playlist_id);
      if (!auth) return Promise.resolve([]);
      var extra = payload.category_id ? { category_id: payload.category_id } : {};
      return apiFetch(buildUrl(auth, 'get_series', extra));
    },
    getSeriesDetails: function (payload) {
      var providerId = providerIdFromPlaylist(payload.playlist_id);
      if (providerId) return providerVaultFetch(providerId, 'get_series_info', { series_id: payload.series_id });
      var auth = getAuth(payload.playlist_id);
      if (!auth) return Promise.resolve(null);
      return apiFetch(buildUrl(auth, 'get_series_info', { series_id: payload.series_id }));
    },

    buildStreamUrl: buildStreamUrl,
    buildVodUrl: buildVodUrl,
    buildSeriesUrl: buildSeriesUrl,
    buildM3uUrl: buildM3uUrl,
    buildXmltvUrl: buildXmltvUrl,
    buildCatchupUrl: buildCatchupUrl,
    isProviderVaultPlaylist: isProviderVaultPlaylist,
    providerVaultStreamUrl: publicStreamUrl,
  };

}(window));
