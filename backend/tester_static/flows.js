/* API tester — Flow builder: line up existing requests into a flow by drag and drop. Extends `T` from app.js. */
(function () {
  'use strict';

  const { h, S } = T;
  const FLOWS_RE = /\bflows?\b/i;
  const START = '// ── Flow builder: start (the Flow builder rewrites the lines down to "end") ──';
  const END = '// ── Flow builder: end ──';
  const META = '// flow-builder:';

  const RUN_AS = {
    asis: { label: 'As in the API', token: null },
    p1: { label: 'Player 1', token: 'p1_token' },
    p2: { label: 'Player 2', token: 'p2_token' },
    server: { label: 'Game server', token: 'build_token' }
  };

  /** The top-level folder flows live in; created on first save. */
  const flowsRoot = () => (S.coll.data.item || []).find((x) => M.isFolder(x) && FLOWS_RE.test(x.name)) || null;
  /** Is this folder one flow (a direct child of the Flows folder)? */
  T.isFlowFolder = (it) => { const root = flowsRoot(); return !!(root && M.isFolder(it) && root.item.includes(it)); };
  T.isFlowsRoot = (it) => !!it && it === flowsRoot();

  /* ── reading a request ─────────────────────────────────────────────────── */

  const headerVal = (req, name) => { const x = (req.header || []).find((hd) => !hd.disabled && String(hd.key).toLowerCase() === name); return x ? String(x.value || '') : ''; };

  function detectRunAs(it) {
    const req = M.req(it);
    const text = headerVal(req, 'authorization') + ' ' + (req.auth && req.auth.type === 'bearer' ? M.bearerToken(req.auth) : '');
    if (/\{\{\s*build_token\s*\}\}/.test(text)) return 'server';
    if (/\{\{\s*p1_token\s*\}\}/.test(text)) return 'p1';
    if (/\{\{\s*p2_token\s*\}\}/.test(text)) return 'p2';
    return 'asis';
  }

  function bodyText(req) {
    const b = req.body;
    if (!b) return '';
    if (b.mode === 'raw') return b.raw || '';
    const rows = b[b.mode];
    return Array.isArray(rows) ? rows.filter((r) => !r.disabled).map((r) => `${r.key}=${r.value}`).join('&') : '';
  }

  /** {{variables}} a step needs to be sent. */
  function varsUsed(it) {
    const req = M.req(it);
    const used = new Set([...M.varsIn(M.urlRaw(req)), ...M.varsIn(bodyText(req))]);
    (req.header || []).filter((x) => !x.disabled).forEach((x) => M.varsIn(x.key + ' ' + x.value).forEach((v) => used.add(v)));
    if (req.auth && req.auth.type === 'bearer') M.varsIn(M.bearerToken(req.auth)).forEach((v) => used.add(v));
    return [...used];
  }

  /** Variables a step's own scripts set (login saves p1_token, create saves flow_tx, …). */
  function varsSetByScripts(it, listens) {
    const code = (listens || ['prerequest', 'test']).map((l) => M.script(it, l)).join('\n');
    return Array.from(code.matchAll(/pm\.(?:variables|environment|collectionVariables|globals)\.set\(\s*['"`]([A-Za-z0-9_.-]+)['"`]/g), (m) => m[1]);
  }

  /** Split a test script into the Flow builder's block (parsed) and everything else (kept as-is). */
  function splitScript(code) {
    const lines = String(code || '').split('\n');
    const s = lines.indexOf(START), e = lines.indexOf(END);
    let meta = { save: [], expect: [], rules: [], ask: [] };
    if (s < 0 || e < s) return { rest: String(code || ''), meta };
    const metaLine = lines.slice(s, e).find((l) => l.startsWith(META));
    try { meta = Object.assign(meta, JSON.parse(metaLine.slice(META.length))); } catch (err) { /* hand-edited — start clean */ }
    const rest = lines.slice(0, s).concat(lines.slice(e + 1)).join('\n').replace(/^\n+|\n+$/g, '');
    return { rest, meta };
  }

  /* ── validations (no code) ─────────────────────────────────────────────── */

  // A rule reads one thing from the response and compares it. `@ok`, `@status` and `@time` are the response
  // itself; anything else is a path into the JSON body (data.reset_token, user._id, items.0.name).
  const OPS = {
    is: { label: 'is', value: true },
    not: { label: 'is not', value: true },
    contains: { label: 'contains', value: true },
    exists: { label: 'exists' },
    missing: { label: 'is missing' },
    true: { label: 'is true' },
    false: { label: 'is false' },
    notempty: { label: 'is not empty' },
    empty: { label: 'is empty' },
    gt: { label: 'is more than', value: true },
    lt: { label: 'is less than', value: true },
    ok2xx: { label: 'is 2xx (success)' },
    // Compared with a value an earlier step kept (`ref`, e.g. {{sa1}}): the way a balance is checked after a stake.
    downby: { label: 'went down by', value: true, ref: true },
    upby: { label: 'went up by', value: true, ref: true },
    down: { label: 'went down', ref: true },
    up: { label: 'went up', ref: true },
    same: { label: 'is the same as', ref: true }
  };
  T.ruleOps = OPS;
  const FIELD_LABEL = { '@ok': 'Response looks OK', '@status': 'HTTP status', '@time': 'Response time (ms)' };
  const fieldLabel = (f) => FIELD_LABEL[f] || f;
  T.ruleText = (r) => (r.field === '@ok' ? 'Response looks OK (HTTP 2xx, no "status": false)' : `${fieldLabel(r.field)} ${OPS[r.op] ? OPS[r.op].label : r.op}${OPS[r.op] && OPS[r.op].value ? ' ' + r.value : ''}${OPS[r.op] && OPS[r.op].ref ? ' since ' + (r.ref || '?') : ''}`);

  function ruleCode(r) {
    const js = JSON.stringify;
    if (r.field === '@ok') {
      return "  pm.test('Response looks OK — HTTP ' + pm.response.code + (j && j.message ? ', ' + j.message : ''), () => { if (pm.response.code >= 300 || (j && (j.status === false || j.success === false))) throw new Error('the response says it failed'); });";
    }
    const cond = {
      is: 'show(v) === want', not: 'show(v) !== want', contains: 'show(v).toLowerCase().includes(want.toLowerCase())',
      exists: 'v !== undefined && v !== null', missing: 'v === undefined || v === null',
      true: "v === true || v === 'true' || v === 1", false: "v === false || v === 'false' || v === 0",
      notempty: '!isEmpty(v)', empty: 'isEmpty(v)', gt: 'Number(v) > Number(want)', lt: 'Number(v) < Number(want)',
      ok2xx: 'Number(v) >= 200 && Number(v) < 300',
      downby: 'Math.abs((Number(before) - Number(v)) - Number(want)) < 1e-6', upby: 'Math.abs((Number(v) - Number(before)) - Number(want)) < 1e-6',
      down: 'Number(v) < Number(before)', up: 'Number(v) > Number(before)',
      same: "(isNum(v) && isNum(before)) ? Number(v) === Number(before) : show(v) === String(before)"
    }[r.op] || 'false';
    const op = OPS[r.op] || { label: r.op };
    const label = fieldLabel(r.field) + ' ' + op.label;
    if (op.ref) {
      // "silver went down by 100 since {{sa1}} — 95,100 → 95,000": both numbers in the name so the graph and the report show the move.
      const refName = String(r.ref || '').replace(/^\{\{|\}\}$/g, '');
      return `  { const v = get(${js(r.field)}); const want = pm.variables.replaceIn(${js(String(r.value == null ? '' : r.value))}); const before = pm.variables.replaceIn(${js(String(r.ref || ''))}); pm.test(${js(label)} + (${js(!!op.value)} ? ' ' + want : '') + ${js((r.op === 'same' ? ' ' : ' since ') + refName)} + ' — ' + show(before) + ' → ' + show(v), () => { if (before === ${js(String(r.ref || ''))} || before === '') throw new Error(${js('{{' + refName + '}} has no value — the step that keeps it did not run')}); if (!(${cond})) throw new Error('was ' + show(before) + ', now ' + show(v) + (${js(!!op.value)} ? ' (moved ' + (Number(v) - Number(before)) + ', expected ' + (${js(r.op === 'downby')} ? '−' : '+') + want + ')' : '')); }); }`;
    }
    return `  { const v = get(${js(r.field)}); const want = pm.variables.replaceIn(${js(String(r.value == null ? '' : r.value))}); pm.test(${js(label)} + (${js(!!op.value)} ? ' ' + want : '') + ' — got ' + show(v), () => { if (!(${cond})) throw new Error('got ' + show(v)); }); }`;
  }

  function builderBlock(meta) {
    const save = (meta.save || []).filter(([p, v]) => String(p).trim() && String(v).trim());
    const rules = (meta.rules || []).filter((r) => r.field && (r.field === '@ok' || OPS[r.op]));
    const ask = (meta.ask || []).filter((a) => String(a.var || '').trim());
    if (!save.length && !rules.length && !ask.length) return '';
    const js = JSON.stringify;
    const out = [START, META + js({ save, rules, ask }), '{',
      '  let j = null; try { j = pm.response.json(); } catch (e) {}',
      "  const get = (p) => p === '@status' ? pm.response.code : p === '@time' ? pm.response.responseTime : String(p).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), j);",
      "  const show = (v) => v === undefined ? 'missing' : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);",
      "  const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Object.keys(v).length);",
      "  const isNum = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));"];
    rules.forEach((r) => out.push(ruleCode(r)));
    save.forEach(([p, v]) => out.push(
      `  { const v = get(${js(p)}); pm.test(${js('Saved {{' + v.trim() + '}} from ' + p.trim() + ' = ')} + show(v), () => { if (v === undefined || v === null || v === '') throw new Error(${js(p.trim() + ' is not in the response')}); }); if (v !== undefined && v !== null) pm.variables.set(${js(v.trim())}, typeof v === 'object' ? JSON.stringify(v) : String(v)); }`));
    out.push('}', END);
    return out.join('\n');
  }

  /** Values a step asks the tester for while a flow runs (an OTP, a new password). */
  T.stepAsks = (it) => (splitScript(M.script(it, 'test')).meta.ask || []).filter((a) => a && a.var);

  /** Leaf paths of a JSON response, for the "save from response" suggestions. */
  function jsonPaths(body) {
    let j; try { j = JSON.parse(body); } catch (e) { return []; }
    const out = [];
    const walk = (v, path, depth) => {
      if (out.length >= 60 || depth > 5) return;
      if (v && typeof v === 'object') {
        const keys = Array.isArray(v) ? (v.length ? [0] : []) : Object.keys(v);
        if (!keys.length && path) out.push({ path, value: JSON.stringify(v) });
        keys.forEach((k) => walk(v[k], path ? `${path}.${k}` : String(k), depth + 1));
      } else if (path) out.push({ path, value: String(v) });
    };
    walk(j, '', 0);
    return out;
  }

  /* ── steps ─────────────────────────────────────────────────────────────── */

  /** A library request copied into a flow: inherited auth and folder scripts are baked in, so it runs the same from the Flows folder. */
  function copyFromLibrary(src) {
    const parents = M.parentsOf(S.coll.data.item, src) || [];
    const it = M.clone(src);
    it.id = M.uid();
    delete it.item;
    const req = M.req(it);
    if (!req.auth) req.auth = M.clone(M.effectiveAuth(src, parents, S.coll.data).auth || { type: 'noauth' });
    ['prerequest', 'test'].forEach((listen) => {
      const inherited = parents.map((p) => M.script(p, listen)).filter((c) => c.trim());
      if (inherited.length) M.setScript(it, listen, inherited.concat(M.script(src, listen)).join('\n'));
    });
    return stepOf(it, src.id);
  }

  function stepOf(it, srcId) {
    if (T.isWaitStep(it)) return { it, srcId: srcId || it.id, wait: true, runAs: 'asis', detected: 'asis', save: [], rules: [], ask: [], open: false, tried: null };
    const { meta } = splitScript(M.script(it, 'test'));
    const runAs = detectRunAs(it);
    // Flows saved before rules existed kept [[path, value]] "must equal" pairs plus an implicit OK check.
    const rules = (meta.rules || []).length ? meta.rules.map((r) => Object.assign({}, r))
      : (meta.expect || []).length ? [{ field: '@ok' }].concat(meta.expect.map(([field, value]) => ({ field, op: 'is', value }))) : [];
    if (!(meta.rules || []).length && !(meta.expect || []).length && (meta.save || []).length) rules.unshift({ field: '@ok' });
    return { it, srcId: srcId || it.id, runAs, detected: runAs, save: (meta.save || []).map((x) => [...x]), rules, ask: (meta.ask || []).map((a) => Object.assign({}, a)), open: false, tried: null };
  }

  /** The request as it will be saved: the chosen token applied, the checks written into its test script. */
  function finalItem(step) {
    const it = M.clone(step.it);
    if (step.wait) { it.wait = Math.max(1, Math.min(600, Math.round(Number(it.wait) || 15))); it.name = `⏱ Wait ${it.wait} s`; return it; }
    const req = M.req(it);
    if (!T.isSocketStep(it) && step.runAs !== step.detected && step.runAs !== 'asis') {
      req.header = (req.header || []).filter((x) => !/^(authorization|gameplaytoken)$/i.test(x.key));
      req.auth = { type: 'bearer', bearer: [{ key: 'token', value: `{{${RUN_AS[step.runAs].token}}}`, type: 'string' }] };
      if (step.runAs === 'server') {
        req.header.push({ key: 'gameplaytoken', value: '{{gameplaytoken}}', type: 'text' });
        if (!headerVal(req, 'apk_signature_black_arch')) req.header.push({ key: 'apk_signature_black_arch', value: '{{apk_signature}}', type: 'text' });
      }
    }
    const { rest } = splitScript(M.script(it, 'test'));
    const block = builderBlock({ save: step.save, rules: step.rules, ask: step.ask });
    M.setScript(it, 'test', [rest, block].filter((x) => x.trim()).join('\n'));
    return it;
  }


  /* ── what the graph editor needs ─────────────────────────────────────── */

  /** A step's builder block: {save, rules, ask} (copies — hand them back to T.setStepMeta). */
  T.stepMeta = (it) => { const st = stepOf(it); return { save: st.save, rules: st.rules, ask: st.ask }; };
  /** Rewrite a step's builder block in place; everything else in its test script stays. */
  T.setStepMeta = (it, meta) => {
    const { rest } = splitScript(M.script(it, 'test'));
    const block = builderBlock({ save: meta.save || [], rules: meta.rules || [], ask: meta.ask || [] });
    M.setScript(it, 'test', [rest, block].filter((x) => x.trim()).join('\n'));
  };
  /** Copy a library request into a flow at `at` (end when omitted); returns the new step. */
  T.flowAddStep = (flow, src, at) => {
    const it = finalItem(copyFromLibrary(src));
    flow.item = flow.item || [];
    flow.item.splice(at == null ? flow.item.length : at, 0, it);
    return it;
  };
  T.flowSteps = (flow) => stepsOf(flow);
  /** Every request outside the Flows folder, with its folder trail, for pickers. */
  T.libraryRequests = () => {
    const out = [];
    M.walk(S.coll.data.item, (x) => { if (!M.isFolder(x) && !T.isInFlows(x)) out.push({ it: x, trail: (M.parentsOf(S.coll.data.item, x) || []).map((p) => p.name).join(' / ') }); });
    return out;
  };

  /* ── branches: "if this, then jump / skip / end" ─────────────────────── */

  /** Does a rule hold for a result, judged the same way the step's own script would? */
  T.evalRule = function (rule, result) {
    if (!rule || !result || !result.res) return false;
    let j = null; try { j = JSON.parse(result.res.body); } catch (e) { /* not JSON */ }
    const get = (p) => (p === '@status' ? result.res.status : p === '@time' ? result.res.timeMs : String(p).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), j));
    const show = (v) => (v === undefined ? 'missing' : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
    const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Object.keys(v).length);
    const isNum = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));
    if (rule.field === '@ok') return result.res.status < 300 && !(j && (j.status === false || j.success === false));
    const scopes = T.scopes();
    const v = get(rule.field);
    const want = M.resolve(rule.value == null ? '' : rule.value, scopes);
    const before = M.resolve(rule.ref == null ? '' : rule.ref, scopes);
    switch (rule.op) {
      case 'is': return show(v) === want;
      case 'not': return show(v) !== want;
      case 'contains': return show(v).toLowerCase().includes(want.toLowerCase());
      case 'exists': return v !== undefined && v !== null;
      case 'missing': return v === undefined || v === null;
      case 'true': return v === true || v === 'true' || v === 1;
      case 'false': return v === false || v === 'false' || v === 0;
      case 'notempty': return !isEmpty(v);
      case 'empty': return isEmpty(v);
      case 'gt': return Number(v) > Number(want);
      case 'lt': return Number(v) < Number(want);
      case 'ok2xx': return Number(v) >= 200 && Number(v) < 300;
      case 'downby': return Math.abs((Number(before) - Number(v)) - Number(want)) < 1e-6;
      case 'upby': return Math.abs((Number(v) - Number(before)) - Number(want)) < 1e-6;
      case 'down': return Number(v) < Number(before);
      case 'up': return Number(v) > Number(before);
      case 'same': return (isNum(v) && isNum(before)) ? Number(v) === Number(before) : show(v) === String(before);
      default: return false;
    }
  };

  const THEN_LABEL = { end: 'end the flow here (passed)', jump: 'jump to', skip: 'skip the next step' };
  T.branchText = (b, rows) => {
    if (!b) return '';
    const target = b.then === 'jump' && rows ? rows.findIndex((r) => r.it.id === b.to) : -1;
    return `if ${T.ruleText(b)} → ${b.then === 'jump' ? 'jump to ' + (target >= 0 ? 'step ' + (target + 1) : 'a step that is gone') : THEN_LABEL[b.then] || b.then}`;
  };

  /**
   * Where a run goes after row i: the next row, or wherever the step's branch points when its condition holds.
   * A taken branch counts as the step passing (that path was expected). Jumps are capped so a loop can't run forever.
   */
  T.flowAdvance = function (rows, i, r, jumps) {
    const b = r.it.branch;
    if (!b || r.state === 'skip' || !r.result || !r.result.res) return { next: i + 1 };
    if (!T.evalRule(b, r.result)) return { next: i + 1 };
    const label = T.branchText(b, rows);
    r.branch = label;
    r.result.branch = label;            // on the result too, so a redraw of the page still shows it
    r.state = 'pass';
    r.reason = 'branch taken: ' + label;
    const skipOver = (from, to) => rows.slice(from, to).forEach((x) => {
      x.state = 'skip'; x.reason = `skipped — the branch at step ${i + 1} jumped over it`;
      S.results.set(x.it.id, { skipped: x.reason, out: { tests: [], errors: [] } });
    });
    const notRun = (from) => rows.slice(from).forEach((x) => { x.state = 'queued'; x.reason = ''; x.result = null; S.results.delete(x.it.id); });
    if (b.then === 'end') { notRun(i + 1); return { next: rows.length, ended: true }; }
    if (b.then === 'skip') { skipOver(i + 1, i + 2); return { next: i + 2 }; }
    const to = rows.findIndex((x) => x.it.id === b.to);
    if (to < 0) return { next: i + 1 };
    jumps.count = (jumps.count || 0) + 1;
    if (jumps.count > 30) { r.state = 'fail'; r.reason = 'the flow jumped 30 times — stopped to avoid running forever'; return { next: rows.length, ended: true }; }
    if (to <= i) rows.slice(to, i + 1).forEach((x) => { x.state = 'queued'; x.reason = ''; });
    else skipOver(i + 1, to);
    return { next: to };
  };

  /* ── Flows tab ─────────────────────────────────────────────────────────── */

  T.flowList = () => { const root = flowsRoot(); return root ? root.item.filter((x) => M.isFolder(x)) : []; };
  T.isInFlows = (it) => { const root = flowsRoot(); return !!(root && (M.parentsOf(S.coll.data.item, it) || []).includes(root)); };

  const stepsOf = (flow) => { const out = []; M.walk(flow.item, (x) => { if (!M.isFolder(x)) out.push(x); }); return out; };

  /**
   * What a flow needs from Variables before it can run: every {{variable}} a step sends that no earlier
   * step keeps or asks for, with its current value. `state`: ok | empty | missing.
   */
  function flowNeeds(flow) {
    const scopes = T.scopes();
    const valueOf = (k) => { const sc = scopes.find((x) => x.has(k)); return sc ? String(sc.get(k) == null ? '' : sc.get(k)) : null; };
    const made = new Set();
    const need = new Map();
    stepsOf(flow).forEach((it) => {
      if (T.isWaitStep(it)) return;
      const req = M.req(it);
      const own = new Set(varsSetByScripts(it, ['prerequest']));
      const asked = new Set(T.stepAsks(it).map((a) => a.var));
      // A variable that only ever rides in a header other than Authorization (an app-check token, an
      // APK signature) is optional: the request still goes out without it.
      const hard = new Set([...M.varsIn(M.urlRaw(req)), ...M.varsIn(bodyText(req))]);
      (req.header || []).filter((x) => !x.disabled && /^authorization$/i.test(x.key)).forEach((x) => M.varsIn(x.value).forEach((v) => hard.add(v)));
      if (req.auth && req.auth.type === 'bearer') M.varsIn(M.bearerToken(req.auth)).forEach((v) => hard.add(v));
      varsUsed(it).forEach((k) => {
        if (made.has(k) || own.has(k) || asked.has(k)) return;
        const v = valueOf(k);
        const filled = v !== null && v.trim() !== '';
        const state = filled ? 'ok' : hard.has(k) ? (v === null ? 'missing' : 'empty') : 'optional';
        const prev = need.get(k);
        if (!prev || (prev.state === 'optional' && state !== 'optional')) need.set(k, { k, value: v, state });
      });
      varsSetByScripts(it).concat([...asked]).forEach((k) => made.add(k));
    });
    return [...need.values()];
  }
  const SECRET_RE = /pass|token|secret|key|signature/i;
  const shown = (k, v) => (SECRET_RE.test(k) && v ? '•'.repeat(Math.min(8, v.length)) + (v.length > 8 ? '…' : '') : v);

  /* list filter (sidebar) */
  S.flowQuery = '';
  S.flowKind = T.ls.get('flowKind', 'all');
  const KIND_MATCH = { all: () => true, fail: (k) => k === 'fail', pass: (k) => k === 'pass', new: (k) => k === 'new' || k === 'part' || k === 'empty' };
  T.flowsShown = () => T.flowList().filter((f) => (!S.flowQuery || f.name.toLowerCase().includes(S.flowQuery)) && KIND_MATCH[S.flowKind || 'all'](flowState(f).kind));

  let sideTools = null;
  function flowSideTools() {
    if (sideTools) return sideTools;
    const search = h('input', { type: 'search', placeholder: 'Find a flow — game, player, word', 'aria-label': 'Find a flow', oninput: () => { S.flowQuery = search.value.trim().toLowerCase(); T.renderTree(); } });
    const chips = h('div.flow-chips', { role: 'group', 'aria-label': 'Show flows by result' });
    const runAll = h('button.primary', { text: '▶ Run all', title: 'Run every flow in this list, one after another, and get one report', onclick: () => T.runFlowsDialog(T.flowsShown()) });
    sideTools = { box: h('div.flow-tools', {}, search, h('div.inline', {}, chips, h('span.grow'), runAll)), chips, runAll, search };
    return sideTools;
  }

  /** Last known result of a flow, from the ✓ / ✕ marks its steps carry. */
  function flowState(flow) {
    const steps = stepsOf(flow);
    const n = { pass: 0, fail: 0, pending: 0 };
    let last = 0, by = '';
    steps.forEach((x) => {
      const m = S.marks[x.id];
      if (m && m.status === 'verified') n.pass++; else if (m && m.status === 'failing') n.fail++; else n.pending++;
      if (m && m.markedAt > last) { last = m.markedAt; by = m.markedBy || ''; }
    });
    const kind = !steps.length ? 'empty' : n.fail ? 'fail' : n.pass === steps.length ? 'pass' : n.pass ? 'part' : 'new';
    return { steps, n, kind, last, by };
  }
  const KIND_LABEL = { pass: 'Passed', fail: 'Failed', part: 'Partly run', new: 'Not run yet', empty: 'No steps' };

  const ago = (sec) => {
    const d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 90) return 'just now';
    if (d < 5400) return Math.round(d / 60) + ' min ago';
    if (d < 129600) return Math.round(d / 3600) + ' h ago';
    return Math.round(d / 86400) + ' days ago';
  };

  function selectedFlow() {
    const list = T.flowList();
    return list.find((f) => f.id === S.flowSel) || list[0] || null;
  }

  T.renderFlowsSide = function (el) {
    const all = T.flowList();
    const cur = selectedFlow();
    if (!all.length) {
      el.replaceChildren(h('div.empty-tree', {}, h('p', { text: 'No flows yet.' }), h('p.hint', { text: 'A flow runs a set of APIs in order — log in, play, settle, check the balance.' })));
      return;
    }
    const tools = flowSideTools();
    const counts = { all: all.length, fail: 0, pass: 0, new: 0 };
    all.forEach((f) => { const k = flowState(f).kind; if (k === 'fail') counts.fail++; else if (k === 'pass') counts.pass++; else counts.new++; });
    tools.chips.replaceChildren(...[['all', 'All'], ['fail', '✕ Failing'], ['pass', '✓ Passed'], ['new', '◌ Not run']].map(([k, label]) => h('button.chip', {
      class: S.flowKind === k ? 'on' : '', 'aria-pressed': String(S.flowKind === k), text: `${label} ${counts[k]}`,
      onclick: () => { S.flowKind = k; T.ls.set('flowKind', k); T.renderTree(); }
    })));
    const list = T.flowsShown();
    tools.runAll.disabled = !list.length;
    tools.runAll.textContent = list.length && list.length < all.length ? `▶ Run ${list.length}` : '▶ Run all';
    if (!list.length) { el.replaceChildren(tools.box, h('p.hint.flow-none', { text: 'No flow matches — clear the search or pick another filter.' })); return; }
    el.replaceChildren(tools.box, ...list.map((f) => {
      const st = flowState(f);
      return h('div.row.flow-row', {
        class: cur === f ? 'sel' : '', role: 'button', tabindex: 0, title: `${f.name}\n${KIND_LABEL[st.kind]}`,
        onclick: () => { S.flowSel = f.id; T.renderTree(); T.renderEditor(); },
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); S.flowSel = f.id; T.renderTree(); T.renderEditor(); } }
      },
        h('span.flow-dot', { class: 'k-' + st.kind, 'aria-label': KIND_LABEL[st.kind] }),
        h('span.label', { text: f.name }),
        h('span.count', { text: String(st.steps.length) }));
    }));
  };

  T.renderFlowsMain = function (el) {
    const flow = selectedFlow();
    if (!flow) {
      el.replaceChildren(h('div.flows-empty', {},
        h('h2', { text: 'Flows' }),
        h('p', { text: 'A flow is a set of APIs that run one after another, like a real game: log in, start a match, settle it, and check that the coins moved the right way.' }),
        h('button.primary', { text: '+ Create your first flow', onclick: () => T.flowBuilder() })));
      return;
    }
    const st = flowState(flow);
    const desc = typeof flow.description === 'string' ? flow.description : (flow.description && flow.description.content) || '';
    const rows = st.steps.map((x) => {
      const m = S.marks[x.id];
      const res = S.results.get(x.id);
      if (res && !res.pending) {
        // ran (or was skipped) in this page: that beats the saved mark
        const j = T.judge(res);
        const state = res.branch ? 'pass' : j.verdict;
        return { it: x, on: true, state, reason: res.branch ? 'branch taken: ' + res.branch : j.reason, branch: res.branch || null, result: res };
      }
      const state = m && m.status === 'verified' ? 'pass' : m && m.status === 'failing' ? 'fail' : 'queued';
      return { it: x, on: true, state, reason: m && m.note ? m.note.replace(/^Auto run: /, '') : state === 'pass' ? 'Worked' : '', result: null };
    });
    const more = h('button.ghost', {
      text: '⋯', title: 'More', 'aria-label': 'More actions',
      onclick: (ev) => T.menu(ev.currentTarget, [
        { label: 'Duplicate flow', run: () => { const root = flowsRoot(); const copy = M.freshIds(M.clone(flow)); copy.name = flow.name + ' copy'; root.item.splice(root.item.indexOf(flow) + 1, 0, copy); S.flowSel = copy.id; T.markDirty(); T.renderTree(); T.renderEditor(); T.saveColl(); } },
        { label: 'Duplicate for another game…', run: () => T.duplicateForGame(flow) },
        { label: '🔗 Share last result', run: () => T.shareReport(flow.name, [{ name: flow.name, rows }]) },
        '-',
        { label: 'Delete flow', danger: true, run: () => { if (!confirm(`Delete the flow "${flow.name}"?`)) return; const root = flowsRoot(); root.item.splice(root.item.indexOf(flow), 1); S.flowSel = null; T.markDirty(); T.renderTree(); T.renderEditor(); T.saveColl(); } }
      ])
    });
    const failedRow = rows.find((r) => r.state === 'fail');
    const failedAt = failedRow ? h('p.flow-failed', {},
      h('b', { text: `✕ Failed at step ${rows.indexOf(failedRow) + 1}: ` }), failedRow.it.name,
      failedRow.reason ? h('span', { text: ' — ' + T.plainReason(failedRow.reason) }) : '') : '';
    el.replaceChildren(h('div.flow-page', {},
      h('div.flow-hero', {},
        h('div.flow-title', {},
          h('span.flow-state', { class: 'k-' + st.kind, text: KIND_LABEL[st.kind] }),
          h('h2', { text: flow.name }),
          desc ? h('p', { text: desc }) : '',
          h('p.hint', { text: `${st.steps.length} steps · ✓ ${st.n.pass} worked · ✕ ${st.n.fail} failed · ${st.n.pending} not run` + (st.last ? ` · last run ${ago(st.last)}${st.by ? ' by ' + st.by : ''}` : '') }),
          failedAt),
        h('div.flow-actions', {},
          h('button.primary.big', { text: '▶ Start test', title: 'Run every step of this flow now', disabled: !st.steps.length, onclick: () => T.runDialog(flow) }),
          h('button', { text: '✎ Edit flow', onclick: () => T.flowBuilder(flow) }),
          more)),
      st.steps.length ? setupCard(flow) : '',
      st.steps.length ? flowView(rows, flow) : h('p.hint', { text: 'This flow has no steps — press Edit flow to add some.' })));
  };

  /** The flow drawn as a graph (nodes and wires) or as the simple chain, with a toggle; the choice sticks. */
  function flowView(rows, flow) {
    const mode = T.ls.get('flowView', 'graph') === 'chart' ? 'chart' : 'graph';
    const box = h('div.flow-view');
    const draw = () => {
      const cur = T.ls.get('flowView', 'graph') === 'chart' ? 'chart' : 'graph';
      const seg = h('div.seg.flow-seg', { role: 'group', 'aria-label': 'View' },
        ['graph', 'chart'].map((v) => h('button', {
          class: cur === v ? 'on' : '', text: v === 'graph' ? '⬡ Graph' : '◇ Chain', 'aria-pressed': String(cur === v),
          onclick: () => { T.ls.set('flowView', v); draw(); }
        })));
      let body;
      if (cur === 'graph') {
        const g = T.flowGraph(rows, flow, {
          pick: (r) => T.stepDetail(r.it),
          runTo: (i) => T.runUpTo(rows, i, () => g.refresh()),
          changed: () => { T.renderTree(); T.renderEditor(); }
        });
        body = g;
      } else body = T.flowChart(rows, 'done', flow, (r) => T.stepDetail(r.it));
      box.replaceChildren(seg, body);
    };
    draw();
    return box;
  }

  /**
   * "Before you run": the variables this flow takes from Variables (edit them here), and a button that
   * sends only the leading safe steps — logins, balance reads — so an empty account or a wrong password
   * shows up before any coin moves.
   */
  function setupCard(flow) {
    const needs = flowNeeds(flow);
    const bad = needs.filter((n) => n.state === 'missing' || n.state === 'empty');
    const steps = stepsOf(flow);
    const lead = [];
    for (const it of steps) { if (T.isWaitStep(it) || T.riskOf(it) || T.stepAsks(it).length) break; lead.push(it); }
    const varRow = (n) => {
      const input = h('input.mono', {
        value: n.value == null ? '' : n.value, type: SECRET_RE.test(n.k) ? 'password' : 'text', 'aria-label': n.k,
        placeholder: n.state === 'missing' ? 'no such variable yet' : 'empty',
        onkeydown: (ev) => { if (ev.key === 'Enter') input.blur(); },
        onchange: async () => {
          const v = input.value;
          const store = S.env && T.envStore().has(n.k) ? T.envStore() : T.collStore();
          store.set(n.k, v);
          if (S.env && store === T.envStore()) { await T.saveEnv(true); } else { T.markDirty(); await T.saveColl(); }
          T.renderEditor();
        }
      });
      return h('div.setup-var', { class: n.state },
        h('code', { text: '{{' + n.k + '}}' }), input,
        h('span.setup-state', { text: n.state === 'ok' ? '' : n.state === 'optional' ? 'optional' : n.state === 'empty' ? 'empty' : 'not set' }));
    };
    const out = h('div.setup-check');
    const checkBtn = h('button', {
      text: lead.length ? `✓ Check accounts (${lead.length} safe step${lead.length === 1 ? '' : 's'})` : '✓ Check accounts',
      title: lead.length ? 'Sends only ' + lead.map((x) => x.name).join(', ') + ' — nothing that moves coins' : 'The first step already moves coins or needs input — nothing safe to check',
      disabled: !lead.length || S.sending,
      onclick: async () => {
        checkBtn.disabled = true; out.replaceChildren(h('span.hint', { text: 'Checking…' }));
        const lines = [];
        try {
          for (const it of lead) {
            const r = await T.execute(it, { skipEmpty: true });
            const j = T.judge(r);
            const tests = (r.out && r.out.tests) || [];
            const text = tests.length ? tests.map((t) => (t.ok ? '✓ ' : '✕ ') + T.plainReason(t.name + (t.error && !t.name.includes(t.error) ? ' — ' + t.error : ''))).join(' · ') : (j.verdict === 'pass' ? '✓ ' : j.verdict === 'skip' ? '– ' : '✕ ') + j.reason;
            lines.push(h('div.setup-line', { class: 'v-' + j.verdict }, h('b', { text: it.name }), h('span', { text: ' — ' + text })));
            if (j.verdict === 'fail') break;
          }
          if (S.envDirty) await T.saveEnv(true);
        } finally {
          out.replaceChildren(...lines);
          checkBtn.disabled = false;
        }
      }
    });
    const summary = bad.length
      ? h('span.setup-warn', { text: `${bad.length} value${bad.length === 1 ? '' : 's'} missing — fill them below or the flow stops early` })
      : h('span.hint', { text: needs.length ? 'Every value is set.' : 'This flow needs nothing from Variables.' });
    return h('details.setup', { open: !!bad.length },
      h('summary', {}, h('b', { text: 'Before you run' }), summary),
      needs.length ? h('div.setup-vars', {}, needs.map(varRow)) : '',
      h('div.inline', {}, checkBtn, h('span.hint', { text: lead.length ? 'Logs in and reads balances only — a wrong password or an empty account shows here, before any coin moves.' : '' })),
      out);
  }

  /* ── run all flows ──────────────────────────────────────────────────────── */

  /** Run one flow's steps in order; stops at the first failure. `hooks.step(r)` after every change, `hooks.ask(r, asks)` for input. */
  async function runFlowRows(rows, opts, hooks) {
    let failed = false;
    const jumps = { count: 0 };
    for (let i = 0; i < rows.length;) {
      const r = rows[i];
      if (opts.stopped()) break;
      const asks = T.stepAsks(r.it);
      if (asks.length) {
        r.state = 'waiting'; r.reason = 'waiting for your input'; hooks.step(r);
        const answers = await hooks.ask(r, asks);
        if (answers === null) { r.state = 'skip'; r.reason = 'skipped — no input given'; hooks.step(r); i++; continue; }
        answers.forEach((v, k) => T.localStore().set(asks[k].var, v));
      }
      r.state = 'running'; hooks.step(r);
      const result = await T.execute(r.it, { skipEmpty: true, onRetry: (n, rep) => { r.reason = `try ${n} of ${rep.max} did not pass — again in ${rep.every} s`; hooks.step(r); } });
      r.result = result;
      const j = T.judge(result);
      r.state = j.verdict; r.reason = j.reason;
      const go = T.flowAdvance(rows, i, r, jumps);
      if (opts.mark && r.state !== 'skip') await T.setMark(r.it, r.state === 'pass' ? 'verified' : 'failing', r.state === 'fail' ? 'Auto run: ' + r.reason : '', { quiet: true });
      if (S.envDirty) await T.saveEnv(true);
      hooks.step(r);
      if (r.state === 'fail') { failed = true; break; }
      if (go.ended) break;
      i = go.next;
      if (opts.pause) await new Promise((res) => setTimeout(res, opts.pause));
    }
    return failed;
  }

  T.runFlowsDialog = function (flows) {
    if (!flows || !flows.length) return T.toast('No flows to run', 'error');
    if (S.sending) return T.toast('A request is still sending — wait a moment', 'error');
    const jobs = flows.map((f) => ({ flow: f, on: true, state: 'queued', rows: stepsOf(f).map((it) => ({ it, on: true, state: 'queued', reason: '', result: null })) }));
    let phase = 'setup', stop = false, asking = null;
    const autoMark = h('input', { type: 'checkbox', id: 'ra-mark', checked: true });
    const delay = h('input', { type: 'number', id: 'ra-delay', min: 0, max: 10000, step: 100, value: 300, style: 'width:90px' });
    const body = h('div.runall');
    const startBtn = h('button.primary', { text: `▶ Run ${jobs.length} flow${jobs.length === 1 ? '' : 's'}` });
    const stopBtn = h('button', { text: 'Stop', hidden: true });
    const shareBtn = h('button', { text: '🔗 Share report', hidden: true, onclick: () => T.shareReport(`${jobs.filter((j) => j.on).length} flows — ${S.coll.name}`, jobs.filter((j) => j.on).map((j) => ({ name: j.flow.name, rows: j.rows }))) });

    const askFor = (r, asks) => new Promise((resolve) => {
      asking = { r, asks, resolve, values: asks.map((a) => { const v = T.localStore().get(a.var); return v == null ? '' : String(v); }) };
      draw();
      const first = body.querySelector('.run-ask input'); if (first) first.focus();
    });
    const askPanel = () => {
      if (!asking) return '';
      const a = asking;
      return h('form.run-ask', { onsubmit: (ev) => { ev.preventDefault(); const v = a.values.slice(); asking = null; a.resolve(v); } },
        h('div', {}, h('b', { text: `"${a.r.it.name}" needs your input` })),
        a.asks.map((q, i) => h('label.run-ask-field', {}, h('span', { text: q.label || `Value for {{${q.var}}}` }), h('input', { value: a.values[i], autocomplete: 'off', oninput: (ev) => { a.values[i] = ev.target.value; } }))),
        h('div.inline', {}, h('button.primary', { type: 'submit', text: 'Continue ▶' }), h('button', { type: 'button', text: 'Skip this step', onclick: () => { asking = null; a.resolve(null); } })));
    };
    const draw = () => {
      const on = jobs.filter((j) => j.on);
      const done = on.filter((j) => ['pass', 'fail', 'stopped'].includes(j.state));
      const passed = on.filter((j) => j.state === 'pass').length, failed = on.filter((j) => j.state === 'fail').length;
      const head = phase === 'setup'
        ? h('div.run-head', {},
          h('div', {}, h('b', { text: `${on.length} of ${jobs.length} flows selected` }), h('span.hint', { text: ' · each flow runs top to bottom and stops at its first failure; the next flow still runs' })),
          h('div.inline', {},
            h('label', { for: 'ra-mark', class: 'inline' }, autoMark, 'Mark results ✓ / ✕ automatically'),
            h('label', { for: 'ra-delay', class: 'inline' }, 'Pause', delay, 'ms between requests')))
        : h('div.run-head', {},
          h('div.run-progress', {}, h('span', { style: `width:${on.length ? Math.round(done.length / on.length * 100) : 0}%` })),
          h('div', {}, h('b', { text: phase === 'done' ? (stop ? 'Stopped' : 'Finished') : `Running flow ${done.length + 1} of ${on.length}` }),
            h('span.run-sum', {}, h('span.mk-verified', { text: ` ✓ ${passed} passed` }), h('span.mk-failing', { text: `  ✕ ${failed} failed` }))));
      const table = h('table.ra-table', {},
        h('thead', {}, h('tr', {}, h('th', { text: phase === 'setup' ? '' : ' ' }), h('th', { text: 'Flow' }), h('th', { text: 'Steps' }), h('th', { text: 'Result' }))),
        h('tbody', {}, jobs.map((j) => {
          const n = j.rows.filter((r) => r.state === 'pass').length;
          const fr = j.rows.find((r) => r.state === 'fail');
          const cur = j.rows.find((r) => r.state === 'running' || r.state === 'waiting');
          const result = phase === 'setup' ? '' : j.state === 'queued' ? '' : j.state === 'running' ? (cur ? `step ${j.rows.indexOf(cur) + 1}: ${cur.it.name}…` : 'running…')
            : fr ? `step ${j.rows.indexOf(fr) + 1} — ${fr.it.name}: ${T.plainReason(fr.reason)}` : j.state === 'pass' ? 'all steps passed' : 'stopped';
          return h('tr', { class: 'st-' + j.state + (j.on ? '' : ' off'), onclick: () => { if (phase === 'setup') { j.on = !j.on; draw(); } else if (phase === 'done') { S.flowSel = j.flow.id; T.renderTree(); T.renderEditor(); } } },
            h('td', {}, phase === 'setup' ? h('input', { type: 'checkbox', checked: j.on, tabindex: -1, 'aria-label': 'Include ' + j.flow.name }) : h('span.run-ico', { text: { queued: '·', running: '…', pass: '✓', fail: '✕', stopped: '·' }[j.state] })),
            h('td', {}, j.flow.name),
            h('td.num', { text: phase === 'setup' ? String(j.rows.length) : `${n}/${j.rows.length}` }),
            h('td', { class: fr ? 'mk-failing' : '', text: result }));
        })));
      body.replaceChildren(head, askPanel(), table, phase === 'done' ? h('p.hint', { text: 'Click a flow to open it. Share report saves this table as a page anyone can open.' }) : '');
      startBtn.hidden = phase !== 'setup'; stopBtn.hidden = phase !== 'running'; shareBtn.hidden = phase !== 'done';
      const live = body.querySelector('tr.st-running'); if (live) live.scrollIntoView({ block: 'nearest' });
    };
    const close = T.modal(`Run flows — ${S.coll.name}`, body, [{ label: 'Close', run: (c) => c() }], () => { stop = true; if (asking) asking.resolve(null); });
    document.querySelector('#overlay .modal').classList.add('wide');
    document.querySelector('#overlay .modal footer').prepend(shareBtn, stopBtn, startBtn);
    stopBtn.onclick = () => { stop = true; stopBtn.disabled = true; if (asking) asking.resolve(null); };
    startBtn.onclick = async () => {
      const on = jobs.filter((j) => j.on);
      if (!on.length) return T.toast('Tick at least one flow', 'error');
      const opts = { mark: autoMark.checked, pause: Math.max(0, Math.min(10000, Number(delay.value) || 0)), stopped: () => stop };
      phase = 'running'; S.sending = true; draw();
      try {
        for (const j of on) {
          if (stop) { j.state = 'stopped'; continue; }
          j.state = 'running'; draw();
          const failed = await runFlowRows(j.rows, opts, { step: () => draw(), ask: askFor });
          j.state = stop && !failed && j.rows.some((r) => r.state === 'queued') ? 'stopped' : failed ? 'fail' : 'pass';
          draw();
        }
      } finally {
        S.sending = false; phase = 'done'; draw();
        T.renderTree(); T.renderMarkBar(); T.renderResponse(); T.renderEditor();
      }
    };
    draw();
  };

  /* ── share a report ─────────────────────────────────────────────────────── */

  /** Save a run as a page anyone with the link can open (no sign-in), and offer the link + a Markdown copy. */
  T.shareReport = async function (title, groups) {
    const flows = groups.map((g) => {
      const rows = g.rows.filter((r) => r.on !== false);
      const fr = rows.find((r) => r.state === 'fail');
      return {
        name: g.name, total: rows.length, passed: rows.filter((r) => r.state === 'pass').length,
        failedAt: fr ? rows.indexOf(fr) + 1 : null,
        steps: rows.map((r) => ({
          name: r.it.name, method: T.isWaitStep(r.it) ? 'WAIT' : (M.req(r.it).method || 'GET').toUpperCase(), url: T.isWaitStep(r.it) ? '' : M.urlRaw(M.req(r.it)),
          state: r.state === 'queued' ? 'not run' : r.state, reason: r.state === 'fail' ? T.plainReason(r.reason) : (r.reason || ''),
          http: r.result && r.result.res ? r.result.res.status : null, ms: r.result && r.result.res ? r.result.res.timeMs : null,
          tests: ((r.result && r.result.out && r.result.out.tests) || []).map((t) => ({ name: t.name, ok: !!t.ok, error: t.error || '' }))
        }))
      };
    });
    const report = { title, collection: S.coll.name, environment: S.env ? S.env.name : '', at: Math.floor(Date.now() / 1000), flows };
    const md = reportMarkdown(report);
    let link = '';
    try {
      const r = await T.api('POST', '/api/tester/reports', report);
      link = location.origin + r.url;
    } catch (e) { T.toast('Could not save the report: ' + (e.message || e), 'error'); }
    const linkIn = h('input.mono', { value: link, readonly: true, 'aria-label': 'Report link', onfocus: (ev) => ev.target.select() });
    const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); T.toast(what + ' copied'); } catch (e) { T.toast('Copy failed — select and copy by hand', 'error'); } };
    T.modal('Share report', h('div.share', {},
      h('p', { text: `${flows.length} flow${flows.length === 1 ? '' : 's'} · ${flows.filter((f) => f.failedAt == null && f.passed === f.total && f.total).length} passed · ${flows.filter((f) => f.failedAt != null).length} failed` }),
      link ? h('div.inline', {}, linkIn, h('button.primary', { text: 'Copy link', onclick: () => copy(link, 'Link') }), h('a', { href: link, target: '_blank', rel: 'noopener', text: 'Open ↗' })) : h('p.warn', { text: 'The report page could not be saved — the Markdown below still works.' }),
      h('p.hint', { text: 'The page needs no sign-in — paste the link to the backend team. It holds step names, results and test messages only, not tokens or bodies.' }),
      h('textarea.mono', { readonly: true, rows: 10, value: md, onfocus: (ev) => ev.target.select() }),
      h('div.inline', {}, h('button', { text: 'Copy as Markdown', onclick: () => copy(md, 'Markdown') }))),
      [{ label: 'Close', run: (c) => c() }]);
    if (link) linkIn.focus();
  };

  function reportMarkdown(rep) {
    const when = new Date(rep.at * 1000).toLocaleString();
    const lines = [`## ${rep.title}`, `${rep.collection}${rep.environment ? ' · ' + rep.environment : ''} · ${when}`, ''];
    rep.flows.forEach((f) => {
      const ok = f.failedAt == null && f.passed === f.total;
      lines.push(`### ${ok ? '✅' : f.failedAt != null ? '❌' : '⏸'} ${f.name} — ${f.passed}/${f.total}${f.failedAt != null ? `, failed at step ${f.failedAt}` : ''}`);
      f.steps.forEach((st, i) => {
        if (st.state === 'not run') return;
        const mark = st.state === 'pass' ? '✓' : st.state === 'fail' ? '✕' : '–';
        const line = st.state === 'fail' ? st.reason : (st.tests.find((t) => /→|—/.test(t.name)) || {}).name || st.reason || '';
        lines.push(`${i + 1}. ${mark} ${st.name}${st.http ? ` (HTTP ${st.http})` : ''}${line ? ` — ${line}` : ''}`);
      });
      lines.push('');
    });
    return lines.join('\n');
  }

  /* ── duplicate for another game ────────────────────────────────────────── */

  /** Copy a flow with every game id swapped: the bodies' "game_id", {{flow_*_game_id}} variables, and "(game N)" in names. */
  T.duplicateForGame = function (flow) {
    const text = JSON.stringify(flow);
    const idsInBodies = [...text.matchAll(/\\"game_id\\":\s*\\"?(\d+)\\"?/g)].map((m) => m[1]);
    const vars = [...new Set([...text.matchAll(/\{\{(flow_[a-z]*_?game_id)\}\}/g)].map((m) => m[1]))];
    const fromName = (flow.name.match(/\(game (\d+)\)/) || [])[1];
    const cur = fromName || idsInBodies[0] || (vars.length ? T.scopes().map((sc) => sc.get(vars[0])).find((v) => v) : '') || '';
    const games = (S.coll.data.item || []).length ? collectGameNames() : [];
    const idIn = h('input.mono', { value: '', placeholder: 'e.g. 15', list: 'dup-games', 'aria-label': 'Game id' });
    const nameIn = h('input', { value: '', placeholder: 'Flow name', 'aria-label': 'Flow name' });
    const datalist = h('datalist', { id: 'dup-games' }, games.map((g) => h('option', { value: g.id, label: g.name })));
    const suggest = () => {
      const id = idIn.value.trim(); if (!id) return;
      const g = games.find((x) => x.id === id);
      let n = flow.name;
      if (fromName) n = n.replace(/\(game \d+\)/, `(game ${id})`);
      const oldGame = games.find((x) => x.id === String(cur));
      if (oldGame && g && n.includes(oldGame.name)) n = n.replace(oldGame.name, g.name);
      else if (g && !fromName) n = `${g.name} — ${n}`;
      if (!/\(game \d+\)/.test(n)) n += ` (game ${id})`;
      nameIn.value = n;
    };
    idIn.oninput = suggest;
    const body = h('div', {},
      h('p', { text: `Copies "${flow.name}"${cur ? ` (game ${cur})` : ''} for another game: every game id in it is replaced, the steps and checks stay the same.` }),
      h('label', {}, 'New game id', datalist, idIn),
      h('label', {}, 'Flow name', nameIn),
      vars.length ? h('p.hint', { text: `This flow reads the game id from {{${vars.join('}}, {{')}}; the copy gets the id written in.` }) : '');
    T.modal('Duplicate for another game', body, [
      { label: 'Cancel', run: (c) => c() },
      { label: 'Create copy', kind: 'primary', run: async (c) => {
        const id = idIn.value.trim();
        if (!/^\d+$/.test(id)) { idIn.focus(); return T.toast('Enter the game id (a number)', 'error'); }
        const name = nameIn.value.trim() || `${flow.name} (game ${id})`;
        const copy = M.freshIds(M.clone(flow));
        copy.name = name;
        if (typeof copy.description === 'string') copy.description = copy.description.replace(/\bGame \d+\b/, 'Game ' + id).replace(/\(game \d+\)/g, `(game ${id})`);
        M.walk(copy.item, (it) => {
          const req = it.request;
          if (!req) return;
          if (req.body && typeof req.body.raw === 'string') {
            req.body.raw = req.body.raw.replace(/("game_id"\s*:\s*)("?)(?:\d+|\{\{flow_[a-z]*_?game_id\}\})("?)/g, `$1$2${id}$3`);
            vars.forEach((v) => { req.body.raw = req.body.raw.split(`{{${v}}}`).join(id); });
          }
          const raw = M.urlRaw(req);
          if (raw && vars.some((v) => raw.includes(`{{${v}}}`))) { let u = raw; vars.forEach((v) => { u = u.split(`{{${v}}}`).join(id); }); if (typeof req.url === 'string') req.url = u; else req.url.raw = u; }
        });
        const root = flowsRoot();
        root.item.splice(root.item.indexOf(flow) + 1, 0, copy);
        S.flowSel = copy.id; T.markDirty(); T.renderTree(); T.renderEditor();
        await T.saveColl();
        c();
        T.toast(`Created "${name}"`);
      } }
    ]);
    idIn.focus();
  };

  /** Game names the collection knows, from folder names like "2 · Ludo" or "Roulette (game 5)". */
  function collectGameNames() {
    const seen = new Map();
    M.walk(S.coll.data.item, (it) => {
      const m = it.name.match(/^(\d+)\s*[·\-–]\s*(.+)$/) || it.name.match(/^(.+?)\s*\(game (\d+)\)$/);
      if (!m) return;
      const id = /^\d+$/.test(m[1]) ? m[1] : m[2], name = /^\d+$/.test(m[1]) ? m[2] : m[1];
      const clean = name.replace(/\s*[—-].*$/, '').replace(/\s*⚠.*$/, '').trim();
      if (!seen.has(id)) seen.set(id, { id, name: clean });
    });
    return [...seen.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** What one step sent and got back the last time it ran. */
  T.stepDetail = function (it) {
    const req = M.req(it);
    const m = S.marks[it.id];
    const r = S.results.get(it.id);
    let bodyText = '';
    if (r && r.res) { try { bodyText = JSON.stringify(JSON.parse(r.res.body), null, 2); } catch (e) { bodyText = r.res.body || ''; } }
    const body = h('div.step-detail', {},
      h('div.inline', {}, h('span.meth', { class: 'm-' + (req.method || 'GET').toUpperCase(), text: (req.method || 'GET').toUpperCase() }), h('code', { text: M.urlRaw(req) })),
      m ? h('p', {}, h('b', { class: m.status === 'verified' ? 'mk-verified' : 'mk-failing', text: m.status === 'verified' ? '✓ Worked' : '✕ Not working' }),
        m.note ? ' — ' + m.note.replace(/^Auto run: /, '') : '', h('span.faint', { text: ` · ${ago(m.markedAt)}${m.markedBy ? ' by ' + m.markedBy : ''}` })) : h('p.hint', { text: 'Not run yet.' }),
      r && r.res ? h('div', {}, h('p.hint', { text: `Response from this page's last run · HTTP ${r.res.status} · ${r.res.timeMs} ms` }), h('pre.code.step-body', { text: bodyText.slice(0, 20000) }))
        : r && (r.error || r.skipped) ? h('p.warn', { text: r.error || r.skipped }) : h('p.hint', { text: 'Run the flow in this page to see the response here.' }),
      r && r.out && r.out.tests.length ? h('ul.step-tests', {}, r.out.tests.map((t) => h('li', { class: t.ok ? 'mk-verified' : 'mk-failing', text: (t.ok ? '✓ ' : '✕ ') + t.name + (t.error ? ' — ' + t.error : '') }))) : '');
    T.modal(it.name, body, [{ label: 'Close', run: (c) => c() }]);
  };

  /* ── examples ────────────────────────────────────────────────────────────── */

  // Ready-made flows built from APIs the collection already has, with their validations filled in —
  // the quickest way to see how asking, checking and keeping values fit together.
  const EXAMPLES = [{
    label: 'Password reset — OTP, new password, log in with it',
    name: 'Password reset — OTP, new password, log in with it',
    desc: 'Asks for the phone number, the SMS OTP and a new password, resets the password, then proves it by logging in with the new one.',
    steps: [
      { url: '/auth/request/update-password', name: '1. Request a reset OTP',
        ask: [{ var: 'phone', label: 'Phone number of the test account (dial code + number, no +)' }],
        rules: [{ field: '@ok' }, { field: '_id', op: 'exists', value: '' }],
        save: [['_id', 'agp_user_id']] },
      { url: '/auth/validate/otp-reset-password/', name: '2. Validate the OTP',
        ask: [{ var: 'otp', label: 'OTP from the SMS' }],
        rules: [{ field: '@ok' }, { field: 'reset_token', op: 'notempty', value: '' }],
        save: [['reset_token', 'reset_token']] },
      { url: '/auth/update/reset-password', name: '3. Set the new password',
        ask: [{ var: 'new_password', label: 'New password to set' }],
        rules: [{ field: '@ok' }, { field: 'status', op: 'true', value: '' }] },
      { url: '/auth/login/phone', method: 'POST', name: '4. Log in with the new password',
        ask: [{ var: 'password', label: 'Type the new password again — the login must work with it' }],
        rules: [{ field: '@ok' }, { field: 'access_token', op: 'notempty', value: '' }, { field: 'user._id', op: 'is', value: '{{agp_user_id}}' }] }
    ]
  }];

  /* ── dialog ────────────────────────────────────────────────────────────── */

  /** Open the builder for an existing flow folder, or with no argument for a new flow. */
  T.flowBuilder = function (folder) {
    if (!S.coll) return T.toast('Open a collection first', 'error');
    if (folder && !T.isFlowFolder(folder)) folder = null;
    const editingId = folder ? folder.id : null;
    let name = folder ? folder.name : '';
    let desc = folder ? (typeof folder.description === 'string' ? folder.description : (folder.description && folder.description.content) || '') : '';
    let steps = folder ? folder.item.filter((x) => !M.isFolder(x)).map((x) => stepOf(M.clone(x))) : [];
    let query = '', dirty = false, busy = false;
    let drag = null;                       // {kind: 'src', id} | {kind: 'step', index}

    const overlay = document.getElementById('overlay');
    const touch = () => { dirty = true; };
    const close = (force) => {
      if (!force && dirty && !confirm('Close the Flow builder without saving this flow?')) return;
      overlay.replaceChildren(); document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev) => { if (ev.key === 'Escape' && !ev.target.closest('input, textarea, select')) close(); };
    document.addEventListener('keydown', onKey);

    /* library */
    const lib = [];
    M.walk(S.coll.data.item, (it) => {
      if (M.isFolder(it)) return;
      const parents = M.parentsOf(S.coll.data.item, it) || [];
      if (editingId && parents.some((p) => p.id === editingId)) return;      // not the flow being edited
      lib.push({ it, top: parents[0] ? parents[0].name : '', trail: parents.slice(1).map((p) => p.name).join(' › '), risk: T.riskOf(it) });
    });
    const search = h('input', { type: 'search', id: 'fb-search', placeholder: 'Search APIs — name or URL', 'aria-label': 'Search APIs' });
    const libList = h('div.fb-lib-list', { role: 'list' });
    search.oninput = () => { query = search.value.trim().toLowerCase(); drawLibrary(); };

    function drawLibrary() {
      const rows = [];
      let lastTop = null, shown = 0;
      for (const x of lib) {
        const req = M.req(x.it);
        if (query && !`${x.it.name} ${M.urlRaw(req)} ${x.trail}`.toLowerCase().includes(query)) continue;
        if (shown++ > 300) { rows.push(h('p.hint', { text: 'More match — keep typing to narrow it down.' })); break; }
        if (x.top !== lastTop) { rows.push(h('div.fb-lib-group', { text: x.top || 'Top level' })); lastTop = x.top; }
        const method = (req.method || 'GET').toUpperCase();
        rows.push(h('div.fb-lib-row', {
          role: 'listitem', draggable: 'true', title: `${M.urlRaw(req)}${x.risk ? '\n⚠ ' + x.risk : ''}\nDrag into the flow, or press +`,
          ondragstart: (ev) => { drag = { kind: 'src', id: x.it.id }; ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData('text/plain', x.it.name); },
          ondragend: () => { drag = null; clearDrop(); }
        },
          h('span.meth', { class: 'm-' + method, text: method.slice(0, 6) }),
          h('span.fb-lib-name', {}, x.it.name, x.trail ? h('span.faint', { text: x.trail }) : ''),
          x.risk ? h('span.fb-risk', { text: '⚠', title: x.risk }) : '',
          h('button.ghost.fb-add', { text: '+', title: 'Add to the end of the flow', 'aria-label': 'Add ' + x.it.name, onclick: () => { steps.push(copyFromLibrary(x.it)); touch(); drawSteps(); scrollToEnd(); } })));
      }
      if (!rows.length) rows.push(h('p.hint', { text: 'No API matches that search.' }));
      libList.replaceChildren(...rows);
    }

    /* steps */
    const nameIn = h('input', { id: 'fb-name', value: name, placeholder: 'Flow name, e.g. Ludo multiplayer — P1 wins', oninput: () => { name = nameIn.value; touch(); } });
    const descIn = h('input', { id: 'fb-desc', value: desc, placeholder: 'What this flow checks (optional)', oninput: () => { desc = descIn.value; touch(); } });
    const stepList = h('ol.fb-steps', { 'aria-label': 'Flow steps' });
    const marker = h('li.fb-drop', { 'aria-hidden': 'true' });
    const summary = h('div.fb-summary');

    const scrollToEnd = () => { const last = stepList.lastElementChild; if (last) last.scrollIntoView({ block: 'nearest' }); };
    const clearDrop = () => { marker.remove(); stepList.classList.remove('over'); };
    const dropIndex = (y) => {
      const cards = [...stepList.querySelectorAll('.fb-step')];
      const i = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
      return i < 0 ? cards.length : i;
    };
    stepList.ondragover = (ev) => {
      if (!drag) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = drag.kind === 'src' ? 'copy' : 'move';
      stepList.classList.add('over');
      const i = dropIndex(ev.clientY);
      const cards = stepList.querySelectorAll('.fb-step');
      if (i < cards.length) stepList.insertBefore(marker, cards[i]); else stepList.append(marker);
    };
    stepList.ondragleave = (ev) => { if (!stepList.contains(ev.relatedTarget)) clearDrop(); };
    stepList.ondrop = (ev) => {
      if (!drag) return;
      ev.preventDefault();
      let i = dropIndex(ev.clientY);
      if (drag.kind === 'src') {
        const src = M.findById(S.coll.data.item, drag.id);
        if (src) steps.splice(i, 0, copyFromLibrary(src));
      } else {
        const [moved] = steps.splice(drag.index, 1);
        if (drag.index < i) i--;
        steps.splice(i, 0, moved);
      }
      drag = null; clearDrop(); touch(); drawSteps();
    };

    function availability() {
      const scopes = T.scopes();
      const valueOf = (k) => { const sc = scopes.find((s) => s.has(k)); return sc ? String(sc.get(k) == null ? '' : sc.get(k)) : null; };
      const madeBy = new Map();        // variable -> step number that sets it
      return steps.map((st, idx) => {
        if (st.wait) return [];
        const it = finalItem(st);
        const own = new Set(varsSetByScripts(it, ['prerequest']));      // set just before this step is sent
        const asked = new Set(st.ask.map((a) => a.var));
        const chips = varsUsed(it).map((k) => {
          if (asked.has(k)) return { k, kind: 'ask' };
          if (madeBy.has(k)) return { k, kind: 'step', from: madeBy.get(k) };
          if (own.has(k)) return { k, kind: 'step', from: idx + 1 };
          const v = valueOf(k);
          return v === null ? { k, kind: 'missing' } : v.trim() ? { k, kind: 'vars' } : { k, kind: 'empty' };
        });
        varsSetByScripts(it).concat([...asked]).forEach((k) => { if (!madeBy.has(k)) madeBy.set(k, idx + 1); });
        return chips;
      });
    }

    function drawSteps() {
      const avail = availability();
      const cards = steps.map((st, idx) => stepCard(st, idx, avail[idx]));
      if (!steps.length) cards.push(h('li.fb-empty', {}, h('b', { text: 'Drag APIs here' }), h('span', { text: 'or press + next to an API on the left. Drag the cards to change the order.' })));
      stepList.replaceChildren(...cards);
      const missing = avail.reduce((n, c) => n + c.filter((x) => x.kind === 'missing').length, 0);
      summary.replaceChildren(
        h('span', { text: `${steps.length} step${steps.length === 1 ? '' : 's'}` }),
        missing ? h('span.fb-miss', { text: ` · ${missing} variable${missing === 1 ? '' : 's'} with no value — save them from an earlier step or fill them in Variables` }) : steps.length ? h('span.faint', { text: ' · every variable has a value' }) : '');
      saveBtn.disabled = runBtn.disabled = busy;
    }

    function stepCard(st, idx, chips) {
      const moveByW = (d) => { const j = idx + d; if (j < 0 || j >= steps.length) return; steps.splice(idx, 1); steps.splice(j, 0, st); touch(); drawSteps(); };
      if (st.wait) {
        const secs = h('input', { type: 'number', min: 1, max: 600, value: st.it.wait, 'aria-label': 'Seconds to wait', style: 'width:80px', oninput: () => { st.it.wait = Number(secs.value) || 1; st.it.name = `⏱ Wait ${st.it.wait} s`; touch(); } });
        return h('li.fb-step.fb-wait', {},
          h('div.fb-step-head', {},
            h('span.fb-handle', { text: '⠿', title: 'Drag to reorder', draggable: 'true', ondragstart: (ev) => { drag = { kind: 'step', index: idx }; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', st.it.name); }, ondragend: () => { drag = null; clearDrop(); } }),
            h('span.fb-num', { text: String(idx + 1) }),
            h('span.meth.m-WAIT', { text: 'WAIT' }),
            h('span.fb-wait-label', {}, 'Wait ', secs, ' seconds — for a win the server pays a little later (outbox), then check the balance in the next step'),
            h('div.fb-step-tools', {},
              h('button.ghost', { text: '↑', title: 'Move up', 'aria-label': 'Move up', disabled: idx === 0, onclick: () => moveByW(-1) }),
              h('button.ghost', { text: '↓', title: 'Move down', 'aria-label': 'Move down', disabled: idx === steps.length - 1, onclick: () => moveByW(1) }),
              h('button.ghost.danger', { text: '✕', title: 'Remove from the flow', 'aria-label': 'Remove', onclick: () => { steps.splice(idx, 1); touch(); drawSteps(); } }))));
      }
      const req = M.req(st.it);
      const method = T.isSocketStep(st.it) ? 'SOCKET' : (req.method || 'GET').toUpperCase();
      const runAs = h('select', { 'aria-label': 'Send as', title: 'Whose token this step sends', onchange: () => { st.runAs = runAs.value; touch(); drawSteps(); } },
        Object.entries(RUN_AS).map(([k, v]) => h('option', { value: k, text: v.label, selected: st.runAs === k })));
      const nameEdit = h('input.fb-step-name', { value: st.it.name, 'aria-label': 'Step name', oninput: () => { st.it.name = nameEdit.value; touch(); } });
      const moveBy = (d) => { const j = idx + d; if (j < 0 || j >= steps.length) return; steps.splice(idx, 1); steps.splice(j, 0, st); touch(); drawSteps(); };
      const checks = st.save.length + st.rules.length + st.ask.length;
      const summary = [
        ...st.ask.map((a) => h('span.fb-sum.ask', { text: `✎ asks {{${a.var}}}`, title: a.label || '' })),
        ...st.rules.map((r) => h('span.fb-sum.rule', { text: '✓ ' + T.ruleText(r) })),
        ...st.save.map(([p, v]) => h('span.fb-sum.save', { text: `⤓ ${p} → {{${v}}}` }))];

      const card = h('li.fb-step', { class: st.open ? 'open' : '' },
        h('div.fb-step-head', {},
          h('span.fb-handle', {
            text: '⠿', title: 'Drag to reorder', draggable: 'true',
            ondragstart: (ev) => { drag = { kind: 'step', index: idx }; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', st.it.name); ev.dataTransfer.setDragImage(card, 16, 16); card.classList.add('dragging'); },
            ondragend: () => { drag = null; card.classList.remove('dragging'); clearDrop(); }
          }),
          h('span.fb-num', { text: String(idx + 1) }),
          h('span.meth', { class: 'm-' + method, text: method.slice(0, 6) }),
          nameEdit,
          runAs,
          h('div.fb-step-tools', {},
            h('button', { class: 'fb-val-btn' + (checks ? ' has' : ''), text: checks ? `✓ Validations · ${checks}` : '+ Validations', title: 'What this step must return, what to keep for later steps, and what to ask while running', 'aria-expanded': String(st.open), onclick: () => { st.open = !st.open; drawSteps(); } }),
            h('button.ghost', { text: '↑', title: 'Move up', 'aria-label': 'Move up', disabled: idx === 0, onclick: () => moveBy(-1) }),
            h('button.ghost', { text: '↓', title: 'Move down', 'aria-label': 'Move down', disabled: idx === steps.length - 1, onclick: () => moveBy(1) }),
            h('button.ghost', { text: '⧉', title: 'Duplicate this step', 'aria-label': 'Duplicate', onclick: () => { const copy = stepOf(M.clone(finalItem(st))); copy.it.id = M.uid(); copy.it.name = st.it.name + ' (again)'; steps.splice(idx + 1, 0, copy); touch(); drawSteps(); } }),
            h('button.ghost.danger', { text: '✕', title: 'Remove from the flow', 'aria-label': 'Remove', onclick: () => { steps.splice(idx, 1); touch(); drawSteps(); } }))),
        h('div.fb-step-sub', {},
          h('code.fb-url', { text: M.urlRaw(req), title: M.urlRaw(req) }),
          chips.map((c) => h(c.kind === 'missing' || c.kind === 'empty' ? 'button' : 'span', {
            class: 'fb-chip ' + c.kind,
            text: c.kind === 'step' ? `{{${c.k}}} ← step ${c.from}` : c.kind === 'ask' ? `{{${c.k}}} ← asked` : `{{${c.k}}}`,
            title: c.kind === 'step' ? `Set by step ${c.from}` : c.kind === 'ask' ? 'Asked while the flow runs' : c.kind === 'vars' ? 'Has a value in Variables' : 'No value yet — click to ask for it while the flow runs',
            onclick: c.kind === 'missing' || c.kind === 'empty' ? () => { st.ask.push({ var: c.k, label: '' }); st.open = true; touch(); drawSteps(); } : undefined
          }))),
        !st.open && summary.length ? h('div.fb-sums', {}, summary) : '',
        st.open ? checksPanel(st) : '');
      return card;
    }

    function checksPanel(st) {
      const tried = st.tried || (S.results.get(st.it.id) && S.results.get(st.it.id).res ? S.results.get(st.it.id)
        : S.results.get(st.srcId) && S.results.get(st.srcId).res ? S.results.get(st.srcId) : null);
      const paths = tried && tried.res ? jsonPaths(tried.res.body) : [];
      const listId = 'fb-paths-' + st.it.id;
      const datalist = h('datalist', { id: listId },
        h('option', { value: '@status', label: 'HTTP status' }), h('option', { value: '@time', label: 'Response time (ms)' }),
        paths.map((p) => h('option', { value: p.path, label: p.value.slice(0, 40) })));
      const redraw = () => { touch(); drawSteps(); };

      /* ask while running */
      const askRows = st.ask.map((a, i) => h('div.fb-row.ask', {},
        h('span.fb-row-lead', { text: 'Ask for' }),
        h('input.mono', { value: a.var, placeholder: 'otp', 'aria-label': 'Variable', oninput: (ev) => { a.var = ev.target.value.trim(); touch(); }, onchange: redraw }),
        h('input', { value: a.label || '', placeholder: 'Question to show, e.g. Enter the OTP sent by SMS', 'aria-label': 'Question', oninput: (ev) => { a.label = ev.target.value; touch(); } }),
        h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { st.ask.splice(i, 1); redraw(); } })));

      /* rules */
      const ruleRows = st.rules.map((r, i) => {
        if (r.field === '@ok') {
          return h('div.fb-row.rule', {}, h('span.fb-row-lead', { text: 'Check' }),
            h('span.fb-ok', { text: 'Response looks OK — HTTP 2xx and no "status": false' }),
            h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { st.rules.splice(i, 1); redraw(); } }));
        }
        const op = h('select', { 'aria-label': 'Condition', onchange: () => { r.op = op.value; redraw(); } },
          Object.entries(OPS).map(([k, v]) => h('option', { value: k, text: v.label, selected: r.op === k })));
        return h('div.fb-row.rule', {},
          h('span.fb-row-lead', { text: 'Check' }),
          h('input.mono', { value: r.field, list: listId, placeholder: 'status', 'aria-label': 'Response field', oninput: (ev) => { r.field = ev.target.value.trim(); touch(); }, onchange: redraw }),
          op,
          OPS[r.op] && OPS[r.op].value
            ? h('input.mono', { value: r.value == null ? '' : r.value, placeholder: 'value or {{variable}}', 'aria-label': 'Expected value', oninput: (ev) => { r.value = ev.target.value; touch(); } })
            : h('span'),
          OPS[r.op] && OPS[r.op].ref
            ? h('span.fb-since', {}, 'since ', h('input.mono', { value: r.ref || '', placeholder: '{{value kept earlier}}', 'aria-label': 'Value kept by an earlier step', oninput: (ev) => { r.ref = ev.target.value.trim(); touch(); } }))
            : '',
          h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { st.rules.splice(i, 1); redraw(); } }));
      });
      const has = (field, op) => st.rules.some((r) => r.field === field && (!op || r.op === op));
      const preset = (label, rule) => h('button.fb-preset', { text: label, disabled: has(rule.field, rule.op), onclick: () => { st.rules.push(Object.assign({}, rule)); redraw(); } });

      /* saves */
      const saveRows = st.save.map((row, i) => h('div.fb-row.save', {},
        h('span.fb-row-lead', { text: 'Keep' }),
        h('input.mono', { value: row[0], list: listId, placeholder: 'reset_token', 'aria-label': 'Response field', oninput: (ev) => { row[0] = ev.target.value.trim(); touch(); } }),
        h('span.faint', { text: 'as' }),
        h('input.mono', { value: row[1], placeholder: 'reset_token', 'aria-label': 'Variable name', oninput: (ev) => { row[1] = ev.target.value.trim(); touch(); }, onchange: redraw }),
        h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { st.save.splice(i, 1); redraw(); } })));

      /* try + clickable response */
      const tryBtn = h('button', {
        text: tried ? '▶ Try again' : '▶ Try this step',
        title: 'Send just this step now and see its response — then click a value to check or keep it',
        onclick: async () => {
          const risk = T.riskOf(st.it);
          if (risk && !confirm(`This request ${risk}. Send it anyway?`)) return;
          for (const a of st.ask) {
            const cur = T.localStore().get(a.var);
            const v = prompt(a.label || `Value for {{${a.var}}}`, cur == null ? '' : cur);
            if (v === null) return;
            T.localStore().set(a.var, v);
          }
          tryBtn.disabled = true; tryBtn.textContent = 'Sending…';
          st.tried = await T.execute(finalItem(st));
          if (S.envDirty) T.saveEnv(true);
          drawSteps();
        }
      });
      const addCheck = (path, value) => {
        if (!st.rules.length) st.rules.push({ field: '@ok' });
        const v = String(value);
        const op = v === 'true' ? 'true' : v === 'false' ? 'false' : 'is';
        st.rules.push({ field: path, op, value: op === 'is' ? v : '' });
        redraw();
      };
      const addKeep = (path) => {
        const key = path.split('.').filter((x) => !/^\d+$/.test(x)).pop() || 'value';
        const name = key.replace(/^_/, '').replace(/[^A-Za-z0-9_]/g, '_') || 'value';
        if (!st.rules.length) st.rules.push({ field: '@ok' });
        st.save.push([path, name]);
        redraw();
      };
      const addExists = (path) => {
        if (!st.rules.length) st.rules.push({ field: '@ok' });
        st.rules.push({ field: path, op: 'exists', value: '' });
        redraw();
      };
      let responseBox = '';
      if (tried && tried.res) {
        let body = null; try { body = JSON.parse(tried.res.body); } catch (e) { /* not JSON */ }
        const results = (tried.out && tried.out.tests) || [];
        responseBox = h('div.fb-resp', {},
          h('div.fb-resp-head', {},
            h('b', { class: tried.res.status < 300 ? 'mk-verified' : 'mk-failing', text: `HTTP ${tried.res.status}` }),
            h('span.faint', { text: `${tried.res.timeMs} ms` }),
            body !== null ? h('span.hint', { text: 'Click ✓ to check a value, or ⤓ to keep it for later steps' }) : ''),
          results.length ? h('ul.fb-results', {}, results.map((t) => h('li', { class: t.ok ? 'mk-verified' : 'mk-failing', text: (t.ok ? '✓ ' : '✕ ') + t.name + (t.error && !t.name.includes(t.error) ? ' — ' + t.error : '') }))) : '',
          body !== null ? jsonTree(body, addCheck, addKeep, addExists) : h('pre.fb-preview', { text: String(tried.res.body || '').slice(0, 800) }));
      } else if (tried) {
        responseBox = h('p.hint.fb-miss', { text: tried.error || tried.skipped || '' });
      }

      return h('div.fb-checks', {},
        datalist,
        h('section.fb-val', {},
          h('div.fb-val-title', {}, h('b', { text: '1 · Ask while running' }), h('span.hint', { text: 'For things only a person has — an OTP from SMS, a new password. The test pauses and asks.' })),
          askRows,
          h('button.ghost.fb-add-row', { text: '+ Ask for a value', onclick: () => { st.ask.push({ var: '', label: '' }); redraw(); } })),
        h('section.fb-val', {},
          h('div.fb-val-title', {}, h('b', { text: '2 · Check the response' }), h('span.hint', { text: 'The step passes only if every check is true. No checks = HTTP 2xx and no "status": false.' })),
          ruleRows,
          h('div.fb-presets', {},
            preset('+ Response looks OK', { field: '@ok' }),
            preset('+ status is true', { field: 'status', op: 'true' }),
            preset('+ message contains…', { field: 'message', op: 'contains', value: 'success' }),
            preset('+ HTTP is 2xx', { field: '@status', op: 'ok2xx' }),
            h('button.fb-preset', { text: '+ Custom check', onclick: () => { st.rules.push({ field: '', op: 'is', value: '' }); redraw(); } }))),
        h('section.fb-val', {},
          h('div.fb-val-title', {}, h('b', { text: '3 · Keep for the next steps' }), h('span.hint', { text: 'A value from this response becomes {{name}} for every step after it.' })),
          saveRows,
          h('button.ghost.fb-add-row', { text: '+ Keep a value', onclick: () => { st.save.push(['', '']); redraw(); } })),
        h('div.inline.fb-try', {}, tryBtn, !tried ? h('span.hint', { text: 'Try it once — then you can click values in the response instead of typing field names.' }) : ''),
        responseBox);
    }

    /** A JSON response as a tree whose values each get a ✓ (check it) and ⤓ (keep it) button. */
    function jsonTree(value, onCheck, onKeep, onExists) {
      let shown = 0;
      const node = (v, path, key, depth) => {
        if (shown > 120) return null;
        if (v !== null && typeof v === 'object') {
          const entries = Array.isArray(v) ? v.slice(0, 3).map((x, i) => [String(i), x]) : Object.entries(v);
          const open = depth < 2;
          return h('details.fb-tree-obj', { open },
            h('summary', {}, key !== null ? h('span.fb-tree-key', { text: key }) : '', h('span.faint', { text: Array.isArray(v) ? ` [${v.length}]` : ' {…}' }),
              key !== null ? h('span.fb-tree-acts', {}, h('button.ghost', { text: '✓ exists', title: `Check that ${path} is in the response`, onclick: (ev) => { ev.preventDefault(); onExists(path); } })) : ''),
            h('div.fb-tree-kids', {}, entries.map(([k, x]) => node(x, path ? `${path}.${k}` : k, k, depth + 1))));
        }
        shown++;
        const text = v === null ? 'null' : typeof v === 'string' ? `"${v.length > 80 ? v.slice(0, 80) + '…' : v}"` : String(v);
        return h('div.fb-tree-leaf', {},
          h('span.fb-tree-key', { text: key }), h('span.faint', { text: ': ' }),
          h('span', { class: v === null || typeof v === 'boolean' ? 'j-lit' : typeof v === 'number' ? 'j-num' : 'j-str', text }),
          h('span.fb-tree-acts', {},
            h('button.ghost', { text: '✓ check', title: `Check that ${path} is ${text}`, onclick: () => onCheck(path, v) }),
            h('button.ghost', { text: '⤓ keep', title: `Keep ${path} for later steps`, onclick: () => onKeep(path) })));
      };
      return h('div.fb-tree', {}, node(value, '', null, 0));
    }

    /* examples */
    function loadExample(ex) {
      const built = [];
      for (const spec of ex.steps) {
        const src = lib.find((x) => !FLOWS_RE.test(x.top) && M.urlRaw(M.req(x.it)).includes(spec.url) && (!spec.method || (M.req(x.it).method || 'GET').toUpperCase() === spec.method));
        if (!src) return T.toast(`This collection has no API for ${spec.url} — the example needs it`, 'error');
        const st = copyFromLibrary(src.it);
        st.it.name = spec.name;
        st.ask = (spec.ask || []).map((a) => Object.assign({}, a));
        st.rules = (spec.rules || []).map((r) => Object.assign({}, r));
        st.save = (spec.save || []).map((x) => [...x]);
        st.open = false;
        built.push(st);
      }
      if (steps.length && !confirm('Replace the steps you have with this example?')) return;
      steps = built;
      if (!name.trim()) { name = ex.name; nameIn.value = name; }
      if (!desc.trim()) { desc = ex.desc; descIn.value = desc; }
      steps[0].open = true;
      touch(); drawSteps();
    }

    /* save */
    async function save(andRun) {
      if (!name.trim()) { nameIn.focus(); return T.toast('Give the flow a name', 'error'); }
      if (!steps.length) return T.toast('Add at least one step', 'error');
      busy = true; drawSteps();
      let root = flowsRoot();
      if (!root) { root = { id: M.uid(), name: '🧪 Flows', auth: { type: 'noauth' }, item: [] }; S.coll.data.item.unshift(root); }
      let target = editingId ? M.findById(S.coll.data.item, editingId) : null;
      if (!target) { target = { id: M.uid(), name: '', auth: { type: 'noauth' }, item: [] }; root.item.push(target); }
      target.name = name.trim();
      if (desc.trim()) target.description = desc.trim(); else delete target.description;
      target.auth = target.auth || { type: 'noauth' };
      target.item = steps.map(finalItem);
      T.markDirty();
      await T.saveColl();
      busy = false;
      if (S.dirty) { drawSteps(); return T.toast('Not saved yet — see the message above and try again', 'error'); }
      dirty = false;
      S.flowSel = target.id; S.view = 'flows'; T.ls.set('view', 'flows');
      T.renderTree(); T.renderEditor(); T.renderResponse();
      close(true);
      T.toast(`Saved flow "${target.name}"`);
      if (andRun) T.runDialog(target);
    }

    const saveBtn = h('button.primary', { text: 'Save flow', onclick: () => save(false) });
    const runBtn = h('button', { text: 'Save & run', onclick: () => save(true) });

    const box = h('div.modal.fb', { role: 'dialog', 'aria-label': 'Flow builder' },
      h('header', {}, h('span.grow', { text: folder ? `Flow builder — ${folder.name}` : 'Flow builder — new flow' }), h('button.ghost', { text: '×', title: 'Close', onclick: () => close() })),
      h('div.fb-body', {},
        h('aside.fb-lib', {}, h('div.fb-col-title', {}, h('b', { text: 'APIs' }), h('span.hint', { text: `${lib.length} in this collection` })), search, libList),
        h('section.fb-flow', {},
          h('div.fb-meta', {}, h('label', { for: 'fb-name', text: 'Flow name' }), nameIn, h('label', { for: 'fb-desc', text: 'Description' }), descIn),
          h('div.fb-col-title', {}, h('b', { text: 'Steps' }), summary, h('span.grow'),
            h('button.ghost', { text: '⏱ + Wait', title: 'Add a pause — for credits the server pays a few seconds later', onclick: () => { steps.push(stepOf(T.waitStep(15))); touch(); drawSteps(); scrollToEnd(); } }),
            h('button.ghost', { text: '✨ Examples', title: 'Start from a ready-made flow', onclick: (ev) => T.menu(ev.currentTarget, EXAMPLES.map((ex) => ({ label: ex.label, run: () => loadExample(ex) }))) })),
          stepList)),
      h('footer', {},
        h('span.hint.grow', { text: 'Saved into the 🧪 Flows folder. Steps are copies — changing a flow never changes the original API.' }),
        h('button', { text: 'Cancel', onclick: () => close() }), runBtn, saveBtn));
    overlay.replaceChildren(box);
    overlay.onclick = (ev) => { if (ev.target === overlay) close(); };
    drawLibrary(); drawSteps();
    (folder ? nameIn : search).focus();
  };
})();
