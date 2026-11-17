// Xtream Codes "player_api" client. Works in the browser and Node (for tests).
(function (root) {
  function normServer(s) {
    s = String(s || '').trim();
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    try {
      const u = new URL(s);
      // People often paste a full get.php / player_api.php link.
      u.pathname = u.pathname.replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, '');
      u.search = '';
      u.hash = '';
      return u.toString().replace(/\/+$/, '');
    } catch {
      return s.replace(/\/+$/, '');
    }
  }

  // If an M3U URL is really an Xtream get.php link, pull the login out of it.
  function fromGetPhp(url) {
    try {
      const u = new URL(url);
      if (!/\/get\.php$/i.test(u.pathname)) return null;
      const username = u.searchParams.get('username');
      const password = u.searchParams.get('password');
      if (!username || !password) return null;
      return { server: normServer(u.origin + u.pathname), username, password };
    } catch {
      return null;
    }
  }

  const toArray = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);

  function b64(s) {
    if (!s) return '';
    try {
      const bin = atob(s);
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return String(s);
    }
  }

  class Xtream {
    constructor({ server, username, password }, fetchImpl) {
      this.server = normServer(server);
      this.username = String(username || '');
      this.password = String(password || '');
      this._fetch = fetchImpl || ((...a) => fetch(...a));
    }

    apiUrl(params = {}) {
      const q = new URLSearchParams({ username: this.username, password: this.password, ...params });
      return `${this.server}/player_api.php?${q}`;
    }

    async api(action, params = {}) {
      const url = this.apiUrl(action ? { action, ...params } : params);
      const r = await this._fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Server did not return JSON. Check the server URL.');
      }
    }

    async login() {
      const d = await this.api('');
      if (!d || !d.user_info) throw new Error('Unexpected response. Check the server URL.');
      if (String(d.user_info.auth) === '0') throw new Error('Login rejected. Check username and password.');
      if (d.user_info.status && !/^active$/i.test(d.user_info.status)) {
        throw new Error(`Account status: ${d.user_info.status}`);
      }
      this.info = d;
      return d;
    }

    allowedFormats() {
      const f = this.info && this.info.user_info && this.info.user_info.allowed_output_formats;
      return Array.isArray(f) ? f : [];
    }

    liveCategories() { return this.api('get_live_categories').then(toArray); }
    liveStreams() { return this.api('get_live_streams').then(toArray); }
    vodCategories() { return this.api('get_vod_categories').then(toArray); }
    vodStreams() { return this.api('get_vod_streams').then(toArray); }
    seriesCategories() { return this.api('get_series_categories').then(toArray); }
    series() { return this.api('get_series').then(toArray); }
    vodInfo(id) { return this.api('get_vod_info', { vod_id: id }); }

    async seriesInfo(id) {
      const d = (await this.api('get_series_info', { series_id: id })) || {};
      return { info: d.info || {}, seasons: Xtream.groupEpisodes(d.episodes) };
    }

    // Normalises the many shapes panels use for "episodes" into
    // [{ season, episodes: [...] }] sorted by season and episode number.
    static groupEpisodes(raw) {
      const map = new Map();
      const add = (season, e) => {
        const s = Number(e.season ?? season) || 0;
        if (!map.has(s)) map.set(s, []);
        map.get(s).push(e);
      };
      if (Array.isArray(raw)) {
        raw.flat().forEach((e) => e && add(0, e));
      } else if (raw && typeof raw === 'object') {
        for (const [k, list] of Object.entries(raw)) toArray(list).forEach((e) => e && add(k, e));
      }
      return [...map.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([season, eps]) => ({
          season,
          episodes: eps.sort((a, b) => (Number(a.episode_num) || 0) - (Number(b.episode_num) || 0)),
        }));
    }

    async shortEpg(streamId, limit = 4) {
      const d = await this.api('get_short_epg', { stream_id: streamId, limit });
      return toArray(d && d.epg_listings).map((e) => ({
        start: e.start_timestamp ? Number(e.start_timestamp) * 1000 : Date.parse(e.start),
        stop: e.stop_timestamp ? Number(e.stop_timestamp) * 1000 : Date.parse(e.end || e.stop),
        title: b64(e.title),
        desc: b64(e.description),
      }));
    }

    _path(kind, id, ext) {
      const u = encodeURIComponent(this.username);
      const p = encodeURIComponent(this.password);
      return `${this.server}/${kind}/${u}/${p}/${id}.${ext}`;
    }
    liveUrl(id, ext = 'ts') { return this._path('live', id, ext); }
    movieUrl(id, ext = 'mp4') { return this._path('movie', id, ext || 'mp4'); }
    episodeUrl(id, ext = 'mp4') { return this._path('series', id, ext || 'mp4'); }
    xmltvUrl() {
      const q = new URLSearchParams({ username: this.username, password: this.password });
      return `${this.server}/xmltv.php?${q}`;
    }
  }

  const api = { Xtream, normServer, fromGetPhp, b64 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(this);
