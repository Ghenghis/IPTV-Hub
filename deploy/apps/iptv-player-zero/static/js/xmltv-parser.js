/**
 * xmltv-parser.js — XMLTV EPG parser + fuzzy channel matching, replacing xmltv.rs.
 */
(function (window) {
  'use strict';

  function parseXmlTv(xmlText) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlText, 'application/xml');
    var channels = [];
    var programs = [];

    doc.querySelectorAll('channel').forEach(function (ch) {
      var id = ch.getAttribute('id') || '';
      var displayName = ch.querySelector('display-name');
      channels.push({ id: id, name: displayName ? displayName.textContent.trim() : id });
    });

    doc.querySelectorAll('programme').forEach(function (prog) {
      var channelId = prog.getAttribute('channel') || '';
      var start = parseXmlTvDate(prog.getAttribute('start'));
      var end = parseXmlTvDate(prog.getAttribute('stop'));
      var titleEl = prog.querySelector('title');
      var descEl = prog.querySelector('desc');
      var iconEl = prog.querySelector('icon');
      programs.push({
        id: channelId + '_' + start,
        channel_id: channelId,
        start: start,
        end: end,
        title: titleEl ? titleEl.textContent.trim() : '',
        description: descEl ? descEl.textContent.trim() : '',
        poster: iconEl ? (iconEl.getAttribute('src') || '') : '',
      });
    });

    return { channels: channels, programs: programs };
  }

  function parseXmlTvDate(str) {
    if (!str) return 0;
    // Format: YYYYMMDDHHmmss +ZZZZ
    var s = str.trim();
    var year = parseInt(s.slice(0, 4), 10);
    var month = parseInt(s.slice(4, 6), 10) - 1;
    var day = parseInt(s.slice(6, 8), 10);
    var hour = parseInt(s.slice(8, 10), 10);
    var min = parseInt(s.slice(10, 12), 10);
    var sec = parseInt(s.slice(12, 14), 10);
    var tzStr = s.slice(15).trim();
    var tzOffset = 0;
    if (tzStr) {
      var sign = tzStr[0] === '-' ? -1 : 1;
      var tzH = parseInt(tzStr.slice(1, 3), 10);
      var tzM = parseInt(tzStr.slice(3, 5), 10);
      tzOffset = sign * (tzH * 60 + tzM) * 60;
    }
    var utc = Date.UTC(year, month, day, hour, min, sec);
    return Math.floor(utc / 1000) - tzOffset;
  }

  async function fetchAndParse(url) {
    var fetchUrl = /^https?:\/\//i.test(url)
      ? '/api/iptv-proxy?url=' + encodeURIComponent(url)
      : url;
    var resp = await fetch(fetchUrl);
    if (!resp.ok) throw new Error('XMLTV fetch failed: HTTP ' + resp.status);
    var text = await resp.text();
    return parseXmlTv(text);
  }

  function suggestEpgChannelIds(channelName, xmltvChannels) {
    if (!channelName || !xmltvChannels.length) return [];
    var name = channelName.toLowerCase().replace(/[^a-z0-9]/g, '');
    var scored = xmltvChannels.map(function (ch) {
      var cname = (ch.name || ch.id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      var score = 0;
      if (cname === name) score = 100;
      else if (cname.includes(name) || name.includes(cname)) score = 60;
      else {
        // bigram similarity
        var a = bigrams(name);
        var b = bigrams(cname);
        var inter = a.filter(function (x) { return b.includes(x); }).length;
        score = a.length + b.length > 0 ? Math.round((2 * inter / (a.length + b.length)) * 50) : 0;
      }
      return { id: ch.id, score: score };
    });
    return scored
      .filter(function (x) { return x.score > 20; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 5)
      .map(function (x) { return x.id; });
  }

  function bigrams(str) {
    var result = [];
    for (var i = 0; i < str.length - 1; i++) result.push(str.slice(i, i + 2));
    return result;
  }

  window.XmlTvParser = {
    parse: parseXmlTv,
    fetchAndParse: fetchAndParse,
    suggestEpgChannelIds: suggestEpgChannelIds,
  };

}(window));
