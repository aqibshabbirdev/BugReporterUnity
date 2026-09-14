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

  M.newRequest = (name) => ({
    name: name || 'New request',
    request: { method: 'GET', header: [], url: { raw: '{{BaseUrl}}', host: ['{{BaseUrl}}'], path: [] } },
    response: []
  });
  M.newFolder = (name) => ({ name: name || 'New folder', item: [] });

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
})();
