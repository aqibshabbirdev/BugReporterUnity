/* API tester — Flow graph: a flow drawn and edited as nodes and wires, the way Unreal's Blueprints do it. Extends `T`.
 *
 * Gray wires are the order the steps run in. Green wires carry a value one step kept ({{p1_token}}, {{flow_tx}})
 * into a later step that uses or checks it. After a run every pin shows the value that actually flowed through
 * it, so "where did the coins go" is visible without opening a single response.
 *
 * The collection stays the only truth: a wire is a "keep as {{name}}" entry on the step it starts from, a check
 * node is one rule in that step's Flow-builder block (see flows.js). Editing here rewrites those blocks, so the
 * list builder and the graph always agree. Node positions live on the flow folder as `graph.pos`. */
(function () {
  'use strict';

  const { h, S } = T;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    kids.flat().forEach((k) => { if (k !== '' && k != null) el.append(k.nodeType ? k : document.createTextNode(String(k))); });
    return el;
  };

  /* ── reading a flow ────────────────────────────────────────────────────── */

  const SETS_RE = /pm\.(?:variables|environment|collectionVariables|globals)\.set\(\s*['"`]([A-Za-z0-9_.-]+)['"`]/g;
  const GETS_RE = /pm\.(?:variables|environment|collectionVariables|globals)\.get\(\s*['"`]([A-Za-z0-9_.-]+)['"`]/g;
  // Plumbing every step carries (host, app signature, wallet key) — folded into one pin so the real inputs stand out.
  const NOISE_RE = /(^|_)url$|signature|app_check|_key$|^agp_|^node_|^php_/i;
  const SECRET_RE = /pass|token|secret|key|signature/i;
  const FIELD_LABEL = { '@ok': 'Response looks OK', '@status': 'HTTP status', '@time': 'Response time (ms)' };
  const uniq = (a) => [...new Set(a)];
  const found = (re, text) => uniq(Array.from(String(text || '').matchAll(re), (m) => m[1]));
  const varName = (ref) => String(ref || '').replace(/^\{\{|\}\}$/g, '').trim();

  function bodyText(req) {
    const b = req.body;
    if (!b) return '';
    if (b.mode === 'raw') return b.raw || '';
    if (b.mode === 'urlencoded' || b.mode === 'formdata') return (b[b.mode] || []).map((x) => `${x.key}=${x.value}`).join('&');
    return '';
  }

  /** Leaf paths of a JSON body with their values — the values a step can keep or check. */
  function jsonPaths(body) {
    let j; try { j = JSON.parse(body); } catch (e) { return []; }
    const out = [];
    const walk = (v, path, depth) => {
      if (out.length >= 80 || depth > 5) return;
      if (v && typeof v === 'object') {
        const keys = Array.isArray(v) ? (v.length ? [0] : []) : Object.keys(v);
        if (!keys.length && path) out.push({ path, value: JSON.stringify(v) });
        keys.forEach((k) => walk(v[k], path ? `${path}.${k}` : String(k), depth + 1));
      } else if (path) out.push({ path, value: v === null ? 'null' : String(v) });
    };
    walk(j, '', 0);
    return out;
  }

  /** The label a rule's test starts with (flows.js names them that way), to pair rules with results. */
  const ruleLabel = (rule) => (rule.field === '@ok' ? 'Response looks OK' : (FIELD_LABEL[rule.field] || rule.field) + ' ' + ((T.ruleOps[rule.op] || { label: rule.op }).label));

  /** Nodes with their pins, check nodes, and who feeds whom. `rows` are the runner rows ({it, state, result, reason}). */
  T.flowGraphModel = function (rows) {
    const producer = {};                       // variable → index of the last step that keeps it
    const nodes = [];
    const checks = [];
    rows.forEach((r, idx) => {
      const it = r.it;
      const req = M.req(it);
      const wait = T.isWaitStep(it);
      const meta = wait ? { save: [], rules: [], ask: [] } : T.stepMeta(it);
      const pre = M.script(it, 'prerequest'), test = M.script(it, 'test');
      const preSets = new Set(found(SETS_RE, pre));
      const kept = meta.save.map(([path, k]) => ({ k, path }));
      found(SETS_RE, test).forEach((k) => { if (!kept.some((o) => o.k === k)) kept.push({ k, path: null }); });
      const sock = T.isSocketStep(it) ? it.socket : null;
      const reqText = wait ? '' : sock
        ? [sock.url, sock.token, (sock.emit && sock.emit.event) || '', (sock.emit && sock.emit.data) || '', (sock.wait && sock.wait.event) || '', ...(sock.query || []).map((q) => q[1] || '')].join('\n')
        : [M.urlRaw(req), bodyText(req), ...(req.header || []).filter((x) => !x.disabled).map((x) => x.value || ''), req.auth && req.auth.type === 'bearer' ? M.bearerToken(req.auth) : ''].join('\n');
      const asked = new Set(meta.ask.map((a) => a.var));
      const inputs = uniq([...M.varsIn(reqText), ...found(GETS_RE, pre)]).filter((k) => !preSets.has(k) && !asked.has(k));
      const reads = found(GETS_RE, test).filter((k) => !kept.some((o) => o.k === k) && !preSets.has(k) && !inputs.includes(k));
      const pin = (k) => ({ k, from: producer[k] !== undefined ? producer[k] : null });
      const isNoise = (k) => NOISE_RE.test(k) && producer[k] === undefined;
      const shared = inputs.filter(isNoise);
      const allTests = (r.result && r.result.out && r.result.out.tests) || [];
      const used = new Set();
      const ruleTest = (rule) => { const lbl = ruleLabel(rule); const t = allTests.find((x) => !used.has(x) && x.name.startsWith(lbl)); if (t) used.add(t); return t || null; };
      const node = {
        type: 'step', it, idx, r, wait, meta, sock, repeat: it.repeat && Number(it.repeat.max) > 1 ? it.repeat : null,
        method: wait ? 'WAIT' : sock ? 'SOCKET' : String(req.method || 'GET').toUpperCase(),
        inputs: inputs.filter((k) => !isNoise(k)).map(pin), shared, reads: reads.map(pin), outputs: kept,
        asks: meta.ask,
        fields: r.result && r.result.res ? jsonPaths(r.result.res.body) : [],
        ran: !!(r.result && (r.result.res || r.result.error || r.result.skipped)),
        checks: []
      };
      meta.rules.forEach((rule, ri) => {
        const op = T.ruleOps[rule.op] || {};
        const rv = varName(rule.ref);
        const c = { type: 'check', id: `check:${it.id}:${ri}`, step: idx, ri, rule, needsRef: !!op.ref, refFrom: rv && producer[rv] !== undefined ? producer[rv] : null, refVar: rv, test: ruleTest(rule) };
        node.checks.push(c); checks.push(c);
      });
      node.tests = allTests.filter((t) => !used.has(t));
      if (it.branch && !wait) {
        const rv = varName(it.branch.ref);
        node.branch = { type: 'branch', id: `branch:${it.id}`, step: idx, rule: it.branch, needsRef: !!(T.ruleOps[it.branch.op] || {}).ref, refFrom: rv && producer[rv] !== undefined ? producer[rv] : null, refVar: rv, taken: r.branch || (r.result && r.result.branch) || null };
        const rvv = rv; if (rvv && !node.reads.some((p) => p.k === rvv) && !node.inputs.some((p) => p.k === rvv)) node.reads.push(pin(rvv));
      }
      kept.forEach((o) => { producer[o.k] = idx; });
      meta.ask.forEach((a) => { producer[a.var] = idx; });
      nodes.push(node);
    });
    const wires = [];
    nodes.forEach((n, i) => {
      if (i) wires.push({ kind: 'exec', from: i - 1, to: i });
      n.inputs.forEach((p, j) => { if (p.from !== null) wires.push({ kind: 'data', from: p.from, to: i, k: p.k, pin: ['in', j] }); });
      n.reads.forEach((p, j) => { if (p.from !== null) wires.push({ kind: 'data', from: p.from, to: i, k: p.k, pin: ['read', j] }); });
    });
    nodes.forEach((n) => { if (n.branch && n.branch.rule.then === 'jump') n.branch.target = nodes.findIndex((x) => x.it.id === n.branch.rule.to); });
    return { nodes, checks, wires };
  };

  /** The value a variable has right now, from the run's own values first. */
  function valueOf(k) {
    for (const s of T.scopes()) { const v = s.get(k); if (v !== undefined) return v; }
    return undefined;
  }
  const show = (k, v) => {
    if (v === undefined || v === null) return '';
    let s = String(v);
    if (SECRET_RE.test(k)) return s.length > 6 ? s.slice(0, 4) + '…' : '••••';
    if (/^-?\d+(\.\d+)?$/.test(s) && !/id|tx|phone|otp|code|no$/i.test(k)) { const n = Number(s); s = Math.abs(n) >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(n); }
    return s;
  };
  const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

  /* ── layout ────────────────────────────────────────────────────────────── */

  const W = 236, HEAD = 40, ROW = 17, PAD = 8, GAP_X = 96, GAP_Y = 56, CW = 236, CGAP = 14;
  let COLS = 3;

  const checkHeight = (c) => (c.rule.field === '@ok' ? 52 : 74) + (c.needsRef ? 22 : 0);
  const branchHeight = (b) => 96 + (b.needsRef ? 22 : 0);

  function measure(n) {
    const pinRows = Math.max(n.inputs.length + (n.shared.length ? 1 : 0) + n.asks.length, n.outputs.length + (n.wait ? 0 : 1));   // +1: the "pick a value" row
    const checkRows = n.reads.length + n.tests.length;
    n.pinTop = HEAD + (n.sock ? ROW * 2 : 0);   // a socket step shows what it sends and waits for under the title
    n.checkTop = n.pinTop + (pinRows ? pinRows * ROW + 6 : 0);
    n.h = n.checkTop + (checkRows ? 10 + checkRows * ROW : 0) + PAD;
    n.hTotal = n.h + n.checks.reduce((a, c) => a + CGAP + checkHeight(c), 0) + (n.branch ? CGAP + branchHeight(n.branch) : 0);
    return n;
  }

  function layout(nodes, saved) {
    nodes.forEach(measure);
    const rows = [];
    nodes.forEach((n, i) => { const r = Math.floor(i / COLS); (rows[r] = rows[r] || []).push(n); });
    let y = 20;
    rows.forEach((row) => {
      const tallest = Math.max(...row.map((n) => n.hTotal));
      row.forEach((n, ci) => { n.x = 20 + ci * (W + GAP_X); n.y = y; n.rowBottom = y + tallest; });
      y += tallest + GAP_Y;
    });
    nodes.forEach((n) => {
      const p = saved && saved[n.it.id]; if (p) { n.x = p[0]; n.y = p[1]; }
      let cy = n.y + n.h + CGAP;
      n.checks.forEach((c) => {
        c.x = n.x; c.y = cy; c.h = checkHeight(c);
        const q = saved && saved[c.id]; if (q) { c.x = q[0]; c.y = q[1]; }
        cy += c.h + CGAP;
      });
      if (n.branch) {
        const b = n.branch;
        b.x = n.x; b.y = cy; b.h = branchHeight(b);
        const q = saved && saved[b.id]; if (q) { b.x = q[0]; b.y = q[1]; }
      }
    });
  }

  const pinPos = (n, side, i) => ({ x: side === 'in' ? n.x : n.x + W, y: n.y + n.pinTop + i * ROW + 9 });
  const readPos = (n, i) => ({ x: n.x, y: n.y + n.checkTop + 10 + i * ROW + 9 });
  const execPos = (n, side) => ({ x: side === 'in' ? n.x : n.x + W, y: n.y + 16 });
  const respPos = (n) => ({ x: n.x + W, y: n.y + n.pinTop + n.outputs.length * ROW + 9 });   // the "pick a value" pin doubles as the response pin
  const checkInPos = (c) => ({ x: c.x, y: c.y + 13 });
  const checkRefPos = (c) => ({ x: c.x, y: c.y + c.h - 33 });
  const branchRefPos = (b) => ({ x: b.x, y: b.y + b.h - 55 });
  const branchOutPos = (b) => ({ x: b.x + CW, y: b.y + b.h - 31 });

  function wirePath(a, b) {
    const dx = Math.max(48, Math.min(160, Math.abs(b.x - a.x) / 2));
    return `M${a.x} ${a.y} C${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  /** The order wire: a curve to the next node on the right, or a route through the gap under the row when it wraps. */
  function execPath(a, b) {
    const from = execPos(a, 'out'), to = execPos(b, 'in');
    if (to.x > from.x) return wirePath(from, to);
    const mid = (a.rowBottom || a.y + a.hTotal) + GAP_Y / 2;
    const r = 10;
    return `M${from.x} ${from.y} h${20 - r} q${r} 0 ${r} ${r} V${mid - r} q0 ${r} -${r} ${r} H${to.x - 20 + r} q-${r} 0 -${r} ${r} V${to.y - r} q0 ${r} ${r} ${r} H${to.x}`;
  }

  /* ── drawing + editing ─────────────────────────────────────────────────── */

  const viewMem = new Map();      // flow id → last pan/zoom, kept across redraws of the page

  /**
   * The graph element. `rows` are runner rows and stay the source of truth for states and values; the runner
   * mutates them and calls el.refresh(). Edits go straight into the flow's steps (their builder blocks), then
   * `hooks.changed()` so the page rebuilds. `hooks.pick(r)` opens a step, `hooks.runTo(i)` runs up to step i.
   */
  T.flowGraph = function (rows, flow, hooks) {
    flow.graph = flow.graph || {};
    if (!flow.graph.pos) {
      flow.graph.pos = {};
      try { const old = JSON.parse(localStorage.getItem('fg:pos:' + flow.id) || 'null'); if (old) flow.graph.pos = old; } catch (e) { /* none */ }
    }
    const saved = flow.graph.pos;
    const view = viewMem.get(flow.id) || { x: 0, y: 0, k: 1, fitted: false };
    viewMem.set(flow.id, view);

    const scene = svg('g', { class: 'fg-scene' });
    const canvas = svg('svg', { class: 'fg', role: 'application', 'aria-label': `Graph of ${flow.name}` },
      svg('defs', {},
        svg('pattern', { id: 'fg-grid', width: 24, height: 24, patternUnits: 'userSpaceOnUse' }, svg('path', { d: 'M24 0H0V24', class: 'fg-gridline' })),
        svg('marker', { id: 'fg-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' }, svg('path', { d: 'M0 .5L8 4 0 7.5z', class: 'fg-arrowhead' }))),
      svg('rect', { class: 'fg-bg', width: '100%', height: '100%', fill: 'url(#fg-grid)' }),
      scene);
    const wrap = h('div.fg-wrap', {}, canvas);
    const outer = h('div.fg-outer', {}, wrap);

    const applyView = () => scene.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    let model = null;

    /* saving edits: the collection is marked dirty at once, written a moment later */
    let saveTimer = null;
    const persist = () => { T.markDirty(); clearTimeout(saveTimer); saveTimer = setTimeout(() => T.saveColl(), 700); };
    const apply = (msg) => { persist(); if (msg) T.toast(msg); hooks.changed && hooks.changed(); };
    const container = (it) => M.containerOf(S.coll.data, it) || flow.item;

    const fit = () => {
      if (!model || !model.nodes.length) return;
      const box = wrap.getBoundingClientRect();
      const all = model.nodes.concat(model.checks, model.nodes.filter((n) => n.branch).map((n) => n.branch));
      const minX = Math.min(...all.map((n) => n.x)) - 20, minY = Math.min(...all.map((n) => n.y)) - 20;
      const maxX = Math.max(...all.map((n) => n.x + W)) + 20, maxY = Math.max(...all.map((n) => n.y + n.h)) + 20;
      const k = Math.min(1.25, (box.width || 800) / (maxX - minX), (box.height || 520) / (maxY - minY));
      view.k = Math.max(0.3, k);
      view.x = ((box.width || 800) - (maxX - minX) * view.k) / 2 - minX * view.k;
      view.y = 12 - minY * view.k;
      view.fitted = true;
      applyView();
    };

    /* a wire being dragged from an output pin */
    const linkLayer = svg('g', { class: 'fg-linking' });
    const toScene = (clientX, clientY) => { const b = canvas.getBoundingClientRect(); return { x: (clientX - b.left - view.x) / view.k, y: (clientY - b.top - view.y) / view.k }; };
    const startLink = (ev, from, at) => {
      ev.stopPropagation(); ev.preventDefault();
      const path = svg('path', { class: 'fg-wire data linking', d: '' });
      linkLayer.replaceChildren(path);
      wrap.classList.add('linking');
      const move = (e) => { const p = toScene(e.clientX, e.clientY); path.setAttribute('d', wirePath(at, p)); };
      const up = (e) => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        linkLayer.replaceChildren();
        wrap.classList.remove('linking');
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const drop = target && target.closest ? target.closest('[data-drop]') : null;
        dropLink(from, drop ? drop.getAttribute('data-drop') : '', e);
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    };
    const anchorAt = (ev) => ({ getBoundingClientRect: () => ({ left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY }) });
    const dropLink = (from, spec, ev) => {
      const src = model.nodes[from.node];
      if (!spec) {
        if (!wrap.contains(document.elementFromPoint(ev.clientX, ev.clientY))) return;
        T.menu(anchorAt(ev), [
          { label: `Check {{${from.k}}} at step ${src.idx + 1}…`, run: () => addCheck(src, from.path || from.k) },
          { label: 'Cancel', run: () => {} }
        ]);
        return;
      }
      const [kind, a, b] = spec.split(':');
      if (kind === 'in') {
        const dst = model.nodes[Number(a)];
        if (dst.idx <= src.idx) return T.toast('A value can only flow forward — to a later step', 'error');
        if (!from.path) return T.toast(`{{${from.k}}} is set by a script in that step — rename it there, or keep a response field instead`, 'error');
        const meta = src.meta;
        const i = meta.save.findIndex(([, k]) => k === b);
        if (i >= 0) meta.save[i] = [from.path, b]; else meta.save.push([from.path, b]);
        T.setStepMeta(src.it, meta);
        apply(`Step ${src.idx + 1} now keeps ${from.path} as {{${b}}}`);
      } else if (kind === 'ref') {
        const dst = model.nodes[Number(a)];
        if (dst.idx < src.idx) return T.toast('Compare with a value from an earlier step', 'error');
        const rule = dst.meta.rules[Number(b)];
        if (!rule) return;
        rule.ref = `{{${from.k}}}`;
        T.setStepMeta(dst.it, dst.meta);
        apply(`Check compares with {{${from.k}}} from step ${src.idx + 1}`);
      } else if (kind === 'bref') {
        const dst = model.nodes[Number(a)];
        if (dst.idx < src.idx) return T.toast('Compare with a value from an earlier step', 'error');
        if (!dst.it.branch) return;
        dst.it.branch.ref = `{{${from.k}}}`;
        apply(`Branch compares with {{${from.k}}} from step ${src.idx + 1}`);
      }
    };

    /* editing helpers */
    const addCheck = (n, field, op) => {
      const rule = field === '@ok' ? { field } : { field, op: op || 'exists', value: '' };
      n.meta.rules.push(rule);
      T.setStepMeta(n.it, n.meta);
      apply(field === '@ok' ? 'Check added' : 'Check added — pick what it must be');
    };
    const keepField = (n, path) => {
      const last = path.split('.').filter((x) => !/^\d+$/.test(x)).pop() || 'value';
      let name = last.replace(/^_/, '').replace(/[^A-Za-z0-9_]/g, '_');
      if (valueOf(name) !== undefined || model.nodes.some((o) => o.outputs.some((x) => x.k === name))) name = `s${n.idx + 1}_${name}`;
      const v = prompt(`Keep ${path} for the steps after step ${n.idx + 1} as {{…}}:`, name);
      if (v === null) return;
      const k = v.trim().replace(/^\{\{|\}\}$/g, '');
      if (!k) return;
      const i = n.meta.save.findIndex(([p]) => p === path);
      if (i >= 0) n.meta.save[i] = [path, k]; else n.meta.save.push([path, k]);
      T.setStepMeta(n.it, n.meta);
      apply(`Step ${n.idx + 1} keeps ${path} as {{${k}}}`);
    };
    const askValue = (n) => {
      const v = prompt('Variable to ask the tester for while the flow runs, e.g. otp:', '');
      if (!v || !v.trim()) return;
      const label = prompt('Question to show:', `Enter ${v.trim()}`) || '';
      n.meta.ask.push({ var: v.trim(), label });
      T.setStepMeta(n.it, n.meta);
      apply('The flow will ask for this value at that step');
    };
    const addBranch = (n) => {
      n.it.branch = { field: '@status', op: 'is', value: '402', then: 'end' };
      apply('Branch added — say when it applies and where it goes');
    };
    const setRepeat = (n) => {
      const cur = n.it.repeat || { every: 3, max: 10 };
      const every = prompt('Send this step again every … seconds, until its checks pass:', String(cur.every));
      if (every === null) return;
      const max = prompt('Give up after how many tries?', String(cur.max));
      if (max === null) return;
      n.it.repeat = { every: Math.max(1, Number(every) || 3), max: Math.max(2, Math.round(Number(max)) || 10) };
      apply(`Step ${n.idx + 1} repeats every ${n.it.repeat.every} s, up to ${n.it.repeat.max} times`);
    };
    const insertAfter = (n, make) => {
      const list = container(n.it);
      const at = list.indexOf(n.it) + 1;
      if (make === 'wait') {
        const sec = prompt('Wait how many seconds?', '15');
        if (sec === null) return;
        list.splice(at, 0, T.waitStep(Number(sec) || 15));
        apply(`Wait added after step ${n.idx + 1}`);
      } else if (make === 'socket') socketForm(null, at);
      else addStepDialog(at);
    };
    /** Create or edit a socket step. */
    const socketForm = (it, at) => {
      const cfg = it ? JSON.parse(JSON.stringify(it.socket)) : { url: valueOf('socket_url') !== undefined ? '{{socket_url}}' : 'https://', query: [['_id', '{{p1_id}}'], ['type', 'web-client'], ['platform', 'web']], token: '{{p1_token}}', emit: { event: '', data: '' }, wait: { event: '', timeout: 20 } };
      const f = (label, el) => h('label.fg-sock-field', {}, h('span', { text: label }), el);
      const url = h('input.mono', { value: cfg.url, placeholder: 'https://agptech123.com/ or {{socket_url}}' });
      const token = h('input.mono', { value: cfg.token || '', placeholder: '{{p1_token}} (sent as auth.token)' });
      const qBox = h('div.fg-sock-q');
      const qRows = (cfg.query || []).map((q) => [q[0], q[1]]);
      const drawQ = () => qBox.replaceChildren(...qRows.map((q, i) => h('div.fg-sock-qrow', {},
        h('input.mono', { value: q[0], placeholder: 'key', oninput: (ev) => { q[0] = ev.target.value; } }),
        h('input.mono', { value: q[1], placeholder: 'value or {{variable}}', oninput: (ev) => { q[1] = ev.target.value; } }),
        h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { qRows.splice(i, 1); drawQ(); } }))),
        h('button.ghost', { text: '+ query value', onclick: () => { qRows.push(['', '']); drawQ(); } }));
      drawQ();
      const emitEv = h('input.mono', { value: (cfg.emit && cfg.emit.event) || '', placeholder: 'leave empty to only listen' });
      const emitData = h('textarea.mono', { rows: 3, placeholder: '{"room_id": 1, "amount": "{{flow_stake}}"}' }); emitData.value = (cfg.emit && cfg.emit.data) || '';
      const waitEv = h('input.mono', { value: (cfg.wait && cfg.wait.event) || '', placeholder: 'event name — empty = the first event that arrives' });
      const timeout = h('input', { type: 'number', min: 1, max: 300, value: (cfg.wait && cfg.wait.timeout) || 20, style: 'width:80px' });
      const name = h('input', { value: it ? it.name : '', placeholder: 'Step name, e.g. Wait for the round result' });
      const body = h('div.fg-sock', {},
        h('p.hint', { text: 'Connects with socket.io, sends one event if you give one, then waits for the event named below. Its payload becomes the step\'s response — keep or check values from it like any other step.' }),
        f('Step name', name),
        f('Socket URL', url),
        f('Query (handshake)', qBox),
        f('Token', token),
        f('Send event', emitEv),
        f('with data (JSON)', emitData),
        f('Wait for event', waitEv),
        f('Give up after', h('span.inline', {}, timeout, ' seconds')));
      T.modal(it ? 'Socket step' : 'Add a socket step', body, [
        { label: 'Cancel', run: (c) => c() },
        { label: it ? 'Save' : 'Add step', kind: 'primary', run: (c) => {
          const next = { url: url.value.trim(), query: qRows.filter((q) => q[0].trim()), token: token.value.trim(), emit: { event: emitEv.value.trim(), data: emitData.value }, wait: { event: waitEv.value.trim(), timeout: Number(timeout.value) || 20 } };
          if (!next.url) return T.toast('Give the socket URL', 'error');
          const nm = name.value.trim() || `⚡ ${next.wait.event || (next.emit.event ? 'send ' + next.emit.event : 'socket')}`;
          c();
          if (it) { it.socket = next; it.name = nm; M.req(it).url = { raw: next.url }; M.req(it).body = { mode: 'raw', raw: next.emit.data || '' }; apply('Socket step saved'); }
          else { const list = flow.item = flow.item || []; list.splice(at == null ? list.length : at, 0, T.socketStep(Object.assign({ name: nm }, next))); apply('Socket step added'); }
        } }
      ]);
    };
    const moveStep = (n, dir) => {
      const list = container(n.it);
      const i = list.indexOf(n.it), j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      list.splice(i, 1); list.splice(j, 0, n.it);
      apply();
    };
    const removeStep = (n) => {
      if (!confirm(`Remove "${n.it.name}" from this flow?`)) return;
      const list = container(n.it);
      list.splice(list.indexOf(n.it), 1);
      delete saved[n.it.id];
      apply('Step removed');
    };

    /* the "pick a value" popover: what a step answered, each value with Keep / Check */
    let pop = null;
    const closePop = () => { if (pop) { pop.remove(); pop = null; } };
    const openPicker = (n, at) => {
      closePop();
      const box = wrap.getBoundingClientRect();
      const list = h('div.fg-pop-list');
      const q = h('input', { placeholder: 'Search a field…', 'aria-label': 'Search fields' });
      const fill = () => {
        const s = q.value.trim().toLowerCase();
        const rows = n.fields.filter((f) => !s || f.path.toLowerCase().includes(s) || f.value.toLowerCase().includes(s));
        list.replaceChildren(...rows.slice(0, 60).map((f) => h('div.fg-pop-row', {},
          h('code', { text: f.path, title: f.path }), h('span.fg-pop-val', { text: cut(f.value, 24), title: f.value }),
          h('button.ghost', { text: 'Keep', title: 'Keep this value as {{name}} for the steps after this one', onclick: () => { closePop(); keepField(n, f.path); } }),
          h('button.ghost', { text: 'Check', title: 'Add a check on this value', onclick: () => { closePop(); addCheck(n, f.path); } }))));
        if (!rows.length) list.append(h('p.hint', { text: 'Nothing matches.' }));
      };
      q.addEventListener('input', fill);
      pop = h('div.fg-pop', {},
        h('div.fg-pop-head', {}, h('b', { text: `Step ${n.idx + 1} answered with` }), h('button.ghost', { text: '×', 'aria-label': 'Close', onclick: closePop })),
        n.fields.length ? [q, list] : h('div.fg-pop-empty', {},
          h('p', { text: 'This step has not run in this page yet, so its values are unknown.' }),
          h('button', { text: `▶ Run up to step ${n.idx + 1}`, onclick: () => { closePop(); hooks.runTo && hooks.runTo(n.idx); } })),
        h('div.fg-pop-foot', {},
          h('button.ghost', { text: '+ Response looks OK', disabled: n.meta.rules.some((r) => r.field === '@ok'), onclick: () => { closePop(); addCheck(n, '@ok'); } }),
          h('button.ghost', { text: '+ HTTP status is 2xx', onclick: () => { closePop(); addCheck(n, '@status', 'ok2xx'); } })));
      wrap.append(pop);
      fill();
      pop.style.left = Math.max(8, Math.min(at.x - box.left, box.width - 348)) + 'px';
      pop.style.top = Math.max(8, Math.min(at.y - box.top + 8, box.height - 120)) + 'px';
      if (n.fields.length) q.focus();
    };
    canvas.addEventListener('mousedown', closePop);

    /* the check node (HTML inside the SVG so the dropdowns are real dropdowns) */
    const checkNode = (c, nodes) => {
      const n = nodes[c.step];
      const rule = c.rule;
      const op = T.ruleOps[rule.op] || {};
      const state = c.test ? (c.test.ok ? 'pass' : 'fail') : 'idle';
      const g = svg('g', { class: `fg-check-g st-${state}`, transform: `translate(${c.x} ${c.y})`, 'data-check': c.id });
      g.append(svg('rect', { class: 'fg-check-box', width: CW, height: c.h, rx: 8 }));
      g.append(svg('circle', { class: 'fg-pin check', cx: 0, cy: 13, r: 4 }));
      if (c.needsRef) {
        g.append(svg('circle', { class: 'fg-pin in wired' + (c.refVar ? ' has' : ''), cx: 0, cy: c.h - 33, r: 4 }));
      }
      const fo = svg('foreignObject', { x: 0, y: 0, width: CW, height: c.h });
      const write = (msg) => { T.setStepMeta(n.it, n.meta); apply(msg); };
      const opSel = h('select', { 'aria-label': 'Condition', onchange: () => { rule.op = opSel.value; if (!(T.ruleOps[rule.op] || {}).ref) delete rule.ref; if (!(T.ruleOps[rule.op] || {}).value) rule.value = ''; write(); } },
        Object.entries(T.ruleOps).map(([k, v]) => h('option', { value: k, text: v.label, selected: rule.op === k })));
      const val = op.value ? h('input.mono', {
        value: rule.value == null ? '' : rule.value, placeholder: 'value or {{variable}}', 'aria-label': 'Amount', list: 'fg-vars',
        onchange: () => { rule.value = val.value; write(); }, onkeydown: (ev) => { if (ev.key === 'Enter') val.blur(); }
      }) : '';
      const refRow = c.needsRef ? h('div.fg-check-row.since', { 'data-drop': `ref:${c.step}:${c.ri}` },
        'since ',
        c.refVar ? h('b', { text: c.refFrom !== null ? `step ${c.refFrom + 1} · ${c.refVar}` : `{{${c.refVar}}}`, title: `{{${c.refVar}}}` }) : h('i', { text: 'drag a kept value here' }),
        c.refVar ? h('button.ghost', { text: '×', 'aria-label': 'Clear', onclick: () => { delete rule.ref; write(); } }) : '') : '';
      let resText = '';
      if (c.test) {
        const full = T.plainReason(c.test.name + (c.test.error && !c.test.name.includes(c.test.error) ? ' — ' + c.test.error : ''));
        const m = c.test.name.match(/ — (.*)$/);
        resText = (c.test.ok ? '✓ ' : '✕ ') + (c.test.ok ? (m ? m[1] : 'ok') : full);
      }
      const res = c.test ? h('div.fg-check-res', { class: c.test.ok ? 'ok' : 'bad', title: resText, text: cut(resText, 42) }) : h('div.fg-check-res.idle', { text: n.ran ? '' : 'not run yet' });
      const body = h('div.fg-check', {},
        h('div.fg-check-head', {},
          h('b', { text: state === 'pass' ? '✓ Check' : state === 'fail' ? '✕ Check' : 'Check' }),
          h('button.ghost', { text: '×', title: 'Remove this check', 'aria-label': 'Remove check', onclick: () => { n.meta.rules.splice(c.ri, 1); delete saved[c.id]; write('Check removed'); } })),
        rule.field === '@ok'
          ? h('div.fg-check-row.ok', { text: 'Response looks OK — HTTP 2xx, no "status": false' })
          : [h('div.fg-check-row', {}, h('input.mono.fg-field', { value: rule.field, list: `fg-fields-${n.idx}`, 'aria-label': 'Field', title: rule.field, onchange: (ev) => { rule.field = ev.target.value.trim() || rule.field; write(); }, onkeydown: (ev) => { if (ev.key === 'Enter') ev.target.blur(); } })),
            h('div.fg-check-row', {}, opSel, val)],
        refRow, res);
      body.addEventListener('mousedown', (ev) => { if (ev.target.closest('select, input, button')) ev.stopPropagation(); });
      fo.append(body);
      g.append(fo);
      // drag the check
      g.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        const press = { sx: ev.clientX, sy: ev.clientY, ox: c.x, oy: c.y, moved: false };
        const move = (e) => {
          const dx = (e.clientX - press.sx) / view.k, dy = (e.clientY - press.sy) / view.k;
          if (!press.moved && Math.hypot(dx, dy) < 3) return;
          press.moved = true; c.x = press.ox + dx; c.y = press.oy + dy;
          saved[c.id] = [Math.round(c.x), Math.round(c.y)];
          g.setAttribute('transform', `translate(${c.x} ${c.y})`); redrawWires();
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); if (press.moved) persist(); };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      });
      return g;
    };

    /** The branch node: "if <rule> then end / jump to step N / skip the next step". */
    const branchNode = (b, nodes) => {
      const n = nodes[b.step];
      const rule = b.rule;
      const op = T.ruleOps[rule.op] || {};
      const state = b.taken ? 'taken' : n.ran ? 'idle' : 'new';
      const g = svg('g', { class: `fg-branch-g st-${state}`, transform: `translate(${b.x} ${b.y})`, 'data-check': b.id });
      g.append(svg('rect', { class: 'fg-branch-box', width: CW, height: b.h, rx: 8 }));
      g.append(svg('circle', { class: 'fg-pin branch', cx: 0, cy: 13, r: 4 }));
      if (b.needsRef) g.append(svg('circle', { class: 'fg-pin in wired' + (b.refVar ? ' has' : ''), cx: 0, cy: b.h - 55, r: 4 }));
      if (rule.then === 'jump') g.append(svg('circle', { class: 'fg-pin exec branch', cx: CW, cy: b.h - 31, r: 4.5 }));
      const fo = svg('foreignObject', { x: 0, y: 0, width: CW, height: b.h });
      const write = (msg) => apply(msg);
      const field = h('input.mono', { value: rule.field, list: `fg-fields-${n.idx}`, placeholder: 'field, @status', 'aria-label': 'Field', onchange: () => { rule.field = field.value.trim() || '@status'; write(); }, onkeydown: (ev) => { if (ev.key === 'Enter') field.blur(); } });
      const opSel = h('select', { 'aria-label': 'Condition', onchange: () => { rule.op = opSel.value; if (!(T.ruleOps[rule.op] || {}).ref) delete rule.ref; if (!(T.ruleOps[rule.op] || {}).value) rule.value = ''; write(); } },
        Object.entries(T.ruleOps).map(([k, v]) => h('option', { value: k, text: v.label, selected: rule.op === k })));
      const val = op.value ? h('input.mono', { value: rule.value == null ? '' : rule.value, placeholder: 'value', 'aria-label': 'Value', list: 'fg-vars', onchange: () => { rule.value = val.value; write(); }, onkeydown: (ev) => { if (ev.key === 'Enter') val.blur(); } }) : '';
      const refRow = b.needsRef ? h('div.fg-check-row.since', { 'data-drop': `bref:${b.step}` },
        'since ', b.refVar ? h('b', { text: b.refFrom !== null ? `step ${b.refFrom + 1} · ${b.refVar}` : `{{${b.refVar}}}` }) : h('i', { text: 'drag a kept value here' }),
        b.refVar ? h('button.ghost', { text: '×', 'aria-label': 'Clear', onclick: () => { delete rule.ref; write(); } }) : '') : '';
      const thenSel = h('select', { 'aria-label': 'Then', onchange: () => { rule.then = thenSel.value; if (rule.then === 'jump' && !rule.to) { const other = nodes.find((x) => x.idx !== n.idx); rule.to = other ? other.it.id : null; } write(); } },
        h('option', { value: 'end', text: 'end the flow (passed)', selected: rule.then === 'end' }),
        h('option', { value: 'jump', text: 'jump to…', selected: rule.then === 'jump' }),
        h('option', { value: 'skip', text: 'skip the next step', selected: rule.then === 'skip' }));
      const toSel = rule.then === 'jump' ? h('select', { 'aria-label': 'Jump to', onchange: () => { rule.to = toSel.value; write(); } },
        nodes.filter((x) => x.idx !== n.idx).map((x) => h('option', { value: x.it.id, text: `${x.idx + 1} · ${cut(x.it.name, 22)}`, selected: rule.to === x.it.id }))) : '';
      const res = h('div.fg-check-res', { class: b.taken ? 'ok' : 'idle', text: b.taken ? '→ taken' : n.ran ? 'not taken — went on to the next step' : 'not run yet' });
      const body = h('div.fg-check.fg-branch', {},
        h('div.fg-check-head', {}, h('b', { text: '⑂ If' }), h('button.ghost', { text: '×', title: 'Remove this branch', 'aria-label': 'Remove branch', onclick: () => { delete n.it.branch; delete saved[b.id]; write('Branch removed'); } })),
        h('div.fg-check-row', {}, field),
        h('div.fg-check-row', {}, opSel, val),
        refRow,
        h('div.fg-check-row.then', {}, h('span.faint', { text: 'then' }), thenSel, toSel),
        res);
      body.addEventListener('mousedown', (ev) => { if (ev.target.closest('select, input, button')) ev.stopPropagation(); });
      fo.append(body);
      g.append(fo);
      g.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        const press = { sx: ev.clientX, sy: ev.clientY, ox: b.x, oy: b.y, moved: false };
        const move = (e) => {
          const dx = (e.clientX - press.sx) / view.k, dy = (e.clientY - press.sy) / view.k;
          if (!press.moved && Math.hypot(dx, dy) < 3) return;
          press.moved = true; b.x = press.ox + dx; b.y = press.oy + dy;
          saved[b.id] = [Math.round(b.x), Math.round(b.y)];
          g.setAttribute('transform', `translate(${b.x} ${b.y})`); redrawWires();
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); if (press.moved) persist(); };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      });
      return g;
    };

    const wireLayerRef = { el: null };
    const drawWires = () => {
      const { nodes, checks, wires } = model;
      const layer = svg('g', { class: 'fg-wires' });
      wires.forEach((w) => {
        const a = nodes[w.from], b = nodes[w.to];
        if (w.kind === 'exec') {
          layer.append(svg('path', { d: execPath(a, b), class: 'fg-wire exec st-' + (a.r.on === false ? 'off' : a.r.state), 'marker-end': 'url(#fg-arrow)' }));
        } else {
          const j = a.outputs.findIndex((o) => o.k === w.k);
          const to = w.pin[0] === 'in' ? pinPos(b, 'in', w.pin[1]) : readPos(b, w.pin[1]);
          const live = a.ran && valueOf(w.k) !== undefined;
          const p = svg('path', { d: wirePath(pinPos(a, 'out', Math.max(0, j)), to), class: 'fg-wire data' + (live ? ' live' : '') });
          p.append(svg('title', {}, `{{${w.k}}} — from step ${a.idx + 1} to step ${b.idx + 1}${live ? ' = ' + show(w.k, valueOf(w.k)) : ''}`));
          layer.append(p);
        }
      });
      nodes.filter((n) => n.branch).forEach((n) => {
        const b = n.branch;
        layer.append(svg('path', { d: wirePath(respPos(n), checkInPos(b)), class: 'fg-wire branch' + (b.taken ? ' live' : '') }));
        if (b.needsRef && b.refFrom !== null) {
          const a = nodes[b.refFrom];
          const j = a.outputs.findIndex((o) => o.k === b.refVar);
          layer.append(svg('path', { d: wirePath(pinPos(a, 'out', Math.max(0, j)), branchRefPos(b)), class: 'fg-wire data' + (a.ran ? ' live' : '') }));
        }
        if (b.rule.then === 'jump' && b.target >= 0) {
          const t = nodes[b.target];
          const p = svg('path', { d: wirePath(branchOutPos(b), execPos(t, 'in')), class: 'fg-wire branch jump' + (b.taken ? ' live' : ''), 'marker-end': 'url(#fg-arrow)' });
          p.append(svg('title', {}, `jumps to step ${t.idx + 1}`));
          layer.append(p);
        }
      });
      checks.forEach((c) => {
        const n = nodes[c.step];
        layer.append(svg('path', { d: wirePath(respPos(n), checkInPos(c)), class: 'fg-wire check' + (c.test ? ' live' : '') }));
        if (c.needsRef && c.refFrom !== null) {
          const a = nodes[c.refFrom];
          const j = a.outputs.findIndex((o) => o.k === c.refVar);
          const p = svg('path', { d: wirePath(pinPos(a, 'out', Math.max(0, j)), checkRefPos(c)), class: 'fg-wire data' + (a.ran ? ' live' : '') });
          p.append(svg('title', {}, `{{${c.refVar}}} kept by step ${a.idx + 1}`));
          layer.append(p);
        }
      });
      return layer;
    };
    const redrawWires = () => { const fresh = drawWires(); wireLayerRef.el.replaceWith(fresh); wireLayerRef.el = fresh; };

    const draw = () => {
      closePop();
      const width = wrap.getBoundingClientRect().width || 900;
      COLS = Math.max(2, Math.min(4, Math.floor((width - 40 + GAP_X) / (W + GAP_X))));
      model = T.flowGraphModel(rows);
      layout(model.nodes, saved);
      const { nodes, checks } = model;
      const nodeLayer = svg('g', { class: 'fg-nodes' });

      nodes.forEach((n) => {
        const r = n.r;
        const state = r.on === false ? 'off' : r.state || 'queued';
        const g = svg('g', { class: `fg-node st-${state}`, transform: `translate(${n.x} ${n.y})`, tabindex: 0, role: 'button' });
        g.append(svg('rect', { class: 'fg-box', width: W, height: n.h, rx: 8 }));
        g.append(svg('rect', { class: 'fg-head m-' + n.method, width: W, height: HEAD - 8, rx: 8 }));
        g.append(svg('rect', { class: 'fg-head-fix m-' + n.method, y: HEAD - 16, width: W, height: 8 }));
        const icon = { pass: '✓', fail: '✕', skip: '–', running: '…', waiting: '✎' }[state] || '';
        g.append(svg('circle', { class: 'fg-num', cx: 18, cy: 16, r: 9 }));
        g.append(svg('text', { class: 'fg-num-t', x: 18, y: 20, 'text-anchor': 'middle' }, String(n.idx + 1)));
        g.append(svg('text', { class: 'fg-meth', x: 34, y: 20 }, n.method + (icon ? '  ' + icon : '')));
        const ms = r.result && r.result.res && r.result.res.timeMs;
        const tries = r.result && r.result.tries;
        if (ms) g.append(svg('text', { class: 'fg-ms', x: W - 52, y: 20, 'text-anchor': 'end' }, (tries > 1 ? `try ${tries} · ` : '') + ms + ' ms'));
        if (n.repeat) {
          const chip = svg('text', { class: 'fg-rep', x: 34 + (n.method.length + (icon ? 3 : 0)) * 6.6 + 6, y: 20 }, `↻ ${n.repeat.every} s ×${n.repeat.max}`);
          chip.append(svg('title', {}, `Sent again every ${n.repeat.every} s until its checks pass, up to ${n.repeat.max} times`));
          g.append(chip);
        }
        if (n.sock) {
          const l1 = svg('text', { class: 'fg-sock-t', x: 8, y: HEAD + 12 }, cut((n.sock.emit && n.sock.emit.event ? '→ send ' + n.sock.emit.event + ' · ' : '') + 'wait for ' + ((n.sock.wait && n.sock.wait.event) || 'any event') + ` ≤ ${(n.sock.wait && n.sock.wait.timeout) || 20} s`, 38));
          l1.append(svg('title', {}, n.sock.url));
          const l2 = svg('text', { class: 'fg-sock-t faint', x: 8, y: HEAD + 12 + ROW }, cut(n.sock.url, 38));
          g.append(l1, l2);
        }
        const title = svg('text', { class: 'fg-title', x: 8, y: HEAD - 3 }, cut(n.it.name, 34));
        title.append(svg('title', {}, n.it.name));
        g.append(title);
        g.append(svg('circle', { class: 'fg-pin exec', cx: 0, cy: 16, r: 4.5 }));
        if (n.idx < nodes.length - 1) g.append(svg('circle', { class: 'fg-pin exec', cx: W, cy: 16, r: 4.5 }));

        // inputs (left)
        const rightRows = n.outputs.length + (n.wait ? 0 : 1);
        let li = 0;
        n.inputs.forEach((p) => {
          const row = li++;
          const y = n.pinTop + row * ROW + 9;
          const v = p.from === null || nodes[p.from].ran ? valueOf(p.k) : undefined;
          const has = v !== undefined && String(v) !== '';
          g.append(svg('circle', { class: 'fg-pin in' + (p.from !== null ? ' wired' : ' var') + (has ? ' has' : ''), cx: 0, cy: y, r: 4 }));
          g.append(svg('circle', { class: 'fg-drop', cx: 0, cy: y, r: 10, 'data-drop': `in:${n.idx}:${p.k}` }));
          const t = svg('text', { class: 'fg-pin-t', x: 9, y: y + 4 }, cut(p.k + (has ? ' · ' + show(p.k, v) : p.from === null ? ' · not set' : ''), row < rightRows ? 17 : 32));
          t.append(svg('title', {}, `{{${p.k}}}` + (p.from !== null ? ` — kept by step ${p.from + 1}` : ' — from Variables') + (has ? '\n= ' + (SECRET_RE.test(p.k) ? show(p.k, v) : v) : p.from === null ? '\nnot set' : '') + '\nDrag a kept value onto this pin to feed it from a step'));
          g.append(t);
        });
        n.asks.forEach((a) => {
          const row = li++;
          const y = n.pinTop + row * ROW + 9;
          g.append(svg('circle', { class: 'fg-pin in ask', cx: 0, cy: y, r: 4 }));
          const t = svg('text', { class: 'fg-pin-t ask', x: 9, y: y + 4 }, cut('asks for ' + a.var, row < rightRows ? 17 : 32));
          t.append(svg('title', {}, (a.label || `Value for {{${a.var}}}`) + '\nClick to stop asking'));
          t.addEventListener('mousedown', (ev) => ev.stopPropagation());
          t.addEventListener('click', () => { if (confirm(`Stop asking for {{${a.var}}} at this step?`)) { n.meta.ask = n.meta.ask.filter((x) => x !== a); T.setStepMeta(n.it, n.meta); apply(); } });
          g.append(t);
        });
        if (n.shared.length) {
          const row = li++;
          const y = n.pinTop + row * ROW + 9;
          const unset = n.shared.filter((k) => { const v = valueOf(k); return v === undefined || String(v) === ''; });
          g.append(svg('circle', { class: 'fg-pin in var' + (unset.length === n.shared.length ? '' : ' has'), cx: 0, cy: y, r: 4 }));
          const t = svg('text', { class: 'fg-pin-t noise', x: 9, y: y + 4 }, cut(`+ ${n.shared.length} shared value${n.shared.length === 1 ? '' : 's'}` + (unset.length ? ` · ${unset.length} not set` : ''), row < rightRows ? 17 : 32));
          t.append(svg('title', {}, 'Values every step carries, from Variables:\n' + n.shared.map((k) => `{{${k}}}` + (unset.includes(k) ? ' — not set' : '')).join('\n')));
          g.append(t);
        }
        // outputs (right) — draggable: drop on a later step's input pin or a check's "since" row
        const leftRows = li;
        n.outputs.forEach((o, i) => {
          const y = n.pinTop + i * ROW + 9;
          const v = n.ran ? valueOf(o.k) : undefined;
          const has = v !== undefined && String(v) !== '';
          const t = svg('text', { class: 'fg-pin-t out', x: W - 9, y: y + 4, 'text-anchor': 'end' }, cut((has ? show(o.k, v) + ' · ' : '') + o.k, i < leftRows ? 17 : 32));
          t.append(svg('title', {}, `keeps ${o.path ? o.path + ' as ' : ''}{{${o.k}}} for the steps after it` + (has ? '\n= ' + (SECRET_RE.test(o.k) ? show(o.k, v) : v) : '') + (o.path ? '\nClick to stop keeping it' : '')));
          if (o.path) {
            t.addEventListener('mousedown', (ev) => ev.stopPropagation());
            t.addEventListener('click', () => { if (confirm(`Stop keeping {{${o.k}}} at step ${n.idx + 1}?`)) { n.meta.save = n.meta.save.filter(([p]) => p !== o.path); T.setStepMeta(n.it, n.meta); apply(); } });
          }
          const pin = svg('circle', { class: 'fg-pin out' + (has ? ' has' : ''), cx: W, cy: y, r: 4 });
          const grab = svg('circle', { class: 'fg-grab', cx: W, cy: y, r: 10 });
          grab.append(svg('title', {}, `Drag {{${o.k}}} to a later step's input, or to a check's "since"`));
          grab.addEventListener('mousedown', (ev) => startLink(ev, { node: n.idx, k: o.k, path: o.path }, { x: n.x + W, y: n.y + y }));
          g.append(t, pin, grab);
        });
        if (!n.wait) {
          const y = n.pinTop + n.outputs.length * ROW + 9;
          const pick = svg('g', { class: 'fg-pick' });
          pick.append(svg('circle', { class: 'fg-pin out pick', cx: W, cy: y, r: 4 }));
          pick.append(svg('text', { class: 'fg-pin-t pick', x: W - 9, y: y + 4, 'text-anchor': 'end' }, n.fields.length ? '+ pick a value…' : '+ pick a value (run first)'));
          pick.append(svg('title', {}, 'Choose a value from this step\'s response to keep for later steps, or to check'));
          pick.addEventListener('mousedown', (ev) => ev.stopPropagation());
          pick.addEventListener('click', (ev) => { ev.stopPropagation(); openPicker(n, { x: ev.clientX, y: ev.clientY }); });
          g.append(pick);
        }
        // reads + leftover (script) tests
        if (n.reads.length || n.tests.length) {
          g.append(svg('line', { class: 'fg-sep', x1: 8, x2: W - 8, y1: n.checkTop + 4, y2: n.checkTop + 4 }));
          n.reads.forEach((p, i) => {
            const y = n.checkTop + 10 + i * ROW + 9;
            const v = p.from === null || nodes[p.from].ran ? valueOf(p.k) : undefined;
            const has = v !== undefined && String(v) !== '';
            g.append(svg('circle', { class: 'fg-pin read' + (p.from !== null ? ' wired' : ' var') + (has ? ' has' : ''), cx: 0, cy: y, r: 4 }));
            const t = svg('text', { class: 'fg-pin-t read', x: 9, y: y + 4 }, cut('compares ' + p.k + (has ? ' · ' + show(p.k, v) : ''), 30));
            t.append(svg('title', {}, `the step's script reads {{${p.k}}}` + (p.from !== null ? ` kept by step ${p.from + 1}` : ' from Variables') + (has ? '\n= ' + v : '')));
            g.append(t);
          });
          n.tests.forEach((tst, i) => {
            const y = n.checkTop + 10 + (n.reads.length + i) * ROW + 9;
            const text = T.plainReason(tst.name + (tst.error && !tst.name.includes(tst.error) ? ' — ' + tst.error : ''));
            const t = svg('text', { class: 'fg-test ' + (tst.ok ? 'ok' : 'bad'), x: 8, y: y + 4 }, cut((tst.ok ? '✓ ' : '✕ ') + text, 36));
            t.append(svg('title', {}, text));
            g.append(t);
          });
        } else if (state === 'fail' && r.reason) {
          const t = svg('text', { class: 'fg-test bad', x: 8, y: n.h - 6 }, cut('✕ ' + T.plainReason(r.reason), 36));
          t.append(svg('title', {}, T.plainReason(r.reason)));
          g.append(t);
        }
        // ▶ run to here, ⋯ menu
        const btn = (x, label, title, onclick) => {
          const b = svg('g', { class: 'fg-btn', transform: `translate(${x} ${HEAD - 16})` });
          b.append(svg('rect', { width: 20, height: 12, rx: 3 }));
          b.append(svg('text', { x: 10, y: 9.5, 'text-anchor': 'middle' }, label));
          b.append(svg('title', {}, title));
          b.addEventListener('mousedown', (ev) => ev.stopPropagation());
          b.addEventListener('click', (ev) => { ev.stopPropagation(); onclick(ev); });
          return b;
        };
        g.append(btn(W - 48, '▶', `Run the flow up to here (steps 1–${n.idx + 1})`, () => hooks.runTo && hooks.runTo(n.idx)));
        g.append(btn(W - 26, '⋯', 'More', (ev) => T.menu(anchorAt(ev), [
          { label: '▶ Run up to here', run: () => hooks.runTo && hooks.runTo(n.idx) },
          { label: 'Open request and response', run: () => hooks.pick && hooks.pick(r) },
          '-',
          ...(n.wait ? [] : [
            { label: '+ Pick a value to keep or check…', run: () => openPicker(n, { x: ev.clientX, y: ev.clientY }) },
            { label: '+ Response looks OK', run: () => addCheck(n, '@ok') },
            { label: '? Ask the tester for a value here…', run: () => askValue(n) },
            ...(n.branch ? [] : [{ label: '⑂ Add a branch — if … then jump / end', run: () => addBranch(n) }]),
            n.repeat ? { label: '↻ Stop repeating', run: () => { delete n.it.repeat; apply('Step runs once again'); } } : { label: '↻ Repeat until the checks pass…', run: () => setRepeat(n) },
            ...(n.sock ? [{ label: '⚡ Edit socket step…', run: () => socketForm(n.it) }] : []),
            '-']),
          { label: 'Insert a step after this…', run: () => insertAfter(n, 'step') },
          { label: 'Insert a wait after this…', run: () => insertAfter(n, 'wait') },
          { label: 'Insert a socket step after this…', run: () => insertAfter(n, 'socket') },
          '-',
          { label: '↑ Move earlier', run: () => moveStep(n, -1) },
          { label: '↓ Move later', run: () => moveStep(n, 1) },
          { label: 'Remove from flow', danger: true, run: () => removeStep(n) }
        ])));

        // drag to move, click to open
        g.addEventListener('mousedown', (ev) => {
          if (ev.button !== 0) return;
          ev.stopPropagation();
          const press = { sx: ev.clientX, sy: ev.clientY, ox: n.x, oy: n.y, moved: false, checks: n.checks.concat(n.branch ? [n.branch] : []).map((c) => [c.x, c.y]) };
          const move = (e) => {
            const dx = (e.clientX - press.sx) / view.k, dy = (e.clientY - press.sy) / view.k;
            if (!press.moved && Math.hypot(dx, dy) < 3) return;
            press.moved = true;
            n.x = press.ox + dx; n.y = press.oy + dy;
            saved[n.it.id] = [Math.round(n.x), Math.round(n.y)];
            g.setAttribute('transform', `translate(${n.x} ${n.y})`);
            // checks that were never moved on their own ride along with their step
            n.checks.concat(n.branch ? [n.branch] : []).forEach((c, i) => {
              if (saved[c.id]) return;
              c.x = press.checks[i][0] + dx; c.y = press.checks[i][1] + dy;
              const el = nodeLayer.querySelector(`[data-check="${c.id}"]`); if (el) el.setAttribute('transform', `translate(${c.x} ${c.y})`);
            });
            redrawWires();
          };
          const up = () => {
            window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
            if (press.moved) persist(); else hooks.pick && hooks.pick(r);
          };
          window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
        });
        g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); hooks.pick && hooks.pick(r); } });
        nodeLayer.append(g);
      });
      checks.forEach((c) => nodeLayer.append(checkNode(c, nodes)));
      nodes.filter((n) => n.branch).forEach((n) => nodeLayer.append(branchNode(n.branch, nodes)));
      // field names each step answered with, for the branch and check boxes
      document.querySelectorAll('datalist[id^="fg-fields-"]').forEach((d) => d.remove());
      nodes.forEach((n) => document.body.append(h('datalist', { id: `fg-fields-${n.idx}` }, [h('option', { value: '@status' }), h('option', { value: '@ok' })].concat(n.fields.map((f) => h('option', { value: f.path }))))));

      const wireLayer = drawWires();
      wireLayerRef.el = wireLayer;
      scene.replaceChildren(wireLayer, nodeLayer, linkLayer);
      applyView();
    };

    /* pan + zoom */
    canvas.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const pan = { sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y };
      canvas.classList.add('panning');
      const move = (e) => { view.x = pan.ox + (e.clientX - pan.sx); view.y = pan.oy + (e.clientY - pan.sy); applyView(); };
      const up = () => { canvas.classList.remove('panning'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    canvas.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;   // plain scrolling keeps moving the page; pinch and ⌘/Ctrl+scroll zoom
      ev.preventDefault();
      const box = canvas.getBoundingClientRect();
      const mx = ev.clientX - box.left, my = ev.clientY - box.top;
      const k = Math.max(0.3, Math.min(2.5, view.k * Math.pow(1.0015, -ev.deltaY)));
      view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k;
      applyView();
    }, { passive: false });
    const zoomBy = (f) => {
      const box = canvas.getBoundingClientRect();
      const mx = box.width / 2, my = box.height / 2;
      const k = Math.max(0.3, Math.min(2.5, view.k * f));
      view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k;
      applyView();
    };

    /* adding steps */
    const addStepDialog = (at) => {
      const lib = T.libraryRequests();
      const q = h('input', { placeholder: 'Search APIs — name or URL', 'aria-label': 'Search' });
      const list = h('div.fg-lib');
      let close = null;
      const fill = () => {
        const s = q.value.trim().toLowerCase();
        const rows = lib.filter((x) => !s || (x.it.name + ' ' + M.urlRaw(M.req(x.it)) + ' ' + x.trail).toLowerCase().includes(s)).slice(0, 80);
        list.replaceChildren(...rows.map((x) => {
          const method = String(M.req(x.it).method || 'GET').toUpperCase();
          return h('button.fg-lib-row', { onclick: () => { close(); const it = T.flowAddStep(flow, x.it, at); apply(`Added "${it.name}" as step ${T.flowSteps(flow).indexOf(it) + 1}`); } },
            h('span.meth', { class: 'm-' + method, text: method.slice(0, 6) }),
            h('span.fg-lib-name', {}, h('b', { text: x.it.name }), h('span.faint', { text: '  ' + x.trail })));
        }));
        if (!rows.length) list.append(h('p.hint', { text: 'Nothing matches.' }));
      };
      q.addEventListener('input', fill);
      close = T.modal('Add a step from the APIs', h('div.fg-lib-box', {}, q, list, h('p.hint', { text: at == null ? 'The step goes at the end — a node\'s ⋯ menu has "Insert a step after this" to place one in the middle.' : `The step goes in as step ${at + 1}.` })), [{ label: 'Close', run: (c) => c() }]);
      fill(); q.focus();
    };
    const addWait = () => {
      const s = prompt('Wait how many seconds before the next step?', '15');
      if (s === null) return;
      flow.item = flow.item || [];
      flow.item.push(T.waitStep(Number(s) || 15));
      apply('Wait step added at the end');
    };

    wrap.append(h('div.fg-tools', {},
      h('button', { text: '+ Step', title: 'Add an API from the collection as the next step', onclick: addStepDialog }),
      h('button', { text: '+ Wait', title: 'Pause between steps', onclick: addWait }),
      h('button', { text: '+ Socket', title: 'Listen for (or send) a socket.io event', onclick: () => socketForm(null) }),
      h('span.fg-tools-sep'),
      h('button.ghost', { text: '−', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.2) }),
      h('button.ghost', { text: '+', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.2) }),
      h('button.ghost', { text: 'Fit', onclick: fit }),
      h('button.ghost', { text: 'Tidy', title: 'Put every node back on the grid', onclick: () => { Object.keys(saved).forEach((k) => delete saved[k]); persist(); draw(); fit(); } })));
    outer.append(h('div.fg-legend', {},
      h('span.fg-key.exec', { text: 'order' }),
      h('span.fg-key.data', { text: 'a value kept for a later step' }),
      h('span.fg-key.var', { text: 'from Variables' }),
      h('span.fg-key.check', { text: 'check' }),
      h('span.fg-key.branch', { text: 'branch' }),
      h('span.hint', { text: 'Drag a green pin onto a later input, or onto a check\'s "since" · "+ pick a value" keeps or checks a response field · ⌘/Ctrl + scroll zooms' })));
    // variable names for the amount box
    if (!document.getElementById('fg-vars')) document.body.append(h('datalist', { id: 'fg-vars' }));
    const names = new Set();
    T.scopes().forEach((sc) => Object.keys(sc.toObject()).forEach((k) => names.add(k)));
    document.getElementById('fg-vars').replaceChildren(...[...names].sort().map((k) => h('option', { value: `{{${k}}}` })));

    outer.refresh = () => draw();
    draw();
    const settle = () => { draw(); if (!view.fitted) fit(); };   // the column count depends on the width, known only once attached
    requestAnimationFrame(() => { if (wrap.isConnected) settle(); else setTimeout(() => wrap.isConnected && settle(), 50); });
    return outer;
  };

  /**
   * Run steps 1..k of a flow in this page — the way to see real values on every pin of step k without running the
   * whole flow. Steps that move coins are named before anything is sent.
   */
  T.runUpTo = async function (rows, k, refresh) {
    if (S.sending) return T.toast('A request is still sending — wait a moment', 'error');
    const part = rows.slice(0, k + 1);
    const risky = part.filter((r) => T.riskOf(r.it));
    if (risky.length && !confirm(`${risky.length === 1 ? 'This step' : risky.length + ' of these steps'} moves coins or changes an account:\n${risky.map((r) => '• ' + r.it.name + ' — ' + T.riskOf(r.it)).join('\n')}\n\nRun steps 1–${k + 1} anyway?`)) return;
    part.forEach((r) => { r.state = 'queued'; r.reason = ''; });
    refresh();
    S.sending = true;
    try {
      const jumps = { count: 0 };
      for (let i = 0; i < part.length;) {
        const r = part[i];
        const asks = T.stepAsks(r.it);
        let skipped = false;
        for (const a of asks) {
          const cur = T.localStore().get(a.var);
          const v = prompt(a.label || `Value for {{${a.var}}}`, cur == null ? '' : cur);
          if (v === null) { skipped = true; break; }
          T.localStore().set(a.var, v);
        }
        if (skipped) { r.state = 'skip'; r.reason = 'skipped — no input given'; refresh(); i++; continue; }
        r.state = 'running'; refresh();
        const result = await T.execute(r.it, { skipEmpty: true, onRetry: (n, rep) => { r.reason = `try ${n} of ${rep.max} — again in ${rep.every} s`; refresh(); } });
        r.result = result;
        const j = T.judge(result);
        r.state = j.verdict; r.reason = j.reason;
        const go = T.flowAdvance(rows, i, r, jumps);   // a jump may point past k — the run then simply ends there
        if (r.state !== 'skip') await T.setMark(r.it, r.state === 'pass' ? 'verified' : 'failing', r.state === 'fail' ? 'Auto run: ' + r.reason : '', { quiet: true });
        if (S.envDirty) await T.saveEnv(true);
        refresh();
        if (r.state === 'fail') { T.toast(`Stopped at step ${i + 1}: ${T.plainReason(r.reason)}`, 'error'); break; }
        if (go.ended) { T.toast(`Flow ended at step ${i + 1} — ${r.branch}`); break; }
        i = go.next;
        await new Promise((res) => setTimeout(res, 250));
      }
    } finally {
      S.sending = false;
      T.renderTree();
      T.renderEditor();     // the flow's header (failed at step…, last run) and setup card follow the marks
    }
  };
})();
