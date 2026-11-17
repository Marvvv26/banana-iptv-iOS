// Banana IPTV – iPhone interface (shared with the Fire TV app, plus a touch layer at the end).
// Runs in the app's WebView; video plays natively (window.BananaNative.play).
// Everything is driven by the remote: arrows move a focus ring, OK selects,
// Back goes back, ☰ (menu) opens options for the focused item.
'use strict';
window.addEventListener('error', (e) => { try { console.error('JS: ' + (e.message || e) + (e.filename ? ' @' + String(e.filename).replace(/.*\//, '') + ':' + e.lineno : '')); } catch (x) { /* ignore */ } });
window.addEventListener('unhandledrejection', (e) => { try { console.error('Promise: ' + ((e.reason && e.reason.message) || e.reason)); } catch (x) { /* ignore */ } });
// Older Fire TV WebViews lack Array.prototype.flat (used when grouping episodes).
if (!Array.prototype.flat) {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Array.prototype, 'flat', { configurable: true, writable: true, value: function flat() { return [].concat.apply([], this); } });
}
const { Xtream, fromGetPhp, b64 } = require('./xtream.js');
const { search } = require('./search.js');

const VERSION = '0.1.0';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

// ------------------------------------------------------------------ helpers
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function btn(cls, text, fn) {
  const b = el('button', 'f ' + (cls || ''), text);
  b.tabIndex = -1;
  if (fn) b.addEventListener('click', fn);
  return b;
}
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : '');
function img(url, alt) {
  const u = safeUrl(url);
  if (!u) return null;
  const i = el('img');
  i.alt = alt || '';
  i.loading = 'lazy';
  i.referrerPolicy = 'no-referrer';
  i.addEventListener('error', () => i.remove());
  i.src = u;
  return i;
}
function initials(name) {
  const w = String(name || '').replace(/^[^A-Za-z0-9]+/, '').split(/[\s|:_-]+/).filter(Boolean);
  return ((w[0] || '?')[0] + ((w[1] || '')[0] || '')).toUpperCase();
}
function logoBox(url, name, cls) {
  const b = el('div', 'logo-box ' + (cls || ''));
  const i = img(url, name);
  if (i) {
    i.addEventListener('error', () => { b.textContent = initials(name); });
    b.appendChild(i);
  } else b.textContent = initials(name);
  return b;
}
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${pad2(m)}m` : `${m} min`;
}
function fmtPos(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

// ------------------------------------------------------------ native bridge
// On the Fire TV this is the Java bridge. In a desktop browser (development and
// tests) a stand-in records what would have been played.
const N = window.BananaNative || (function mock() {
  const played = (window.__played = []);
  return {
    version: () => VERSION + '-web', platform: () => 'web',
    play: (j) => played.push(JSON.parse(j)),
    openExternal: (u, t) => played.push({ external: u, title: t }),
    externalPlayer: () => '',
    secretSet: (i, v) => { localStorage.setItem('mock.sec.' + i, v); return true; },
    secretGet: (i) => localStorage.getItem('mock.sec.' + i),
    secretDel: (i) => localStorage.removeItem('mock.sec.' + i),
    playerState: () => localStorage.getItem('mock.ps') || '{}',
    clearPlayerState: (w) => { const s = JSON.parse(localStorage.getItem('mock.ps') || '{}'); if (w === 'resume' || w === 'all') delete s.resume; if (w === 'recentLive' || w === 'all') delete s.recentLive; localStorage.setItem('mock.ps', JSON.stringify(s)); },
    forgetResume: () => {},
    toast: (m) => toast(m),
    exitApp: () => { window.__exited = true; },
  };
})();
const netFetch = (url, opts) => fetch('/net?u=' + encodeURIComponent(url), opts);

// ----------------------------------------------------------------- settings
const S = Object.assign({ liveFormat: 'auto', player: 'builtin', resume: 'ask', aspect: 0, accent: '#FB923C', buffer: 3000, subs: 'off' }, LS.get('ay.settings', {}));
const saveSettings = () => LS.set('ay.settings', S);
function applyAccent() { document.documentElement.style.setProperty('--accent', S.accent); }

// -------------------------------------------------------------------- state
const A = {
  playlists: LS.get('ay.playlists', []),
  activeId: LS.get('ay.active', ''),
  pl: null, xt: null, info: null,
  live: null, vod: { movies: null, series: null }, vodLoading: {},
  favs: { live: [], movie: [], series: [] },
  cw: {}, // continue-watching details we need to show a tile (no links/passwords)
  ps: { resume: {}, recentLive: [] }, // positions and recent channels from the player
  epg: new Map(),
  screen: '', prev: null, lastBack: 0,
  liveCat: '__all', vodCat: { movies: '__all', series: '__all' }, vodSort: { movies: 'added', series: 'added' },
};
// Profiles: each has its own favourites, Continue watching and recently viewed channels.
// The first profile has id '' so data saved before profiles existed belongs to it.
A.profiles = LS.get('ay.profiles', null) || [{ id: '', name: 'Me', color: '#FB923C', playlist: '', kids: false }];
A.prof = A.profiles.find((p) => p.id === LS.get('ay.profile', '')) || A.profiles[0];
const saveProfiles = () => { LS.set('ay.profiles', A.profiles); LS.set('ay.profile', A.prof ? A.prof.id : ''); };
const profSuffix = () => (A.prof && A.prof.id ? '.' + A.prof.id : '');
const profPrefix = () => (A.prof && A.prof.id ? A.prof.id + '|' : '');
const rk = (k) => profPrefix() + k; // key the player stores positions under
const favKey = () => 'ay.fav.' + (A.pl ? A.pl.id : '') + profSuffix();
const cwKey = () => 'ay.cw.' + (A.pl ? A.pl.id : '') + profSuffix();
// Kids profiles hide adult categories everywhere.
const ADULT = /\b(adult|adults|xxx|18\+|\+18|porn|erotic|for adults)\b/i;
const allowed = (name) => !(A.prof && A.prof.kids) || !ADULT.test(String(name || ''));
function loadUserData() {
  A.favs = Object.assign({ live: [], movie: [], series: [] }, LS.get(favKey(), {}));
  A.cw = LS.get(cwKey(), {});
  readPlayerState();
}
function readPlayerState() {
  let raw;
  try { raw = Object.assign({ resume: {}, recentLive: [] }, JSON.parse(N.playerState() || '{}')); } catch (e) { raw = { resume: {}, recentLive: [] }; }
  // Show only this profile's part of what the player remembers.
  const pre = profPrefix(), mine = (k) => (pre ? k.indexOf(pre) === 0 : k.indexOf('|') < 0), strip = (k) => k.slice(pre.length);
  const resume = {};
  Object.keys(raw.resume || {}).forEach((k) => { if (mine(k)) resume[strip(k)] = raw.resume[k]; });
  A.ps = { resume, recentLive: (raw.recentLive || []).map(String).filter(mine).map(strip) };
}
const isFav = (kind, id) => A.favs[kind].indexOf(String(id)) >= 0;
function toggleFav(kind, id, name) {
  id = String(id);
  const l = A.favs[kind], i = l.indexOf(id);
  if (i >= 0) l.splice(i, 1); else l.unshift(id);
  LS.set(favKey(), A.favs);
  toast(i >= 0 ? `Removed ${name || ''} from favourites` : `Added ${name || ''} to favourites`);
  return i < 0;
}
function resumeOf(key) {
  const r = A.ps.resume && A.ps.resume[key];
  return r && !r.done ? r : null;
}

// ------------------------------------------------------------------ UI bits
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), 2600);
}
function loading(on, text) {
  $('#loading').classList.toggle('hidden', !on);
  if (text) $('#loadingText').textContent = text;
}
let dlgPrev = null;
function openDialog(title, text, buttons) {
  dlgPrev = cur;
  $('#dlgTitle').textContent = title || '';
  $('#dlgText').textContent = text || '';
  const box = $('#dlgBtns');
  box.textContent = '';
  buttons.forEach((b) => box.appendChild(btn('btn' + (b.primary ? ' primary' : ''), b.label, () => { closeDialog(); b.fn && b.fn(); })));
  if (!buttons.length) box.appendChild(btn('btn', 'Close', closeDialog));
  $('#dialog').classList.remove('hidden');
  focus(box.firstChild);
}
function closeDialog() {
  if ($('#dialog').classList.contains('hidden')) return;
  $('#dialog').classList.add('hidden');
  if (dlgPrev && document.body.contains(dlgPrev)) focus(dlgPrev, true);
  else focusDefault();
}
const dialogOpen = () => !$('#dialog').classList.contains('hidden');

// ----------------------------------------------------------------- focusing
let cur = null;
function visible(e) {
  if (!e || !e.isConnected || e.offsetParent === null) return false;
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}
function focus(e, silent) {
  if (!e) return;
  if (cur && cur !== e) cur.classList.remove('focus');
  cur = e;
  e.classList.add('focus');
  try { e.focus({ preventScroll: true }); } catch (x) { /* old WebView */ }
  ensureVisible(e);
  if (!silent && e._onFocus) e._onFocus();
}
// Keep the focused item on screen inside the scrolling areas we manage by hand.
function ensureVisible(e) {
  let p = e.parentElement;
  while (p && p !== document.body) {
    if (p.matches && p.matches('.strip, #homeRows, #searchRows, #fbRows, #setPane, .d-seasons, .dlg-btns, .setup')) {
      const r = e.getBoundingClientRect(), pr = p.getBoundingClientRect(), m = remPx() * 1.2;
      if (p.matches('.strip, .d-seasons')) {
        if (r.right > pr.right - m) p.scrollLeft += r.right - pr.right + m;
        else if (r.left < pr.left + m) p.scrollLeft -= pr.left + m - r.left;
      } else {
        if (r.bottom > pr.bottom - m) p.scrollTop += r.bottom - pr.bottom + m;
        else if (r.top < pr.top + m) p.scrollTop -= pr.top + m - r.top;
      }
    }
    p = p.parentElement;
  }
}
function widgetOf(e) {
  for (let p = e; p && p !== document.body; p = p.parentElement) if (p._w) return p._w;
  return null;
}
function scopeEls() {
  if (dialogOpen()) return [$('#dialog')];
  const s = $('#scr-' + A.screen);
  const out = s ? [s] : [];
  if (A.pl && BARE.indexOf(A.screen) < 0) { out.unshift($('.top-right')); out.unshift($('#nav')); }
  return out;
}
function spatial(dir) {
  if (!cur || !cur.isConnected) { focusDefault(); return; }
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bestScore = Infinity;
  const fromW = widgetOf(cur);
  scopeEls().forEach((scope) => $$('.f', scope).forEach((c) => {
    if (c === cur || !visible(c)) return;
    const w = widgetOf(c);
    if (w && w === fromW) return; // moving inside a list is the list's job
    const q = c.getBoundingClientRect();
    const qx = q.left + q.width / 2, qy = q.top + q.height / 2;
    let main, side;
    // Sideways moves stay on the same row: never jump up into the top bar from the end of a row.
    if ((dir === 'right' || dir === 'left') && (q.bottom <= r.top + 2 || q.top >= r.bottom - 2)) return;
    if (dir === 'right') { if (q.left < r.right - 6) return; main = q.left - r.right; side = Math.max(0, Math.abs(qy - cy) - (q.height + r.height) / 4); }
    else if (dir === 'left') { if (q.right > r.left + 6) return; main = r.left - q.right; side = Math.max(0, Math.abs(qy - cy) - (q.height + r.height) / 4); }
    else if (dir === 'down') { if (q.top < r.bottom - 6) return; main = q.top - r.bottom; side = Math.max(0, Math.abs(qx - cx) - (q.width + r.width) / 4); }
    else { if (q.bottom > r.top + 6) return; main = r.top - q.bottom; side = Math.max(0, Math.abs(qx - cx) - (q.width + r.width) / 4); }
    const score = Math.max(0, main) + side * 2.5;
    if (score < bestScore) { bestScore = score; best = c; }
  }));
  if (!best) return;
  // Moving up into the top bar lands on the current section, not whichever tab is nearest.
  if (best.closest('#nav') && !cur.classList.contains('nav')) best = $('#nav .nav.active') || best;
  const w = widgetOf(best);
  if (w && w.enter()) return;
  focus(best);
}
function focusDefault() {
  if (dialogOpen()) return focus($('#dlgBtns .f'));
  const f = SCREENS[A.screen] && SCREENS[A.screen].focus;
  if (f && f() !== false) return;
  const c = $$('.f', $('#scr-' + A.screen)).find(visible) || $$('.nav').find(visible);
  if (c) { const w = widgetOf(c); if (!(w && w.enter())) focus(c); }
}

// ------------------------------------------------------------- input boxes
function startEditing(wrap) {
  const i = $('input', wrap);
  if (!i) return;
  wrap.classList.add('editing');
  i.focus();
  try { i.setSelectionRange(i.value.length, i.value.length); } catch (e) { /* type=url etc. */ }
}
function stopEditing(input) {
  const wrap = input.closest('.input-wrap');
  input.blur();
  if (wrap) { wrap.classList.remove('editing'); focus(wrap, true); }
}

// ------------------------------------------------------------- virtual list
// Only the rows on screen exist in the page, so lists of 20,000 channels stay quick.
class VList {
  constructor(e, o) {
    this.el = e; this.o = o; this.items = []; this.i = 0; this.first = 0; this.pool = [];
    e._w = this;
    this.empty = el('div', 'muted', '');
    this.empty.style.cssText = 'padding:1.6rem;font-size:1.3rem';
    e.appendChild(this.empty);
  }
  rowPx() { return this.o.rowH * remPx(); }
  rows() { return Math.max(1, Math.floor(this.el.clientHeight / this.rowPx())); }
  setItems(items, i) {
    this.items = items || [];
    this.i = Math.max(0, Math.min(i || 0, this.items.length - 1));
    this.first = Math.max(0, this.i - 2);
    this.pool.forEach((r) => { r._item = null; });
    this.render();
  }
  render() {
    const n = this.rows(), rp = this.rowPx(), max = Math.max(0, this.items.length - n);
    if (this.i < this.first + 1) this.first = this.i - 1;
    if (this.i > this.first + n - 2) this.first = this.i - n + 2;
    this.first = Math.max(0, Math.min(this.first, max));
    const need = Math.min(n + 1, this.items.length - this.first);
    while (this.pool.length < need) {
      const r = el('div', 'f vrow ' + (this.o.cls || ''));
      r.tabIndex = -1;
      r.addEventListener('click', () => {
        const k = +r.dataset.i;
        if (k < 0) return;
        this.i = k;
        if (this.o.onSelect) this.o.onSelect(this.items[k], k);
      });
      r._ctx = () => (this.o.ctx ? this.o.ctx(this.items[+r.dataset.i], +r.dataset.i) : null);
      this.el.appendChild(r);
      this.pool.push(r);
    }
    this.pool.forEach((r, j) => {
      if (j >= need) { r.style.display = 'none'; r.dataset.i = -1; r._item = null; return; }
      const k = this.first + j, it = this.items[k];
      r.style.display = '';
      r.style.top = (j * rp + rp * 0.06) + 'px';
      r.style.height = (rp * 0.88) + 'px';
      if (r._item !== it || +r.dataset.i !== k) {
        r.dataset.i = k; r._item = it; r.textContent = '';
        this.o.render(r, it, k);
      }
      r.classList.toggle('sel', k === this.i);
    });
    this.empty.textContent = this.items.length ? '' : (this.o.emptyText || 'Nothing here');
    if (this.o.onRender) this.o.onRender();
  }
  rowEl(k) { return this.pool.find((r) => +r.dataset.i === k); }
  current() { return this.items[this.i]; }
  enter() {
    if (!this.items.length) return false;
    this.render();
    focus(this.rowEl(this.i), true);
    if (this.o.onFocus) this.o.onFocus(this.items[this.i], this.i);
    return true;
  }
  move(d) {
    const n = this.items.length;
    if (!n) return false;
    let k = this.i + d;
    if (k < 0) { if (this.i === 0) return false; k = 0; }
    if (k >= n) k = n - 1;
    if (k === this.i) return true;
    this.i = k;
    this.render();
    focus(this.rowEl(k), true);
    if (this.o.onFocus) this.o.onFocus(this.items[k], k);
    return true;
  }
  key(k) {
    if (k === 'up') return this.move(-1);
    if (k === 'down') return this.move(1);
    if (k === 'rew') { this.move(-this.rows()); return true; }
    if (k === 'ff') { this.move(this.rows()); return true; }
    return false;
  }
  refresh() {
    const had = cur && this.el.contains(cur);
    this.pool.forEach((r) => { r._item = null; });
    this.render();
    if (had) { const e = this.rowEl(this.i); if (e) focus(e, true); }
  }
  visibleItems() { return this.items.slice(this.first, this.first + this.rows() + 1); }
}

// Poster grid: same idea, several columns.
class VGrid {
  constructor(e, o) {
    this.el = e; this.o = o; this.items = []; this.i = 0; this.firstRow = 0; this.pool = [];
    e._w = this;
    this.empty = el('div', 'muted', '');
    this.empty.style.cssText = 'padding:2rem;font-size:1.4rem';
    e.appendChild(this.empty);
  }
  dims() {
    const pad = remPx() * 0.9; // room for the focused card to grow
    const W = this.el.clientWidth - pad * 2, H = this.el.clientHeight - pad, cols = this.o.cols;
    const cw = W / cols, ch = cw * this.o.ratio;
    return { cols, cw, ch, pad, full: Math.max(1, Math.floor(H / ch)), vis: Math.ceil(H / ch) + 1 };
  }
  setItems(items, i) {
    this.items = items || [];
    this.i = Math.max(0, Math.min(i || 0, this.items.length - 1));
    this.firstRow = 0;
    this.pool.forEach((c) => { c._item = null; });
    this.render();
  }
  render() {
    const d = this.dims(), row = Math.floor(this.i / d.cols), rowsTotal = Math.ceil(this.items.length / d.cols);
    if (row < this.firstRow) this.firstRow = row;
    if (row > this.firstRow + d.full - 1) this.firstRow = row - d.full + 1;
    this.firstRow = Math.max(0, Math.min(this.firstRow, Math.max(0, rowsTotal - d.full)));
    const start = this.firstRow * d.cols, need = Math.min(d.vis * d.cols, this.items.length - start);
    while (this.pool.length < need) {
      const c = el('div', 'f card');
      c.tabIndex = -1;
      c.addEventListener('click', () => {
        const k = +c.dataset.i;
        if (k < 0) return;
        this.i = k;
        this.o.onSelect(this.items[k], k);
      });
      c._ctx = () => (this.o.ctx ? this.o.ctx(this.items[+c.dataset.i], +c.dataset.i) : null);
      this.el.appendChild(c);
      this.pool.push(c);
    }
    this.pool.forEach((c, j) => {
      if (j >= need) { c.style.display = 'none'; c.dataset.i = -1; c._item = null; return; }
      const k = start + j, it = this.items[k];
      c.style.display = '';
      c.style.left = (d.pad + (k % d.cols) * d.cw) + 'px';
      c.style.top = (d.pad + (Math.floor(k / d.cols) - this.firstRow) * d.ch) + 'px';
      c.style.width = d.cw + 'px';
      c.style.height = d.ch + 'px';
      if (c._item !== it || +c.dataset.i !== k) {
        c.dataset.i = k; c._item = it; c.textContent = '';
        this.o.render(c, it, k);
      }
    });
    this.empty.textContent = this.items.length ? '' : (this.o.emptyText || 'Nothing here');
  }
  cardEl(k) { return this.pool.find((c) => +c.dataset.i === k); }
  enter() {
    if (!this.items.length) return false;
    this.render();
    focus(this.cardEl(this.i), true);
    if (this.o.onFocus) this.o.onFocus(this.items[this.i]);
    return true;
  }
  go(k) {
    this.i = k;
    this.render();
    focus(this.cardEl(k), true);
    if (this.o.onFocus) this.o.onFocus(this.items[k]);
    return true;
  }
  key(k) {
    const cols = this.o.cols, n = this.items.length, col = this.i % cols, row = Math.floor(this.i / cols);
    if (!n) return false;
    if (k === 'left') return col === 0 ? false : this.go(this.i - 1);
    if (k === 'right') return col === cols - 1 || this.i === n - 1 ? true : this.go(this.i + 1);
    if (k === 'up') return row === 0 ? false : this.go(this.i - cols);
    if (k === 'down') {
      if (this.i + cols < n) return this.go(this.i + cols);
      if (row < Math.floor((n - 1) / cols)) return this.go(n - 1);
      return true;
    }
    if (k === 'rew') return this.go(Math.max(0, this.i - cols * this.dims().full));
    if (k === 'ff') return this.go(Math.min(n - 1, this.i + cols * this.dims().full));
    return false;
  }
  refresh() {
    const had = cur && this.el.contains(cur);
    this.pool.forEach((c) => { c._item = null; });
    this.render();
    if (had) { const e = this.cardEl(this.i); if (e) focus(e, true); }
  }
}

// -------------------------------------------------------------------- keys
const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Up: 'up', Down: 'down', Left: 'left', Right: 'right',
  Enter: 'enter', NumpadEnter: 'enter',
  Escape: 'back', Backspace: 'back', GoBack: 'back', BrowserBack: 'back',
  ContextMenu: 'menu', MediaPlayPause: 'play', MediaRewind: 'rew', MediaFastForward: 'ff', PageUp: 'rew', PageDown: 'ff',
};
document.addEventListener('keydown', (e) => {
  let k = KEYMAP[e.key];
  if (!k && e.key === 'm' && !window.BananaNative) k = 'menu'; // desktop testing
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT') {
    if (k === 'up' || k === 'down' || k === 'enter' || (k === 'back' && e.key !== 'Backspace')) {
      e.preventDefault();
      stopEditing(ae);
      if (ae.id === 'searchInput' && (k === 'enter' || k === 'down')) { runSearch(true); return; }
      if (k === 'up' || k === 'down') nav(k);
      else if (k === 'enter') nav('down'); // next field
    }
    return; // letters, left/right and backspace edit the text
  }
  if (!k) return;
  e.preventDefault();
  handleKey(k, e.repeat);
});
function nav(dir) {
  const w = cur && widgetOf(cur);
  if (w && cur.isConnected && w.key(dir)) return;
  spatial(dir);
}
function handleKey(k) {
  if (A.screen === 'football') FB.autoFocus = false;
  if (!cur || !cur.isConnected) { focusDefault(); if (k !== 'enter') return; }
  switch (k) {
    case 'up': case 'down': case 'left': case 'right': nav(k); break;
    case 'rew': case 'ff': { const w = cur && widgetOf(cur); if (w) w.key(k); break; }
    case 'enter': case 'play':
      if (!cur) break;
      if (cur.classList.contains('input-wrap')) startEditing(cur);
      else cur.click();
      break;
    case 'back': if (!goBack()) exitApp(); break;
    case 'menu': contextMenu(); break;
    default: break;
  }
}
window.bananaKey = (k) => handleKey(k);
window.bananaBack = () => (goBack() ? 'handled' : 'exit');
function exitApp() { N.exitApp(); }

function goBack() {
  if (dialogOpen()) { closeDialog(); return true; }
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT') { stopEditing(ae); return true; }
  if (A.screen === 'detail' && A.prev) {
    const p = A.prev;
    A.prev = null;
    show(p.screen);
    if (p.screen === 'vod') navActive(vodKind);
    if (p.focus && p.focus.isConnected) { const w = widgetOf(p.focus); if (w) { w.refresh(); w.enter(); } else focus(p.focus, true); }
    else focusDefault();
    return true;
  }
  if (A.screen === 'setup') {
    if (A.playlists.length && A.pl) { go('settings'); return true; }
    return false;
  }
  if (A.screen === 'profedit') { go('profiles'); return true; }
  if (A.screen === 'profiles') {
    if (profManaging) { profManaging = false; renderProfiles(); SCREENS.profiles.focus(); return true; }
    if (A.pl) { go('home'); return true; }
    return false;
  }
  if (!A.pl) return false;
  const navName = A.screen === 'vod' ? vodKind : A.screen;
  if (cur && !cur.classList.contains('nav') && A.screen !== 'home' && $(`.nav[data-go="${navName}"]`)) {
    focus($(`.nav[data-go="${navName}"]`));
    return true;
  }
  if (A.screen !== 'home') { go('home'); return true; }
  if (Date.now() - A.lastBack < 2500) return false;
  A.lastBack = Date.now();
  toast('Press Back again to exit');
  return true;
}
function contextMenu() {
  if (!cur || dialogOpen()) return;
  const items = cur._ctx && cur._ctx();
  if (!items || !items.length) return;
  openDialog(items.title || 'Options', items.text || '', items);
}

// ------------------------------------------------------------------ screens
const SCREENS = {};
const BARE = ['setup', 'profiles', 'profedit']; // full-screen pages without the top bar
function show(name) {
  A.screen = name;
  $$('.scr').forEach((s) => s.classList.toggle('hidden', s.id !== 'scr-' + name));
  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.go === name || (name === 'detail' && A.prev && b.dataset.go === A.prev.screenNav)));
  const bare = !A.pl || BARE.indexOf(name) >= 0;
  $('#nav').classList.toggle('hidden', bare);
  $('.top-right').classList.toggle('hidden', bare);
  if (name !== 'home') stopHeroTimer();
}
function go(name, keepFocus) {
  if (!A.pl && BARE.indexOf(name) < 0) name = 'setup';
  show(name);
  const s = SCREENS[name];
  if (s && s.enter) s.enter();
  if (!keepFocus) focusDefault();
}
$$('.nav').forEach((b) => {
  b.tabIndex = -1;
  b.addEventListener('click', () => { if (b.dataset.go === 'profiles') profManaging = false; go(b.dataset.go); });
});

// ---------------------------------------------------------------- playlists
function savePlaylists() { LS.set('ay.playlists', A.playlists); LS.set('ay.active', A.activeId); }
async function connect(pl) {
  const pass = N.secretGet('pl_' + pl.id);
  if (!pass) { openSetup(pl, 'Please enter the password for this playlist again.'); return false; }
  status('Connecting to ' + pl.name + '…');
  const xt = new Xtream({ server: pl.server, username: pl.username, password: pass }, netFetch);
  try {
    A.info = await xt.login();
    status('Loading channels…');
    const [cats, streams] = await Promise.all([xt.liveCategories(), xt.liveStreams()]);
    A.xt = xt; A.pl = pl; A.activeId = pl.id; savePlaylists();
    A.live = buildLive(cats, streams);
    A.vod = { movies: null, series: null }; A.vodLoading = {};
    A.epg = new Map();
    A.liveCat = '__all';
    loadUserData();
    loading(false);
    go('home');
    hideSplash();
    // One list at a time: big libraries are heavy for a Firestick's memory.
    setTimeout(() => { if (A.pl === pl) ensureVod('movies', true).then(() => { if (A.pl === pl) ensureVod('series', true); }); }, 6000);
    return true;
  } catch (e) {
    loading(false);
    hideSplash();
    openSetup(pl, 'Could not connect: ' + (e && e.message ? e.message : e));
    return false;
  }
}
// ------------------------------------------------------------------ splash
const splashT0 = Date.now();
const splashOn = () => !$('#splash').classList.contains('gone');
function status(text) {
  if (splashOn()) $('#splashText').textContent = text;
  else loading(true, text);
}
function hideSplash() {
  if (!splashOn()) return;
  const wait = Math.max(0, 1400 - (Date.now() - splashT0)); // long enough to see the logo
  setTimeout(() => {
    $('#splash').classList.add('gone');
    setTimeout(() => { $('#splash').style.display = 'none'; }, 500);
  }, wait);
}
function buildLive(cats, streams) {
  const list = streams.map((s, i) => ({
    id: String(s.stream_id), name: String(s.name || '').trim(), num: Number(s.num) || i + 1,
    logo: s.stream_icon || '', cat: String(s.category_id || ''), added: Number(s.added) || 0,
  })).filter((c) => c.id && c.name && allowed(c.name));
  const blocked = new Set(cats.filter((c) => !allowed(c.category_name)).map((c) => String(c.category_id)));
  for (let i = list.length - 1; i >= 0; i--) if (blocked.has(list[i].cat)) list.splice(i, 1);
  list.sort((a, b) => a.num - b.num);
  const byCat = new Map();
  list.forEach((c) => { if (!byCat.has(c.cat)) byCat.set(c.cat, []); byCat.get(c.cat).push(c); });
  const catName = new Map();
  const outCats = cats.filter((c) => byCat.has(String(c.category_id))).map((c) => {
    catName.set(String(c.category_id), c.category_name);
    return { id: String(c.category_id), name: String(c.category_name || '').trim(), count: byCat.get(String(c.category_id)).length };
  });
  return { list, byId: new Map(list.map((c) => [c.id, c])), byCat, cats: outCats, catName };
}

// ----------------------------------------------------------------------- EPG
const epgQueue = [];
let epgActive = 0;
function getEpg(id) {
  const c = A.epg.get(id);
  if (c && (c.p || Date.now() - c.t < 10 * 60000)) return c.p || Promise.resolve(c.list);
  const p = new Promise((res) => { epgQueue.push({ id, res }); pumpEpg(); });
  A.epg.set(id, { t: Date.now(), p, list: c ? c.list : null });
  return p;
}
function pumpEpg() {
  while (epgActive < 3 && epgQueue.length) {
    const job = epgQueue.shift();
    epgActive++;
    const xt = A.xt;
    xt.shortEpg(job.id, 4).catch(() => []).then((list) => {
      epgActive--;
      if (xt === A.xt) A.epg.set(job.id, { t: Date.now(), list });
      job.res(list);
      pumpEpg();
    });
  }
}
function nowNext(list) {
  const now = Date.now();
  const l = (list || []).filter((p) => p.stop > now).sort((a, b) => a.start - b.start);
  const n = l[0] && l[0].start <= now ? l[0] : null;
  return { now: n, next: l.filter((p) => p !== n) };
}
const cachedEpg = (id) => { const c = A.epg.get(id); return c && c.list; };

// --------------------------------------------------------------------- live
function liveUrls(id) {
  const allowed = A.xt.allowedFormats();
  const hls = A.xt.liveUrl(id, 'm3u8'), ts = A.xt.liveUrl(id, 'ts');
  const hlsOk = !allowed.length || allowed.indexOf('m3u8') >= 0;
  const tsOk = !allowed.length || allowed.indexOf('ts') >= 0;
  if (S.liveFormat === 'ts' && tsOk) return [ts, hlsOk ? hls : ''];
  if (S.liveFormat === 'hls' && hlsOk) return [hls, tsOk ? ts : ''];
  return hlsOk ? [hls, tsOk ? ts : ''] : [ts, ''];
}
function playLive(list, i) {
  if (!list.length) return;
  const c = list[i];
  const [url, alt] = liveUrls(c.id);
  rememberRecent(c.id);
  if (S.player === 'external') { N.openExternal(url, c.name); return; }
  // Don't hand the player a giant list: a window around the channel is enough to flick through.
  let from = 0, to = list.length;
  if (list.length > 1200) { from = Math.max(0, i - 600); to = Math.min(list.length, from + 1200); }
  const items = list.slice(from, to).map((ch) => {
    const u = liveUrls(ch.id);
    return {
      key: 'l:' + ch.id, id: ch.id, title: ch.num + '   ' + ch.name, sub: A.live.catName.get(ch.cat) || '',
      url: u[0], alt: u[1], logo: safeUrl(ch.logo),
      epg: A.xt.apiUrl({ action: 'get_short_epg', stream_id: ch.id, limit: 4 }),
    };
  });
  N.play(JSON.stringify({ type: 'live', index: i - from, items, ...playerOpts() }));
}
// Settings the player needs. acct lets it check the login's connection limit when a stream fails.
function playerOpts() {
  return { aspect: S.aspect, buffer: S.buffer, subs: S.subs, acct: A.xt ? A.xt.apiUrl({}) : '', profile: profPrefix() };
}
function rememberRecent(id) {
  const l = (A.ps.recentLive || []).filter((x) => x !== id);
  l.unshift(id);
  A.ps.recentLive = l.slice(0, 30);
}
function recentChannels() {
  return (A.ps.recentLive || []).map((id) => A.live.byId.get(String(id))).filter(Boolean);
}
function favChannels() { return A.favs.live.map((id) => A.live.byId.get(id)).filter(Boolean); }
function channelsFor(cat) {
  if (cat === '__all') return A.live.list;
  if (cat === '__fav') return favChannels();
  if (cat === '__recent') return recentChannels();
  return A.live.byCat.get(cat) || [];
}
// Channels added to the Football hub (per playlist): always checked for matches.
const fbPinKey = () => 'ay.fbPinned.' + (A.pl ? A.pl.id : '');
const fbPinned = () => LS.get(fbPinKey(), []);
function toggleFbPin(ch) {
  const l = fbPinned(), i = l.indexOf(ch.id);
  if (i >= 0) l.splice(i, 1); else l.unshift(ch.id);
  LS.set(fbPinKey(), l.slice(0, 300));
  FB.groups = null; FB.at = 0; // rescan with the new list next time
  toast(i >= 0 ? `${ch.name} removed from Football` : `⚽ ${ch.name} added to Football`);
  if (A.screen === 'football') { fbScan(); renderFootball(true); }
}
function chanCtx(ch, list, i) {
  const f = isFav('live', ch.id);
  const pinned = fbPinned().indexOf(ch.id) >= 0;
  const items = [
    { label: '▶  Watch', primary: true, fn: () => playLive(list, i) },
    { label: f ? '★  Remove from favourites' : '☆  Add to favourites', fn: () => { toggleFav('live', ch.id, ch.name); refreshAfterFav(); } },
    { label: pinned ? '⚽  Remove from Football' : '⚽  Add to Football (always check it for matches)', fn: () => toggleFbPin(ch) },
    { label: 'Open in VLC / external player', fn: () => N.openExternal(liveUrls(ch.id)[0], ch.name) },
  ];
  items.title = ch.name;
  return items;
}
function refreshAfterFav() {
  if (A.screen === 'live') { liveCatList.refresh(); if (A.liveCat === '__fav') setLiveCat('__fav', 'keep'); else liveList.refresh(); }
  if (A.screen === 'home') SCREENS.home.enter(true);
  if (A.screen === 'vod') vodGrid.refresh();
}

const liveCatList = new VList($('#liveCats'), {
  rowH: 4.4, cls: 'cat-row',
  render(r, c) {
    if (c.ico) r.appendChild(el('span', 'ico', c.ico));
    r.appendChild(el('span', 't', c.name));
    r.appendChild(el('span', 'n', String(c.special ? channelsFor(c.id).length : c.count)));
  },
  onFocus: debounce((c) => { if (A.screen === 'live' && c) setLiveCat(c.id); }, 220),
  onSelect(c) { setLiveCat(c.id); liveList.enter(); },
});
const liveList = new VList($('#liveList'), {
  rowH: 6.4, cls: 'ch-row', emptyText: 'No channels here yet.',
  render(r, ch) {
    r.appendChild(el('span', 'num', String(ch.num)));
    r.appendChild(logoBox(ch.logo, ch.name));
    const t = el('div', 'txt');
    t.appendChild(el('div', 'nm', ch.name));
    const nn = nowNext(cachedEpg(ch.id));
    t.appendChild(el('div', 'ep', nn.now ? nn.now.title : ''));
    if (nn.now) {
      const b = el('div', 'bar'), i = el('i');
      i.style.width = Math.min(100, 100 * (Date.now() - nn.now.start) / (nn.now.stop - nn.now.start)) + '%';
      b.appendChild(i); t.appendChild(b);
    }
    r.appendChild(t);
    if (isFav('live', ch.id)) r.appendChild(el('span', 'star', '★'));
  },
  onFocus: debounce((ch) => { if (ch) showLiveInfo(ch); }, 150),
  onSelect(ch, i) { playLive(liveList.items, i); },
  ctx(ch, i) { return chanCtx(ch, liveList.items, i); },
  onRender: debounce(() => loadVisibleEpg(), 350),
});
function loadVisibleEpg() {
  if (A.screen !== 'live') return;
  const want = liveList.visibleItems().filter((c) => !A.epg.has(c.id));
  if (!want.length) return;
  Promise.all(want.map((c) => getEpg(c.id))).then(() => { if (A.screen === 'live') liveList.refresh(); });
}
// mode: undefined = only if it changed, 'keep' = refill but stay put, 'force' = refill from the top
function setLiveCat(id, mode) {
  if (id === A.liveCat && !mode && liveList.items.length) return;
  const keepI = mode === 'keep' && id === A.liveCat ? liveList.i : 0;
  A.liveCat = id;
  const c = liveCatItems().find((x) => x.id === id);
  $('#liveCatName').textContent = c ? c.name : '';
  const list = channelsFor(id);
  $('#liveCount').textContent = list.length.toLocaleString();
  liveList.setItems(list, keepI);
}
function liveCatItems() {
  return [
    { id: '__all', name: 'All channels', ico: '≡', count: A.live.list.length },
    { id: '__fav', name: 'Favourites', ico: '★', special: true },
    { id: '__recent', name: 'Recently viewed', ico: '↺', special: true },
  ].concat(A.live.cats);
}
const showLiveInfo = (ch) => {
  $('#liLogo').replaceWith(Object.assign(logoBox(ch.logo, ch.name), { id: 'liLogo' }));
  $('#liName').textContent = ch.name;
  $('#liGroup').textContent = (A.live.catName.get(ch.cat) || '') + '  ·  ' + ch.num;
  const paint = (list) => {
    if (liveList.current() !== ch) return;
    const nn = nowNext(list);
    const now = $('#liNow');
    now.textContent = '';
    if (nn.now) {
      now.appendChild(el('small', '', `ON NOW  ${hhmm(nn.now.start)} – ${hhmm(nn.now.stop)}`));
      now.appendChild(document.createTextNode(nn.now.title));
      $('#liBar').style.width = Math.min(100, 100 * (Date.now() - nn.now.start) / (nn.now.stop - nn.now.start)) + '%';
      $('#liDesc').textContent = nn.now.desc || '';
    } else {
      now.appendChild(el('small', '', list ? 'NO GUIDE INFO' : 'LOADING GUIDE…'));
      $('#liBar').style.width = '0';
      $('#liDesc').textContent = '';
    }
    const nx = $('#liNext');
    nx.textContent = '';
    nn.next.slice(0, 3).forEach((p) => {
      const d = el('div');
      d.appendChild(el('b', '', hhmm(p.start)));
      d.appendChild(el('span', '', p.title));
      nx.appendChild(d);
    });
  };
  paint(cachedEpg(ch.id));
  getEpg(ch.id).then(paint);
};
SCREENS.live = {
  enter() {
    if (!A.live) return;
    const cats = liveCatItems();
    const idx = Math.max(0, cats.findIndex((c) => c.id === A.liveCat));
    liveCatList.setItems(cats, idx);
    setLiveCat(A.liveCat, 'keep');
  },
  focus() { return liveList.items.length ? liveList.enter() : liveCatList.enter(); },
};

// --------------------------------------------------------- movies & series
async function ensureVod(kind, quiet) {
  if (A.vod[kind]) return A.vod[kind];
  if (!quiet) loading(true, kind === 'movies' ? 'Loading movies…' : 'Loading series…');
  if (A.vodLoading[kind]) {
    const r = await A.vodLoading[kind];
    if (!quiet) loading(false);
    return r;
  }
  const xt = A.xt;
  const p = (async () => {
    try {
      const [cats, items] = kind === 'movies'
        ? await Promise.all([xt.vodCategories(), xt.vodStreams()])
        : await Promise.all([xt.seriesCategories(), xt.series()]);
      if (xt !== A.xt) return null;
      const list = items.map((v) => kind === 'movies' ? {
        kind: 'movie', id: String(v.stream_id), name: String(v.name || '').trim(), poster: v.stream_icon || '',
        rating: parseFloat(v.rating) || (parseFloat(v.rating_5based) * 2) || 0, added: Number(v.added) || 0,
        cat: String(v.category_id || ''), ext: v.container_extension || 'mp4',
      } : {
        kind: 'series', id: String(v.series_id), name: String(v.name || '').trim(), poster: v.cover || '',
        rating: parseFloat(v.rating) || (parseFloat(v.rating_5based) * 2) || 0, added: Number(v.last_modified) || 0,
        cat: String(v.category_id || ''), year: String(v.releaseDate || v.release_date || '').slice(0, 4),
        backdrop: Array.isArray(v.backdrop_path) ? v.backdrop_path[0] : v.backdrop_path, plot: v.plot || '', genre: v.genre || '',
      }).filter((v) => v.id && v.name && allowed(v.name));
      const blocked = new Set(cats.filter((c) => !allowed(c.category_name)).map((c) => String(c.category_id)));
      for (let i = list.length - 1; i >= 0; i--) if (blocked.has(list[i].cat)) list.splice(i, 1);
      const byCat = new Map();
      list.forEach((v) => { if (!byCat.has(v.cat)) byCat.set(v.cat, []); byCat.get(v.cat).push(v); });
      const outCats = cats.filter((c) => byCat.has(String(c.category_id)))
        .map((c) => ({ id: String(c.category_id), name: String(c.category_name || '').trim(), count: byCat.get(String(c.category_id)).length }));
      A.vod[kind] = { list, byId: new Map(list.map((v) => [v.id, v])), byCat, cats: outCats };
      if (A.screen === 'home') SCREENS.home.enter(true);
      return A.vod[kind];
    } catch (e) {
      if (!quiet) toast('Could not load ' + kind + ': ' + (e.message || e));
      return null;
    } finally {
      A.vodLoading[kind] = null;
      if (!quiet) loading(false);
    }
  })();
  A.vodLoading[kind] = p;
  return p;
}
let vodKind = 'movies';
const favKind = (k) => (k === 'movies' ? 'movie' : 'series');
function vodItems(kind, cat) {
  const v = A.vod[kind];
  if (!v) return [];
  let l;
  if (cat === '__all') l = v.list.slice();
  else if (cat === '__fav') l = A.favs[favKind(kind)].map((id) => v.byId.get(id)).filter(Boolean);
  else if (cat === '__cw') l = continueItems().filter((c) => c.kind === favKind(kind)).map((c) => v.byId.get(c.id)).filter(Boolean);
  else l = (v.byCat.get(cat) || []).slice();
  if (cat === '__fav' || cat === '__cw') return l;
  const s = A.vodSort[kind];
  if (s === 'az') l.sort((a, b) => a.name.localeCompare(b.name));
  else if (s === 'rating') l.sort((a, b) => b.rating - a.rating);
  else l.sort((a, b) => b.added - a.added);
  return l;
}
function vodCatItems(kind) {
  const v = A.vod[kind];
  return [
    { id: '__all', name: kind === 'movies' ? 'All movies' : 'All series', ico: '≡', count: v ? v.list.length : 0 },
    { id: '__fav', name: 'Favourites', ico: '★', special: true },
    { id: '__cw', name: 'Continue watching', ico: '▶', special: true },
  ].concat(v ? v.cats : []);
}
function posterCard(c, v) {
  const p = el('div', 'poster');
  p.appendChild(el('div', 'ph', v.name));
  const i = img(v.poster, v.name);
  if (i) p.appendChild(i);
  if (v.rating) p.appendChild(el('span', 'rate', '★ ' + (Math.round(v.rating * 10) / 10)));
  if (isFav(v.kind, v.id)) p.appendChild(el('span', 'fav', '♥'));
  const r = v.kind === 'movie' ? resumeOf('m:' + v.id) : null;
  if (r && r.d) { const g = el('div', 'prog'), x = el('i'); x.style.width = Math.min(100, 100 * r.p / r.d) + '%'; g.appendChild(x); p.appendChild(g); }
  c.appendChild(p);
  c.appendChild(el('div', 'ct', v.name));
}
function vodCtx(v) {
  const f = isFav(v.kind, v.id);
  const items = [
    { label: 'Open', primary: true, fn: () => openDetail(v) },
    { label: f ? '★  Remove from favourites' : '☆  Add to favourites', fn: () => { toggleFav(v.kind, v.id, v.name); refreshAfterFav(); } },
  ];
  if (v.kind === 'movie') items.push({ label: 'Open in VLC / external player', fn: () => N.openExternal(A.xt.movieUrl(v.id, v.ext), v.name) });
  items.title = v.name;
  return items;
}
const vodCatList = new VList($('#vodCats'), {
  rowH: 4.4, cls: 'cat-row',
  render(r, c) {
    if (c.ico) r.appendChild(el('span', 'ico', c.ico));
    r.appendChild(el('span', 't', c.name));
    r.appendChild(el('span', 'n', String(c.special ? vodItems(vodKind, c.id).length : c.count)));
  },
  onFocus: debounce((c) => { if (A.screen === 'vod' && c) setVodCat(c.id); }, 220),
  onSelect(c) { setVodCat(c.id); vodGrid.enter(); },
});
const vodGrid = new VGrid($('#vodGrid'), {
  cols: 6, ratio: 1.68, emptyText: 'Nothing here yet.',
  render: posterCard,
  onSelect: (v) => openDetail(v),
  ctx: (v) => vodCtx(v),
});
function setVodCat(id, force) {
  if (!force && id === A.vodCat[vodKind] && vodGrid.items.length) return;
  A.vodCat[vodKind] = id;
  const c = vodCatItems(vodKind).find((x) => x.id === id);
  $('#vodCatName').textContent = c ? c.name : '';
  const l = vodItems(vodKind, id);
  $('#vodCount').textContent = l.length.toLocaleString() + (vodKind === 'movies' ? ' movies' : ' series');
  vodGrid.setItems(l, 0);
}
const SORTS = { added: 'Recently added', az: 'A – Z', rating: 'Top rated' };
$('#vodSort').tabIndex = -1;
$('#vodSort').addEventListener('click', () => {
  const keys = Object.keys(SORTS);
  A.vodSort[vodKind] = keys[(keys.indexOf(A.vodSort[vodKind]) + 1) % keys.length];
  $('#vodSort').textContent = 'Sort: ' + SORTS[A.vodSort[vodKind]];
  setVodCat(A.vodCat[vodKind], true);
});
async function enterVod(kind) {
  vodKind = kind;
  $('#vodKind').textContent = kind === 'movies' ? 'Movies' : 'Series';
  $('#vodSort').textContent = 'Sort: ' + SORTS[A.vodSort[kind]];
  if (!A.vod[kind]) {
    vodCatList.setItems([], 0); vodGrid.setItems([], 0);
    await ensureVod(kind);
    if (A.screen !== 'vod' || vodKind !== kind) return;
  }
  const cats = vodCatItems(kind);
  vodCatList.setItems(cats, Math.max(0, cats.findIndex((c) => c.id === A.vodCat[kind])));
  setVodCat(A.vodCat[kind], true);
  focusDefault();
}
SCREENS.movies = { enter() { show('vod'); A.screenNav = 'movies'; navActive('movies'); enterVod('movies'); }, focus: () => (vodGrid.items.length ? vodGrid.enter() : vodCatList.enter()) };
SCREENS.series = { enter() { show('vod'); A.screenNav = 'series'; navActive('series'); enterVod('series'); }, focus: () => (vodGrid.items.length ? vodGrid.enter() : vodCatList.enter()) };
SCREENS.vod = { focus: () => (vodGrid.items.length ? vodGrid.enter() : vodCatList.enter()) };
function navActive(name) { $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.go === name)); }

// ------------------------------------------------------------------ details
function openDetail(v) {
  A.detail = v;
  A.prev = { screen: A.screen, focus: cur, screenNav: A.screen === 'vod' ? vodKind : A.screen };
  show('detail');
  navActive(A.prev.screenNav);
  $('#dTitle').textContent = v.name;
  $('#dMeta').textContent = '';
  $('#dPlot').textContent = 'Loading…';
  $('#dCredits').textContent = '';
  $('#dSeasons').textContent = '';
  $('#dEpisodes').classList.add('hidden');
  $('#dBackdrop').style.backgroundImage = '';
  setPoster($('#dPoster'), v.poster);
  renderDetailButtons(v, null);
  const xt = A.xt;
  const p = v.kind === 'movie' ? xt.vodInfo(v.id) : xt.seriesInfo(v.id);
  p.then((d) => { if (A.screen === 'detail' && $('#dTitle').textContent === v.name) fillDetail(v, d || {}); })
    .catch(() => { $('#dPlot').textContent = 'No details available.'; });
}
function setPoster(box, url) {
  const u = safeUrl(url);
  box.style.backgroundImage = u ? `url("${u.replace(/["\\]/g, '')}")` : '';
}
function fillDetail(v, d) {
  const info = d.info || {};
  const meta = $('#dMeta');
  meta.textContent = '';
  const year = String(info.releasedate || info.releaseDate || info.release_date || v.year || '').slice(0, 4);
  const rating = parseFloat(info.rating) || v.rating;
  [year, info.genre, info.duration || (info.episode_run_time ? info.episode_run_time + ' min' : ''), info.country]
    .filter(Boolean).forEach((x) => meta.appendChild(el('span', '', String(x))));
  if (rating) meta.appendChild(el('span', 'star', '★ ' + Math.round(rating * 10) / 10));
  $('#dPlot').textContent = info.plot || info.description || 'No description.';
  const credits = [info.director ? 'Director: ' + info.director : '', (info.cast || info.actors) ? 'Cast: ' + (info.cast || info.actors) : ''].filter(Boolean);
  $('#dCredits').textContent = credits.join('   ·   ');
  const bd = Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : info.backdrop_path;
  const bu = safeUrl(bd);
  $('#dBackdrop').style.backgroundImage = bu ? `url("${bu.replace(/["\\]/g, '')}")` : '';
  if (!v.poster) setPoster($('#dPoster'), info.movie_image || info.cover_big || info.cover);
  if (v.kind === 'movie') {
    if (d.movie_data && d.movie_data.container_extension) v.ext = d.movie_data.container_extension;
    v.info = { year, genre: info.genre || '', backdrop: bu };
    renderDetailButtons(v, d);
  } else {
    v.seasons = d.seasons || [];
    v.info = { year, backdrop: bu };
    renderDetailButtons(v, d);
    renderSeasons(v);
  }
}
function renderDetailButtons(v, d) {
  const box = $('#dButtons');
  box.textContent = '';
  if (v.kind === 'movie') {
    const r = resumeOf('m:' + v.id);
    if (r) {
      box.appendChild(btn('btn primary', `▶  Resume ${fmtPos(r.p)}`, () => playMovie(v, r.p)));
      box.appendChild(btn('btn', '↺  Start over', () => playMovie(v, 0)));
    } else box.appendChild(btn('btn primary', '▶  Play', () => playMovie(v, 0)));
  } else if (d) {
    const last = lastEpisode(v);
    if (last) box.appendChild(btn('btn primary', `▶  ${last.resume ? 'Resume' : 'Play'} S${last.season} E${last.ep.episode_num}`, () => playEpisode(v, last.season, last.index)));
    else if (v.seasons && v.seasons.length) box.appendChild(btn('btn primary', '▶  Play S' + v.seasons[0].season + ' E1', () => playEpisode(v, v.seasons[0].season, 0)));
  }
  const fb = btn('btn', isFav(v.kind, v.id) ? '♥  Favourite' : '♡  Add to favourites', () => {
    const on = toggleFav(v.kind, v.id, v.name);
    fb.textContent = on ? '♥  Favourite' : '♡  Add to favourites';
  });
  box.appendChild(fb);
  if (v.kind === 'movie') box.appendChild(btn('btn', 'Open in VLC', () => N.openExternal(A.xt.movieUrl(v.id, v.ext), v.name)));
  if (A.screen === 'detail' && (!cur || !cur.isConnected || !$('#scr-detail').contains(cur))) focus(box.firstChild, true);
}
let epSeason = null, epSeries = null;
const epList = new VList($('#dEpisodes'), {
  rowH: 5.4, cls: 'ep-row',
  render(r, e) {
    r.appendChild(el('span', 'num', 'E' + (e.episode_num || '')));
    r.appendChild(el('span', 't', epTitle(e, epSeries)));
    const info = e.info || {};
    if (info.duration) r.appendChild(el('span', 'dur', String(info.duration).replace(/^00:/, '')));
    const res = A.ps.resume['e:' + e.id];
    if (res && res.d) {
      const b = el('div', 'bar'), i = el('i');
      i.style.width = (res.done ? 100 : Math.min(100, 100 * res.p / res.d)) + '%';
      b.appendChild(i); r.appendChild(b);
    }
  },
  onSelect(e, i) { playEpisode(epSeries, epSeason, i); },
});
function epTitle(e, s) {
  let t = String(e.title || '').trim();
  if (s) t = t.replace(new RegExp('^' + s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-:|]\\s*', 'i'), '');
  t = t.replace(/^S\d+\s*E\d+\s*[-:|]\s*/i, '');
  return t || 'Episode ' + e.episode_num;
}
function renderSeasons(v) {
  const box = $('#dSeasons');
  box.textContent = '';
  epSeries = v;
  if (!v.seasons.length) { $('#dPlot').textContent += '  (No episodes listed.)'; return; }
  const last = lastEpisode(v);
  const start = last ? last.season : v.seasons[0].season;
  v.seasons.forEach((s) => {
    const b = btn('season', 'Season ' + s.season + '  (' + s.episodes.length + ')', () => { selectSeason(v, s.season); epList.enter(); });
    b.dataset.season = s.season;
    b._onFocus = () => selectSeason(v, s.season);
    box.appendChild(b);
  });
  selectSeason(v, start, last ? last.index : 0);
}
function selectSeason(v, season, idx) {
  epSeason = season;
  $$('.season', $('#dSeasons')).forEach((b) => b.classList.toggle('sel', String(b.dataset.season) === String(season)));
  const s = v.seasons.find((x) => String(x.season) === String(season));
  $('#dEpisodes').classList.remove('hidden');
  epList.setItems(s ? s.episodes : [], idx || 0);
}
function lastEpisode(v) {
  const cw = A.cw['s:' + v.id];
  if (!cw || !v.seasons) return null;
  for (const s of v.seasons) {
    const i = s.episodes.findIndex((e) => String(e.id) === String(cw.ep));
    if (i >= 0) {
      const r = A.ps.resume['e:' + cw.ep];
      if (r && r.done && i + 1 < s.episodes.length) return { season: s.season, index: i + 1, ep: s.episodes[i + 1], resume: false };
      return { season: s.season, index: i, ep: s.episodes[i], resume: !!(r && !r.done) };
    }
  }
  return null;
}
function rememberCw(key, data) {
  A.cw[key] = Object.assign({}, data, { t: Date.now() });
  const keys = Object.keys(A.cw).sort((a, b) => A.cw[b].t - A.cw[a].t);
  keys.slice(60).forEach((k) => delete A.cw[k]);
  LS.set(cwKey(), A.cw);
}
function askResume(pos, play) {
  if (!pos || S.resume === 'always') return play(pos || 0);
  openDialog('Resume?', '', [
    { label: '▶  Resume from ' + fmtPos(pos), primary: true, fn: () => play(pos) },
    { label: '↺  Start from the beginning', fn: () => play(0) },
  ]);
}
function playMovie(v, start) {
  const url = A.xt.movieUrl(v.id, v.ext);
  rememberCw('m:' + v.id, { kind: 'movie', id: v.id, name: v.name, poster: v.poster, backdrop: v.info && v.info.backdrop });
  if (S.player === 'external') { N.openExternal(url, v.name); return; }
  N.play(JSON.stringify({
    type: 'movie', index: 0, start: start || 0, ...playerOpts(),
    items: [{ key: rk('m:' + v.id), id: v.id, title: v.name, sub: [v.info && v.info.year, v.info && v.info.genre].filter(Boolean).join('  ·  '), url }],
  }));
}
function playEpisode(v, season, i, startMs) {
  const s = v.seasons.find((x) => String(x.season) === String(season));
  if (!s) return;
  const e = s.episodes[i];
  const r = resumeOf('e:' + e.id);
  const run = (start) => {
    rememberCw('s:' + v.id, { kind: 'series', id: v.id, name: v.name, poster: v.poster, backdrop: v.info && v.info.backdrop, ep: String(e.id), season, label: `S${season} E${e.episode_num}` });
    const url = A.xt.episodeUrl(e.id, e.container_extension);
    if (S.player === 'external') { N.openExternal(url, v.name + ' ' + `S${season}E${e.episode_num}`); return; }
    N.play(JSON.stringify({
      type: 'series', index: i, start, ...playerOpts(),
      items: s.episodes.map((x) => ({
        key: rk('e:' + x.id), id: String(x.id), title: `S${pad2(season)}E${pad2(x.episode_num)}  ·  ${epTitle(x, v)}`, sub: v.name,
        url: A.xt.episodeUrl(x.id, x.container_extension),
      })),
    }));
  };
  if (startMs != null) run(startMs); else askResume(r ? r.p : 0, run);
}
SCREENS.detail = { focus() { const b = $('#dButtons .f'); if (b) { focus(b); return true; } return false; } };

// --------------------------------------------------------------------- home
function continueItems() {
  return Object.keys(A.cw).map((k) => A.cw[k]).sort((a, b) => b.t - a.t).map((c) => {
    const r = c.kind === 'movie' ? A.ps.resume['m:' + c.id] : A.ps.resume['e:' + c.ep];
    return Object.assign({}, c, { r });
  }).filter((c) => c.kind === 'series' || (c.r && !c.r.done));
}
function strip(title, tiles) {
  const row = el('div', 'hrow');
  row.appendChild(el('h3', '', title));
  const s = el('div', 'strip');
  tiles.forEach((t) => s.appendChild(t));
  row.appendChild(s);
  return row;
}
function chanTile(ch, list, i) {
  const t = el('div', 'f tile chan');
  t.tabIndex = -1;
  t.dataset.k = 'c' + ch.id + ':' + list.tag;
  t.appendChild(logoBox(ch.logo, ch.name));
  t.appendChild(el('div', 'ct', ch.name));
  const nn = nowNext(cachedEpg(ch.id));
  t.appendChild(el('div', 'cs', nn.now ? nn.now.title : A.live.catName.get(ch.cat) || ''));
  t.addEventListener('click', () => playLive(list, i));
  t._ctx = () => chanCtx(ch, list, i);
  return t;
}
function posterTile(v, tag) {
  const t = el('div', 'f tile poster-tile');
  t.tabIndex = -1;
  t.dataset.k = v.kind + v.id + ':' + tag;
  const p = el('div', 'poster');
  p.appendChild(el('div', 'ph', v.name));
  const i = img(v.poster, v.name);
  if (i) p.appendChild(i);
  t.appendChild(p);
  t.appendChild(el('div', 'ct', v.name));
  t.addEventListener('click', () => openDetail(v));
  t._ctx = () => vodCtx(v);
  return t;
}
function cwTile(c) {
  const t = el('div', 'f tile wide');
  t.tabIndex = -1;
  t.dataset.k = 'cw' + c.kind + c.id;
  const p = el('div', 'poster');
  const u = safeUrl(c.backdrop || c.poster);
  if (u) p.style.backgroundImage = `url("${u.replace(/["\\]/g, '')}")`;
  else p.appendChild(el('div', 'ph', c.name));
  if (c.r && c.r.d && !c.r.done) { const g = el('div', 'prog'), x = el('i'); x.style.width = Math.min(100, 100 * c.r.p / c.r.d) + '%'; g.appendChild(x); p.appendChild(g); }
  t.appendChild(p);
  t.appendChild(el('div', 'ct', c.name));
  const left = c.r && c.r.d && !c.r.done ? fmtDur(c.r.d - c.r.p) + ' left' : '';
  t.appendChild(el('div', 'cs', [c.kind === 'series' ? c.label : 'Film', left].filter(Boolean).join('  ·  ')));
  t.addEventListener('click', () => {
    const v = c.kind === 'movie'
      ? (A.vod.movies && A.vod.movies.byId.get(c.id)) || { kind: 'movie', id: c.id, name: c.name, poster: c.poster, ext: 'mp4' }
      : (A.vod.series && A.vod.series.byId.get(c.id)) || { kind: 'series', id: c.id, name: c.name, poster: c.poster };
    openDetail(v);
  });
  const items = [{ label: 'Open', primary: true, fn: () => t.click() }, { label: 'Remove from Continue watching', fn: () => {
    delete A.cw[(c.kind === 'movie' ? 'm:' : 's:') + c.id]; LS.set(cwKey(), A.cw); SCREENS.home.enter(true); focusDefault();
  } }];
  items.title = c.name;
  t._ctx = () => items;
  return t;
}
// Home: a big Apple TV-style feature at the top, rows of tiles underneath.
let heroItems = [], heroI = 0, heroTimer = null;
function stopHeroTimer() { if (heroTimer) { clearInterval(heroTimer); heroTimer = null; } }
function heroPick() {
  const out = [], seen = new Set();
  const add = (x) => { const k = x.kind + x.id; if (!seen.has(k) && x.bg) { seen.add(k); out.push(x); } };
  continueItems().slice(0, 3).forEach((c) => add({
    kind: c.kind, id: c.id, name: c.name, bg: c.backdrop || c.poster, isPoster: !c.backdrop, cw: c,
    kicker: 'Continue watching',
    meta: [c.kind === 'series' ? c.label : 'Film', c.r && c.r.d && !c.r.done ? fmtDur(c.r.d - c.r.p) + ' left' : ''].filter(Boolean).join('  ·  '),
  }));
  const sr = A.vod.series;
  if (sr) sr.list.filter((v) => v.backdrop).sort((a, b) => b.added - a.added).slice(0, 4).forEach((v) => add({
    kind: 'series', id: v.id, name: v.name, bg: v.backdrop, v, kicker: 'New series',
    meta: [v.year, v.genre, v.rating ? '★ ' + Math.round(v.rating * 10) / 10 : ''].filter(Boolean).join('  ·  '), desc: v.plot,
  }));
  const mv = A.vod.movies;
  if (mv) mv.list.slice().sort((a, b) => b.added - a.added).slice(0, 6).forEach((v) => {
    if (out.length < 6) add({ kind: 'movie', id: v.id, name: v.name, bg: v.poster, isPoster: true, v, kicker: 'New movie',
      meta: v.rating ? '★ ' + Math.round(v.rating * 10) / 10 : '' });
  });
  return out.slice(0, 6);
}
function vodFor(kind, id, c) {
  const store = kind === 'movie' ? A.vod.movies : A.vod.series;
  return (store && store.byId.get(String(id))) || { kind, id: String(id), name: c ? c.name : '', poster: c ? c.poster : '', ext: 'mp4' };
}
function paintHero(box, keepIndex) {
  box.textContent = '';
  const n = heroItems.length;
  const h = n ? heroItems[heroI % n] : null;
  const bg = el('div', 'bg' + (h && h.isPoster ? ' poster' : ''));
  const u = safeUrl(h ? h.bg : '');
  if (u) bg.style.backgroundImage = `url("${u.replace(/["\\]/g, '')}")`;
  box.appendChild(bg);
  box.appendChild(el('div', 'shade'));
  const info = el('div', 'info');
  const btns = el('div', 'btns');
  if (h) {
    info.appendChild(el('div', 'kicker', h.kicker));
    info.appendChild(el('h2', '', h.name));
    if (h.meta) info.appendChild(el('div', 'meta', h.meta));
    if (h.desc) info.appendChild(el('div', 'desc', h.desc));
    const v = vodFor(h.kind, h.id, h.cw);
    if (h.kind === 'movie') {
      const r = resumeOf('m:' + h.id);
      btns.appendChild(btn('btn primary', r ? '▶  Resume' : '▶  Play', () => (r ? playMovie(v, r.p) : askResume(0, (st) => playMovie(v, st)))));
      btns.appendChild(btn('btn', 'More info', () => openDetail(v)));
    } else {
      btns.appendChild(btn('btn primary', h.cw ? '▶  Continue' : '▶  Watch', () => openDetail(v)));
      btns.appendChild(btn('btn', isFav('series', h.id) ? '♥  Favourite' : '♡  Add to favourites', function () {
        const on = toggleFav('series', h.id, h.name); this.textContent = on ? '♥  Favourite' : '♡  Add to favourites';
      }));
    }
  } else {
    info.appendChild(el('div', 'kicker', A.prof && A.prof.id ? 'Hi ' + A.prof.name : 'Welcome'));
    info.appendChild(el('h2', '', 'Banana IPTV'));
    info.appendChild(el('div', 'desc', `${A.live.list.length.toLocaleString()} channels ready. Films and series you watch, and your favourites, will show up here.`));
    btns.appendChild(btn('btn primary', 'Live TV', () => go('live')));
    btns.appendChild(btn('btn', 'Movies', () => go('movies')));
    btns.appendChild(btn('btn', 'Football', () => go('football')));
  }
  info.appendChild(btns);
  box.appendChild(info);
  if (n > 1) {
    const d = el('div', 'dots');
    for (let i = 0; i < n; i++) d.appendChild(el('i', i === heroI % n ? 'on' : ''));
    box.appendChild(d);
  }
  if (keepIndex != null) { const b = $$('.btn', btns)[Math.min(keepIndex, btns.children.length - 1)]; if (b) focus(b, true); }
}
function heroWidget(box) {
  return {
    key(k) {
      const b = $$('.btn', box), i = b.indexOf(cur);
      if (k === 'left') { if (i > 0) focus(b[i - 1]); else slideHero(box, -1, 0); return true; }
      if (k === 'right') { if (i >= 0 && i < b.length - 1) focus(b[i + 1]); else slideHero(box, 1, 0); return true; }
      return false;
    },
    enter() { const b = $('.btn', box); if (b) focus(b); return !!b; },
    refresh() {},
  };
}
function slideHero(box, d, keep) {
  if (heroItems.length < 2) return;
  heroI = (heroI + d + heroItems.length) % heroItems.length;
  paintHero(box, keep);
}
function wideTile(c) {
  const t = cwTile(c);
  const u = safeUrl(c.backdrop);
  if (u) t.querySelector('.poster').classList.add('cover');
  return t;
}
SCREENS.home = {
  enter(keep) {
    if (!A.live) return;
    const k = keep && cur && cur.dataset && cur.dataset.k;
    const inHero = keep && cur && cur.closest && cur.closest('.hero2') ? $$('.btn', cur.closest('.hero2')).indexOf(cur) : null;
    const box = $('#homeRows');
    const top = box.scrollTop;
    box.textContent = '';
    heroItems = heroPick();
    if (heroI >= heroItems.length) heroI = 0;
    const hero = el('div', 'hero2');
    hero._w = heroWidget(hero);
    box.appendChild(hero);
    paintHero(hero, null);
    const cw = continueItems().slice(0, 15);
    if (cw.length) box.appendChild(strip('Up Next', cw.map(wideTile)));
    const rec = recentChannels().slice(0, 20); rec.tag = 'r';
    if (rec.length) box.appendChild(strip('Recently viewed channels', rec.map((c, i) => chanTile(c, rec, i))));
    const fav = favChannels().slice(0, 40); fav.tag = 'f';
    if (fav.length) box.appendChild(strip('Favourite channels', fav.map((c, i) => chanTile(c, fav, i))));
    ['movies', 'series'].forEach((kind) => {
      const v = A.vod[kind];
      if (!v) return;
      const favs = A.favs[favKind(kind)].map((id) => v.byId.get(id)).filter(Boolean).slice(0, 20);
      if (favs.length) box.appendChild(strip(kind === 'movies' ? 'Favourite movies' : 'Favourite series', favs.map((x) => posterTile(x, 'f'))));
      const latest = v.list.slice().sort((a, b) => b.added - a.added).slice(0, 20);
      if (latest.length) box.appendChild(strip(kind === 'movies' ? 'Recently added movies' : 'Recently added series', latest.map((x) => posterTile(x, 'n'))));
    });
    box.scrollTop = top;
    if (inHero != null && inHero >= 0) paintHero(hero, inHero);
    else if (k) { const e = $(`[data-k="${k}"]`, box); if (e) focus(e, true); else if (cur && !cur.isConnected) focusDefault(); }
    [...rec, ...fav].slice(0, 30).forEach((c) => { if (!A.epg.has(c.id)) getEpg(c.id); });
    stopHeroTimer();
    heroTimer = setInterval(() => {
      if (A.screen !== 'home' || dialogOpen()) return;
      if (cur && hero.contains(cur)) return; // don't move it while you're using it
      if (box.scrollTop > remPx() * 8) return; // scrolled away from it
      slideHero(hero, 1, null);
    }, 9000);
  },
  focus() { const b = $('.hero2 .btn'); if (b) { focus(b); return true; } const f = $$('.f', $('#homeRows')).find(visible); if (f) { focus(f); return true; } return false; },
};

// ------------------------------------------------------------------ profiles
const COLOURS = ['#FB923C', '#22D3EE', '#A78BFA', '#F472B6', '#34D399', '#FBBF24', '#60A5FA', '#F87171'];
let profManaging = false;
function paintAvatar() {
  const b = $('#avatarBtn');
  b.textContent = initials(A.prof ? A.prof.name : '?');
  b.style.background = A.prof ? A.prof.color : '#555';
}
function playlistFor(p) {
  return A.playlists.find((x) => p && p.playlist && x.id === p.playlist)
    || A.playlists.find((x) => x.id === A.activeId) || A.playlists[0];
}
function renderProfiles() {
  $('#profTitle').textContent = profManaging ? 'Manage profiles' : "Who's watching?";
  $('#profManage').textContent = profManaging ? 'Done' : 'Manage profiles';
  const box = $('#profList');
  box.textContent = '';
  A.profiles.forEach((p) => {
    const t = btn('prof' + (p === A.prof ? ' cur' : ''), null, () => (profManaging ? editProfile(p) : pickProfile(p)));
    const a = el('div', 'pa', initials(p.name));
    a.style.background = p.color;
    t.appendChild(a);
    t.appendChild(el('div', 'pn', p.name));
    if (profManaging) t.appendChild(el('div', 'pk', '✎ Edit'));
    else if (p.kids) t.appendChild(el('div', 'pk', 'Kids'));
    box.appendChild(t);
  });
  if (A.profiles.length < 6) {
    const t = btn('prof add', null, () => editProfile(null));
    t.appendChild(el('div', 'pa', '+'));
    t.appendChild(el('div', 'pn', 'Add profile'));
    box.appendChild(t);
  }
}
SCREENS.profiles = {
  enter() { renderProfiles(); },
  focus() { const e = $('.prof.cur', $('#profList')) || $('.prof', $('#profList')); if (e) focus(e); return true; },
};
$('#profManage').tabIndex = -1;
$('#profManage').addEventListener('click', () => { profManaging = !profManaging; renderProfiles(); SCREENS.profiles.focus(); });
function pickProfile(p) {
  const prevKids = A.prof && A.prof.kids;
  A.prof = p;
  saveProfiles();
  paintAvatar();
  const pl = playlistFor(p);
  if (!pl) { openSetup(null); return; }
  if (A.pl && A.pl.id === pl.id && !!prevKids === !!p.kids) {
    loadUserData(); // same playlist: just switch favourites and history
    go('home');
    return;
  }
  connect(pl); // different playlist, or kids filtering changes what's listed
}
// edit / add
let peTarget = null, peDraft = null;
function fillChoice(box, options, value, onPick) {
  box.textContent = '';
  options.forEach(([v, text, colour]) => {
    const b = btn((colour ? 'swatch' : '') + (v === value ? (colour ? ' on' : ' on') : ''), colour ? '' : text, () => {
      $$('button', box).forEach((x) => x.classList.toggle('on', x === b));
      onPick(v);
    });
    if (colour) { b.style.background = colour; b.setAttribute('aria-label', text); }
    box.appendChild(b);
  });
}
function editProfile(p) {
  peTarget = p;
  peDraft = Object.assign({ id: 'u' + Date.now().toString(36), name: '', color: COLOURS[A.profiles.length % COLOURS.length], playlist: '', kids: false }, p || {});
  $('#peTitle').textContent = p ? 'Edit ' + p.name : 'Add a profile';
  $('#peName').value = peDraft.name;
  fillChoice($('#peColours'), COLOURS.map((c) => [c, c, c]), peDraft.color, (v) => { peDraft.color = v; });
  fillChoice($('#pePlaylists'), [['', 'Last used']].concat(A.playlists.map((x) => [x.id, x.name])), peDraft.playlist, (v) => { peDraft.playlist = v; });
  fillChoice($('#peKids'), [[false, 'No'], [true, 'Yes, hide adult categories']], !!peDraft.kids, (v) => { peDraft.kids = v; });
  $('#peDelete').classList.toggle('hidden', !p || p.id === '');
  go('profedit');
}
SCREENS.profedit = { focus() { focus($('#peName').closest('.input-wrap')); return true; } };
$('#peName').closest('.input-wrap').tabIndex = -1;
['#peSave', '#peDelete', '#peCancel'].forEach((x) => { $(x).tabIndex = -1; });
$('#peCancel').addEventListener('click', () => go('profiles'));
$('#peSave').addEventListener('click', () => {
  const name = $('#peName').value.trim();
  if (!name) { toast('Give the profile a name'); return; }
  peDraft.name = name.slice(0, 20);
  if (peTarget) Object.assign(peTarget, peDraft);
  else A.profiles.push(peDraft);
  saveProfiles();
  paintAvatar();
  go('profiles');
});
$('#peDelete').addEventListener('click', () => {
  const p = peTarget;
  if (!p || p.id === '') return;
  openDialog('Delete ' + p.name + '?', 'Their favourites and Continue watching are removed from this iPhone.', [
    { label: 'Delete', primary: true, fn: () => {
      A.playlists.forEach((pl) => { LS.del('ay.fav.' + pl.id + '.' + p.id); LS.del('ay.cw.' + pl.id + '.' + p.id); });
      A.profiles = A.profiles.filter((x) => x !== p);
      if (A.prof === p) { A.prof = A.profiles[0]; if (A.pl) loadUserData(); }
      saveProfiles();
      paintAvatar();
      go('profiles');
    } },
    { label: 'Cancel' },
  ]);
});

// ------------------------------------------------------------------ football
// Finds football in the provider's own TV guide. Only sports channels are checked,
// and HD/FHD/SD copies of a channel share one guide lookup.
const COMPS = [
  ['Premier League', /\bpremier league\b|\bepl\b/i],
  ['Championship', /\bchampionship\b/i],
  ['League One / Two', /\bleague (one|two)\b|\bsky bet league\b/i],
  ['FA Cup', /\bfa cup\b/i],
  ['EFL Cup', /\b(efl|carabao) cup\b/i],
  ['Champions League', /\bchampions league\b|\bucl\b/i],
  ['Europa League', /\beuropa league\b/i],
  ['Conference League', /\bconference league\b/i],
  ['La Liga', /\bla ?liga\b/i],
  ['Serie A', /\bserie a\b/i],
  ['Bundesliga', /\bbundesliga\b/i],
  ['Ligue 1', /\bligue 1\b/i],
  ['Scottish', /\bscottish\b|\bspfl\b|\bscottish premiership\b/i],
  ['WSL', /\bwsl\b|women'?s super league/i],
  ['MLS', /\bmls\b|major league soccer/i],
  ['Internationals', /\bworld cup\b|\bnations league\b|\beuro 20\d\d\b|\binternational friendly\b|\bqualif(ier|ying)\b/i],
];
const FOOTBALL_WORDS = /\b(football|soccer|premier league|championship|fa cup|efl|carabao|champions league|europa league|conference league|la ?liga|serie a|bundesliga|ligue 1|eredivisie|primeira liga|spfl|scottish premiership|wsl|women'?s super league|mls|world cup|nations league|uefa|fifa)\b/i;
const NOT_FOOTBALL = /\b(nfl|american football|rugby|gaelic|gaa|hurling|afl|aussie rules|australian football|redzone|super bowl|ncaa|college football|fantasy football|madden)\b/i;
const NOT_A_MATCH = /\b(highlights?|replay|review|classics?|best of|goals|preview|magazine|legends|catch-?up|news|weekly|countdown|debate|podcast|stories|documentary|rewind|reloaded|greatest|top 10|hall of fame|the 100|100 club|soccer am|supplement|quiz|breakfast|lunchtime|sports desk|transfer)\b/i;
const VS = /\s(v|vs\.?)\s/i;
const LIVE_WORD = /\blive\b/i;
const SPORTY = /\b(sports?|football|soccer|premier|league|liga|serie|bundesliga|uefa|epl|tnt|bt|sky ?sports|dazn|bein|viaplay|eurosport|espn|supersport|ppv|events?|match|cup|laliga|premier ?sports|prime|stadium)\b/i;
const qualityRank = (n) => (/\b(uhd|4k)\b/i.test(n) ? 0 : /\bfhd\b/i.test(n) ? 1 : /\bhd\b/i.test(n) ? 2 : /\bsd\b/i.test(n) ? 4 : 3);
const byQuality = (a, b) => qualityRank(a.name) - qualityRank(b.name) || a.name.localeCompare(b.name);
const baseName = (n) => n.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\b(uhd|4k|fhd|hd|sd|hevc|h\.?265|50 ?fps|60 ?fps|backup|raw|vip|\+1)\b/g, ' ')
  .replace(/^[a-z]{2,3}\s*[|:-]\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const FB = { groups: null, progs: new Map(), done: 0, scanning: false, at: 0, comp: 'All', token: 0 };

function fbGroups() {
  const groups = new Map();
  const pins = new Set(fbPinned());
  // Your own football channels first, so they're never cut off by the limit below.
  const ordered = A.live.list.filter((c) => pins.has(c.id)).concat(A.live.list.filter((c) => !pins.has(c.id)));
  ordered.forEach((c) => {
    const text = c.name + ' ' + (A.live.catName.get(c.cat) || '');
    if (!pins.has(c.id) && (!SPORTY.test(text) || NOT_FOOTBALL.test(text))) return;
    const k = baseName(c.name);
    if (!k) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  });
  const out = [...groups.values()].map((chans) => chans.sort(byQuality));
  return out.slice(0, 320); // keep the scan quick
}
function fbScan() {
  if (FB.scanning) return;
  if (FB.groups && Date.now() - FB.at < 20 * 60000) return;
  FB.scanning = true;
  FB.at = Date.now();
  FB.groups = fbGroups();
  FB.progs = new Map();
  FB.done = 0;
  const token = ++FB.token, xt = A.xt;
  let next = 0, active = 0;
  const repaint = debounce(() => { if (A.screen === 'football') renderFootball(true); }, 700);
  const pump = () => {
    if (token !== FB.token || xt !== A.xt) return;
    while (active < 4 && next < FB.groups.length) {
      const g = FB.groups[next++];
      active++;
      xt.shortEpg(g[0].id, 12).catch(() => []).then((list) => {
        active--; FB.done++;
        if (token !== FB.token) return;
        if (list && list.length) FB.progs.set(g, list);
        if (FB.done % 15 === 0 || FB.done === FB.groups.length) repaint();
        if (FB.done === FB.groups.length) { FB.scanning = false; repaint(); }
        pump();
      });
    }
    if (!FB.groups.length) { FB.scanning = false; repaint(); }
  };
  pump();
}
function matchLabel(p) {
  let t = p.title.replace(/^\s*live\s*[:\-–]?\s*/i, '').trim();
  if (!VS.test(t)) {
    const m = /([A-Z][\w.'&-]*(?:\s[A-Z][\w.'&-]*){0,3})\s+(?:v|vs\.?)\s+([A-Z][\w.'&-]*(?:\s[A-Z][\w.'&-]*){0,3})/.exec(p.desc || '');
    if (m) t = `${t}: ${m[1]} v ${m[2]}`;
  }
  return t;
}
function findMatches() {
  const now = Date.now();
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const until = day0.getTime() + 2 * 86400000;
  const found = new Map();
  const pins = new Set(fbPinned());
  FB.progs.forEach((progs, chans) => {
    const pinned = chans.some((c) => pins.has(c.id)); // your channels: no need for the word "football"
    progs.forEach((p) => {
      if (p.stop <= now || p.start >= until) return;
      const text = `${p.title} ${p.desc || ''}`;
      if ((!pinned && !FOOTBALL_WORDS.test(text)) || NOT_FOOTBALL.test(text) || NOT_A_MATCH.test(p.title)) return;
      const compEntry = COMPS.find(([, re]) => re.test(text));
      const compInTitle = compEntry && compEntry[1].test(p.title);
      if (!VS.test(p.title) && !VS.test(p.desc || '') && !compInTitle && !LIVE_WORD.test(p.title)) return;
      const key = `${p.title.toLowerCase().replace(/[^a-z0-9]+/g, '')}|${p.start}`;
      let m = found.get(key);
      if (!m) {
        m = { p, comp: compEntry ? compEntry[0] : 'Football', isLive: LIVE_WORD.test(p.title) || /\b(live|kick-?off)\b/i.test(p.desc || ''), label: matchLabel(p), channels: [] };
        found.set(key, m);
      }
      chans.forEach((c) => { if (m.channels.indexOf(c) < 0) m.channels.push(c); });
    });
  });
  const list = [...found.values()];
  list.forEach((m) => m.channels.sort(byQuality));
  return list.sort((a, b) => a.p.start - b.p.start || a.label.localeCompare(b.label));
}
function eventChannels() {
  return A.live.list.filter((c) => {
    const text = c.name + ' ' + (A.live.catName.get(c.cat) || '');
    return /\s(v|vs\.?)\s/i.test(c.name) && /\d{1,2}[:.]\d{2}/.test(c.name) && !NOT_FOOTBALL.test(text)
      && /foot|soccer|uefa|epl|premier|league|cup|ppv|event|match|liga|serie|bundes|sport/i.test(text);
  });
}
const dayLabel = (ms) => {
  const d = new Date(ms), t = new Date();
  t.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'short' });
};
function matchTile(m, now) {
  const t = el('div', 'f tile match');
  t.tabIndex = -1;
  t.dataset.k = 'm' + m.p.start + m.label;
  const top = el('div', 'm-top');
  top.appendChild(el('span', '', m.comp));
  if (m.p.start <= now) top.appendChild(el('span', 'm-live', (m.isLive ? 'LIVE' : 'ON NOW') + ' · ' + Math.max(0, Math.round((m.p.stop - now) / 60000)) + 'm left'));
  else top.appendChild(el('span', '', (dayLabel(m.p.start) === 'Today' ? '' : dayLabel(m.p.start) + ' ') + hhmm(m.p.start)));
  t.appendChild(top);
  t.appendChild(el('div', 'm-title', m.label));
  t.appendChild(el('div', 'm-ch', m.channels[0].name + (m.channels.length > 1 ? `  +${m.channels.length - 1} more` : '')));
  const list = m.channels.slice();
  t.addEventListener('click', () => playLive(list, 0));
  t._ctx = () => {
    const items = list.slice(0, 12).map((c, i) => ({ label: (i === 0 ? '▶  ' : '') + 'Watch on ' + c.name, primary: i === 0, fn: () => playLive(list, i) }));
    items.title = m.label;
    items.text = 'Up and down in the player flicks between these channels.';
    return items;
  };
  return t;
}
function renderFootball(keep) {
  const k = keep && cur && cur.dataset && cur.dataset.k;
  const box = $('#fbRows');
  const top = box.scrollTop;
  box.textContent = '';
  const total = FB.groups ? FB.groups.length : 0;
  $('#fbStatus').textContent = FB.scanning ? `Checking the guide for ${total} sports channels… ${FB.done}/${total}`
    : total ? `From your provider's TV guide · ${total} sports channels checked · updated ${hhmm(FB.at)}` : '';
  const now = Date.now();
  let matches = findMatches();
  const comps = [...new Set(matches.map((m) => m.comp))];
  const chips = el('div', 'chips strip');
  ['All'].concat(COMPS.map((c) => c[0]).filter((n) => comps.indexOf(n) >= 0), comps.indexOf('Football') >= 0 ? ['Football'] : []).forEach((n) => {
    const b = btn('chip' + (FB.comp === n ? ' on' : ''), n, () => { FB.comp = n; renderFootball(false); focus($('.chip.on', $('#fbRows'))); });
    b.dataset.k = 'chip' + n;
    chips.appendChild(b);
  });
  box.appendChild(chips);
  if (FB.comp !== 'All') matches = matches.filter((m) => m.comp === FB.comp);
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const tomorrow = day0.getTime() + 86400000;
  const onNow = matches.filter((m) => m.p.start <= now);
  const later = matches.filter((m) => m.p.start > now && m.p.start < tomorrow);
  const tmrw = matches.filter((m) => m.p.start >= tomorrow);
  if (onNow.length) box.appendChild(strip(`On now (${onNow.length})`, onNow.map((m) => matchTile(m, now))));
  if (later.length) box.appendChild(strip(`Later today (${later.length})`, later.map((m) => matchTile(m, now))));
  if (tmrw.length) box.appendChild(strip(`Tomorrow (${tmrw.length})`, tmrw.map((m) => matchTile(m, now))));
  const pins = new Set(fbPinned());
  const yours = A.live.list.filter((c) => pins.has(c.id)); yours.tag = 'fb';
  if (yours.length && FB.comp === 'All') {
    box.appendChild(strip(`Your football channels (${yours.length})`, yours.map((c, i) => chanTile(c, yours, i))));
    yours.forEach((c) => { if (!A.epg.has(c.id)) getEpg(c.id); });
  }
  const ev = eventChannels().sort(byQuality).slice(0, 40); ev.tag = 'ev';
  if (ev.length && FB.comp === 'All') box.appendChild(strip(`Event channels (${ev.length})`, ev.map((c, i) => chanTile(c, ev, i))));
  if (!onNow.length && !later.length && !tmrw.length && !FB.scanning) {
    box.appendChild(el('div', 'home-empty muted', FB.comp === 'All'
      ? 'No football found in your provider\'s TV guide for today or tomorrow. Matches only show here if the provider lists them in its guide. Missing a channel? In Live TV, touch and hold it and choose "Add to Football".'
      : 'Nothing for ' + FB.comp + ' today or tomorrow.'));
  }
  box.scrollTop = top;
  const firstMatch = $('.tile.match', box);
  if (FB.autoFocus && firstMatch && A.screen === 'football') { FB.autoFocus = false; box.scrollTop = 0; focus(firstMatch, true); }
  else if (k) { const e = $(`[data-k="${CSS && CSS.escape ? CSS.escape(k) : k}"]`, box); if (e) focus(e, true); else if (cur && !cur.isConnected) focusDefault(); }
}
SCREENS.football = {
  enter() { if (!A.live) return; FB.autoFocus = true; fbScan(); renderFootball(false); },
  focus() { const f = $$('.tile', $('#fbRows')).find(visible) || $('.chip', $('#fbRows')); if (f) { focus(f); return true; } return false; },
};

// ------------------------------------------------------------------- search
const runSearch = debounce(async (moveFocus) => {
  const q = $('#searchInput').value.trim();
  const box = $('#searchRows');
  box.textContent = '';
  if (q.length < 2) return;
  const ch = search(A.live.list, q, { limit: 30 }); ch.tag = 's';
  if (ch.length) box.appendChild(strip(`Channels (${ch.length})`, ch.map((c, i) => chanTile(c, ch, i))));
  for (const kind of ['movies', 'series']) {
    const v = A.vod[kind] || (await ensureVod(kind, true));
    if (!v || $('#searchInput').value.trim() !== q) continue;
    const r = search(v.list, q, { limit: 30 });
    if (r.length) box.appendChild(strip(`${kind === 'movies' ? 'Movies' : 'Series'} (${r.length})`, r.map((x) => posterTile(x, 's'))));
  }
  if (!box.children.length) box.appendChild(el('div', 'home-empty muted', `Nothing found for “${q}”.`));
  if (moveFocus === true) { const f = $$('.f', box).find(visible); if (f) focus(f); }
}, 350);
$('#searchInput').addEventListener('input', () => runSearch());
SCREENS.search = {
  enter() { if (A.live) { ensureVod('movies', true); ensureVod('series', true); } },
  focus() { focus($('#searchWrap')); return true; },
};

// ----------------------------------------------------------------- settings
let setTab = 'playlists';
$$('.set-tab').forEach((b) => {
  b.tabIndex = -1;
  b.addEventListener('click', () => { renderPane(b.dataset.pane); const f = $$('.f', $('#setPane'))[0]; if (f) focus(f); });
  b._onFocus = () => renderPane(b.dataset.pane);
});
function seg(label, options, value, onPick) {
  const row = el('div', 'opt');
  row.appendChild(el('span', '', label));
  const s = el('div', 'seg');
  options.forEach(([v, text]) => {
    const b = btn(v === value ? 'on' : '', text, () => {
      $$('button', s).forEach((x) => x.classList.toggle('on', x === b));
      onPick(v);
    });
    s.appendChild(b);
  });
  row.appendChild(s);
  return row;
}
function renderPane(name) {
  if (setTab === name && $('#setPane').children.length && name !== 'playlists') return;
  setTab = name;
  $$('.set-tab').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  const p = $('#setPane');
  p.textContent = '';
  p.scrollTop = 0;
  if (name === 'playlists') {
    p.appendChild(el('h2', '', 'Playlists'));
    A.playlists.forEach((pl) => {
      const r = el('div', 'pl-row');
      const t = el('div', 'pl-txt');
      t.appendChild(el('div', 'pl-name', pl.name));
      t.appendChild(el('div', 'pl-sub', pl.server.replace(/^https?:\/\//, '') + '  ·  ' + pl.username));
      r.appendChild(t);
      if (A.pl && A.pl.id === pl.id) r.appendChild(el('span', 'badge', 'IN USE'));
      else r.appendChild(btn('btn', 'Use', () => connect(pl)));
      r.appendChild(btn('btn', 'Edit', () => openSetup(pl)));
      r.appendChild(btn('btn', 'Remove', () => openDialog('Remove ' + pl.name + '?', 'This deletes the saved login from this iPhone.', [
        { label: 'Remove', primary: true, fn: () => removePlaylist(pl) }, { label: 'Cancel' }])));
      p.appendChild(r);
    });
    p.appendChild(btn('btn primary', '＋  Add playlist', () => openSetup(null)));
    if (A.info && A.info.user_info) {
      const u = A.info.user_info, kv = el('div', 'kv');
      const exp = Number(u.exp_date) ? new Date(Number(u.exp_date) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never';
      [['Status', u.status || ''], ['Expires', exp], ['Connections', `${u.active_cons || 0} in use of ${u.max_connections || '?'}`]]
        .forEach(([a, b]) => { kv.appendChild(el('b', '', a)); kv.appendChild(el('span', '', String(b))); });
      p.appendChild(el('h2', '', 'This account'));
      p.appendChild(kv);
    }
  } else if (name === 'playback') {
    p.appendChild(el('h2', '', 'Playback'));
    p.appendChild(seg('Player', [['builtin', 'Built-in'], ['external', 'VLC / external']], S.player, (v) => { S.player = v; saveSettings(); }));
    p.appendChild(seg('Live stream format', [['auto', 'Automatic'], ['hls', 'HLS (.m3u8)'], ['ts', 'MPEG-TS (.ts)']], S.liveFormat, (v) => { S.liveFormat = v; saveSettings(); }));
    p.appendChild(seg('Picture', [[0, 'Fit'], [1, 'Fill'], [2, 'Zoom']], S.aspect, (v) => { S.aspect = v; saveSettings(); }));
    p.appendChild(seg('Buffer', [[1500, 'Low (faster start)'], [3000, 'Normal'], [8000, 'High (fewer pauses)']], S.buffer, (v) => { S.buffer = v; saveSettings(); }));
    p.appendChild(seg('Subtitles', [['off', 'Off unless I choose'], ['on', 'On when available']], S.subs, (v) => { S.subs = v; saveSettings(); }));
    p.appendChild(seg('Films and episodes', [['ask', 'Ask to resume'], ['always', 'Always resume']], S.resume, (v) => { S.resume = v; saveSettings(); }));
    const ext = N.externalPlayer();
    p.appendChild(el('div', 'note', (ext ? 'External player found: ' + ext + '. ' : 'No external player installed. Get VLC from the App Store if you want one. ') +
      'Automatic tries HLS first and switches to MPEG-TS by itself if a channel won\'t start. In the player, tap the screen for subtitles, audio tracks and Open in VLC. If VLC is open in the background it uses up a connection: press Back until it closes.'));
  } else if (name === 'appearance') {
    p.appendChild(el('h2', '', 'Appearance'));
    const row = el('div', 'opt');
    row.appendChild(el('span', '', 'Highlight colour'));
    const s = el('div', 'seg');
    ['#FB923C', '#22D3EE', '#A78BFA', '#F472B6', '#34D399', '#FBBF24'].forEach((c) => {
      const b = btn('swatch' + (S.accent === c ? ' on' : ''), '', () => {
        S.accent = c; saveSettings(); applyAccent();
        $$('.swatch', s).forEach((x) => x.classList.toggle('on', x === b));
      });
      b.style.background = c;
      b.setAttribute('aria-label', c);
      s.appendChild(b);
    });
    row.appendChild(s);
    p.appendChild(row);
    p.appendChild(seg('Ask who\'s watching when the app opens', [[true, 'Yes'], [false, 'No']], S.askProfile !== false, (v) => { S.askProfile = v; saveSettings(); }));
    p.appendChild(el('div', 'note', 'Add, edit or switch profiles with the round profile button at the top right.'));
  } else if (name === 'history') {
    p.appendChild(el('h2', '', 'History'));
    p.appendChild(btn('btn', 'Clear recently viewed channels', () => { N.clearPlayerState('recentLive'); readPlayerState(); A.ps.recentLive = []; toast('Cleared'); }));
    p.appendChild(btn('btn', 'Clear Continue watching', () => { A.cw = {}; LS.set(cwKey(), A.cw); N.clearPlayerState('resume'); readPlayerState(); toast('Cleared'); }));
    p.appendChild(btn('btn', 'Clear favourites for this playlist', () => openDialog('Clear all favourites?', '', [
      { label: 'Clear', primary: true, fn: () => { A.favs = { live: [], movie: [], series: [] }; LS.set(favKey(), A.favs); toast('Cleared'); } }, { label: 'Cancel' }])));
  } else if (name === 'about') {
    p.appendChild(el('h2', '', 'Banana IPTV'));
    const kv = el('div', 'kv');
    [['Version', VERSION + ' (iPhone)'], ['App build', N.version()], ['Playlists', String(A.playlists.length)]]
      .forEach(([a, b]) => { kv.appendChild(el('b', '', a)); kv.appendChild(el('span', '', b)); });
    p.appendChild(kv);
    p.appendChild(el('div', 'note', 'Passwords are encrypted with a key held in the iPhone\'s Keychain and never shown again. ' +
      'Watch history stores only stream numbers and positions. The app talks only to your IPTV provider.'));
    p.appendChild(btn('btn', 'Exit app', () => N.exitApp()));
    // Crashes, freezes and interface errors, as recorded on this iPhone (never sent anywhere).
    const diag = (N.diagnostics && N.diagnostics()) || '';
    p.appendChild(el('h2', '', 'Diagnostics'));
    const pre = el('pre', 'diag', diag ? diag.slice(-1800) : 'No crashes or freezes recorded.');
    p.appendChild(pre);
    if (diag) p.appendChild(btn('btn', 'Clear diagnostics', () => { N.clearDiagnostics(); pre.textContent = 'Cleared.'; }));
  }
}
SCREENS.settings = {
  enter() { setTab = ''; renderPane('playlists'); },
  focus() { focus($('.set-tab[data-pane="playlists"]')); return true; },
};
function removePlaylist(pl) {
  N.secretDel('pl_' + pl.id);
  LS.del('ay.fav.' + pl.id); LS.del('ay.cw.' + pl.id);
  A.playlists = A.playlists.filter((x) => x.id !== pl.id);
  if (A.pl && A.pl.id === pl.id) {
    A.pl = null; A.xt = null; A.live = null; A.activeId = '';
    savePlaylists();
    if (A.playlists.length) connect(A.playlists[0]); else go('setup');
  } else { savePlaylists(); renderPane('playlists'); focusDefault(); }
}

// --------------------------------------------------------- add / edit login
let editing = null;
['#fName', '#fServer', '#fUser', '#fPass'].forEach((s) => { $(s).closest('.input-wrap').tabIndex = -1; });
$('#searchWrap').tabIndex = -1;
function openSetup(pl, error) {
  editing = pl;
  $('#setupTitle').textContent = pl ? 'Edit ' + pl.name : (A.playlists.length ? 'Add a playlist' : 'Add your IPTV login');
  $('#fName').value = pl ? pl.name : '';
  $('#fServer').value = pl ? pl.server : '';
  $('#fUser').value = pl ? pl.username : '';
  $('#fPass').value = '';
  $('#fPass').placeholder = pl ? 'Leave blank to keep the saved password' : '';
  $('#fError').textContent = error || '';
  $('#fCancel').classList.toggle('hidden', !A.pl);
  go('setup');
}
SCREENS.setup = { focus() { focus($(editing ? '#fPass' : '#fName').closest('.input-wrap')); return true; } };
$('#fCancel').tabIndex = -1;
$('#fSave').tabIndex = -1;
$('#fCancel').addEventListener('click', () => go('settings'));
$('#fSave').addEventListener('click', async () => {
  let server = $('#fServer').value.trim(), user = $('#fUser').value.trim(), pass = $('#fPass').value;
  const gp = fromGetPhp(server);
  if (gp) { server = gp.server; user = user || gp.username; pass = pass || gp.password; }
  if (editing && !pass) pass = N.secretGet('pl_' + editing.id) || '';
  const err = (m) => { $('#fError').textContent = m; };
  if (!server || !user || !pass) return err('Please fill in the server, username and password.');
  loading(true, 'Checking your login…');
  const xt = new Xtream({ server, username: user, password: pass }, netFetch);
  try {
    await xt.login();
  } catch (e) {
    loading(false);
    return err('Could not log in: ' + (e && e.message ? e.message : e));
  }
  const id = editing ? editing.id : 'p' + Date.now().toString(36);
  if (!N.secretSet('pl_' + id, pass)) { loading(false); return err('Could not save the password securely on this device.'); }
  const pl = { id, name: $('#fName').value.trim() || new URL(xt.server).hostname, server: xt.server, username: user };
  const i = A.playlists.findIndex((x) => x.id === id);
  if (i >= 0) A.playlists[i] = pl; else A.playlists.push(pl);
  savePlaylists();
  $('#fPass').value = '';
  loading(false);
  connect(pl);
});

// ---------------------------------------------------------------- lifecycle
window.bananaResume = () => {
  if (!A.pl) return;
  readPlayerState();
  if (A.screen === 'home') SCREENS.home.enter(true);
  else if (A.screen === 'live') liveList.refresh();
  else if (A.screen === 'vod') vodGrid.refresh();
  else if (A.screen === 'detail' && A.detail) {
    const v = A.detail;
    if (v.kind === 'series' && v.seasons) { epList.refresh(); renderDetailButtons(v, {}); }
    else if (v.kind === 'movie') renderDetailButtons(v, null);
  }
};
function tickClock() { const d = new Date(); $('#clock').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
setInterval(tickClock, 15000);
tickClock();
window.addEventListener('resize', debounce(() => {
  [liveCatList, liveList, vodCatList, epList].forEach((l) => l.render());
  vodGrid.render();
}, 200));

(function start() {
  applyAccent();
  paintAvatar();
  if (!A.playlists.length) { openSetup(null); hideSplash(); return; }
  if (A.profiles.length > 1 && S.askProfile !== false) { go('profiles'); hideSplash(); return; }
  connect(playlistFor(A.prof));
})();

window.__banana = { A, S, go, focus, get cur() { return cur; }, liveList, liveCatList, vodGrid, epList, b64 };

// ------------------------------------------------------------- iPhone: touch
// The interface was designed for a TV remote. On iPhone, taps already work
// (everything is a click handler); this adds swipe scrolling for the long lists,
// tap-and-hold for the ☰ options menu, a back button and edge-swipe back.
const TOUCH = (N.platform && N.platform() === 'ios') || /[?&]touch\b/.test(location.search);
if (TOUCH) (function touchUi() {
  document.documentElement.classList.add('touch');
  const back = el('button', 'touch-back', '‹');
  back.setAttribute('aria-label', 'Back');
  document.body.appendChild(back);
  function touchBack() {
    if (dialogOpen()) { closeDialog(); return; }
    const ae = document.activeElement;
    if (ae && ae.tagName === 'INPUT') { ae.blur(); return; }
    if (['detail', 'setup', 'profedit', 'profiles'].indexOf(A.screen) >= 0) { goBack(); return; }
    if (A.pl && A.screen !== 'home') go('home');
  }
  back.addEventListener('click', (e) => { e.stopPropagation(); touchBack(); });
  setInterval(() => {
    const show = dialogOpen() || (A.screen !== 'home' && !(A.screen === 'setup' && !A.pl) && !(A.screen === 'profiles' && !A.pl));
    back.classList.toggle('hidden', !show);
  }, 250);

  let t = null, suppressUntil = 0, lpTimer = 0;
  const step = (w) => (w instanceof VList ? w.rowPx() : w.dims().ch);
  function moveBy(w, rows) {
    if (!rows) return;
    if (w instanceof VList) { w.move(rows); return; }
    const cols = w.o.cols, n = w.items.length;
    if (!n) return;
    w.go(Math.max(0, Math.min(n - 1, w.i + rows * cols)));
  }
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { t = null; return; }
    const p = e.touches[0], host = e.target.closest && e.target.closest('.vlist, .vgrid');
    t = { x: p.clientX, y: p.clientY, lastY: p.clientY, w: host && host._w, moved: false, at: Date.now(), vy: 0, lt: Date.now(),
      target: e.target.closest && e.target.closest('.f'), edge: p.clientX < 24 };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {   // tap and hold = the ☰ menu
      if (!t || t.moved || !t.target) return;
      suppressUntil = Date.now() + 700;
      focus(t.target, true);
      contextMenu();
    }, 550);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!t) return;
    const p = e.touches[0], dx = p.clientX - t.x, dy = p.clientY - t.y;
    if (!t.moved && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) { t.moved = true; clearTimeout(lpTimer); }
    if (!t.w || !t.moved) return;
    e.preventDefault();   // the virtual lists scroll by hand
    const s = step(t.w), rows = Math.trunc((t.lastY - p.clientY) / s);
    if (rows) {
      const now = Date.now();
      t.vy = (t.lastY - p.clientY) / Math.max(1, now - t.lt); t.lt = now;
      t.lastY -= rows * s;
      moveBy(t.w, rows);
    }
  }, { passive: false });
  document.addEventListener('touchend', (e) => {
    clearTimeout(lpTimer);
    if (!t) return;
    const p = e.changedTouches[0];
    if (t.moved) suppressUntil = Date.now() + 350;
    if (t.edge && p.clientX - t.x > 70 && Math.abs(p.clientY - t.y) < 60) touchBack();   // swipe in from the left edge
    else if (t.w && t.moved && Math.abs(t.vy) > 0.6 && Date.now() - t.lt < 120) {        // flick: keep going a little
      let left = Math.min(25, Math.round(Math.abs(t.vy) * 10)), dir = t.vy > 0 ? 1 : -1, w = t.w;
      (function glide() { if (left-- <= 0) return; moveBy(w, dir); setTimeout(glide, 16 + (25 - left) * 2); })();
    }
    t = null;
  }, { passive: true });
  // A tap moves the highlight to what was tapped; a drag or hold isn't a tap.
  document.addEventListener('click', (e) => {
    if (Date.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); return; }
    const f = e.target.closest && e.target.closest('.f');
    if (f && f !== cur && !f.classList.contains('vrow') && !f.classList.contains('card')) focus(f, true);
  }, true);
})();
