/**
 * m3u-parser.js - M3U/M3U8 playlist parser replacing m3u.rs.
 * Handles real provider playlists from Apollo/Xtreme-style services: header
 * EPG URLs, alternate EXTINF ordering, EXTGRP fallback, catch-up metadata,
 * channel numbers, and EXTVLCOPT user-agent/referrer hints.
 */
(function (window) {
  'use strict';

  var HLS_PREFIXES = ['#EXT-X-', '#EXTM3U:VERSION', '#EXT-X-VERSION'];

  function proxyUrl(url) {
    return /^https?:\/\//i.test(url)
      ? '/api/iptv-proxy?url=' + encodeURIComponent(url)
      : url;
  }

  function readAttr(source, key) {
    var lower = source.toLowerCase();
    var needle = key.toLowerCase();
    var idx = 0;
    while (idx < lower.length) {
      var found = lower.indexOf(needle, idx);
      if (found < 0) return '';
      var before = found === 0 ? '' : source[found - 1];
      if (before && /[A-Za-z0-9_-]/.test(before)) {
        idx = found + needle.length;
        continue;
      }
      var eqIdx = found + needle.length;
      if (source[eqIdx] !== '=') {
        idx = eqIdx;
        continue;
      }
      var cursor = eqIdx + 1;
      if (source[cursor] === '"') {
        cursor++;
        var value = '';
        while (cursor < source.length) {
          var ch = source[cursor];
          if (ch === '\\' && source[cursor + 1] === '"') {
            value += '"';
            cursor += 2;
            continue;
          }
          if (ch === '"') return value;
          value += ch;
          cursor++;
        }
        return value;
      }
      var end = cursor;
      while (end < source.length && source[end] !== ' ' && source[end] !== '\t' && source[end] !== ',') end++;
      return source.slice(cursor, end);
    }
    return '';
  }

  function stripAttrs(tail) {
    return tail
      .replace(/\b[A-Za-z][\w-]*="(?:[^"\\]|\\.)*"/g, '')
      .replace(/\b[A-Za-z][\w-]*=[^\s,]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function isHlsTag(line) {
    return HLS_PREFIXES.some(function (prefix) { return line.indexOf(prefix) === 0; });
  }

  function lastCommaOutsideQuotes(text) {
    var inQuote = false;
    var last = -1;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '"' && text[i - 1] !== '\\') inQuote = !inQuote;
      else if (ch === ',' && !inQuote) last = i;
    }
    return last;
  }

  function numberOrNull(raw) {
    if (!raw) return null;
    var n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function parseExtInf(line) {
    var directive = line.replace(/^#EXTINF\s*:?/i, '');
    var commaIdx = directive.indexOf(',');
    var attrs = '';
    var name = '';

    if (commaIdx < 0) {
      name = directive.trim();
    } else {
      var head = directive.slice(0, commaIdx);
      var tail = directive.slice(commaIdx + 1);
      if (/^\s*[A-Za-z][\w-]*\s*=/.test(tail)) {
        var splitIdx = lastCommaOutsideQuotes(tail);
        attrs = head + ' ' + (splitIdx >= 0 ? tail.slice(0, splitIdx) : tail);
        name = splitIdx >= 0 ? tail.slice(splitIdx + 1).trim() : '';
      } else {
        attrs = head;
        name = stripAttrs(tail);
      }
    }

    var tvgName = readAttr(attrs, 'tvg-name');
    var chno = numberOrNull(readAttr(attrs, 'tvg-chno') || readAttr(attrs, 'channel-number'));
    var catchupDays = numberOrNull(readAttr(attrs, 'catchup-days'));
    var tvgType = readAttr(attrs, 'tvg-type');
    var radioAttr = readAttr(attrs, 'radio').toLowerCase();

    return {
      id: '',
      name: name || tvgName || '',
      logo: readAttr(attrs, 'tvg-logo') || '',
      group: readAttr(attrs, 'group-title') || '',
      epg_id: readAttr(attrs, 'tvg-id') || readAttr(attrs, 'channel-id') || '',
      tvg_name: tvgName || '',
      channel_number: chno,
      catchup: readAttr(attrs, 'catchup') || '',
      catchup_days: catchupDays,
      catchup_source: readAttr(attrs, 'catchup-source') || '',
      user_agent: '',
      referer: '',
      tvg_type: tvgType || '',
      is_radio: (tvgType || '').toLowerCase() === 'radio' || radioAttr === 'true',
      url: '',
    };
  }

  function fallbackNameFromUrl(url, order) {
    try {
      var clean = url.split('?')[0].replace(/\/+$/, '');
      return decodeURIComponent(clean.split('/').pop() || '') || ('Channel ' + order);
    } catch (e) {
      return 'Channel ' + order;
    }
  }

  function finalizeChannel(ch, url, sortOrder, extgrpFallback) {
    var group = ch.group || extgrpFallback || '';
    var idSeed = (ch.epg_id || ch.tvg_name || ch.name || url || ('ch_' + sortOrder)).toString();
    ch.url = url;
    ch.group = group;
    ch.name = ch.name || fallbackNameFromUrl(url, sortOrder);
    ch.id = ch.id || (idSeed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) + '_' + sortOrder);
    ch.sort_order = sortOrder;
    return ch;
  }

  function parseDetailed(text) {
    var payload = text || '';
    if (payload.charCodeAt(0) === 0xfeff) payload = payload.slice(1);

    var channels = [];
    var lines = payload.split(/\r?\n/);
    var pending = null;
    var extgrpFallback = '';
    var epgUrl = '';
    var sortOrder = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (line.indexOf('#EXTM3U') === 0) {
        epgUrl = readAttr(line, 'x-tvg-url') || readAttr(line, 'tvg-url') || readAttr(line, 'url-tvg') || epgUrl;
        continue;
      }

      if (line.indexOf('#EXTINF') === 0) {
        pending = parseExtInf(line);
        continue;
      }

      if (line.indexOf('#EXTGRP:') === 0) {
        extgrpFallback = line.slice('#EXTGRP:'.length).trim();
        continue;
      }

      if (line.indexOf('#EXTVLCOPT:') === 0) {
        if (!pending) continue;
        var opt = line.slice('#EXTVLCOPT:'.length);
        var eq = opt.indexOf('=');
        if (eq <= 0) continue;
        var key = opt.slice(0, eq).trim().toLowerCase();
        var value = opt.slice(eq + 1).trim();
        if (key === 'http-user-agent') pending.user_agent = value;
        else if (key === 'http-referrer' || key === 'http-referer') pending.referer = value;
        continue;
      }

      if (line.indexOf('#KODIPROP:') === 0 || isHlsTag(line) || line.indexOf('#') === 0) continue;

      if (pending) {
        channels.push(finalizeChannel(pending, line, sortOrder++, extgrpFallback));
        pending = null;
        extgrpFallback = '';
      } else {
        channels.push(finalizeChannel({
          id: '',
          name: '',
          logo: '',
          group: '',
          epg_id: '',
          tvg_name: '',
          channel_number: null,
          catchup: '',
          catchup_days: null,
          catchup_source: '',
          user_agent: '',
          referer: '',
          tvg_type: '',
          is_radio: false,
          url: '',
        }, line, sortOrder++, ''));
      }
    }

    return { channels: channels, epg_url: epgUrl };
  }

  function parseM3U(text) {
    return parseDetailed(text).channels;
  }

  async function fetchText(url) {
    var resp = await fetch(proxyUrl(url));
    if (!resp.ok) throw new Error('M3U fetch failed: HTTP ' + resp.status);
    return resp.text();
  }

  async function fetchAndParse(url) {
    return parseM3U(await fetchText(url));
  }

  async function fetchAndParseDetailed(url) {
    return parseDetailed(await fetchText(url));
  }

  window.M3UParser = {
    parse: parseM3U,
    parseDetailed: parseDetailed,
    fetchAndParse: fetchAndParse,
    fetchAndParseDetailed: fetchAndParseDetailed,
    proxyUrl: proxyUrl,
  };

}(window));
