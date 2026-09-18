/* API tester — sending, the response pane, dialogs, import/export, shortcuts. Extends `T` from app.js. */
(function () {
  'use strict';

  const { h, S, R } = T;

  /* ── sending ───────────────────────────────────────────────────────────── */

  const decoder = new TextDecoder();

  async function sendFromBrowser(t) {
    const headers = new Headers();
    const skipped = [];
    for (const [k, v] of t.headers) { try { headers.append(k, v); } catch (e) { skipped.push(k); } }
    let body;
    if (t.body && !['GET', 'HEAD'].includes(t.method)) {
      if (t.body.mode === 'raw') { body = t.body.raw; if (!headers.has('content-type') && t.body.contentType) headers.set('Content-Type', t.body.contentType); }
      else if (t.body.mode === 'urlencoded') body = new URLSearchParams(t.body.fields);
      else if (t.body.mode === 'formdata') { body = new FormData(); t.body.fields.forEach(([k, v]) => body.append(k, v)); }
    }
    const started = performance.now();
    let r;
    try {
      r = await fetch(t.url, { method: t.method, headers, body, credentials: 'omit' });
    } catch (e) {
      throw new Error(`Your browser couldn't get a response from ${t.url}.\n` +
        'Usually: the API doesn\'t allow this page\'s origin (CORS), the port is wrong, or it isn\'t running. ' +
        'Public APIs work from "Send via server".');
    }
    const buf = await r.arrayBuffer();
    return {
      status: r.status, reason: r.statusText, headers: [...r.headers.entries()],
      timeMs: Math.round(performance.now() - started), size: buf.byteLength, body: decoder.decode(buf),
      via: 'browser', note: skipped.length ? `Browser refused to set: ${skipped.join(', ')}` : ''
    };
  }

  /**
   * Run one request end to end — pre-request scripts, variables, send, test scripts — and store the
   * result in S.results. Shared by the Send button and the folder runner.
   * opts.skipEmpty: don't send when a variable in the URL or Authorization header is empty — the runner
   * uses it so "not logged in yet" is reported as skipped, not as a broken API.
   */
  /** A "⏱ Wait" step: a flow item that only pauses (item.wait = seconds), for credits that arrive a little later. */
  T.isWaitStep = (it) => !!it && Number(it.wait) > 0;
  T.waitStep = (seconds) => {
    const s = Math.max(1, Math.min(600, Math.round(Number(seconds) || 15)));
    return { id: M.uid(), name: `⏱ Wait ${s} s`, wait: s, request: { method: 'GET', header: [], url: { raw: 'wait://' + s, host: ['wait:'], path: [String(s)] }, auth: { type: 'noauth' } }, response: [], event: [] };
  };

  T.isSocketStep = (it) => !!(it && it.socket && typeof it.socket === 'object');
  T.socketStep = (cfg) => {
    const c = Object.assign({ url: '', query: [], token: '', emit: { event: '', data: '' }, wait: { event: '', timeout: 20 } }, cfg || {});
    return { id: M.uid(), name: c.name || `⚡ ${c.wait.event || 'socket'}`, socket: { url: c.url, query: c.query, token: c.token, emit: c.emit, wait: c.wait },
      request: { method: 'GET', header: [], url: { raw: c.url }, body: { mode: 'raw', raw: c.emit && c.emit.data ? c.emit.data : '' }, auth: { type: 'noauth' } }, response: [], event: [] };
  };

  /** socket.io-client, loaded the first time a socket step runs. */
  let ioLoading = null;
  const loadIo = () => {
    if (window.io) return Promise.resolve(window.io);
    if (!ioLoading) ioLoading = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.socket.io/4.8.1/socket.io.min.js';
      sc.onload = () => resolve(window.io);
      sc.onerror = () => { ioLoading = null; reject(new Error('Could not load socket.io-client (cdn.socket.io) — is the internet reachable?')); };
      document.head.append(sc);
    });
    return ioLoading;
  };

  /**
   * A socket step: connect (query + token resolved from variables), emit one event if asked, then wait for
   * the named event (or any event) and hand its payload on as the "response" so checks and keeps work as usual.
   */
  async function executeSocket(it) {
    const out = { logs: [], tests: [], errors: [] };
    const scopes = T.scopes();
    const missing = new Set();
    const res = (t) => M.resolve(t, scopes, missing);
    const cfg = it.socket;
    const url = res(cfg.url || '');
    const query = {};
    (cfg.query || []).forEach(([k, v]) => { if (String(k || '').trim()) query[k.trim()] = res(v); });
    const token = res(cfg.token || '');
    const emitEvent = res((cfg.emit && cfg.emit.event) || '');
    const emitRaw = res((cfg.emit && cfg.emit.data) || '');
    const waitEvent = res((cfg.wait && cfg.wait.event) || '');
    const timeout = Math.max(1, Math.min(300, Number(cfg.wait && cfg.wait.timeout) || 20));
    if (missing.size) {
      const result = { error: `These variables have no value: ${[...missing].map((k) => '{{' + k + '}}').join(', ')}`, missing: [...missing], out };
      S.results.set(it.id, result); return result;
    }
    let result;
    const started = performance.now();
    try {
      const io = await loadIo();
      let emitData = emitRaw;
      if (emitRaw.trim()) { try { emitData = JSON.parse(emitRaw); } catch (e) { /* send as text */ } }
      const got = await new Promise((resolve, reject) => {
        const sock = io(url, { transports: ['websocket', 'polling'], query, auth: token ? { token } : undefined, reconnection: false, timeout: timeout * 1000, forceNew: true });
        const seen = [];
        const done = (fn) => { clearTimeout(timer); try { sock.offAny(); sock.disconnect(); } catch (e) { /* closed */ } fn(); };
        const timer = setTimeout(() => done(() => reject(new Error(`No "${waitEvent || 'event'}" within ${timeout} s` + (seen.length ? ` — got ${seen.slice(0, 5).map((x) => x.event).join(', ')} instead` : ' — nothing arrived')))), timeout * 1000);
        sock.on('connect_error', (err) => done(() => reject(new Error('Socket connect failed: ' + (err && err.message ? err.message : err)))));
        sock.on('connect', () => {
          out.logs.push(`[socket] connected ${url} as ${JSON.stringify(query)} via ${sock.io.engine.transport.name}`);
          if (emitEvent) { sock.emit(emitEvent, emitData); out.logs.push(`[socket] emitted ${emitEvent} ${emitRaw.slice(0, 200)}`); }
        });
        sock.onAny((event, ...args) => {
          const payload = args.length <= 1 ? args[0] : args;
          seen.push({ event, payload });
          out.logs.push(`[socket] ← ${event} ${JSON.stringify(payload).slice(0, 300)}`);
          if (!waitEvent || event === waitEvent) done(() => resolve({ event, payload, seen }));
        });
      });
      const body = JSON.stringify({ event: got.event, payload: got.payload === undefined ? null : got.payload });
      const r = { status: 200, reason: 'event', headers: [['x-socket-event', got.event]], timeMs: Math.round(performance.now() - started), size: body.length, body, via: 'socket' };
      const coll = S.coll.data, parents = M.parentsOf(coll.item, it) || [];
      const env = T.envStore(), collVars = T.collStore(), local = T.localStore();
      for (const sc of M.scriptsFor(it, parents, coll, 'test')) {
        const o = M.runScript(sc.code, { env, coll: collVars, local, response: r, name: it.name });
        o.logs.forEach((l) => out.logs.push(`[post-response · ${sc.from}] ${l}`));
        o.tests.forEach((x) => out.tests.push(x));
        if (o.error) out.errors.push(`post-response script (${sc.from}): ${o.error}`);
      }
      out.tests.unshift({ name: `Got "${got.event}" after ${r.timeMs} ms`, ok: true });
      result = { res: r, sent: { method: 'SOCKET', url, headers: [], body: emitRaw }, out };
    } catch (e) {
      result = { error: e.message, out };
    }
    S.results.set(it.id, result);
    return result;
  }

  /** Runs a step; a step with `repeat` {every, max} is sent again until its checks pass or the tries run out. */
  T.execute = async function (it, opts) {
    const rep = it.repeat && Number(it.repeat.max) > 1 ? { every: Math.max(1, Math.min(600, Number(it.repeat.every) || 5)), max: Math.max(2, Math.min(200, Math.round(Number(it.repeat.max)))) } : null;
    if (!rep) return executeOnce(it, opts);
    let result = null;
    for (let n = 1; n <= rep.max; n++) {
      result = await executeOnce(it, opts);
      const j = T.judge(result);
      if (j.verdict !== 'fail') {
        if (result.out) result.out.tests.push({ name: n === 1 ? `Passed on the first try` : `Passed on try ${n} of ${rep.max} (every ${rep.every} s)`, ok: true });
        result.tries = n;
        S.results.set(it.id, result);
        return result;
      }
      if (n < rep.max) {
        S.results.set(it.id, Object.assign({}, result, { retrying: n }));
        if (opts && opts.onRetry) opts.onRetry(n, rep, j);
        await new Promise((res) => setTimeout(res, rep.every * 1000));
      }
    }
    if (result && result.out) result.out.tests.push({ name: `Still not passing after ${rep.max} tries, every ${rep.every} s`, ok: false, error: 'gave up' });
    if (result) { result.tries = rep.max; S.results.set(it.id, result); }
    return result;
  };

  async function executeOnce(it, opts) {
    if (T.isSocketStep(it)) return executeSocket(it);
    if (T.isWaitStep(it)) {
      const ms = Number(it.wait) * 1000;
      const started = performance.now();
      await new Promise((res) => setTimeout(res, ms));
      const result = { res: { status: 200, reason: 'waited', headers: [], timeMs: Math.round(performance.now() - started), size: 0, body: '', via: 'wait' }, out: { logs: [], tests: [{ name: `Waited ${it.wait} s`, ok: true }], errors: [] } };
      S.results.set(it.id, result);
      return result;
    }
    const coll = S.coll.data;
    const parents = M.parentsOf(coll.item, it) || [];
    const env = T.envStore(), collVars = T.collStore(), local = T.localStore();
    const scopes = [local, env, collVars];
    const out = { logs: [], tests: [], errors: [] };
    const absorb = (r, from, phase) => {
      r.logs.forEach((l) => out.logs.push(`[${phase} · ${from}] ${l}`));
      r.tests.forEach((x) => out.tests.push(x));
      if (r.error) out.errors.push(`${phase} script (${from}): ${r.error}`);
    };
    let result;
    try {
      const template = M.build(it, parents, coll);
      for (const s of M.scriptsFor(it, parents, coll, 'prerequest')) {
        absorb(M.runScript(s.code, { env, coll: collVars, local, request: template, name: it.name }), s.from, 'pre-request');
      }
      const missing = new Set();
      const final = M.finalize(template, scopes, missing);
      if (missing.size) {
        throw Object.assign(new Error(`These variables have no value: ${[...missing].map((k) => '{{' + k + '}}').join(', ')}\nSet them under "Variables" (or pick the right environment) and send again.`), { missing: [...missing] });
      }
      if (opts && opts.skipEmpty) {
        const used = new Set(M.varsIn(template.url));
        template.headers.forEach(([k, v]) => { if (/^authorization$/i.test(k)) M.varsIn(v).forEach((x) => used.add(x)); });
        const empty = [...used].filter((k) => { const sc = scopes.find((x) => x.has(k)); return sc && String(sc.get(k) == null ? '' : sc.get(k)).trim() === ''; });
        if (empty.length) {
          result = { skipped: `empty ${empty.map((k) => '{{' + k + '}}').join(', ')} — run the login request first or fill it in Variables`, out };
          S.results.set(it.id, result);
          return result;
        }
      }

      let res;
      if (S.mode === 'browser') res = await sendFromBrowser(final);
      else {
        try {
          res = await T.api('POST', '/api/tester/send', Object.assign({}, final, { verifyTls: S.verifyTls }));
          res.via = 'server';
        } catch (e) {
          if (e.status === 401) { location.reload(); return null; }
          throw e;
        }
      }

      for (const s of M.scriptsFor(it, parents, coll, 'test')) {
        absorb(M.runScript(s.code, { env, coll: collVars, local, response: res, name: it.name }), s.from, 'post-response');
      }
      result = { res, sent: final, out };
    } catch (e) {
      result = { error: e.message, missing: e.missing, out };
    }
    S.results.set(it.id, result);
    return result;
  };

  T.send = async function () {
    const it = S.sel;
    if (!it || M.isFolder(it) || S.sending) return;
    S.sending = true;
    S.results.set(it.id, { pending: true });
    T.renderResponse();
    R.sendBtn && (R.sendBtn.disabled = true);
    try {
      await T.execute(it);
    } finally {
      S.sending = false;
      if (R.sendBtn) R.sendBtn.disabled = false;
      if (S.sel === it) { T.renderResponse(); T.renderVarWarning(); }
      if (S.envDirty) T.saveEnv(true);   // scripts setting {{token}} should stick for the next request
    }
  };

  /* ── folder runner ─────────────────────────────────────────────────────── */

  // Requests the runner leaves unticked until someone ticks them: they spend coins, delete things, start a
  // game, change an account or send an OTP. `get` is the stricter pattern for reads (GET, or a POST that
  // only lists/looks up — CardGames uses POST for everything), where "purchase history" is harmless.
  const RISK = [
    { why: 'spends or moves coins',
      any: /withdraw|redeem|purchase|puchase|payment|recharge|add_?cash|order|gift|golds?\b|silvers?\b|in-app|transfer|\bbet\b|bet_|place_bet|\bspin|payout|claim|collect|settle|win-loss|winner|double|repeat|book|participate|generate-session|coin-payment/i,
      get: /claim|settle|win-loss|session-winner|make_winner|generate-session|coin-payment|\bspin\b/i },
    { why: 'deletes or cancels something',
      any: /delete|remove|destroy|logout|leave|ignore|reject|cancel|clear/i,
      get: /delete|remove|destroy|logout|leave|ignore|reject|cancel|clear/i },
    { why: 'starts a game or session',
      any: /create|join|\bplay\b|\bround\b|rematch|re-match|start|private_table|table_with_code/i,
      get: /create|\bjoin\b|\bplay\b|\bround\b|rematch|re-match/i },
    { why: 'changes an account',
      any: /password|kyc|adhar|bank|crypto|register|signup|update|edit|fcm|upload|proof/i,
      get: null },
    { why: 'sends a message or OTP',
      any: /otp|sms|notify|send|ticket|conversation|accept|request\b/i,
      get: /otp|notify/i }
  ];
  const LOOKUP = /history|statement|_log\b|log$|\blist\b|table_master|\/get|details?\b|\bstatus\b|agent_chats|\bwallet$|\/profile$|\/setting$|\/plan$|paymentmethod|currencyavailable|game_on_off|types$|info$|winners|\/welcome_bonus$|reffer_level/i;

  T.riskOf = function (it) {
    if (T.isWaitStep(it)) return '';
    if (T.isSocketStep(it)) return it.socket.emit && String(it.socket.emit.event || '').trim() ? 'sends a socket event' : '';
    const req = M.req(it);
    const url = M.urlRaw(req);
    const text = `${it.name} ${url}`;
    if (/\/login(\/|\b)|build-token/i.test(url)) return '';      // later requests need its token
    const method = (req.method || 'GET').toUpperCase();
    const read = method === 'GET' || method === 'HEAD' || (method !== 'DELETE' && LOOKUP.test(text));
    for (const r of RISK) {
      const re = read ? r.get : r.any;
      if (re && re.test(text)) return r.why;
    }
    return read ? '' : 'changes data';
  };

  /** Was the response what a working API returns? {verdict: pass | fail | skip, reason} */
  T.judge = function (r) {
    if (!r) return { verdict: 'skip', reason: 'not run' };
    if (r.skipped) return { verdict: 'skip', reason: r.skipped };
    if (r.missing && r.missing.length) return { verdict: 'skip', reason: 'needs ' + r.missing.map((k) => '{{' + k + '}}').join(', ') };
    if (r.error) return { verdict: 'fail', reason: r.error.split('\n')[0] };
    const out = r.out || { tests: [], errors: [] };
    if (out.errors.length) return { verdict: 'fail', reason: out.errors[0] };
    const res = r.res;
    let body = null;
    try { body = JSON.parse(res.body); } catch (e) { /* not JSON */ }
    const msg = body && typeof body === 'object' && typeof body.message === 'string' ? ': ' + body.message.slice(0, 120) : '';
    const failed = out.tests.filter((t) => !t.ok);
    if (out.tests.length) {
      return failed.length
        ? { verdict: 'fail', reason: `HTTP ${res.status}, test "${failed[0].name}" failed${failed[0].error ? ' — ' + failed[0].error : ''}` }
        : { verdict: 'pass', reason: `HTTP ${res.status}, ${out.tests.length} test${out.tests.length === 1 ? '' : 's'} passed` };
    }
    if (res.status < 200 || res.status >= 300) return { verdict: 'fail', reason: `HTTP ${res.status}${msg}` };
    // CardGames (PHP/Node) always answer HTTP 200 and put the real outcome in the body.
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const code = Number(body.code);
      if (body.code !== undefined && Number.isFinite(code) && code !== 200 && code !== 201) return { verdict: 'fail', reason: `HTTP ${res.status} but body code ${body.code}${msg}` };
      if (body.status === false || body.success === false) return { verdict: 'fail', reason: `HTTP ${res.status} but body status false${msg}` };
    }
    return { verdict: 'pass', reason: `HTTP ${res.status}` };
  };


  /* ── flow chart (runner) ───────────────────────────────────────────────── */

  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    kids.forEach((k) => el.append(k.nodeType ? k : document.createTextNode(String(k))));
    return el;
  };

  /**
   * A failure in plain words: the check's own title, its error, and — when both sides are numbers —
   * the difference, so "expected 46700, got 46600" also says "(−100)".
   */
  T.plainReason = function (text) {
    let s = String(text || '').replace(/^Auto run: /, '');
    const m = s.match(/^HTTP \d+, test "([^"]*)" failed(?: — (.*))?$/s);
    if (m) s = m[2] && !m[1].includes(m[2]) ? `${m[1]} — ${m[2]}` : m[1];
    const nums = s.match(/expected\s+(-?[\d,]+(?:\.\d+)?)[^\d-]{1,40}?got\s+(-?[\d,]+(?:\.\d+)?)/i);
    if (nums) {
      const want = Number(nums[1].replace(/,/g, '')), got = Number(nums[2].replace(/,/g, ''));
      if (Number.isFinite(want) && Number.isFinite(got) && want !== got) {
        const d = got - want;
        s += ` (${d > 0 ? '+' : '−'}${fmtNum(Math.abs(d))} off)`;
      }
    }
    return s;
  };

  /** The short line under a step: the check that decided it, or what the server said. */
  function stepDetail(r) {
    if (!r.on) return 'not selected';
    if (r.state === 'queued') return '';
    if (r.state === 'running') return T.isWaitStep(r.it) ? 'waiting…' : 'sending…';
    if (r.state === 'waiting') return 'waiting for your input';
    const tests = (r.result && r.result.out && r.result.out.tests) || [];
    const bad = tests.find((t) => !t.ok);
    if (bad) return T.plainReason(bad.name + (bad.error && !bad.name.includes(bad.error) ? ' — ' + bad.error : ''));
    if (r.state === 'fail' && r.reason) return T.plainReason(r.reason);
    const pick = tests.find((t) => /→/.test(t.name)) || null;
    if (pick) return pick.name.replace(/\s*\(for information\)\s*$/, '');
    return r.reason || '';
  }

  /** Gold/silver read by a balance step, and whose wallet it was. */
  function balanceOf(r) {
    const res = r.result && r.result.res;
    if (!res || !/balance/i.test(M.urlRaw(M.req(r.it)) + ' ' + r.it.name)) return null;
    let j; try { j = JSON.parse(res.body); } catch (e) { return null; }
    const d = j && (j.gold_balance !== undefined ? j : j.data);
    if (!d || d.gold_balance === undefined) return null;
    const gold = Number(d.gold_balance);
    if (!Number.isFinite(gold)) return null;
    const auth = (M.req(r.it).header || []).map((x) => x.value || '').join(' ');
    const who = (auth.match(/\{\{\s*p(\d+)_token\s*\}\}/) || r.it.name.match(/\bp(?:layer)?\s*(\d)\b/i) || [])[1];
    return { gold, who: who ? 'P' + who : 'Wallet' };
  }

  /** One small line chart per flow: gold after each balance check, one line per player. */
  function goldGraph(points) {
    const players = [...new Set(points.map((p) => p.who))];
    const W = 640, H = 132, padL = 12, padR = 12, top = 26, bottom = 30;
    const vals = points.map((p) => p.gold);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { lo -= 1; hi += 1; }
    const x = (i) => padL + 40 + (points.length === 1 ? 0 : i * (W - padL - padR - 80) / (points.length - 1));
    const y = (v) => top + (hi - v) * (H - top - bottom) / (hi - lo);
    const room = Math.max(8, Math.floor((points.length === 1 ? 200 : (W - padL - padR - 80) / (points.length - 1)) / 5.6));
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fc-graph', role: 'img', 'aria-label': 'Gold balance after each balance check' });
    [0, 1].forEach((t) => {
      const yy = top + t * (H - top - bottom);
      g.append(svg('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: 'fc-grid' }));
    });
    players.forEach((who, pi) => {
      const mine = points.map((p, i) => ({ p, i })).filter((o) => o.p.who === who);
      const cls = 'fc-line p' + (pi % 3);
      if (mine.length > 1) g.append(svg('polyline', { points: mine.map((o) => `${x(o.i)},${y(o.p.gold)}`).join(' '), class: cls, fill: 'none' }));
      mine.forEach((o, k) => {
        const prev = k ? mine[k - 1].p.gold : null;
        const delta = prev === null ? '' : o.p.gold - prev;
        g.append(svg('circle', { cx: x(o.i), cy: y(o.p.gold), r: 4, class: cls }));
        g.append(svg('text', { x: x(o.i), y: y(o.p.gold) - 9, class: 'fc-val', 'text-anchor': 'middle' }, fmtNum(o.p.gold)));
        if (delta !== '') {
          g.append(svg('text', { x: x(o.i), y: H - 16, class: 'fc-delta ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'), 'text-anchor': 'middle' },
            `${who} ${delta > 0 ? '+' : ''}${fmtNum(delta)}`));
        } else {
          g.append(svg('text', { x: x(o.i), y: H - 16, class: 'fc-delta flat', 'text-anchor': 'middle' }, `${who} start`));
        }
        g.append(svg('text', { x: x(o.i), y: H - 3, class: 'fc-step', 'text-anchor': 'middle' }, o.p.step.length > room ? o.p.step.slice(0, room - 1) + '…' : o.p.step));
      });
    });
    const legend = h('div.fc-legend', {}, h('span', { text: 'Gold after each balance check' }),
      players.map((who, pi) => h('span.fc-key', { class: 'p' + (pi % 3), text: who })));
    return h('div.fc-graphbox', {}, legend, h('div.fc-graphscroll', {}, g));
  }
  const fmtNum = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

  /** Every flow as a chain of steps, coloured live as the runner reaches them. */
  T.flowChart = (...a) => flowChart(...a);
  function flowChart(rows, phase, folder, onPick) {
    const base = folder ? (M.parentsOf(S.coll.data.item, folder) || []).length + 1 : 0;
    const groups = [];
    rows.forEach((r) => {
      const trail = (M.parentsOf(S.coll.data.item, r.it) || []).slice(base);
      const key = trail.length ? trail[0].id : '_';
      let g = groups.find((x) => x.key === key);
      if (!g) groups.push((g = { key, name: trail.length ? trail[0].name : (folder ? folder.name : 'Requests'), rows: [] }));
      g.rows.push(r);
    });
    const icon = { queued: '', running: '', waiting: '✎', pass: '✓', fail: '✕', skip: '–' };
    return h('div.fc', {}, groups.map((g) => {
      const on = g.rows.filter((r) => r.on);
      const n = (st) => on.filter((r) => r.state === st).length;
      const failed = on.find((r) => r.state === 'fail');
      const pill = phase === 'setup' ? { cls: 'idle', text: `${on.length} steps` }
        : failed ? { cls: 'fail', text: 'Failed at: ' + failed.it.name }
          : on.some((r) => r.state === 'running') ? { cls: 'run', text: 'Running' }
            : on.length && on.every((r) => r.state === 'pass') ? { cls: 'pass', text: 'Passed' }
              : n('pass') + n('skip') + n('fail') === 0 ? { cls: 'idle', text: phase === 'done' ? 'Not run' : 'Waiting' }
                : { cls: 'idle', text: `${n('pass')} of ${on.length} passed` };
      const points = [];
      on.forEach((r) => { const b = balanceOf(r); if (b) points.push(Object.assign(b, { step: r.it.name })); });
      return h('section.fc-flow', { class: 'fc-' + pill.cls },
        h('header.fc-head', {},
          h('b', { text: g.name }),
          h('span.fc-pill', { class: pill.cls, text: pill.text, title: pill.text }),
          phase === 'setup' ? '' : h('span.fc-count', {}, h('span.mk-verified', { text: `✓ ${n('pass')}` }), h('span.mk-failing', { text: ` ✕ ${n('fail')}` }), n('skip') ? h('span.faint', { text: ` – ${n('skip')}` }) : '')),
        h('ol.fc-chain', {}, g.rows.map((r, i) => {
          const method = T.isWaitStep(r.it) ? 'WAIT' : T.isSocketStep(r.it) ? 'SOCKET' : (M.req(r.it).method || 'GET').toUpperCase();
          const detail = stepDetail(r);
          const ms = r.result && r.result.res && r.result.res.timeMs;
          return h('li.fc-node', {
            class: `st-${r.on ? r.state : 'off'}`, tabindex: 0,
            title: `${r.it.name}${detail ? '\n' + detail : ''}${phase === 'done' ? '\n\nClick to open this request' : phase === 'setup' ? '\n\nClick to include or leave out' : ''}`,
            onclick: () => onPick(r),
            onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick(r); } }
          },
            h('div.fc-top', {},
              h('span.fc-num', { text: r.on && r.state !== 'queued' ? icon[r.state] : String(i + 1) }),
              h('span.meth', { class: 'm-' + method, text: method.slice(0, 6) }),
              ms ? h('span.fc-ms', { text: ms + ' ms' }) : ''),
            h('div.fc-name', { text: r.it.name }),
            detail ? h('div.fc-detail', { text: detail }) : '');
        })),
        points.length ? goldGraph(points) : '');
    }));
  }

  T.runDialog = function (folder) {
    if (!S.coll) return;
    const items = [];
    M.walk(folder ? folder.item : S.coll.data.item, (it) => { if (!M.isFolder(it)) items.push(it); });
    if (!items.length) return T.toast('No requests in here', 'error');
    const title = folder ? folder.name : (S.coll.data.info && S.coll.data.info.name) || S.coll.name;
    const rows = items.map((it) => ({ it, risk: T.riskOf(it), state: 'queued', reason: '' }));
    // A "Flows" folder is a scripted scenario (log in, stake, settle, check balances): every step belongs,
    // in order, and a failed step makes the rest meaningless.
    const isFlow = /\bflows?\b/i.test(title) || (folder && (M.parentsOf(S.coll.data.item, folder) || []).some((p) => /\bflows?\b/i.test(p.name)));
    rows.forEach((r) => { r.on = isFlow || !r.risk; });
    let phase = 'setup', stop = false, failedStop = false;
    let view = isFlow ? (T.ls.get('runView', 'chart') === 'list' ? 'list' : 'chart') : 'list';

    const body = h('div.runner');
    const autoMark = h('input', { type: 'checkbox', id: 'run-automark', checked: true });
    const stopOnFail = h('input', { type: 'checkbox', id: 'run-stopfail', checked: !!isFlow });
    const delay = h('input', { type: 'number', id: 'run-delay', min: 0, max: 10000, step: 100, value: 300, style: 'width:90px' });
    const startBtn = h('button.primary', { text: isFlow ? '▶ Start test' : '🚀 Run all tests' });
    const stopBtn = h('button', { text: 'Stop', hidden: true });

    const icon = { queued: '·', running: '…', waiting: '✎', pass: '✓', fail: '✕', skip: '–', stopped: '·' };
    // A step that needs a person (an OTP, a new password) pauses the run here until they answer.
    let asking = null;
    const askFor = (r, asks) => new Promise((resolve) => {
      asking = { r, asks, resolve, values: asks.map((a) => { const v = T.localStore().get(a.var); return v == null ? '' : String(v); }) };
      draw();
      const first = body.querySelector('.run-ask input');
      if (first) first.focus();
    });
    const askPanel = () => {
      if (!asking) return '';
      const a = asking;
      return h('form.run-ask', { onsubmit: (ev) => { ev.preventDefault(); a.resolve(a.values.slice()); } },
        h('div', {}, h('b', { text: `Step ${rows.indexOf(a.r) + 1} needs your input` }), h('span.hint', { text: '  ' + a.r.it.name })),
        a.asks.map((q, i) => h('label.run-ask-field', { for: 'run-ask-' + i },
          h('span', { text: q.label || `Value for {{${q.var}}}` }),
          h('input', { id: 'run-ask-' + i, value: a.values[i], autocomplete: 'off', oninput: (ev) => { a.values[i] = ev.target.value; } }))),
        h('div.inline', {},
          h('button.primary', { type: 'submit', text: 'Continue ▶' }),
          h('button', { type: 'button', text: 'Skip this step', onclick: () => a.resolve(null) })));
    };
    const draw = () => {
      const chosen = rows.filter((r) => r.on);
      const done = rows.filter((r) => ['pass', 'fail', 'skip'].includes(r.state));
      const count = (st) => rows.filter((r) => r.state === st).length;
      const head = phase === 'setup'
        ? h('div.run-head', {},
          h('div', {}, h('b', { text: `${chosen.length} of ${rows.length} requests selected` }),
            h('span.hint', { text: isFlow ? ' · flow: every step runs in order, including ones that move coins — use test accounts' : ` · ${rows.filter((r) => r.risk).length} left unticked because they spend coins, delete, change an account or send an SMS` })),
          h('div.inline', {},
            h('button.ghost', { text: 'Select all', onclick: () => { rows.forEach((r) => { r.on = true; }); draw(); } }),
            h('button.ghost', { text: 'Safe only', onclick: () => { rows.forEach((r) => { r.on = !r.risk; }); draw(); } }),
            h('button.ghost', { text: 'None', onclick: () => { rows.forEach((r) => { r.on = false; }); draw(); } })),
          h('div.inline', {},
            h('label', { for: 'run-automark', class: 'inline' }, autoMark, 'Mark results ✓ / ✕ automatically'),
            h('label', { for: 'run-stopfail', class: 'inline' }, stopOnFail, 'Stop at the first failure'),
            h('label', { for: 'run-delay', class: 'inline' }, 'Pause', delay, 'ms between requests')))
        : h('div.run-head', {},
          h('div.run-progress', {}, h('span', { style: `width:${chosen.length ? Math.round(done.length / chosen.length * 100) : 0}%` })),
          h('div', {}, h('b', { text: phase === 'done' ? (failedStop ? 'Stopped at the first failure' : stop ? 'Stopped' : 'Finished') : `Running ${done.length + 1} of ${chosen.length}` }),
            h('span.run-sum', {}, h('span.mk-verified', { text: ` ✓ ${count('pass')}` }), h('span.mk-failing', { text: `  ✕ ${count('fail')}` }), h('span.faint', { text: `  – ${count('skip')} skipped` }))),
          phase === 'done' ? h('p.hint', { text: 'Click a row to open that request and its response.' }) : '');
      const openRow = (r) => {
        close();
        if (S.view === 'flows' && T.stepDetail) return T.stepDetail(r.it);
        M.parentsOf(S.coll.data.item, r.it).forEach((p) => S.open.add(p.id));
        S.sel = r.it; T.renderTree(); T.renderEditor(); T.renderResponse();
      };
      const toggle = isFlow ? h('div.seg', { role: 'group', 'aria-label': 'View' },
        ['chart', 'list'].map((v) => h('button', {
          class: view === v ? 'on' : '', text: v === 'chart' ? '◇ Flow chart' : '☰ List', 'aria-pressed': String(view === v),
          onclick: () => { view = v; T.ls.set('runView', v); draw(); }
        }))) : '';
      if (view === 'chart') {
        body.replaceChildren(head, askPanel(), toggle, flowChart(rows, phase, folder, (r) => {
          if (phase === 'setup') { r.on = !r.on; draw(); } else if (phase === 'done') openRow(r);
        }));
        startBtn.hidden = phase !== 'setup';
        stopBtn.hidden = phase !== 'running';
        const live = body.querySelector('.fc-node.st-running');
        if (live) live.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }
      const list = h('div.run-list', {}, rows.map((r) => {
        const method = T.isWaitStep(r.it) ? 'WAIT' : (M.req(r.it).method || 'GET').toUpperCase();
        const parents = (M.parentsOf(S.coll.data.item, r.it) || []).slice(folder ? (M.parentsOf(S.coll.data.item, folder) || []).length + 1 : 0);
        return h('div.run-row', {
          class: `st-${r.state}${r.on ? '' : ' off'}`,
          onclick: () => {
            if (phase === 'setup') { r.on = !r.on; draw(); return; }
            if (phase !== 'done') return;
            openRow(r);
          }
        },
          phase === 'setup' ? h('input', { type: 'checkbox', checked: r.on, tabindex: -1, 'aria-label': 'Include ' + r.it.name }) : h('span.run-ico', { text: r.on ? icon[r.state] : '' }),
          h('span.meth', { class: 'm-' + method, text: method.slice(0, 6) }),
          h('span.run-name', {}, r.it.name, parents.length ? h('span.faint', { text: '  ' + parents.map((p) => p.name).join(' › ') }) : ''),
          h('span.run-why', { text: phase === 'setup' ? (r.risk ? '⚠ ' + r.risk : '') : (r.on ? r.reason : 'not selected'), title: r.reason || r.risk || '' }));
      }));
      body.replaceChildren(head, askPanel(), toggle, list);
      startBtn.hidden = phase !== 'setup';
      stopBtn.hidden = phase !== 'running';
    };

    const close = T.modal(isFlow ? `Flow test: ${title}` : `Run all tests: ${title}`, body, [
      { label: 'Close', run: (c) => c() }
    ], () => { stop = true; if (asking) asking.resolve(null); });
    if (isFlow) document.querySelector('#overlay .modal').classList.add('wide');
    const footer = document.querySelector('#overlay .modal footer');
    footer.prepend(stopBtn, startBtn);

    stopBtn.onclick = () => { stop = true; stopBtn.disabled = true; if (asking) asking.resolve(null); };
    startBtn.onclick = async () => {
      const chosen = rows.filter((r) => r.on);
      if (!chosen.length) return T.toast('Tick at least one request', 'error');
      if (S.sending) return T.toast('A request is still sending — wait a moment', 'error');
      const mark = autoMark.checked, haltOnFail = stopOnFail.checked, pause = Math.max(0, Math.min(10000, Number(delay.value) || 0));
      phase = 'running'; S.sending = true; draw();
      try {
        const jumps = { count: 0 };
        for (let i = 0; i < chosen.length;) {
          const r = chosen[i];
          if (stop) break;
          const asks = T.stepAsks ? T.stepAsks(r.it) : [];
          if (asks.length) {
            r.state = 'waiting'; r.reason = 'waiting for your input';
            const answers = await askFor(r, asks);
            asking = null;
            if (answers === null) {
              if (stop) { r.state = 'queued'; r.reason = ''; break; }
              r.state = 'skip'; r.reason = 'skipped — no input given'; draw();
              i++; continue;
            }
            answers.forEach((v, i2) => T.localStore().set(asks[i2].var, v));
          }
          r.state = 'running'; draw();
          const result = await T.execute(r.it, { skipEmpty: true, onRetry: (n, rep) => { r.reason = `try ${n} of ${rep.max} did not pass — again in ${rep.every} s`; draw(); } });
          r.result = result;
          const j = T.judge(result);
          r.state = j.verdict; r.reason = j.reason;
          const go = T.flowAdvance ? T.flowAdvance(chosen, i, r, jumps) : { next: i + 1 };
          if (mark && r.state !== 'skip') await T.setMark(r.it, r.state === 'pass' ? 'verified' : 'failing', r.state === 'fail' ? 'Auto run: ' + r.reason : '', { quiet: true });
          if (S.envDirty) await T.saveEnv(true);
          if (haltOnFail && r.state === 'fail') { stop = true; failedStop = true; }
          draw();
          if (go.ended) break;
          i = go.next;
          if (pause && !stop) await new Promise((res) => setTimeout(res, pause));
        }
      } finally {
        S.sending = false;
        phase = 'done'; draw();
        T.renderTree(); T.renderMarkBar(); T.renderResponse();
        if (S.view === 'flows') T.renderEditor();
        if (T.shareReport) footer.prepend(h('button', { text: '🔗 Share report', title: 'Save this run as a page anyone can open, and copy its link', onclick: () => T.shareReport(title, [{ name: title, rows: rows.filter((r) => r.on) }]) }));
      }
    };
    draw();
  };

  /* ── response ──────────────────────────────────────────────────────────── */

  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');

  /** Pretty JSON as coloured spans (text nodes only — never innerHTML with response data). */
  function jsonNode(text) {
    const pre = h('pre.code');
    if (text.length > 400000) { pre.textContent = text; return pre; }
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) pre.append(text.slice(last, m.index));
      const cls = m[1] ? (m[2] ? 'j-key' : 'j-str') : m[3] ? 'j-lit' : 'j-num';
      pre.append(h('span', { class: cls, text: m[1] || m[0] }));
      if (m[2]) pre.append(m[2]);
      last = re.lastIndex;
    }
    pre.append(text.slice(last));
    return pre;
  }

  let resTab = 'body', pretty = true;

  /** After a send the tester is looking at the answer — let them give the verdict right there. */
  function markButtons(it) {
    const status = T.statusOf(it);
    return h('span.res-mark', {},
      status === 'verified' ? h('span.mk-done.mk-verified', { text: '✓ Verified' })
        : h('button.mk-btn.mk-verified', { title: 'Tested & verified', onclick: () => T.setMark(it, 'verified') }, h('span.mk-ico', { text: '✓' }), 'Mark verified'),
      status === 'failing' ? h('span.mk-done.mk-failing', { text: '✕ Not working' })
        : h('button.mk-btn.mk-failing', { title: 'Not working as expected', onclick: () => T.markFailing(it) }, h('span.mk-ico', { text: '✕' }), 'Not working'));
  }

  T.renderResponse = function () {
    if (!R.response) return;
    R.response.hidden = !!(S.coll && S.view === 'flows');
    if (R.response.hidden) return;
    const it = S.sel;
    const r = it && !M.isFolder(it) ? S.results.get(it.id) : null;
    if (!r) {
      R.response.replaceChildren(h('div.idle', {}, it && !M.isFolder(it) ? ['Press ', h('b', { text: 'Send' }), ' to see the response.', h('br'), h('span.faint', { text: 'Ctrl/Cmd+Enter sends · Ctrl/Cmd+S saves' })] : ''));
      return;
    }
    if (r.pending) { R.response.replaceChildren(h('div.idle', {}, h('span.spinner'), ' Sending…')); return; }
    if (r.skipped) { R.response.replaceChildren(h('div.idle', {}, 'Not sent by the runner: ' + r.skipped)); return; }

    const parts = [];
    const out = r.out || { logs: [], tests: [], errors: [] };
    if (r.error) {
      parts.push(h('div.error-box', { text: r.error }));
      if (r.missing && r.missing.length) parts.push(h('div.inline', { style: 'margin-top:8px' }, h('button', { text: 'Set these variables', onclick: () => T.envDialog(r.missing) })));
      out.errors.forEach((e) => parts.push(h('div.error-box', { text: e })));
      if (out.logs.length) parts.push(h('div.section-title', { text: 'Console' }), h('pre.code', { text: out.logs.join('\n') }));
      R.response.replaceChildren(...parts);
      return;
    }

    const res = r.res;
    const cls = 's' + String(res.status).charAt(0);
    const passed = out.tests.filter((x) => x.ok).length;
    parts.push(h('div.res-meta', {},
      h('span.pill', { class: cls, text: `${res.status} ${res.reason || ''}`.trim() }),
      h('span', { text: res.timeMs + ' ms' }),
      h('span', { text: fmtSize(res.size) + (res.truncated ? ' (truncated)' : '') }),
      h('span.faint', { text: res.via === 'server' ? `via server → ${res.address}` : 'from your browser' }),
      res.note ? h('span.warn', { text: res.note }) : '',
      markButtons(it)));
    out.errors.forEach((e) => parts.push(h('div.error-box', { text: e })));

    const headerCount = (res.headers || []).length;
    const tabs = h('div.tabs', {}, [
      ['body', 'Body', ''], ['headers', 'Headers', headerCount], ['tests', 'Tests', out.tests.length ? `${passed}/${out.tests.length}` : ''], ['console', 'Console', out.logs.length || '']
    ].map(([key, label, n]) => h('button.tab', { class: resTab === key ? 'on' : '', onclick: () => { resTab = key; T.renderResponse(); } }, label, n !== '' ? h('span.n', { text: n }) : '')));
    parts.push(tabs);

    const view = h('div.res-body');
    if (resTab === 'body') {
      let text = res.body;
      let parsed = null;
      if (text != null) { try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ } }
      const tools = h('div.inline', { style: 'margin-bottom:6px' });
      if (parsed !== null) tools.append(h('button.ghost', { text: pretty ? 'Raw' : 'Pretty', onclick: () => { pretty = !pretty; T.renderResponse(); } }));
      tools.append(h('button.ghost', { text: 'Copy', onclick: () => navigator.clipboard.writeText(text || '').then(() => T.toast('Copied')) }));
      if (r.sent) tools.append(h('span.faint', { style: 'font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: r.sent.url, text: `${r.sent.method} ${r.sent.url}` }));
      view.append(tools);
      if (text == null) view.append(h('p.hint', { text: `Binary response (${fmtSize(res.size)}) — not shown.` }));
      else if (text === '') view.append(h('p.hint', { text: 'Empty body.' }));
      else if (parsed !== null && pretty) view.append(jsonNode(JSON.stringify(parsed, null, 2)));
      else view.append(h('pre.code', { text: text.length > 2000000 ? text.slice(0, 2000000) + '\n… (cut at 2 MB)' : text }));
    } else if (resTab === 'headers') {
      view.append(h('table.headers', {}, (res.headers || []).map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { text: v })))));
      if (res.via === 'browser') view.append(h('p.hint', { text: 'From the browser only CORS-exposed headers are visible.' }));
    } else if (resTab === 'tests') {
      if (!out.tests.length) view.append(h('p.hint', { text: 'No pm.test(...) calls in this request\'s scripts.' }));
      out.tests.forEach((x) => view.append(h('div.test-row', { class: x.ok ? 'ok' : 'bad', text: x.name + (x.error ? ' — ' + x.error : '') })));
    } else {
      view.append(out.logs.length ? h('pre.code', { text: out.logs.join('\n') }) : h('p.hint', { text: 'Nothing logged.' }));
    }
    parts.push(view);
    R.response.replaceChildren(...parts);
  };

  /* ── dialogs ───────────────────────────────────────────────────────────── */

  /** onClose runs however the dialog closes (a button, ×, Escape, or a click outside). */
  T.modal = function (title, body, buttons, onClose) {
    const overlay = document.getElementById('overlay');
    const close = () => { overlay.replaceChildren(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const box = h('div.modal', { role: 'dialog', 'aria-label': title },
      h('header', {}, h('span.grow', { text: title }), h('button.ghost', { text: '×', title: 'Close', onclick: close })),
      h('div.body', {}, body),
      h('footer', {}, (buttons || []).map((b) => h('button', { class: b.kind || '', text: b.label, onclick: () => b.run(close) }))));
    overlay.replaceChildren(box);
    overlay.onclick = (ev) => { if (ev.target === overlay) close(); };
    return close;
  };

  /** Environments + collection variables. `need` = variable names to add as empty rows. */
  T.envDialog = function (need) {
    let tab = S.env ? 'env' : (S.envs.length ? 'env' : 'coll');
    const body = h('div');
    const draw = () => {
      const tabs = h('div.tabs', {},
        h('button.tab', { class: tab === 'env' ? 'on' : '', text: 'Environment', onclick: () => { tab = 'env'; draw(); } }),
        h('button.tab', { class: tab === 'coll' ? 'on' : '', text: 'Collection variables', onclick: () => { tab = 'coll'; draw(); } }));
      const parts = [tabs];
      if (tab === 'env') {
        const pick = h('select', {
          onchange: async () => { await T.openEnv(pick.value); draw(); T.renderEditor(); }
        }, h('option', { value: '', text: '— none —' }), S.envs.map((e) => h('option', { value: e.id, text: e.name, selected: S.env && S.env.id === e.id })));
        parts.push(h('div.inline', { style: 'margin-bottom:10px' }, pick,
          h('button', { text: '+ New', onclick: () => T.newEnvironment().then(draw) }),
          S.env ? h('button', { text: 'Export', onclick: () => download(`${S.env.name}.postman_environment.json`, S.env.data) }) : '',
          S.env && S.me.role === 'admin' ? h('button.danger', { text: 'Delete', onclick: () => deleteDoc('environments', S.env).then(draw) }) : ''));
        if (S.env) {
          addNeeded(S.env.data.values, 'enabled');
          const name = h('input', { value: S.env.name, oninput: () => { S.env.data.name = name.value; S.env.name = name.value; S.envDirty = true; } });
          parts.push(h('div.field', {}, h('label', { text: 'Name' }), name),
            T.kvTable(S.env.data.values, { flag: 'enabled', keyHint: 'Variable', valueHint: 'Value', onChange: () => { S.env.data.values.forEach((v) => { if (!v.type) v.type = 'default'; if (!('enabled' in v)) v.enabled = true; }); S.envDirty = true; } }),
            h('p.hint', { text: 'Environments are shared with the whole team. Values set by scripts (like a login token) save automatically.' }));
        } else {
          parts.push(h('p.hint', { text: 'No environment selected. Create one for values like BaseUrl and token, so switching dev/prod is one click.' }));
        }
      } else if (S.coll) {
        const vars = S.coll.data.variable = S.coll.data.variable || [];
        addNeeded(vars, 'disabled');
        parts.push(T.kvTable(vars, { keyHint: 'Variable', onChange: T.markDirty }),
          h('p.hint', { text: 'Stored inside the collection (exported with it). Environment values win over these. Save the collection to keep changes.' }));
      }
      body.replaceChildren(...parts);
    };
    const addNeeded = (list, flag) => {
      for (const k of need || []) if (!list.some((v) => v.key === k)) list.push(flag === 'enabled' ? { key: k, value: '', type: 'default', enabled: true } : { key: k, value: '' });
      need = null;
    };
    draw();
    T.modal('Variables', body, [
      { label: 'Close', run: async (close) => { await T.saveEnv(); close(); T.renderEditor(); } },
      { label: 'Save', kind: 'primary', run: async (close) => { await T.saveEnv(); if (S.dirty && tab === 'coll') await T.saveColl(); close(); T.renderEditor(); } }
    ]);
  };

  T.newEnvironment = async function () {
    const name = prompt('Environment name', 'Dev');
    if (!name) return;
    const data = { name: name.trim(), values: [{ key: 'BaseUrl', value: 'https://', type: 'default', enabled: true }, { key: 'token', value: '', type: 'secret', enabled: true }], _postman_variable_scope: 'environment' };
    const r = await T.api('POST', '/api/tester/environments', { data });
    S.envs.push(r); S.envs.sort((a, b) => a.name.localeCompare(b.name));
    await T.openEnv(r.id);
  };

  T.newCollection = async function () {
    const name = prompt('Collection name', 'New collection');
    if (!name) return;
    const r = await T.api('POST', '/api/tester/collections', { data: { info: { name: name.trim(), schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] } });
    S.colls.push(r); S.colls.sort((a, b) => a.name.localeCompare(b.name));
    await T.openColl(r.id);
  };

  async function deleteDoc(kind, doc) {
    if (!confirm(`Delete "${doc.name}" for everyone? This can't be undone.`)) return;
    try {
      await T.api('DELETE', `/api/tester/${kind}/${doc.id}`);
      if (kind === 'environments') { S.envs = S.envs.filter((e) => e.id !== doc.id); S.env = null; S.envDirty = false; T.ls.set('env', ''); T.renderTop(); }
      else { S.colls = S.colls.filter((c) => c.id !== doc.id); S.coll = null; S.dirty = false; S.sel = null; if (S.colls[0]) await T.openColl(S.colls[0].id); else T.renderAll(); }
      T.toast('Deleted');
    } catch (e) { T.toast(e.message, 'error'); }
  }

  function download(filename, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: filename.replace(/[\\/:*?"<>|]+/g, '_') });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  T.collMenu = function (anchor) {
    const entries = [{ label: 'New collection', run: () => T.newCollection() }];
    if (S.coll) {
      entries.push(
        { label: 'Rename collection', run: () => { const n = prompt('Collection name', S.coll.data.info.name); if (n && n.trim()) { S.coll.data.info.name = n.trim(); T.markDirty(); T.saveColl(); } } },
        { label: '▶ Run whole collection…', run: () => T.runDialog(null) },
        { label: 'Find & replace in URLs…', run: () => replaceDialog() },
        { label: 'Export (Postman v2.1)', run: () => download(`${S.coll.data.info.name}.postman_collection.json`, S.coll.data) },
        '-', { label: 'Reload from server', run: async () => { if (!S.dirty || confirm('Discard unsaved changes?')) await T.openColl(S.coll.id); } });
      if (S.me.role === 'admin') entries.push({ label: 'Delete collection', danger: true, run: () => deleteDoc('collections', S.coll) });
    }
    T.menu(anchor, entries);
  };

  function replaceDialog() {
    const find = h('input', { placeholder: 'http://localhost:2053/', spellcheck: 'false' });
    const repl = h('input', { placeholder: '{{BaseUrl}}', spellcheck: 'false' });
    const info = h('p.hint', { text: 'Type what to find.' });
    const hits = () => { const f = find.value; const list = []; if (f) M.walk(S.coll.data.item, (it) => { if (!M.isFolder(it) && M.urlRaw(M.req(it)).includes(f)) list.push(it); }); return list; };
    const update = () => { const n = hits().length; info.textContent = find.value ? `${n} request URL${n === 1 ? '' : 's'} contain it.` : 'Type what to find.'; };
    find.addEventListener('input', update);
    T.modal('Find & replace in URLs', h('div', {},
      h('div.field', {}, h('label', { text: 'Find' }), find),
      h('div.field', {}, h('label', { text: 'Replace with' }), repl), info,
      h('p.hint', { text: 'Handy for pointing localhost:2053 requests at {{BaseUrl}} so an environment decides the server. Include "http://" in Find when the URLs have it — run it once with and once without.' })), [
      { label: 'Cancel', run: (close) => close() },
      {
        label: 'Replace all', kind: 'primary', run: (close) => {
          const list = hits();
          list.forEach((it) => { const req = M.req(it); M.setUrl(req, M.urlRaw(req).split(find.value).join(repl.value)); });
          if (list.length) { T.markDirty(); T.renderTree(); T.renderEditor(); }
          T.toast(`Updated ${list.length} request${list.length === 1 ? '' : 's'} — Save to keep it`);
          close();
        }
      }
    ]);
    find.focus();
  }

  /** Short text for one side of a conflict: the body text, a header list, a script — not raw JSON where avoidable. */
  function conflictPreview(c, v) {
    if (c.unit === 'deleted') return v === 'delete' ? 'Delete it' : 'Keep it, with the edits';
    if (v === undefined) return '(removed)';
    let text;
    if (v && typeof v === 'object') {
      if (typeof v.raw === 'string') text = v.raw;
      else if (Array.isArray(v) && v.every((x) => x && x.script)) text = v.map((e) => [].concat(e.script.exec || []).join('\n')).join('\n');
      else if (Array.isArray(v) && v.every((x) => x && 'key' in x)) text = v.map((x) => `${x.disabled ? '// ' : ''}${x.key}: ${x.value}`).join('\n');
      else if ('key' in v && 'value' in v) text = `${v.key} = ${v.value}`;
      else text = JSON.stringify(v, null, 2);
    } else text = String(v);
    text = text || '(empty)';
    return text.length > 600 ? text.slice(0, 600) + '\n…' : text;
  }

  /**
   * Fields that both this page and `who` changed since the last load. Resolves {conflictId: 'mine' |
   * 'theirs'} — every row starts on "mine", since saving is what brought the user here — or null.
   */
  T.conflictDialog = function (conflicts, who) {
    return new Promise((resolve) => {
      const choices = {};
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const rows = conflicts.map((c) => {
        choices[c.id] = 'mine';
        const option = (side, title) => h('label.choice', {},
          h('input', { type: 'radio', name: 'c-' + c.id, checked: side === 'mine', onchange: () => { choices[c.id] = side; } }),
          h('div', {}, h('div.choice-title', { text: title }), h('pre.code', { text: conflictPreview(c, c[side]) })));
        return h('div.conflict', {},
          h('div.conflict-head', {}, h('b', { text: c.label }), h('span.faint', { text: ' · ' + M.unitLabel(c.unit) })),
          h('div.choices', {}, option('mine', 'Keep mine'), option('theirs', `Keep ${who || 'theirs'}`)));
      });
      T.modal(`You and ${who || 'a teammate'} changed the same thing`, h('div', {},
        h('p.hint', { text: `Everything else is merged automatically. ${conflicts.length === 1 ? 'Pick' : 'For each of these, pick'} which version to keep:` }),
        rows), [
        { label: 'Cancel', run: (close) => close() },
        { label: 'Merge', kind: 'primary', run: (close) => { finish(choices); close(); } }
      ], () => finish(null));
    });
  };

  /** Keep this page's edits as a new collection (when the shared one was deleted meanwhile). */
  T.saveAsCopy = async function () {
    try {
      const data = M.clone(S.coll.data); data.info = data.info || {}; data.info.name = (data.info.name || S.coll.name) + ' (my copy)';
      const r = await T.api('POST', '/api/tester/collections', { data });
      S.colls.push(r); S.dirty = false; await T.openColl(r.id); T.toast('Saved as a new collection');
    } catch (e) { T.toast('Could not save a copy: ' + e.message, 'error'); }
  };

  /* ── import ────────────────────────────────────────────────────────────── */

  T.importFile = function () {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch (e) { return T.toast('That file is not valid JSON', 'error'); }
      if (data && data.collection && data.collection.item) data = data.collection;          // Postman API export wrapper
      if (data && data.environment && data.environment.values) data = data.environment;
      try {
        if (data && Array.isArray(data.item)) {
          if (!data.info || !String(data.info.schema || '').includes('v2')) T.toast('Not marked as v2.1 — importing anyway; check it looks right', 'error');
          const r = await T.api('POST', '/api/tester/collections', { data });
          S.colls.push(r); S.colls.sort((a, b) => a.name.localeCompare(b.name));
          if (S.dirty && !confirm('Open the imported collection and discard unsaved changes here?')) { T.renderTop(); return; }
          await T.openColl(r.id);
          T.toast(`Imported "${r.name}" — ${M.countRequests(S.coll.data.item)} requests`);
        } else if (data && Array.isArray(data.values)) {
          const r = await T.api('POST', '/api/tester/environments', { data });
          S.envs.push(r); S.envs.sort((a, b) => a.name.localeCompare(b.name));
          await T.openEnv(r.id);
          T.toast(`Imported environment "${r.name}"`);
        } else {
          T.toast('Not a Postman collection or environment file', 'error');
        }
      } catch (e) { T.toast('Import failed: ' + e.message, 'error'); }
    });
    document.body.append(input);
    input.click();
  };

  /* ── shortcuts ─────────────────────────────────────────────────────────── */

  document.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); T.saveColl(); }
    else if (mod && ev.key === 'Enter') { ev.preventDefault(); T.send(); }
  });
})();
