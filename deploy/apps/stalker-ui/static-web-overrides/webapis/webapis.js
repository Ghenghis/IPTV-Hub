// DaveTV hosted-browser stub for Samsung/Tizen webapis.
// The Stalker UI bundle checks for the object, but hosted playback uses
// DaveTV provider-vault streams and browser APIs instead of TV-native APIs.
(function () {
  var noop = function () {};
  window.webapis = window.webapis || {
    avplay: {
      open: noop,
      close: noop,
      prepare: noop,
      prepareAsync: function (success) { if (typeof success === 'function') success(); },
      play: noop,
      pause: noop,
      stop: noop,
      seekTo: noop,
      setDisplayRect: noop,
      setListener: noop,
      setStreamingProperty: noop,
      getState: function () { return 'NONE'; }
    }
  };
  window.tizen = window.tizen || {};
})();
