/**
 * player-shim.js — Browser video player replacing Tauri/mpv backend.
 * Uses native <video> element with hls.js for HLS streams.
 * Falls back to direct src for non-HLS (RTMP/TS via HTTP).
 */
(function (window) {
  'use strict';

  var _state = 'stopped';
  var _currentUrl = null;
  var _duration = 0;
  var _muted = false;
  var _volume = 1.0;
  var _videoEl = null;
  var _hlsInstance = null;
  var _positionTimer = null;

  function emit(event, payload) {
    window.dispatchEvent(new CustomEvent('tauri:' + event, { detail: payload }));
  }

  function redactUrl(url) {
    if (!url) return '';
    return String(url)
      .replace(/(username=)[^&]+/ig, '$1***')
      .replace(/(password=)[^&]+/ig, '$1***')
      .replace(/\/(live|movie|series)\/([^/]+)\/([^/]+)\//ig, '/$1/***/***/');
  }

  function proxyMediaUrl(url, options) {
    if (!url || !/^https?:\/\//i.test(url) || /^\/api\/iptv-proxy/i.test(url)) return url;
    var params = new URLSearchParams({ url: url });
    options = options || {};
    if (options.userAgent) params.set('ua', options.userAgent);
    if (options.referer) params.set('referer', options.referer);
    return '/api/iptv-proxy?' + params.toString();
  }

  function getOrCreateVideoEl() {
    if (_videoEl) return _videoEl;
    _videoEl = document.createElement('video');
    _videoEl.id = 'ipz-player';
    _videoEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9000;background:#000;display:none;';
    _videoEl.setAttribute('playsinline', '');
    _videoEl.setAttribute('webkit-playsinline', '');

    _videoEl.addEventListener('playing', function () {
      _state = 'playing';
      _videoEl.style.display = 'block';
      emit('native_player_state', { state: 'playing' });
      startPositionTimer();
    });
    _videoEl.addEventListener('pause', function () {
      _state = 'paused';
      emit('native_player_state', { state: 'paused' });
    });
    _videoEl.addEventListener('ended', function () {
      _state = 'stopped';
      stopPositionTimer();
      _videoEl.style.display = 'none';
      emit('native_player_state', { state: 'stopped' });
    });
    _videoEl.addEventListener('waiting', function () {
      emit('player_overlay', { buffering: true });
    });
    _videoEl.addEventListener('canplay', function () {
      emit('player_overlay', { buffering: false });
    });
    _videoEl.addEventListener('durationchange', function () {
      _duration = _videoEl.duration || 0;
    });
    _videoEl.addEventListener('error', function () {
      var err = _videoEl.error;
      _state = 'stopped';
      stopPositionTimer();
      _videoEl.style.display = 'none';
      emit('player_error', { message: err ? err.message : 'Playback error', stage: 'video' });
      emit('native_player_state', { state: 'error' });
    });

    document.body.appendChild(_videoEl);
    return _videoEl;
  }

  function startPositionTimer() {
    if (_positionTimer) return;
    _positionTimer = setInterval(function () {
      if (!_videoEl || _state !== 'playing') return;
      emit('player_overlay', { time: _videoEl.currentTime, duration: _duration });
    }, 1000);
  }

  function stopPositionTimer() {
    if (_positionTimer) { clearInterval(_positionTimer); _positionTimer = null; }
  }

  // ── Buffer / quality config ──────────────────────────────────────────────
  var HLS_CONFIG = {
    enableWorker: true,
    lowLatencyMode: false,
    // Buffer ahead: 60s normal, 120s for VOD
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    // Start buffering 30s before playback
    maxBufferSize: 60 * 1000 * 1000,  // 60 MB
    maxBufferHole: 0.5,
    // Stall recovery
    highBufferWatchdogPeriod: 2,
    nudgeMaxRetry: 5,
    // ABR — start at highest quality possible
    startLevel: -1,          // auto
    abrEwmaDefaultEstimate: 5000000,  // assume 5 Mbps initially (4K capable)
    abrBandWidthFactor: 0.95,
    abrBandWidthUpFactor: 0.7,
    // Retry on error
    fragLoadingMaxRetry: 6,
    manifestLoadingMaxRetry: 4,
    levelLoadingMaxRetry: 4,
    fragLoadingRetryDelay: 1000,
    // Progressive loading
    progressive: true,
    // CORS
    xhrSetup: function (xhr) {
      xhr.withCredentials = false;
    },
  };

  var HLS_LOW_LATENCY_CONFIG = Object.assign({}, HLS_CONFIG, {
    lowLatencyMode: true,
    maxBufferLength: 8,
    maxMaxBufferLength: 16,
    maxBufferSize: 10 * 1000 * 1000,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 6,
  });

  function loadHls(url, video, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var Hls = window.Hls;
      if (!Hls) {
        // No hls.js — try native HLS (Safari/Tizen)
        video.src = url;
        video.play().then(resolve).catch(reject);
        return;
      }
      if (!Hls.isSupported()) {
        video.src = url;
        video.play().then(resolve).catch(reject);
        return;
      }
      if (_hlsInstance) { _hlsInstance.destroy(); _hlsInstance = null; }

      var cfg = options.live ? HLS_LOW_LATENCY_CONFIG : HLS_CONFIG;
      var hls = new Hls(cfg);
      _hlsInstance = hls;

      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
        // Emit available quality levels to UI
        var levels = (data.levels || []).map(function (l, i) {
          return { id: i, width: l.width, height: l.height, bitrate: l.bitrate, name: l.name || (l.height + 'p') };
        });
        emit('player_quality_levels', { levels: levels, current: hls.currentLevel });
        video.play().then(resolve).catch(reject);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, function (event, data) {
        var level = hls.levels[data.level];
        if (level) {
          emit('player_quality_changed', { level: data.level, height: level.height, bitrate: level.bitrate });
        }
      });

      hls.on(Hls.Events.FRAG_BUFFERED, function (event, data) {
        emit('player_buffer_update', {
          buffered: video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0,
          total: data.stats ? data.stats.total : 0,
        });
      });

      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.warn('[player] Network error — trying to recover');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.warn('[player] Media error — trying to recover');
              hls.recoverMediaError();
              break;
            default:
              emit('player_error', { message: data.details, stage: 'hls', fatal: true });
              reject(new Error(data.details));
              break;
          }
        } else {
          console.warn('[player] Non-fatal HLS error:', data.details);
        }
      });
    });
  }

  function isHlsUrl(url) {
    return /\.m3u8(\?|$)/i.test(url) || url.includes('/hls/') || url.includes('type=m3u8');
  }

  var PlayerShim = {

    play: function (url, options) {
      options = options || {};
      if (!url) return Promise.reject(new Error('No stream URL provided'));
      var playbackUrl = proxyMediaUrl(url, options);
      _currentUrl = redactUrl(url);
      _state = 'buffering';
      emit('native_player_state', { state: 'buffering' });

      return new Promise(function (resolve, reject) {
        var video = getOrCreateVideoEl();
        PlayerShim._stopInternal();
        video.muted = _muted;
        video.volume = _volume;

        if (isHlsUrl(url)) {
          loadHls(playbackUrl, video, options).then(resolve).catch(function () {
            video.src = playbackUrl;
            video.play().then(resolve).catch(reject);
          });
        } else {
          video.src = playbackUrl;
          video.play().then(resolve).catch(reject);
        }
      });
    },

    setQualityLevel: function (levelIndex) {
      if (_hlsInstance) {
        _hlsInstance.currentLevel = levelIndex; // -1 = auto ABR
        emit('player_quality_changed', { level: levelIndex, manual: levelIndex !== -1 });
      }
      return Promise.resolve();
    },

    getQualityLevels: function () {
      if (!_hlsInstance) return [];
      return (_hlsInstance.levels || []).map(function (l, i) {
        return { id: i, width: l.width, height: l.height, bitrate: l.bitrate, name: l.name || (l.height + 'p') };
      });
    },

    // ── Download stream segments for offline viewing ─────────────────────────
    // Uses MediaRecorder on a <video> srcObject or fetch+stream for TS/MP4 URLs
    downloadStream: function (url, filename, options) {
      options = options || {};
      var playbackUrl = proxyMediaUrl(url, options);
      var durationSecs = options.durationSecs || 3600; // default: record 1 hour
      filename = filename || ('ipz-recording-' + Date.now() + '.webm');

      emit('vod_download_progress', { id: filename, status: 'starting', percent: 0 });

      return new Promise(function (resolve, reject) {
        // Path 1: Direct MP4/MKV — use fetch + stream download
        if (/\.(mp4|mkv|avi|mov)(\?|$)/i.test(url)) {
          var a = document.createElement('a');
          a.href = playbackUrl;
          a.download = filename.replace(/\.webm$/, '.mp4');
          a.target = '_blank';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          emit('vod_download_progress', { id: filename, status: 'browser_download', percent: 100 });
          resolve({ id: filename, method: 'browser_download' });
          return;
        }

        // Path 2: HLS — record via MediaRecorder on a hidden video element
        var Hls = window.Hls;
        if (!Hls || !Hls.isSupported()) {
          reject(new Error('HLS download requires hls.js'));
          return;
        }

        var recVideo = document.createElement('video');
        recVideo.muted = true;
        recVideo.style.display = 'none';
        document.body.appendChild(recVideo);

        var hls = new Hls(Object.assign({}, HLS_CONFIG, {
          maxBufferLength: 120,
          maxMaxBufferLength: 300,
          // Force highest quality for download
          startLevel: options.qualityLevel !== undefined ? options.qualityLevel : -1,
        }));

        hls.loadSource(playbackUrl);
        hls.attachMedia(recVideo);

        hls.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
          // Force highest available level for download quality
          if (options.qualityLevel === undefined) {
            var levels = data.levels || [];
            var best = levels.reduce(function (max, l, i) { return l.bitrate > (levels[max] || { bitrate: 0 }).bitrate ? i : max; }, 0);
            hls.currentLevel = best;
          }

          var stream = recVideo.captureStream ? recVideo.captureStream() : recVideo.mozCaptureStream ? recVideo.mozCaptureStream() : null;
          if (!stream) {
            hls.destroy();
            document.body.removeChild(recVideo);
            reject(new Error('captureStream not supported in this browser'));
            return;
          }

          var mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' :
                         MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4';

          var recorder = new MediaRecorder(stream, { mimeType: mimeType, videoBitsPerSecond: options.bitrate || 8000000 });
          var chunks = [];
          var startTime = Date.now();

          recorder.ondataavailable = function (e) {
            if (e.data && e.data.size > 0) chunks.push(e.data);
            var elapsed = (Date.now() - startTime) / 1000;
            emit('vod_download_progress', { id: filename, status: 'recording', percent: Math.min(99, Math.round(elapsed / durationSecs * 100)) });
          };

          recorder.onstop = function () {
            var blob = new Blob(chunks, { type: mimeType });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
            hls.destroy();
            document.body.removeChild(recVideo);
            emit('vod_download_progress', { id: filename, status: 'complete', percent: 100 });
            resolve({ id: filename, size: blob.size });
          };

          recVideo.play().then(function () {
            recorder.start(5000); // collect chunks every 5s
            // Stop after durationSecs
            setTimeout(function () {
              if (recorder.state !== 'inactive') recorder.stop();
            }, durationSecs * 1000);
          }).catch(function (e) {
            hls.destroy();
            document.body.removeChild(recVideo);
            reject(e);
          });
        });

        hls.on(Hls.Events.ERROR, function (event, data) {
          if (data.fatal) {
            hls.destroy();
            document.body.removeChild(recVideo);
            reject(new Error(data.details));
          }
        });
      });
    },

    _stopInternal: function () {
      stopPositionTimer();
      if (_hlsInstance) { _hlsInstance.destroy(); _hlsInstance = null; }
      if (_videoEl) {
        _videoEl.pause();
        _videoEl.removeAttribute('src');
        _videoEl.load();
        _videoEl.style.display = 'none';
      }
    },

    stop: function () {
      PlayerShim._stopInternal();
      _state = 'stopped';
      _currentUrl = null;
      emit('native_player_state', { state: 'stopped' });
      return Promise.resolve();
    },

    togglePause: function () {
      if (!_videoEl) return Promise.resolve();
      if (_state === 'playing') {
        _videoEl.pause();
        _state = 'paused';
        stopPositionTimer();
        emit('native_player_state', { state: 'paused' });
      } else if (_state === 'paused') {
        _videoEl.play();
        _state = 'playing';
        startPositionTimer();
        emit('native_player_state', { state: 'playing' });
      }
      return Promise.resolve();
    },

    seek: function (timeSecs) {
      if (_videoEl && isFinite(timeSecs)) _videoEl.currentTime = timeSecs;
      return Promise.resolve();
    },

    getTime: function () { return _videoEl ? (_videoEl.currentTime || 0) : 0; },
    getDuration: function () { return _duration; },
    isPlaying: function () { return _state === 'playing'; },

    setVolume: function (vol) {
      _volume = Math.max(0, Math.min(1, vol));
      if (_videoEl) _videoEl.volume = _volume;
      return Promise.resolve();
    },
    getVolume: function () { return _volume; },

    setMute: function (muted) {
      _muted = muted;
      if (_videoEl) _videoEl.muted = muted;
      return Promise.resolve();
    },
    getMute: function () { return _muted; },

    getPlayerState: function () {
      return {
        state: _state, url: _currentUrl,
        time: PlayerShim.getTime(), duration: _duration,
        muted: _muted, volume: _volume,
      };
    },
  };

  window.PlayerShim = PlayerShim;

}(window));
