(function () {
  'use strict';

  var PROVIDERS = [
    { id: 'apollo', name: 'Apollo Group TV' },
    { id: 'xtremehd', name: 'XtremeHD' },
  ];
  var LIMITS = { liveLimit: '1200', movieLimit: '500', seriesLimit: '500' };
  var state = {
    all: [],
    filtered: [],
    currentIndex: 0,
    activeKind: 'all',
    query: '',
    hls: null,
  };

  var videoPlayer = document.getElementById('videoPlayer');
  var channelName = document.getElementById('channelName');
  var statusText = document.getElementById('statusText');
  var channelList = document.getElementById('channelList');
  var providerCounts = document.getElementById('providerCounts');
  var searchInput = document.getElementById('searchInput');
  var tabs = document.getElementById('tabs');

  function text(value, fallback) {
    var out = String(value || '').trim();
    return out || fallback || '';
  }

  function setStatus(message) {
    statusText.textContent = message;
  }

  function providerLabel(providerId) {
    var match = PROVIDERS.find(function (provider) { return provider.id === providerId; });
    return match ? match.name : text(providerId, 'Provider');
  }

  function catalogUrl(providerId) {
    var params = new URLSearchParams(Object.assign({ provider: providerId }, LIMITS));
    return '/api/provider-vault/catalog?' + params.toString();
  }

  function streamUrl(providerId, kind, item) {
    var providedUrl = text(item && item.url);
    if (providedUrl.indexOf('/api/provider-vault/stream') === 0) return providedUrl;
    var id = text(item && (item.id || item.stream_id || item.series_id));
    if (!id) return '';
    var ext = text(item && (item.extension || item.container_extension), kind === 'movie' ? 'mp4' : 'm3u8');
    var params = new URLSearchParams({ provider: providerId, kind: kind, id: id, ext: ext });
    return '/api/provider-vault/stream?' + params.toString();
  }

  function normalizeItems(provider, kind, items) {
    return (Array.isArray(items) ? items : []).map(function (item) {
      var name = text(item && item.name, kind + ' stream');
      var group = text(item && item.group && item.group.title, kind === 'live' ? 'Live TV' : kind);
      return {
        providerId: provider.id,
        providerName: provider.name,
        kind: kind,
        name: name,
        group: group,
        url: streamUrl(provider.id, kind, item),
      };
    }).filter(function (item) {
      return item.url.indexOf('/api/provider-vault/stream') === 0;
    });
  }

  function fetchJson(url) {
    return fetch(url, {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  function destroyHls() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
  }

  function hlsConfig(kind) {
    return {
      enableWorker: true,
      lowLatencyMode: false,
      startFragPrefetch: true,
      capLevelToPlayerSize: true,
      maxBufferLength: kind === 'live' ? 120 : 300,
      maxMaxBufferLength: kind === 'live' ? 300 : 900,
      maxBufferSize: 180 * 1000 * 1000,
      backBufferLength: kind === 'live' ? 90 : 180,
      fragLoadingTimeOut: 30000,
      manifestLoadingTimeOut: 30000,
      levelLoadingTimeOut: 30000,
    };
  }

  function playVideo() {
    var playPromise = videoPlayer.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(function () {
        setStatus('Stream is buffered. Press play to start.');
      });
    }
  }

  function loadStream(index) {
    var item = state.filtered[index];
    if (!item) return;
    state.currentIndex = index;
    channelName.textContent = item.name;
    setStatus('Loading ' + item.providerName + ' ' + item.kind + ' with expanded HLS buffering...');
    renderList();
    destroyHls();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();

    if (window.Hls && Hls.isSupported() && (item.kind !== 'movie' || item.url.indexOf('ext=m3u8') !== -1)) {
      state.hls = new Hls(hlsConfig(item.kind));
      state.hls.loadSource(item.url);
      state.hls.attachMedia(videoPlayer);
      state.hls.on(Hls.Events.MANIFEST_PARSED, function () {
        setStatus(item.providerName + ' ready. Buffer target: ' + (item.kind === 'live' ? '2 minutes live' : 'up to 15 minutes VOD') + '.');
        playVideo();
      });
      state.hls.on(Hls.Events.ERROR, function (_event, data) {
        if (!data || !data.fatal) return;
        setStatus('Stream failed. Trying the next available item...');
        window.setTimeout(function () {
          selectRelative(1);
        }, 900);
      });
      return;
    }

    videoPlayer.src = item.url;
    videoPlayer.preload = 'auto';
    videoPlayer.addEventListener('loadedmetadata', function () {
      setStatus(item.providerName + ' ready. Browser native buffering is active.');
      playVideo();
    }, { once: true });
  }

  function selectRelative(delta) {
    if (!state.filtered.length) return;
    var next = (state.currentIndex + delta + state.filtered.length) % state.filtered.length;
    loadStream(next);
  }

  function renderCounts() {
    var totals = PROVIDERS.map(function (provider) {
      var count = state.all.filter(function (item) { return item.providerId === provider.id; }).length;
      return '<span class="countPill">' + count.toLocaleString() + ' ' + provider.name + '</span>';
    });
    totals.push('<span class="countPill">' + state.all.length.toLocaleString() + ' total</span>');
    providerCounts.innerHTML = totals.join('');
  }

  function applyFilters() {
    var query = state.query.toLowerCase();
    state.filtered = state.all.filter(function (item) {
      var kindOk = state.activeKind === 'all' || item.kind === state.activeKind;
      var queryOk = !query || (item.name + ' ' + item.group + ' ' + item.providerName).toLowerCase().indexOf(query) !== -1;
      return kindOk && queryOk;
    }).slice(0, 900);
    state.currentIndex = Math.min(state.currentIndex, Math.max(0, state.filtered.length - 1));
    renderList();
  }

  function renderList() {
    if (!state.filtered.length) {
      channelList.innerHTML = '<div class="channelItem"><div class="channelMeta"><div class="channelTitle">No streams found</div><div class="channelSub">Try another tab or search.</div></div></div>';
      return;
    }
    channelList.innerHTML = state.filtered.map(function (item, index) {
      return [
        '<button type="button" class="channelItem' + (index === state.currentIndex ? ' active' : '') + '" data-index="' + index + '">',
        '<span class="channelMeta"><span class="channelTitle">' + escapeHtml(item.name) + '</span><span class="channelSub">' + escapeHtml(item.providerName + ' - ' + item.group) + '</span></span>',
        '<span class="channelKind">' + escapeHtml(item.kind) + '</span>',
        '</button>',
      ].join('');
    }).join('');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function bindEvents() {
    channelList.addEventListener('click', function (event) {
      var button = event.target.closest('.channelItem[data-index]');
      if (!button) return;
      loadStream(Number(button.getAttribute('data-index') || 0));
    });
    searchInput.addEventListener('input', function () {
      state.query = searchInput.value;
      state.currentIndex = 0;
      applyFilters();
    });
    tabs.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-kind]');
      if (!button) return;
      state.activeKind = button.getAttribute('data-kind');
      Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (node) {
        node.classList.toggle('active', node === button);
      });
      state.currentIndex = 0;
      applyFilters();
      loadStream(0);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') selectRelative(-1);
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') selectRelative(1);
      if (event.key === 'Enter' || event.key === ' ') playVideo();
    });
  }

  function loadProviders() {
    setStatus('Loading Apollo Group TV and XtremeHD from DaveTV vault...');
    return Promise.all(PROVIDERS.map(function (provider) {
      return fetchJson(catalogUrl(provider.id)).then(function (catalog) {
        return []
          .concat(normalizeItems(provider, 'live', catalog.live))
          .concat(normalizeItems(provider, 'movie', catalog.movies))
          .concat(normalizeItems(provider, 'series', catalog.series));
      }).catch(function () {
        return [];
      });
    })).then(function (groups) {
      state.all = groups.reduce(function (acc, group) { return acc.concat(group); }, []);
      renderCounts();
      applyFilters();
      if (!state.all.length) {
        channelName.textContent = 'Provider vault unavailable';
        setStatus('No Apollo or XtremeHD streams were returned.');
        return;
      }
      loadStream(0);
    });
  }

  bindEvents();
  loadProviders();
}());
