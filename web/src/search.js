// Typo-tolerant, ranked title search. Works in the browser and Node.
//   search(items, "brekin bad")  ->  [Breaking Bad, ...] best first
(function (root) {
  function norm(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip accents
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/['’`.]/g, '') // "Grey's" -> "greys", "S.W.A.T." -> "swat"
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Optimal-string-alignment distance (Levenshtein + adjacent swaps),
  // bailing out as soon as it exceeds `max`.
  function osa(a, b, max) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let prev2 = null;
    let prev = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      const cur = new Array(lb + 1);
      cur[0] = i;
      let rowMin = i;
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[lb];
  }

  const allowedTypos = (len) => (len <= 2 ? 0 : len <= 4 ? 1 : len <= 7 ? 2 : 3);

  function tokenScore(q, t) {
    if (t === q) return 1;
    if (t.startsWith(q)) return 0.9;
    if (q.length >= 3 && t.includes(q)) return 0.7;
    const max = allowedTypos(q.length);
    if (!max) return 0;
    const d = osa(q, t, max);
    if (d <= max) return 0.8 - 0.15 * d;
    if (t.length > q.length) {
      // typo inside a word that's still being typed: "brek" ~ "break..."
      const d2 = osa(q, t.slice(0, q.length), max);
      if (d2 <= max) return 0.6 - 0.15 * d2;
    }
    return 0;
  }

  function prepare(text) {
    const n = norm(text);
    return { n, t: n ? n.split(' ') : [] };
  }

  function scorePrepared(qTokens, qNorm, p) {
    if (!p.t.length) return 0;
    let total = 0;
    for (const q of qTokens) {
      let best = 0;
      for (const t of p.t) {
        const s = tokenScore(q, t);
        if (s > best) best = s;
        if (best === 1) break;
      }
      if (!best) return 0; // every word of the query must match something
      total += best;
    }
    let score = total / qTokens.length;
    if (p.n === qNorm) score += 1;
    else if (p.n.startsWith(qNorm)) score += 0.3;
    else if (p.n.includes(qNorm)) score += 0.2;
    score -= 0.01 * Math.max(0, p.t.length - qTokens.length); // prefer tighter titles
    return score;
  }

  function score(query, text) {
    const qn = norm(query);
    if (!qn) return 0;
    return scorePrepared(qn.split(' '), qn, prepare(text));
  }

  // Returns matching items, best first. Caches normalised titles on items.
  function search(items, query, opts = {}) {
    const qn = norm(query);
    if (!qn) return items.slice();
    const qt = qn.split(' ');
    const key = opts.key || 'name';
    const hits = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const text = it[key];
      let p = it._sp;
      if (!p || p.src !== text) {
        p = prepare(text);
        p.src = text;
        Object.defineProperty(it, '_sp', { value: p, writable: true, configurable: true, enumerable: false });
      }
      const s = scorePrepared(qt, qn, p);
      if (s > 0) hits.push([s, i, it]);
    }
    hits.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const out = hits.map((h) => h[2]);
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  const api = { search, score, norm, osa };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Search = api;
})(this);
