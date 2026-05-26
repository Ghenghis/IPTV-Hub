/**
 * store.js — IndexedDB persistence layer replacing Tauri/SQLite backend.
 * Mirrors every table used by IPTV Player Zero 1.7.99.
 * Must load before tauri-shim.js.
 */
(function (window) {
  'use strict';

  var DB_NAME = 'ipz-db';
  var DB_VERSION = 2;
  var _db = null;

  function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('playlists')) {
          db.createObjectStore('playlists', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('channels')) {
          var cs = db.createObjectStore('channels', { keyPath: 'id' });
          cs.createIndex('playlist_id', 'playlist_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('epg_programs')) {
          var es = db.createObjectStore('epg_programs', { keyPath: 'id' });
          es.createIndex('channel_id', 'channel_id', { unique: false });
          es.createIndex('start', 'start', { unique: false });
        }
        if (!db.objectStoreNames.contains('watched_movies')) {
          db.createObjectStore('watched_movies', { keyPath: ['movie_id', 'playlist_id'] });
        }
        if (!db.objectStoreNames.contains('watched_episodes')) {
          db.createObjectStore('watched_episodes', { keyPath: ['episode_id', 'playlist_id'] });
        }
        if (!db.objectStoreNames.contains('vod_downloads')) {
          db.createObjectStore('vod_downloads', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('prefs')) {
          db.createObjectStore('prefs', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('epg_mappings')) {
          db.createObjectStore('epg_mappings', { keyPath: 'channel_id' });
        }
        if (!db.objectStoreNames.contains('favorites')) {
          db.createObjectStore('favorites', { keyPath: ['item_id', 'type', 'playlist_id'] });
        }
        if (!db.objectStoreNames.contains('diagnostics')) {
          db.createObjectStore('diagnostics', { keyPath: 'id' });
        }
      };
      req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function tx(storeName, mode) {
    return openDb().then(function (db) {
      return db.transaction(storeName, mode).objectStore(storeName);
    });
  }

  function promReq(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function (e) { res(e.target.result); };
      req.onerror = function (e) { rej(e.target.error); };
    });
  }

  function storeGet(storeName, key) {
    return tx(storeName, 'readonly').then(function (s) { return promReq(s.get(key)); });
  }
  function storeGetAll(storeName) {
    return tx(storeName, 'readonly').then(function (s) { return promReq(s.getAll()); });
  }
  function storePut(storeName, value) {
    return tx(storeName, 'readwrite').then(function (s) { return promReq(s.put(value)); });
  }
  function storeDelete(storeName, key) {
    return tx(storeName, 'readwrite').then(function (s) { return promReq(s.delete(key)); });
  }
  function storeGetByIndex(storeName, indexName, value) {
    return tx(storeName, 'readonly').then(function (s) { return promReq(s.index(indexName).getAll(value)); });
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ── Playlists ──────────────────────────────────────────────────────────────
  function getPlaylists() { return storeGetAll('playlists'); }

  function getPlaylistSummaries() {
    return getPlaylists().then(function (playlists) {
      return Promise.all(playlists.map(function (p) {
        return storeGetByIndex('channels', 'playlist_id', p.id).then(function (ch) {
          return Object.assign({}, p, { channel_count: ch.length });
        });
      }));
    });
  }

  function savePlaylist(playlist) {
    if (!playlist.id) playlist.id = genId();
    playlist.created_at = playlist.created_at || Date.now();
    playlist.updated_at = Date.now();
    return storePut('playlists', playlist).then(function () { return playlist.id; });
  }

  function removePlaylist(playlistId) {
    return storeDelete('playlists', playlistId).then(function () {
      return storeGetByIndex('channels', 'playlist_id', playlistId).then(function (channels) {
        return tx('channels', 'readwrite').then(function (s) {
          channels.forEach(function (c) { s.delete(c.id); });
        });
      });
    });
  }

  function renamePlaylist(playlistId, name) {
    return storeGet('playlists', playlistId).then(function (p) {
      if (p) { p.name = name; p.updated_at = Date.now(); return storePut('playlists', p); }
    });
  }

  // ── Channels ───────────────────────────────────────────────────────────────
  function saveChannels(playlistId, channels) {
    return storeGetByIndex('channels', 'playlist_id', playlistId).then(function (existing) {
      return tx('channels', 'readwrite').then(function (s) {
        existing.forEach(function (c) { s.delete(c.id); });
        var order = 0;
        channels.forEach(function (ch) {
          ch.playlist_id = playlistId;
          ch.id = ch.id || (playlistId + '_' + order);
          ch.sort_order = order++;
          s.put(ch);
        });
        return channels.length;
      });
    });
  }

  function getChannels(playlistId) {
    return storeGetByIndex('channels', 'playlist_id', playlistId).then(function (channels) {
      return channels.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
    });
  }

  // ── EPG ────────────────────────────────────────────────────────────────────
  function saveEpgPrograms(programs) {
    return tx('epg_programs', 'readwrite').then(function (s) {
      programs.forEach(function (p) {
        p.id = p.id || (p.channel_id + '_' + p.start);
        s.put(p);
      });
    });
  }

  function getEpgProgramsWindow(payload) {
    var channel_ids = payload.channel_ids;
    var start = payload.start;
    var end = payload.end;
    var result = [];
    var promises = channel_ids.map(function (cid) {
      return storeGetByIndex('epg_programs', 'channel_id', cid).then(function (programs) {
        programs.filter(function (p) { return p.end > start && p.start < end; })
          .forEach(function (p) { result.push(p); });
      });
    });
    return Promise.all(promises).then(function () { return result; });
  }

  function clearEpg(playlistId) {
    return getChannels(playlistId).then(function (channels) {
      var cids = new Set(channels.map(function (c) { return c.id; }));
      return storeGetAll('epg_programs').then(function (all) {
        return tx('epg_programs', 'readwrite').then(function (s) {
          all.filter(function (p) { return cids.has(p.channel_id); })
            .forEach(function (p) { s.delete(p.id); });
        });
      });
    });
  }

  // ── Prefs ──────────────────────────────────────────────────────────────────
  function getPref(key, defaultVal) {
    if (defaultVal === undefined) defaultVal = null;
    return storeGet('prefs', key).then(function (row) {
      if (!row) return defaultVal;
      try { return JSON.parse(row.value); } catch (e) { return row.value; }
    });
  }

  function setPref(key, value) {
    return storePut('prefs', { key: key, value: JSON.stringify(value) });
  }

  // ── Watch state ────────────────────────────────────────────────────────────
  function getWatchedMovies(playlistId) {
    return storeGetAll('watched_movies').then(function (all) {
      return all.filter(function (m) { return m.playlist_id === playlistId; });
    });
  }

  function markMovieWatched(payload) {
    return storePut('watched_movies', {
      movie_id: payload.movie_id, playlist_id: payload.playlist_id,
      watched: true, updated_at: Date.now()
    });
  }

  function upsertContinueWatching(payload) {
    return storeGet('watched_movies', [payload.movie_id, payload.playlist_id]).then(function (existing) {
      return storePut('watched_movies', Object.assign({}, existing || {}, {
        movie_id: payload.movie_id, playlist_id: payload.playlist_id,
        position: payload.time, updated_at: Date.now()
      }));
    });
  }

  function removeContinueWatching(payload) {
    return storeGet('watched_movies', [payload.movie_id, payload.playlist_id]).then(function (existing) {
      if (existing) { existing.position = 0; return storePut('watched_movies', existing); }
    });
  }

  function toggleMovieFavorite(payload) {
    var key = [payload.movie_id, 'movie', payload.playlist_id];
    return storeGet('favorites', key).then(function (existing) {
      if (existing) return storeDelete('favorites', key);
      return storePut('favorites', { item_id: payload.movie_id, type: 'movie', playlist_id: payload.playlist_id, added_at: Date.now() });
    });
  }

  function markEpisodeViewed(payload) {
    return storePut('watched_episodes', {
      episode_id: payload.episode_id, series_id: payload.series_id || '',
      playlist_id: payload.playlist_id, viewed: true, updated_at: Date.now()
    });
  }

  function markEpisodesViewedBulk(payload) {
    return tx('watched_episodes', 'readwrite').then(function (s) {
      payload.episode_ids.forEach(function (eid) {
        s.put({ episode_id: eid, playlist_id: payload.playlist_id, viewed: true, updated_at: Date.now() });
      });
    });
  }

  function unmarkEpisodesViewedBulk(payload) {
    return tx('watched_episodes', 'readwrite').then(function (s) {
      payload.episode_ids.forEach(function (eid) {
        s.put({ episode_id: eid, playlist_id: payload.playlist_id, viewed: false, updated_at: Date.now() });
      });
    });
  }

  function toggleSeriesFavorite(payload) {
    var key = [payload.series_id, 'series', payload.playlist_id];
    return storeGet('favorites', key).then(function (existing) {
      if (existing) return storeDelete('favorites', key);
      return storePut('favorites', { item_id: payload.series_id, type: 'series', playlist_id: payload.playlist_id, added_at: Date.now() });
    });
  }

  function setChannelEpgMapping(payload) {
    return storePut('epg_mappings', { channel_id: payload.channel_id, epg_id: payload.epg_id });
  }

  function getChannelEpgMapping(channel_id) {
    return storeGet('epg_mappings', channel_id);
  }

  // ── VOD Downloads ──────────────────────────────────────────────────────────
  function getVodDownloads() { return storeGetAll('vod_downloads'); }

  function saveVodDownload(dl) {
    if (!dl.id) dl.id = genId();
    return storePut('vod_downloads', dl).then(function () { return dl.id; });
  }

  function deleteVodDownload(id) { return storeDelete('vod_downloads', id); }

  // ── Exports ────────────────────────────────────────────────────────────────
  window.Store = {
    openDb: openDb,
    genId: genId,
    getPlaylists: getPlaylists,
    getPlaylistSummaries: getPlaylistSummaries,
    savePlaylist: savePlaylist,
    removePlaylist: removePlaylist,
    renamePlaylist: renamePlaylist,
    saveChannels: saveChannels,
    getChannels: getChannels,
    saveEpgPrograms: saveEpgPrograms,
    getEpgProgramsWindow: getEpgProgramsWindow,
    clearEpg: clearEpg,
    getPref: getPref,
    setPref: setPref,
    getWatchedMovies: getWatchedMovies,
    markMovieWatched: markMovieWatched,
    upsertContinueWatching: upsertContinueWatching,
    removeContinueWatching: removeContinueWatching,
    toggleMovieFavorite: toggleMovieFavorite,
    markEpisodeViewed: markEpisodeViewed,
    markEpisodesViewedBulk: markEpisodesViewedBulk,
    unmarkEpisodesViewedBulk: unmarkEpisodesViewedBulk,
    toggleSeriesFavorite: toggleSeriesFavorite,
    setChannelEpgMapping: setChannelEpgMapping,
    getChannelEpgMapping: getChannelEpgMapping,
    getVodDownloads: getVodDownloads,
    saveVodDownload: saveVodDownload,
    deleteVodDownload: deleteVodDownload,
  };

}(window));
