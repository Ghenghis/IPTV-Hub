/**
 * samsung-remote.js — Full Samsung Smart TV remote control support.
 * Covers: QN series (QLED/Neo QLED), UN series (Crystal/Frame/Lifestyle),
 *         Tizen 5.0–8.0, One Remote, Smart Remote, Bixby voice commands.
 *
 * Translates Samsung keyCode values → PlayerShim + app navigation actions.
 * Must load after tauri-shim.js. Works in any browser but activates
 * Samsung-specific features only on Tizen.
 */
(function (window) {
  'use strict';

  var isTizen = typeof window.tizen !== 'undefined' || /Tizen/.test(navigator.userAgent);
  var isSamsungTV = isTizen || /SMART-TV/.test(navigator.userAgent) || /SmartTV/.test(navigator.userAgent);

  // ── Samsung Tizen keyCode map (One Remote + Smart Remote) ─────────────────
  // Covers QN / UN series — all models 2016–2024
  var SAMSUNG_KEYS = {
    // D-pad / navigation
    38:   'UP',        // ArrowUp
    40:   'DOWN',      // ArrowDown
    37:   'LEFT',      // ArrowLeft
    39:   'RIGHT',     // ArrowRight
    13:   'ENTER',     // Enter / OK
    10009:'RETURN',    // Return / Back
    10182:'EXIT',      // Exit (close app)

    // Playback controls (One Remote physical buttons)
    415:  'PLAY',
    19:   'PAUSE',
    10252:'PLAY_PAUSE', // combined Play/Pause toggle
    413:  'STOP',
    417:  'FF',         // Fast Forward
    412:  'RW',         // Rewind
    10233:'SKIP_NEXT',  // Next (some models)
    10232:'SKIP_PREV',  // Previous (some models)

    // Channel / volume (virtual — One Remote has no physical vol buttons but
    // IR blaster models do; included for full coverage)
    427:  'CH_UP',
    428:  'CH_DOWN',
    447:  'VOL_UP',
    448:  'VOL_DOWN',
    449:  'MUTE',

    // Number keys 0-9
    48:  '0', 49:  '1', 50:  '2', 51:  '3', 52:  '4',
    53:  '5', 54:  '6', 55:  '7', 56:  '8', 57:  '9',

    // Color / function buttons (One Remote top strip)
    403:  'RED',        // A
    404:  'GREEN',      // B
    405:  'YELLOW',     // C
    406:  'BLUE',       // D (INFO on some models)

    // Smart Remote buttons
    10140:'EXTRA',      // Extra / Source
    10133:'CAPTION',    // CC / Subtitles
    10135:'TELETEXT',
    10190:'SEARCH',     // Search / Bixby (older)
    10137:'TOOLS',      // Tools / Settings
    10232:'PREV_CH',
    10255:'AMBIENT',    // Ambient mode (Frame/Serif TV)
    457:  'INFO',       // Info
    10182:'HOME',       // Smart Hub / Home
    10072:'GUIDE',      // Program Guide / EPG
    10073:'SCHEDULE',   // Record / Schedule
    10077:'PIP',        // PIP (picture in picture)
    10148:'MTS',        // Multi-track sound
    10230:'E_MANUAL',
    10199:'SOCCER',     // Sports mode (QN sports models)
    10067:'ZOOM_IN',    // Zoom in (Frame TV)
    10068:'ZOOM_OUT',
    10178:'ASPECT',     // Screen size / aspect ratio
    116:  'POWER_TOGGLE',

    // Bixby / voice (QN 2018+, UN 2019+)
    10539:'BIXBY',      // Bixby button keyCode (Tizen 5+)
    461:  'BIXBY_LEGACY', // older models

    // Smart Things / multiview
    10248:'MULTIVIEW',  // Multi View
    10223:'GAME_MODE',  // Game Mode (QN series)
    10172:'SUBTITLE_LANG',
    10176:'AUDIO_LANG',
  };

  // ── Seek step config ───────────────────────────────────────────────────────
  var SEEK_STEP_SHORT  = 10;   // seconds
  var SEEK_STEP_LONG   = 60;   // seconds (hold FF/RW)
  var _ffHold = false;
  var _rwHold = false;
  var _holdTimer = null;

  // ── Register Tizen keys (required to receive them) ─────────────────────────
  function registerTizenKeys() {
    if (!isTizen || !window.tizen || !tizen.tvinputdevice) return;
    var keys = [
      'MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop',
      'MediaFastForward', 'MediaRewind',
      'MediaNextTrack', 'MediaPreviousTrack',
      'ChannelUp', 'ChannelDown',
      'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
      'Info', 'Search', 'Tools', 'Guide', 'Exit', 'Return',
      'Caption', 'Extra', 'Mute', 'VolumeUp', 'VolumeDown',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    ];
    keys.forEach(function (k) {
      try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* not all keys available on every model */ }
    });
    console.log('[samsung-remote] Tizen keys registered');
  }

  // ── Bixby / voice input bridge ─────────────────────────────────────────────
  function handleBixby() {
    // Tizen 5+: tizen.tv.voice API
    if (isTizen && window.tizen && tizen.tv && tizen.tv.voice) {
      try {
        tizen.tv.voice.start(null, function (result) {
          if (result && result.result === 'SUCCESS' && result.transcript) {
            handleVoiceCommand(result.transcript.toLowerCase());
          }
        });
      } catch (e) {
        console.warn('[samsung-remote] Bixby/voice start failed:', e.message);
      }
      return;
    }
    // Browser fallback: Web Speech API
    if (window.SpeechRecognition || window.webkitSpeechRecognition) {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      var r = new SR();
      r.lang = 'en-US';
      r.interimResults = false;
      r.maxAlternatives = 1;
      r.onresult = function (e) {
        var transcript = e.results[0][0].transcript.toLowerCase();
        handleVoiceCommand(transcript);
      };
      r.onerror = function (e) { console.warn('[samsung-remote] Voice error:', e.error); };
      try { r.start(); } catch (e) {}
      window.dispatchEvent(new CustomEvent('tauri:voice_listening', { detail: { active: true } }));
    }
  }

  // ── Voice command parser ────────────────────────────────────────────────────
  function handleVoiceCommand(text) {
    console.log('[samsung-remote] Voice:', text);
    window.dispatchEvent(new CustomEvent('tauri:voice_command', { detail: { text: text } }));

    if (/\b(play|resume)\b/.test(text) && !/pause/.test(text)) { PlayerShim.togglePause(); return; }
    if (/\bpause\b/.test(text)) { PlayerShim.togglePause(); return; }
    if (/\bstop\b/.test(text)) { PlayerShim.stop(); return; }

    var ffMatch = text.match(/(?:skip|forward)\s+(\d+)\s*(second|minute|min|sec)?/);
    if (ffMatch) {
      var secs = parseInt(ffMatch[1]) * (/min/.test(ffMatch[2] || '') ? 60 : 1);
      PlayerShim.seek(PlayerShim.getTime() + secs);
      return;
    }
    var rwMatch = text.match(/(?:back|rewind|go back)\s+(\d+)\s*(second|minute|min|sec)?/);
    if (rwMatch) {
      var secs = parseInt(rwMatch[1]) * (/min/.test(rwMatch[2] || '') ? 60 : 1);
      PlayerShim.seek(Math.max(0, PlayerShim.getTime() - secs));
      return;
    }

    if (/\bmute\b/.test(text)) { PlayerShim.setMute(true); return; }
    if (/\bunmute\b/.test(text)) { PlayerShim.setMute(false); return; }

    var volMatch = text.match(/volume\s+(up|down|\d+)/);
    if (volMatch) {
      var v = volMatch[1];
      if (v === 'up') PlayerShim.setVolume(Math.min(1, PlayerShim.getVolume() + 0.1));
      else if (v === 'down') PlayerShim.setVolume(Math.max(0, PlayerShim.getVolume() - 0.1));
      else PlayerShim.setVolume(parseInt(v) / 100);
      return;
    }

    if (/\b(full\s*screen|fullscreen)\b/.test(text)) {
      var v = document.getElementById('ipz-player');
      if (v && v.requestFullscreen) v.requestFullscreen();
      return;
    }
    if (/\bexit\s*(fullscreen|full\s*screen)\b/.test(text)) {
      if (document.exitFullscreen) document.exitFullscreen();
      return;
    }
    if (/\bsubtitle|caption\b/.test(text)) {
      window.dispatchEvent(new CustomEvent('tauri:toggle_subtitles', {}));
      return;
    }
    if (/\bhome\b/.test(text)) {
      window.dispatchEvent(new CustomEvent('tauri:navigate_home', {}));
      return;
    }
    if (/\bguide|epg|program guide\b/.test(text)) {
      window.dispatchEvent(new CustomEvent('tauri:open_epg', {}));
      return;
    }

    var qualMatch = text.match(/\b(1080|2k|4k|720|480|auto)\b/);
    if (qualMatch) {
      var qMap = { '480': 480, '720': 720, '1080': 1080, '2k': 1440, '4k': 2160 };
      var target = qMap[qualMatch[1]] || -1;
      if (target === -1) { PlayerShim.setQualityLevel(-1); return; }
      var levels = PlayerShim.getQualityLevels();
      var best = levels.reduce(function (acc, l) {
        return Math.abs(l.height - target) < Math.abs((acc.height || 9999) - target) ? l : acc;
      }, { id: -1 });
      PlayerShim.setQualityLevel(best.id !== undefined ? best.id : -1);
    }
  }

  // ── Main key handler ───────────────────────────────────────────────────────
  function handleKey(action, repeat) {
    switch (action) {
      case 'PLAY':
        if (!PlayerShim.isPlaying()) PlayerShim.togglePause();
        break;
      case 'PAUSE':
        if (PlayerShim.isPlaying()) PlayerShim.togglePause();
        break;
      case 'PLAY_PAUSE':
        PlayerShim.togglePause();
        break;
      case 'STOP':
        PlayerShim.stop();
        break;
      case 'FF':
        PlayerShim.seek(PlayerShim.getTime() + (repeat ? SEEK_STEP_LONG : SEEK_STEP_SHORT));
        break;
      case 'RW':
        PlayerShim.seek(Math.max(0, PlayerShim.getTime() - (repeat ? SEEK_STEP_LONG : SEEK_STEP_SHORT)));
        break;
      case 'SKIP_NEXT':
        window.dispatchEvent(new CustomEvent('tauri:next_channel', {}));
        break;
      case 'SKIP_PREV':
        window.dispatchEvent(new CustomEvent('tauri:prev_channel', {}));
        break;
      case 'VOL_UP':
        PlayerShim.setVolume(Math.min(1, PlayerShim.getVolume() + 0.05));
        break;
      case 'VOL_DOWN':
        PlayerShim.setVolume(Math.max(0, PlayerShim.getVolume() - 0.05));
        break;
      case 'MUTE':
        PlayerShim.setMute(!PlayerShim.getMute());
        break;
      case 'CH_UP':
        window.dispatchEvent(new CustomEvent('tauri:channel_up', {}));
        break;
      case 'CH_DOWN':
        window.dispatchEvent(new CustomEvent('tauri:channel_down', {}));
        break;
      case 'UP':
        window.dispatchEvent(new CustomEvent('tauri:nav_up', {}));
        break;
      case 'DOWN':
        window.dispatchEvent(new CustomEvent('tauri:nav_down', {}));
        break;
      case 'LEFT':
        window.dispatchEvent(new CustomEvent('tauri:nav_left', {}));
        break;
      case 'RIGHT':
        window.dispatchEvent(new CustomEvent('tauri:nav_right', {}));
        break;
      case 'ENTER':
        window.dispatchEvent(new CustomEvent('tauri:nav_enter', {}));
        break;
      case 'RETURN':
        window.dispatchEvent(new CustomEvent('tauri:nav_back', {}));
        break;
      case 'EXIT':
        PlayerShim.stop();
        window.dispatchEvent(new CustomEvent('tauri:navigate_home', {}));
        break;
      case 'HOME':
        window.dispatchEvent(new CustomEvent('tauri:navigate_home', {}));
        break;
      case 'INFO':
        window.dispatchEvent(new CustomEvent('tauri:toggle_info_panel', {}));
        break;
      case 'GUIDE':
        window.dispatchEvent(new CustomEvent('tauri:open_epg', {}));
        break;
      case 'SEARCH':
        window.dispatchEvent(new CustomEvent('tauri:open_search', {}));
        break;
      case 'CAPTION':
        window.dispatchEvent(new CustomEvent('tauri:toggle_subtitles', {}));
        break;
      case 'RED':
        window.dispatchEvent(new CustomEvent('tauri:action_red', {}));
        break;
      case 'GREEN':
        window.dispatchEvent(new CustomEvent('tauri:action_green', {}));
        break;
      case 'YELLOW':
        window.dispatchEvent(new CustomEvent('tauri:action_yellow', {}));
        break;
      case 'BLUE':
        window.dispatchEvent(new CustomEvent('tauri:action_blue', {}));
        break;
      case 'MULTIVIEW':
        window.dispatchEvent(new CustomEvent('tauri:toggle_multiview', {}));
        break;
      case 'GAME_MODE':
        window.dispatchEvent(new CustomEvent('tauri:toggle_game_mode', {}));
        break;
      case 'AMBIENT':
        window.dispatchEvent(new CustomEvent('tauri:toggle_ambient', {}));
        break;
      case 'PIP':
        window.dispatchEvent(new CustomEvent('tauri:toggle_pip', {}));
        break;
      case 'ASPECT':
        window.dispatchEvent(new CustomEvent('tauri:cycle_aspect_ratio', {}));
        break;
      case 'BIXBY':
      case 'BIXBY_LEGACY':
        handleBixby();
        break;
      default:
        // Numeric keys 0-9 — channel jump
        if (/^\d$/.test(action)) {
          window.dispatchEvent(new CustomEvent('tauri:num_key', { detail: { digit: parseInt(action) } }));
        }
    }
  }

  // ── Fullscreen on ENTER while player is visible ────────────────────────────
  function handleEnterFullscreen() {
    var v = document.getElementById('ipz-player');
    if (v && v.style.display !== 'none') {
      if (!document.fullscreenElement) {
        v.requestFullscreen && v.requestFullscreen();
      } else {
        document.exitFullscreen && document.exitFullscreen();
      }
      return true;
    }
    return false;
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    var action = SAMSUNG_KEYS[e.keyCode];
    if (!action) return;

    // Prevent default browser behavior for media/nav keys
    if ([37, 38, 39, 40, 13, 10009, 415, 19, 10252, 413, 417, 412, 447, 448, 449].indexOf(e.keyCode) !== -1) {
      e.preventDefault();
    }

    if (action === 'ENTER') {
      if (handleEnterFullscreen()) return;
    }

    handleKey(action, e.repeat);
  }, true);

  // ── Expose for tauri-shim ────────────────────────────────────────────────
  window.SamsungRemote = {
    handleVoiceCommand: handleVoiceCommand,
    triggerBixby: handleBixby,
    keyMap: SAMSUNG_KEYS,
    isTizen: isTizen,
    isSamsungTV: isSamsungTV,
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerTizenKeys);
  } else {
    registerTizenKeys();
  }

  console.log('[samsung-remote] Loaded — isTizen:', isTizen, '| isSamsungTV:', isSamsungTV);

}(window));
