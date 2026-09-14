/* API tester — Postman v2.1 document helpers, variables, and the pm.* script sandbox.
 *
 * The collection is edited IN PLACE: helpers read and write the same fields Postman does and never
 * rebuild an item from scratch, so fields this page doesn't know about survive a save and Export
 * still opens in Postman.
 */
(function () {
  'use strict';

  const M = {};
  window.M = M;

  M.isFolder = (it) => Array.isArray(it && it.item);
  M.clone = (o) => JSON.parse(JSON.stringify(o));

  /** Depth-first walk: fn(item, parents) for every folder and request. */
  M.walk = function walk(items, fn, parents = []) {
    for (const it of items || []) {
      fn(it, parents);
      if (M.isFolder(it)) walk(it.item, fn, parents.concat([it]));
    }
  };

  M.countRequests = (items) => { let n = 0; M.walk(items, (it) => { if (!M.isFolder(it)) n++; }); return n; };

  /** Parents of `target` (outermost first), or null if it isn't in the tree. */
  M.parentsOf = function (items, target) {
    let found = null;
    M.walk(items, (it, parents) => { if (it === target) found = parents; });
    return found;
  };

  /** The array that directly holds `target` (collection.item or a folder's item). */
  M.containerOf = function (root, target) {
    if (root.item.includes(target)) return root.item;
    let found = null;
    M.walk(root.item, (it) => { if (M.isFolder(it) && it.item.includes(target)) found = it.item; });
    return found;
  };

  /* ── ids ───────────────────────────────────────────────────────────────── */

  // Every item carries an `id` (the server assigns missing ones). Merging concurrent saves matches
  // requests and folders across versions by it, so a copy must never share its original's ids.
  M.uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(16) + Math.random().toString(16).slice(2));

  M.freshIds = function (it) {
    it.id = M.uid();
    if (M.isFolder(it)) it.item.forEach(M.freshIds);
    return it;
  };

  M.ensureIds = function (items) {
    const seen = new Set();
    M.walk(items, (it) => { if (!it.id || seen.has(it.id)) it.id = M.uid(); seen.add(it.id); });
  };

  M.findById = function (items, id) {
    let found = null;
    if (id) M.walk(items, (it) => { if (!found && it.id === id) found = it; });
    return found;
  };

  M.newRequest = (name) => ({
    id: M.uid(),
    name: name || 'New request',
    request: { method: 'GET', header: [], url: { raw: '{{BaseUrl}}', host: ['{{BaseUrl}}'], path: [] } },
    response: []
  });
  M.newFolder = (name) => ({ id: M.uid(), name: name || 'New folder', item: [] });

  /* ── requests ──────────────────────────────────────────────────────────── */

  M.req = (it) => {
    if (typeof it.request === 'string') it.request = { method: 'GET', header: [], url: it.request };
    if (!it.request) it.request = { method: 'GET', header: [] };
    return it.request;
  };

  M.urlRaw = function (req) {
    const u = req.url;
    if (!u) return '';
    if (typeof u === 'string') return u;
    if (typeof u.raw === 'string') return u.raw;
    const host = Array.isArray(u.host) ? u.host.join('.') : (u.host || '');
    const path = Array.isArray(u.path) ? u.path.join('/') : (u.path || '');
    return (u.protocol ? u.protocol + '://' : '') + host + (u.port ? ':' + u.port : '') + (path ? '/' + path : '');
  };

  const splitQuery = (raw) => {
    const i = raw.indexOf('?');
    return i < 0 ? [raw, ''] : [raw.slice(0, i), raw.slice(i + 1)];
  };

  const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } };

  /** Set the URL from its raw text, rebuilding host/path/query/variable the way Postman stores them. */
  M.setUrl = function (req, raw) {
    const old = typeof req.url === 'object' && req.url ? req.url : {};
    const [base, qs] = splitQuery(raw);
    const m = base.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
    const rest = m ? m[2] : base;
    const slash = rest.indexOf('/');
    const hostPort = slash < 0 ? rest : rest.slice(0, slash);
    const pathStr = slash < 0 ? '' : rest.slice(slash + 1);
    const pm = hostPort.match(/^(.*?)(?::(\d+))?$/);
    const url = { raw };
    if (m) url.protocol = m[1];
    url.host = pm[1] ? pm[1].split('.') : [];
    if (pm[2]) url.port = pm[2];
    url.path = pathStr ? pathStr.split('/') : [];

    const oldQuery = Array.isArray(old.query) ? old.query : [];
    const query = qs ? qs.split('&').filter(Boolean).map((pair) => {
      const eq = pair.indexOf('=');
      const key = decode(eq < 0 ? pair : pair.slice(0, eq));
      const value = eq < 0 ? '' : decode(pair.slice(eq + 1));
      const prev = oldQuery.find((q) => q.key === key && !q.disabled);
      return prev && prev.description ? { key, value, description: prev.description } : { key, value };
    }) : [];
    const disabled = oldQuery.filter((q) => q.disabled);     // not in raw, but keep them listed
    if (query.length || disabled.length) url.query = query.concat(disabled);

    const names = url.path.filter((p) => p.startsWith(':') && p.length > 1).map((p) => p.slice(1));
    if (names.length) {
      const oldVars = Array.isArray(old.variable) ? old.variable : [];
      url.variable = names.map((key) => oldVars.find((v) => v.key === key) || { key, value: '' });
    }
    req.url = url;
  };

  /** Rewrite the raw URL from an edited query list (disabled rows stay out of the URL). */
  M.setQuery = function (req, rows) {
    const [base] = splitQuery(M.urlRaw(req));
    const enc = (s) => String(s).replace(/[&#]/g, encodeURIComponent);
    const on = rows.filter((r) => !r.disabled && (r.key || r.value));
    const raw = on.length ? base + '?' + on.map((r) => enc(r.key) + (r.value !== '' ? '=' + enc(r.value) : '')).join('&') : base;
    M.setUrl(req, raw);
    const off = rows.filter((r) => r.disabled && (r.key || r.value));
    if (typeof req.url === 'object') {
      const q = (req.url.query || []).filter((x) => !x.disabled).concat(off.map((r) => ({ key: r.key, value: r.value, disabled: true })));
      if (q.length) req.url.query = q; else delete req.url.query;
    }
  };

  M.query = (req) => (req.url && typeof req.url === 'object' && Array.isArray(req.url.query)) ? req.url.query : [];
  M.pathVars = (req) => (req.url && typeof req.url === 'object' && Array.isArray(req.url.variable)) ? req.url.variable : [];

  /* ── scripts ───────────────────────────────────────────────────────────── */

  M.script = function (it, listen) {
    const ev = (it.event || []).find((e) => e.listen === listen);
    if (!ev || !ev.script) return '';
    const exec = ev.script.exec;
    return Array.isArray(exec) ? exec.join('\n') : String(exec || '');
  };

  M.setScript = function (it, listen, code) {
    it.event = (it.event || []).filter((e) => e.listen !== listen);
    if (code.trim()) it.event.push({ listen, script: { type: 'text/javascript', exec: code.split('\n') } });
    if (!it.event.length) delete it.event;
  };

  /* ── variables ─────────────────────────────────────────────────────────── */

  /** A get/set view over a Postman [{key, value, enabled|disabled}] list. */
  M.varStore = function (list, onChange) {
    const on = (v) => v.enabled !== false && !v.disabled;
    return {
      get: (k) => { const v = list().find((x) => x.key === k && on(x)); return v ? v.value : undefined; },
      has: (k) => list().some((x) => x.key === k && on(x)),
      set: (k, value) => {
        const arr = list();
        const v = arr.find((x) => x.key === k);
        const val = value === undefined || value === null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
        if (v) { v.value = val; if ('enabled' in v) v.enabled = true; delete v.disabled; } else arr.push({ key: k, value: val, type: 'default', enabled: true });
        onChange && onChange();
      },
      unset: (k) => { const arr = list(); const i = arr.findIndex((x) => x.key === k); if (i >= 0) { arr.splice(i, 1); onChange && onChange(); } },
      toObject: () => Object.fromEntries(list().filter(on).map((x) => [x.key, x.value]))
    };
  };

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  }));
  const DYNAMIC = {
    $guid: uuid, $randomUUID: uuid,
    $timestamp: () => String(Math.floor(Date.now() / 1000)),
    $isoTimestamp: () => new Date().toISOString(),
    $randomInt: () => String(Math.floor(Math.random() * 1001))
  };

  /** Replace {{name}} using the scopes in order; unknown names are left in place and reported. */
  M.resolve = function (text, scopes, missing) {
    return String(text == null ? '' : text).replace(/\{\{([^{}]+)\}\}/g, (all, name) => {
      const key = name.trim();
      if (DYNAMIC[key]) return DYNAMIC[key]();
      for (const s of scopes) { const v = s.get(key); if (v !== undefined) return v; }
      if (missing) missing.add(key);
      return all;
    });
  };

  M.varsIn = (text) => Array.from(String(text || '').matchAll(/\{\{([^{}]+)\}\}/g), (m) => m[1].trim()).filter((k) => !DYNAMIC[k]);

  /* ── auth ──────────────────────────────────────────────────────────────── */

  /** The auth that applies: the request's own, else the nearest folder's, else the collection's. */
  M.effectiveAuth = function (it, parents, coll) {
    const own = M.req(it).auth;
    if (own) return { auth: own, from: 'request' };
    for (let i = parents.length - 1; i >= 0; i--) if (parents[i].auth) return { auth: parents[i].auth, from: parents[i].name };
    if (coll.auth) return { auth: coll.auth, from: 'collection' };
    return { auth: null, from: null };
  };

  M.bearerToken = (auth) => {
    const list = auth && Array.isArray(auth.bearer) ? auth.bearer : [];
    const t = list.find((x) => x.key === 'token');
    return t ? String(t.value == null ? '' : t.value) : '';
  };

  /* ── building a send ───────────────────────────────────────────────────── */

  /**
   * A request item as a send TEMPLATE: {method, url, headers, body} with path variables and inherited
   * auth applied, but {{variables}} still literal — pre-request scripts run against this (and may add
   * headers or set the very variables it uses), then finalize() resolves it.
   */
  M.build = function (it, parents, coll) {
    const req = M.req(it);
    let url = M.urlRaw(req);
    for (const v of M.pathVars(req)) {
      if (v.key) url = url.replace(new RegExp('/:' + v.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=/|\\?|#|$)'), '/' + (v.value || ''));
    }

    const headers = [];
    for (const h of req.header || []) if (!h.disabled && h.key) headers.push([h.key, h.value || '']);

    const { auth } = M.effectiveAuth(it, parents, coll);
    if (auth && auth.type === 'bearer') {
      const token = M.bearerToken(auth);
      if (token && !headers.some(([k]) => k.toLowerCase() === 'authorization')) headers.push(['Authorization', 'Bearer ' + token]);
    }

    let body = null;
    const b = req.body;
    if (b && b.mode === 'raw' && b.raw) {
      const lang = b.options && b.options.raw && b.options.raw.language;
      body = { mode: 'raw', raw: b.raw, contentType: lang === 'json' ? 'application/json' : lang === 'xml' ? 'application/xml' : 'text/plain' };
    } else if (b && (b.mode === 'urlencoded' || b.mode === 'formdata')) {
      const rows = (b[b.mode] || []).filter((f) => !f.disabled && f.key && f.type !== 'file');
      body = { mode: b.mode, fields: rows.map((f) => [f.key, f.value || '']) };
    }
    return { method: (req.method || 'GET').toUpperCase(), url, headers, body };
  };

  /** Resolve every {{variable}} in a built template. `missing` collects names nobody defines. */
  M.finalize = function (t, scopes, missing) {
    const r = (s) => M.resolve(s, scopes, missing);
    let url = r(t.url).trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url;   // Postman does the same
    // Forgive a base URL variable that repeats the scheme or ends in "/" before "{{BaseUrl}}/path".
    url = url.replace(/^(?:[a-z][a-z0-9+.-]*:\/\/)+(?=[a-z][a-z0-9+.-]*:\/\/)/i, '').replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)\/{2,}/i, '$1/');
    const body = !t.body ? null : t.body.mode === 'raw'
      ? { mode: 'raw', raw: r(t.body.raw), contentType: t.body.contentType }
      : { mode: t.body.mode, fields: t.body.fields.map(([k, v]) => [r(k), r(v)]) };
    return { method: t.method, url, headers: t.headers.map(([k, v]) => [r(k), r(v)]), body };
  };

  /* ── pm.* sandbox ──────────────────────────────────────────────────────── */

  function expect(actual, negate) {
    const fail = (msg) => { throw new Error(msg); };
    const check = (ok, msg) => { if (negate ? ok : !ok) fail((negate ? 'expected not: ' : 'expected: ') + msg); };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const chain = {
      equal: (v) => check(actual === v, `${JSON.stringify(actual)} to equal ${JSON.stringify(v)}`),
      eql: (v) => check(same(actual, v), `${JSON.stringify(actual)} to deeply equal ${JSON.stringify(v)}`),
      include: (v) => check(actual != null && (typeof actual === 'string' || Array.isArray(actual)) && actual.includes(v), `${JSON.stringify(actual)} to include ${JSON.stringify(v)}`),
      property: (k) => check(actual != null && Object.prototype.hasOwnProperty.call(actual, k), `object to have property ${k}`),
      above: (n) => check(actual > n, `${actual} to be above ${n}`),
      below: (n) => check(actual < n, `${actual} to be below ${n}`),
      a: (t) => check(Array.isArray(actual) ? t === 'array' : typeof actual === t, `${JSON.stringify(actual)} to be a ${t}`),
      status: (code) => check(actual && actual.code === code, `status ${actual && actual.code} to be ${code}`)
    };
    chain.equals = chain.eql; chain.deep = { equal: chain.eql }; chain.an = chain.a; chain.contain = chain.include;
    Object.defineProperty(chain, 'ok', { get: () => check(!!actual, `${JSON.stringify(actual)} to be truthy`) });
    Object.defineProperty(chain, 'true', { get: () => check(actual === true, `${JSON.stringify(actual)} to be true`) });
    Object.defineProperty(chain, 'false', { get: () => check(actual === false, `${JSON.stringify(actual)} to be false`) });
    Object.defineProperty(chain, 'not', { get: () => expect(actual, !negate) });
    for (const w of ['to', 'be', 'been', 'is', 'that', 'and', 'have', 'with']) Object.defineProperty(chain, w, { get: () => chain });
    return chain;
  }

  /**
   * Run one script. ctx: {env, coll, local (stores), request (built send, mutable in pre-request),
   * response (result object), name}. Returns {logs, tests, error}.
   *
   * Scripts come from the team's own shared collection and run in this page, like Postman runs them in
   * the app — they are trusted content, not a security boundary.
   */
  M.runScript = function (code, ctx) {
    const logs = [], tests = [];
    if (!code || !code.trim()) return { logs, tests, error: null };
    const fmt = (args) => args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(' ');
    const con = { log: (...a) => logs.push(fmt(a)), info: (...a) => logs.push(fmt(a)), warn: (...a) => logs.push('warn: ' + fmt(a)), error: (...a) => logs.push('error: ' + fmt(a)) };
    const vars = { get: (k) => [ctx.local, ctx.env, ctx.coll].reduce((v, s) => (v !== undefined ? v : s.get(k)), undefined), set: ctx.local.set, has: (k) => ctx.local.has(k) || ctx.env.has(k) || ctx.coll.has(k), replaceIn: (s) => M.resolve(s, [ctx.local, ctx.env, ctx.coll]) };

    const pm = {
      environment: ctx.env, globals: ctx.env, collectionVariables: ctx.coll, variables: vars,
      info: { requestName: ctx.name, eventName: ctx.response ? 'test' : 'prerequest' },
      test: (name, fn) => { try { fn(); tests.push({ name, ok: true }); } catch (e) { tests.push({ name, ok: false, error: e.message }); } },
      expect: (v) => expect(v, false)
    };
    if (ctx.request) {
      const hs = ctx.request.headers;
      pm.request = {
        method: ctx.request.method, url: { toString: () => ctx.request.url },
        headers: {
          get: (k) => { const h = hs.find(([x]) => x.toLowerCase() === String(k).toLowerCase()); return h ? h[1] : undefined; },
          add: (h) => hs.push([h.key, String(h.value)]),
          upsert: (h) => { const i = hs.findIndex(([x]) => x.toLowerCase() === h.key.toLowerCase()); if (i >= 0) hs[i] = [h.key, String(h.value)]; else hs.push([h.key, String(h.value)]); },
          remove: (k) => { for (let i = hs.length - 1; i >= 0; i--) if (hs[i][0].toLowerCase() === String(k).toLowerCase()) hs.splice(i, 1); }
        }
      };
    }
    if (ctx.response) {
      const res = ctx.response;
      pm.response = {
        code: res.status, status: res.reason || '', responseTime: res.timeMs, responseSize: res.size,
        headers: { get: (k) => { const h = (res.headers || []).find(([x]) => x.toLowerCase() === String(k).toLowerCase()); return h ? h[1] : undefined; } },
        text: () => res.body || '',
        json: () => JSON.parse(res.body || 'null')
      };
      pm.response.to = { have: { status: (c) => expect(pm.response).to.have.status(c) }, be: {} };
      Object.defineProperty(pm.response.to.be, 'ok', { get: () => { if (res.status < 200 || res.status > 299) throw new Error(`expected 2xx, got ${res.status}`); } });
    }
    const postman = { setEnvironmentVariable: (k, v) => ctx.env.set(k, v), getEnvironmentVariable: (k) => ctx.env.get(k), clearEnvironmentVariable: (k) => ctx.env.unset(k), setGlobalVariable: (k, v) => ctx.env.set(k, v), getGlobalVariable: (k) => ctx.env.get(k) };
    const requireStub = (name) => { throw new Error(`require('${name}') is not available here`); };

    try {
      // eslint-disable-next-line no-new-func
      new Function('pm', 'postman', 'console', 'require', code)(pm, postman, con, requireStub);
      return { logs, tests, error: null };
    } catch (e) {
      return { logs, tests, error: e && e.message ? e.message : String(e) };
    }
  };

  /** Scripts that apply to a request, outermost first: collection, folders, then the request. */
  M.scriptsFor = (it, parents, coll, listen) => [coll].concat(parents, [it]).map((x) => ({ from: x === coll ? 'collection' : x.name, code: M.script(x, listen) })).filter((s) => s.code.trim());

  /* ── three-way merge ───────────────────────────────────────────────────── */

  /** JSON with sorted object keys, so "same value" doesn't depend on the order fields were written in. */
  M.stable = (v) => JSON.stringify(v === undefined ? null : v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
    ? Object.keys(val).sort().reduce((o, key) => { o[key] = val[key]; return o; }, {}) : val));
  const same = (a, b) => M.stable(a) === M.stable(b);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  /**
   * Split an item (or the collection root) into separately mergeable units, so two people changing
   * different parts of the same thing don't conflict: `request.<field>` (body vs headers vs URL),
   * `info.<field>`, `event:<listen>` (pre-request vs test script), `variable:<key>`; anything else is
   * one unit. `request.` / `event[]` style markers keep an emptied object or list from disappearing.
   */
  function units(node, keepId) {
    const out = {};
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (k === 'item' || (k === 'id' && !keepId)) continue;
      if ((k === 'request' || k === 'info') && isObj(v)) {
        out[k + '.'] = true;
        for (const sk of Object.keys(v)) out[k + '.' + sk] = v[sk];
      } else if (k === 'event' && Array.isArray(v) && v.every(isObj)) {
        out['event[]'] = true;
        for (const e of v) (out['event:' + e.listen] = out['event:' + e.listen] || []).push(e);
      } else if (k === 'variable' && Array.isArray(v) && v.every(isObj)) {
        out['variable[]'] = true;
        const n = {};
        for (const e of v) { n[e.key] = (n[e.key] || 0) + 1; out['variable:' + e.key + '#' + n[e.key]] = e; }
      } else out[k] = v;
    }
    return out;
  }

  function fromUnits(u, head) {
    const node = Object.assign({}, head);
    for (const [k, v] of Object.entries(u)) {
      let m;
      if ((m = /^(request|info)\.([\s\S]*)$/.exec(k))) {
        node[m[1]] = node[m[1]] || {};
        if (m[2]) node[m[1]][m[2]] = v;
      } else if ((m = /^(event|variable)(\[\]|:)/.exec(k))) {
        node[m[1]] = node[m[1]] || [];
        if (m[2] === ':') node[m[1]].push(...(m[1] === 'event' ? v : [v]));
      } else node[k] = v;
    }
    return node;
  }

  /** Unit-by-unit merge; onConflict(unit, mine, theirs) settles units both sides changed differently. */
  function mergeUnits(b, m, t, onConflict) {
    const out = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) {
      const mc = !same(m[k], b[k]), tc = !same(t[k], b[k]);
      const v = mc && tc && !same(m[k], t[k]) ? onConflict(k, m[k], t[k]) : mc ? m[k] : t[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /** A readable name for a merge unit, for the conflict dialog. */
  M.unitLabel = function (k) {
    const names = { 'request.body': 'Body', 'request.header': 'Headers', 'request.url': 'URL', 'request.method': 'Method',
      'request.auth': 'Auth', 'request.description': 'Description', 'info.name': 'Name', 'info.description': 'Description',
      name: 'Name', auth: 'Auth', description: 'Description', response: 'Saved examples', 'event:prerequest': 'Pre-request script',
      'event:test': 'Test script', deleted: 'Deleted' };
    if (names[k]) return names[k];
    const v = /^variable:([\s\S]*)#\d+$/.exec(k);
    return v ? 'Variable ' + v[1] : k.replace(/^request\./, '');
  };

  function indexTree(doc) {
    const map = new Map(), kids = new Map();
    const walk = (items, parent) => {
      const ids = [];
      for (const it of items || []) {
        if (!isObj(it)) continue;
        ids.push(it.id);
        map.set(it.id, { node: it, parent });
        if (M.isFolder(it)) walk(it.item, it.id);
      }
      kids.set(parent, ids);
    };
    walk(doc.item, null);
    return { map, kids };
  }

  /**
   * Merge `mine` and `theirs`, both edited from `base` (items matched by `id`). Returns {doc, conflicts}.
   * A conflict is {id, label, unit, mine, theirs}; `choices[id]` ('mine' | 'theirs') settles it, and
   * without a choice theirs is used — so call once to find the conflicts, then again with the choices.
   *
   * - a unit changed on one side only comes from that side; the same change on both sides is no conflict;
   * - an item added on either side is kept; one deleted on one side goes, unless the other side edited it
   *   (a conflict whose values are 'delete' / 'keep');
   * - a move wins if only one side moved the item; order in a folder follows the side that reordered it.
   */
  M.merge3 = function (base, mine, theirs, choices) {
    choices = choices || {};
    const conflicts = [];
    const decide = (id, label, unit, mv, tv) => {
      conflicts.push({ id, label, unit, mine: mv, theirs: tv });
      return choices[id] === 'mine' ? mv : tv;
    };

    const rootUnits = mergeUnits(units(base, true), units(mine, true), units(theirs, true),
      (k, mv, tv) => decide('root|' + k, 'Collection', k, mv, tv));

    const B = indexTree(base), Mi = indexTree(mine), Th = indexTree(theirs);
    const kept = new Map();   // id -> {units, folder, parent}
    for (const id of new Set([...B.map.keys(), ...Mi.map.keys(), ...Th.map.keys()])) {
      const b = B.map.get(id), m = Mi.map.get(id), t = Th.map.get(id);
      const any = (m || t || b).node;
      const label = any.name || '(unnamed)';
      let u;
      if (m && t) {
        u = mergeUnits(b ? units(b.node) : {}, units(m.node), units(t.node), (k, mv, tv) => decide(id + '|' + k, label, k, mv, tv));
      } else if (m || t) {
        const side = (m || t).node;
        if (b && same(units(side), units(b.node))) continue;            // deleted on one side, untouched on the other
        if (b && decide(id + '|deleted', label, 'deleted', m ? 'keep' : 'delete', m ? 'delete' : 'keep') === 'delete') continue;
        u = units(side);                                                 // added, or edited-vs-deleted and kept
      } else continue;                                                   // deleted on both sides

      let parent;
      if (m && t) parent = b && m.parent !== b.parent && t.parent === b.parent ? m.parent : t.parent;
      else parent = (m || t).parent;
      kept.set(id, { units: u, folder: M.isFolder(any), parent });
    }
    for (const e of kept.values()) if (e.parent !== null && !kept.has(e.parent)) e.parent = null;   // its folder is gone
    for (const [id, e] of kept) {                  // each side moving a folder into the other's makes a loop
      const seen = new Set();
      for (let p = e.parent; p !== null && !seen.has(p); p = kept.get(p).parent) {
        if (p === id) { e.parent = null; break; }
        seen.add(p);
      }
    }

    const orderFor = (parent) => {
      const here = (ids) => ids.filter((id) => kept.has(id) && kept.get(id).parent === parent);
      const ob = B.kids.get(parent) || [];
      const om = here(Mi.kids.get(parent) || []), ot = here(Th.kids.get(parent) || []);
      const inAll = (id) => ob.includes(id) && om.includes(id) && ot.includes(id);
      const theyReordered = !same(ot.filter(inAll), ob.filter(inAll));
      const [primary, secondary] = theyReordered ? [ot, om] : [om, ot];
      const result = primary.slice();
      for (const id of [...secondary, ...here([...kept.keys()])]) {
        if (result.includes(id)) continue;
        const src = secondary.includes(id) ? secondary : ob;       // place it after its nearest earlier sibling there
        let at = src.indexOf(id) < 0 ? result.length : 0;
        for (let i = src.indexOf(id) - 1; i >= 0; i--) { const j = result.indexOf(src[i]); if (j >= 0) { at = j + 1; break; } }
        result.splice(at, 0, id);
      }
      return result;
    };

    const build = (parent) => orderFor(parent).map((id) => {
      const e = kept.get(id);
      const node = fromUnits(e.units, { id });
      if (e.folder) node.item = build(id);
      return node;
    });
    const doc = fromUnits(rootUnits, {});
    doc.item = build(null);
    return { doc, conflicts };
  };

  /**
   * Merge environment values by variable name. A name both sides changed differently keeps mine (the
   * usual case: each person's login script refreshed {{token}}) and is listed in `overridden`.
   */
  M.mergeEnvValues = function (base, mine, theirs) {
    const byKey = (list) => new Map((list || []).map((v) => [v.key, v]));
    const b = byKey(base), m = byKey(mine), t = byKey(theirs);
    const overridden = [], values = [];
    for (const key of new Set([...(theirs || []), ...(mine || [])].map((v) => v.key))) {
      const bv = b.get(key), mv = m.get(key), tv = t.get(key);
      const mc = !same(mv, bv), tc = !same(tv, bv);
      let v;
      if (mc && tc && !same(mv, tv)) { v = mv; if (mv && tv) overridden.push(key); } else v = mc ? mv : tv;
      if (v) values.push(v);
    }
    return { values, overridden };
  };
})();
