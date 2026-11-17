// Injected before the page loads. Gives the shared interface the same
// window.BananaNative it has on Fire TV. Reads come from a snapshot the app
// passes in (window.__bananaInit); writes go to the app as messages.
(function () {
  var st = window.__bananaInit || {};
  st.sec = st.sec || {};
  var post = function (m) { try { window.webkit.messageHandlers.banana.postMessage(m); } catch (e) { /* not in the app */ } };
  var ps = function () { try { return JSON.parse(st.ps || '{}'); } catch (e) { return {}; } };
  window.BananaNative = {
    version: function () { return st.version || '?'; },
    platform: function () { return 'ios'; },
    diagnostics: function () { return st.diag || ''; },
    clearDiagnostics: function () { st.diag = ''; post({ op: 'clearDiag' }); },
    play: function (json) { post({ op: 'play', json: String(json) }); },
    openExternal: function (url, title) { post({ op: 'external', url: String(url || ''), title: String(title || '') }); },
    externalPlayer: function () { return st.ext || ''; },
    secretSet: function (id, v) { st.sec[id] = String(v); post({ op: 'secretSet', id: String(id), value: String(v) }); return true; },
    secretGet: function (id) { return Object.prototype.hasOwnProperty.call(st.sec, id) ? st.sec[id] : null; },
    secretDel: function (id) { delete st.sec[id]; post({ op: 'secretDel', id: String(id) }); },
    playerState: function () { return st.ps || '{}'; },
    clearPlayerState: function (w) {
      var s = ps();
      if (w === 'resume' || w === 'all') delete s.resume;
      if (w === 'recentLive' || w === 'all') delete s.recentLive;
      st.ps = JSON.stringify(s); post({ op: 'clearState', what: String(w) });
    },
    forgetResume: function (k) { var s = ps(); if (s.resume) delete s.resume[k]; st.ps = JSON.stringify(s); post({ op: 'forget', key: String(k) }); },
    toast: function () {},
    exitApp: function () {},
    // called by the app after the player closes
    _setState: function (json) { st.ps = json; }
  };
  window.addEventListener('error', function (e) { post({ op: 'log', text: (e.message || 'error') + ' @' + (e.filename || '') + ':' + (e.lineno || 0) }); });
  window.addEventListener('unhandledrejection', function (e) { post({ op: 'log', text: 'promise: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)) }); });
})();
