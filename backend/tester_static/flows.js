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
    let meta = { save: [], expect: [] };
    if (s < 0 || e < s) return { rest: String(code || ''), meta };
    const metaLine = lines.slice(s, e).find((l) => l.startsWith(META));
    try { meta = Object.assign(meta, JSON.parse(metaLine.slice(META.length))); } catch (err) { /* hand-edited — start clean */ }
    const rest = lines.slice(0, s).concat(lines.slice(e + 1)).join('\n').replace(/^\n+|\n+$/g, '');
    return { rest, meta };
  }

  function builderBlock(save, expect) {
    save = save.filter(([p, v]) => p.trim() && v.trim());
    expect = expect.filter(([p]) => p.trim());
    if (!save.length && !expect.length) return '';
    const js = JSON.stringify;
    const out = [START, META + js({ save, expect }), '{',
      '  let j = null; try { j = pm.response.json(); } catch (e) {}',
      "  const get = (p) => String(p).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), j);",
      "  pm.test('HTTP ' + pm.response.code + (j && j.message ? ' — ' + j.message : ''), () => { if (pm.response.code >= 300 || (j && (j.status === false || j.success === false))) throw new Error('the response says it failed'); });"];
    save.forEach(([p, v]) => out.push(
      `  { const v = get(${js(p)}); pm.test(${js('Saved ' + v.trim() + ' from ' + p.trim() + ' = ')} + v, () => { if (v === undefined || v === null || v === '') throw new Error(${js(p.trim() + ' is not in the response')}); }); if (v !== undefined && v !== null) pm.variables.set(${js(v.trim())}, typeof v === 'object' ? JSON.stringify(v) : String(v)); }`));
    expect.forEach(([p, want]) => out.push(
      `  { const v = get(${js(p)}); const got = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v); pm.test(${js(p.trim() + ' = ')} + got + ${js(' (expected ' + want + ')')}, () => { if (got !== ${js(String(want))}) throw new Error('expected ' + ${js(String(want))} + ', got ' + got); }); }`));
    out.push('}', END);
    return out.join('\n');
  }

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
    const { meta } = splitScript(M.script(it, 'test'));
    const runAs = detectRunAs(it);
    return { it, srcId: srcId || it.id, runAs, detected: runAs, save: meta.save.map((x) => [...x]), expect: meta.expect.map((x) => [...x]), open: false, tried: null };
  }

  /** The request as it will be saved: the chosen token applied, the checks written into its test script. */
  function finalItem(step) {
    const it = M.clone(step.it);
    const req = M.req(it);
    if (step.runAs !== step.detected && step.runAs !== 'asis') {
      req.header = (req.header || []).filter((x) => !/^(authorization|gameplaytoken)$/i.test(x.key));
      req.auth = { type: 'bearer', bearer: [{ key: 'token', value: `{{${RUN_AS[step.runAs].token}}}`, type: 'string' }] };
      if (step.runAs === 'server') {
        req.header.push({ key: 'gameplaytoken', value: '{{gameplaytoken}}', type: 'text' });
        if (!headerVal(req, 'apk_signature_black_arch')) req.header.push({ key: 'apk_signature_black_arch', value: '{{apk_signature}}', type: 'text' });
      }
    }
    const { rest } = splitScript(M.script(it, 'test'));
    const block = builderBlock(step.save, step.expect);
    M.setScript(it, 'test', [rest, block].filter((x) => x.trim()).join('\n'));
    return it;
  }


  /* ── Flows tab ─────────────────────────────────────────────────────────── */

  T.flowList = () => { const root = flowsRoot(); return root ? root.item.filter((x) => M.isFolder(x)) : []; };
  T.isInFlows = (it) => { const root = flowsRoot(); return !!(root && (M.parentsOf(S.coll.data.item, it) || []).includes(root)); };

  const stepsOf = (flow) => { const out = []; M.walk(flow.item, (x) => { if (!M.isFolder(x)) out.push(x); }); return out; };

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
    const list = T.flowList();
    const cur = selectedFlow();
    if (!list.length) {
      el.replaceChildren(h('div.empty-tree', {}, h('p', { text: 'No flows yet.' }), h('p.hint', { text: 'A flow runs a set of APIs in order — log in, play, settle, check the balance.' })));
      return;
    }
    el.replaceChildren(...list.map((f) => {
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
      const state = m && m.status === 'verified' ? 'pass' : m && m.status === 'failing' ? 'fail' : 'queued';
      return { it: x, on: true, state, reason: m && m.note ? m.note.replace(/^Auto run: /, '') : state === 'pass' ? 'Worked' : '', result: S.results.get(x.id) || null };
    });
    const more = h('button.ghost', {
      text: '⋯', title: 'More', 'aria-label': 'More actions',
      onclick: (ev) => T.menu(ev.currentTarget, [
        { label: 'Duplicate flow', run: () => { const root = flowsRoot(); const copy = M.freshIds(M.clone(flow)); copy.name = flow.name + ' copy'; root.item.splice(root.item.indexOf(flow) + 1, 0, copy); S.flowSel = copy.id; T.markDirty(); T.renderTree(); T.renderEditor(); T.saveColl(); } },
        '-',
        { label: 'Delete flow', danger: true, run: () => { if (!confirm(`Delete the flow "${flow.name}"?`)) return; const root = flowsRoot(); root.item.splice(root.item.indexOf(flow), 1); S.flowSel = null; T.markDirty(); T.renderTree(); T.renderEditor(); T.saveColl(); } }
      ])
    });
    el.replaceChildren(h('div.flow-page', {},
      h('div.flow-hero', {},
        h('div.flow-title', {},
          h('span.flow-state', { class: 'k-' + st.kind, text: KIND_LABEL[st.kind] }),
          h('h2', { text: flow.name }),
          desc ? h('p', { text: desc }) : '',
          h('p.hint', { text: `${st.steps.length} steps · ✓ ${st.n.pass} worked · ✕ ${st.n.fail} failed · ${st.n.pending} not run` + (st.last ? ` · last run ${ago(st.last)}${st.by ? ' by ' + st.by : ''}` : '') })),
        h('div.flow-actions', {},
          h('button.primary.big', { text: '▶ Start test', title: 'Run every step of this flow now', disabled: !st.steps.length, onclick: () => T.runDialog(flow) }),
          h('button', { text: '✎ Edit flow', onclick: () => T.flowBuilder(flow) }),
          more)),
      st.steps.length ? T.flowChart(rows, 'done', flow, (r) => T.stepDetail(r.it)) : h('p.hint', { text: 'This flow has no steps — press Edit flow to add some.' })));
  };

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
        const it = finalItem(st);
        const own = new Set(varsSetByScripts(it, ['prerequest']));      // set just before this step is sent
        const chips = varsUsed(it).map((k) => {
          if (madeBy.has(k)) return { k, kind: 'step', from: madeBy.get(k) };
          if (own.has(k)) return { k, kind: 'step', from: idx + 1 };
          const v = valueOf(k);
          return v === null ? { k, kind: 'missing' } : v.trim() ? { k, kind: 'vars' } : { k, kind: 'empty' };
        });
        varsSetByScripts(it).forEach((k) => { if (!madeBy.has(k)) madeBy.set(k, idx + 1); });
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
      const req = M.req(st.it);
      const method = (req.method || 'GET').toUpperCase();
      const runAs = h('select', { 'aria-label': 'Send as', title: 'Whose token this step sends', onchange: () => { st.runAs = runAs.value; touch(); drawSteps(); } },
        Object.entries(RUN_AS).map(([k, v]) => h('option', { value: k, text: v.label, selected: st.runAs === k })));
      const nameEdit = h('input.fb-step-name', { value: st.it.name, 'aria-label': 'Step name', oninput: () => { st.it.name = nameEdit.value; touch(); } });
      const moveBy = (d) => { const j = idx + d; if (j < 0 || j >= steps.length) return; steps.splice(idx, 1); steps.splice(j, 0, st); touch(); drawSteps(); };
      const checks = st.save.length + st.expect.length;

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
            h('button.ghost', { text: checks ? `Checks · ${checks}` : 'Checks', title: 'Save values from the response and check fields', 'aria-expanded': String(st.open), onclick: () => { st.open = !st.open; drawSteps(); } }),
            h('button.ghost', { text: '↑', title: 'Move up', 'aria-label': 'Move up', disabled: idx === 0, onclick: () => moveBy(-1) }),
            h('button.ghost', { text: '↓', title: 'Move down', 'aria-label': 'Move down', disabled: idx === steps.length - 1, onclick: () => moveBy(1) }),
            h('button.ghost', { text: '⧉', title: 'Duplicate this step', 'aria-label': 'Duplicate', onclick: () => { const copy = stepOf(M.clone(finalItem(st))); copy.it.id = M.uid(); copy.it.name = st.it.name + ' (again)'; steps.splice(idx + 1, 0, copy); touch(); drawSteps(); } }),
            h('button.ghost.danger', { text: '✕', title: 'Remove from the flow', 'aria-label': 'Remove', onclick: () => { steps.splice(idx, 1); touch(); drawSteps(); } }))),
        h('div.fb-step-sub', {},
          h('code.fb-url', { text: M.urlRaw(req), title: M.urlRaw(req) }),
          chips.map((c) => h('span.fb-chip', {
            class: c.kind, text: c.kind === 'step' ? `{{${c.k}}} ← step ${c.from}` : `{{${c.k}}}`,
            title: c.kind === 'step' ? `Set by step ${c.from}` : c.kind === 'vars' ? 'Has a value in Variables' : c.kind === 'empty' ? 'In Variables, but empty — sent as blank' : 'No value yet: save it from an earlier step (Checks → Save), or add it in Variables'
          }))),
        st.open ? checksPanel(st) : '');
      return card;
    }

    function checksPanel(st) {
      const tried = st.tried || (S.results.get(st.srcId) && S.results.get(st.srcId).res ? S.results.get(st.srcId) : null);
      const paths = tried && tried.res ? jsonPaths(tried.res.body) : [];
      const listId = 'fb-paths-' + st.it.id;
      const datalist = h('datalist', { id: listId }, paths.map((p) => h('option', { value: p.path, label: p.value.slice(0, 40) })));
      const rowsOf = (list, kind) => list.map((row, i) => h('div.fb-check-row', {},
        h('input', { value: row[0], list: listId, placeholder: 'data.transaction_id', 'aria-label': 'Response field', oninput: (ev) => { row[0] = ev.target.value; touch(); } }),
        h('span.faint', { text: kind === 'save' ? 'save as' : 'must equal' }),
        h('input', { value: row[1], placeholder: kind === 'save' ? 'flow_tx' : 'true', 'aria-label': kind === 'save' ? 'Variable name' : 'Expected value', oninput: (ev) => { row[1] = ev.target.value; touch(); }, onchange: () => drawSteps() }),
        h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { list.splice(i, 1); touch(); drawSteps(); } })));
      const tryBtn = h('button', {
        text: '▶ Try this step', title: 'Send just this step now to see its response and pick fields from it',
        onclick: async () => {
          const risk = T.riskOf(st.it);
          if (risk && !confirm(`This request ${risk}. Send it anyway?`)) return;
          tryBtn.disabled = true; tryBtn.textContent = 'Sending…';
          st.tried = await T.execute(finalItem(st));
          if (S.envDirty) T.saveEnv(true);
          drawSteps();
        }
      });
      const preview = tried ? (tried.res ? h('pre.fb-preview', { text: `HTTP ${tried.res.status}\n${String(tried.res.body || '').slice(0, 600)}` }) : h('p.hint.fb-miss', { text: tried.error || tried.skipped || '' })) : '';
      return h('div.fb-checks', {},
        datalist,
        h('div.fb-check-title', {}, h('b', { text: 'Save from the response' }), h('span.hint', { text: 'Later steps that use {{name}} get this value.' })),
        rowsOf(st.save, 'save'),
        h('button.ghost', { text: '+ Save a value', onclick: () => { st.save.push(['', '']); touch(); drawSteps(); } }),
        h('div.fb-check-title', {}, h('b', { text: 'Check' }), h('span.hint', { text: 'With no checks, a step passes on HTTP 2xx and no "status": false in the body.' })),
        rowsOf(st.expect, 'expect'),
        h('button.ghost', { text: '+ Check a field', onclick: () => { st.expect.push(['status', 'true']); touch(); drawSteps(); } }),
        h('div.inline', { style: 'margin-top:6px' }, tryBtn, paths.length ? h('span.hint', { text: `${paths.length} fields to pick from in the boxes above` }) : h('span.hint', { text: 'Try it once to get field suggestions.' })),
        preview);
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
          h('div.fb-col-title', {}, h('b', { text: 'Steps' }), summary),
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
