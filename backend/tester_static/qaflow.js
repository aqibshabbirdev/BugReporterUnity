/* API tester — flows made simple for QA: a flow is a numbered list of steps written in plain words, and the
   editor asks plain questions (who sends it, when does it pass, what to remember, what if it fails).
   Same data as before — steps live in the Flows folder, checks in each step's test script, `repeat` and
   `branch` on the item — so the runner, reports and the old graph (still under ⋯ → Advanced) keep working.
   Extends `T` from app.js; needs flows.js (T._fb) and graph.js. */
(function () {
  'use strict';

  const { h, S } = T;
  const F = T._fb;
  const OPS = T.ruleOps;

  /* ── words ─────────────────────────────────────────────────────────────── */

  const WHO = { asis: 'As set in the API', p1: 'Player 1', p2: 'Player 2', server: 'Game server' };
  /** Who a step runs as, for display: "No login" when it sends no token at all. */
  function whoLabel(it, runAs) {
    if (runAs !== 'asis') return WHO[runAs];
    const req = M.req(it);
    const auth = (req.header || []).some((x) => !x.disabled && /^authorization$/i.test(x.key) && String(x.value || '').trim()) || (req.auth && req.auth.type === 'bearer' && M.bearerToken(req.auth));
    return auth ? WHO.asis : 'No login';
  }
  const WHAT = [
    ['@ok', 'The response looks OK'],
    ['@status', 'The HTTP status'],
    ['@time', 'The response time (ms)'],
    ['field', 'A value in the response…']
  ];
  // [op, words, needs a value, compares with a value kept earlier]
  const CONDS = [
    ['is', 'is equal to', true], ['not', 'is not', true], ['contains', 'contains', true],
    ['notempty', 'has a value'], ['empty', 'is empty'], ['true', 'is true'], ['false', 'is false'],
    ['exists', 'is in the response'], ['missing', 'is not in the response'],
    ['gt', 'is more than', true], ['lt', 'is less than', true], ['ok2xx', 'is 2xx (success)'],
    ['downby', 'went down by', true, true], ['upby', 'went up by', true, true],
    ['down', 'went down', false, true], ['up', 'went up', false, true], ['same', 'stayed the same as', false, true]
  ];
  const condOf = (op) => CONDS.find((c) => c[0] === op) || CONDS[0];
  const THEN = { end: 'end the flow here (counts as passed)', skip: 'skip the next step', jump: 'go to step…' };

  const pathOf = (req) => M.urlRaw(req).replace(/^\{\{agp_url\}\}/, '').replace(/^https?:\/\/[^/]+/, '') || M.urlRaw(req);
  const methodOf = (it) => (T.isWaitStep(it) ? 'WAIT' : T.isSocketStep(it) ? 'SOCKET' : (M.req(it).method || 'GET').toUpperCase());

  function ruleWords(r) {
    if (r.field === '@ok') return 'the response looks OK (HTTP 2xx, no "status": false)';
    const what = r.field === '@status' ? 'HTTP status' : r.field === '@time' ? 'response time' : r.field;
    const c = condOf(r.op);
    return `${what} ${c[1]}${c[2] ? ' ' + (r.value === '' || r.value == null ? '…' : r.value) : ''}${c[3] ? (r.op === 'same' ? ' ' : ' since ') + (r.ref || '…') : ''}`;
  }

  /** Plain lines that describe a step: who sends what, when it passes, what it keeps, retries, shortcut. */
  function stepLines(it, rows) {
    if (T.isWaitStep(it)) return [['wait', `Waits ${it.wait} seconds, then goes on.`]];
    const st = F.stepOf(it);
    const out = [];
    if (T.isSocketStep(it)) {
      const c = it.socket || {};
      const who = c.channel === 'p2' ? "Player 2's socket" : "Player 1's socket";
      if (c.mode === 'listen') out.push(['who', `Opens ${who} (${c.url || 'no URL'}${c.token ? ', JWT ' + c.token : ''}) and keeps it open` + (c.emit && c.emit.event ? `, sends "${c.emit.event}"` : '') + '.']);
      else if (c.mode === 'wait') out.push(['who', `Waits on ${who} for "${(c.wait && c.wait.event) || 'the next event'}" (up to ${(c.wait && c.wait.timeout) || 20} s) — also one that arrived during the steps before.`]);
      else out.push(['who', `Connects to ${c.url || '(no URL)'}${c.token ? ' with ' + c.token : ''}` +
        (c.emit && c.emit.event ? `, sends "${c.emit.event}"` : '') + `, waits for "${(c.wait && c.wait.event) || 'any event'}" (up to ${(c.wait && c.wait.timeout) || 20} s).`]);
    }
    const sends = sentWords(it);
    if (sends) out.push(['send', 'Sends ' + sends]);
    const scripted = scriptChecks(it);
    const passWords = st.rules.map(ruleWords).concat(scripted);
    out.push(['pass', 'Passes when ' + (passWords.length ? passWords.join(' · ') : 'the response looks OK (default)') + '.']);
    const me = rows ? rows.findIndex((r) => r.it.id === it.id) : -1;
    const from = new Map(st.save.map(([p, v]) => [v, p]));
    const saved = [...new Set(st.save.map((x) => x[1]).concat(F.varsSetByScripts(it, ['test'])))].filter(Boolean);
    saved.forEach((v) => {
      const users = me < 0 ? [] : laterUsers(rows, me, v);
      const now = currentValue(v);
      out.push(['keep', `Saves {{${v}}}` + (from.get(v) ? ` (the answer's ${from.get(v)})` : '') +
        (users.length ? ` → used by step${users.length === 1 ? '' : 's'} ${users.join(', ')}` : ' → not used by a later step') +
        (now ? ` · now: ${now}` : '')]);
    });
    if (me > 0) {
      const own = new Set(setsBeforeSending(it));
      const needs = F.varsUsed(it).filter((v) => !own.has(v)).map((v) => [v, savedBy(rows, me, v)]).filter(([, n]) => n);
      if (needs.length) out.push(['need', 'Uses ' + needs.map(([v, n]) => `{{${v}}} from step ${n}`).join(' · ') + '.']);
    }
    if (st.ask.length) out.push(['ask', 'Asks the tester for ' + st.ask.map((a) => `{{${a.var}}}`).join(', ') + '.']);
    if (it.repeat && Number(it.repeat.max) > 1) out.push(['retry', `If it does not pass, tries again every ${it.repeat.every} s, up to ${it.repeat.max} times.`]);
    if (it.branch) out.push(['branch', 'Shortcut: ' + T.branchText(it.branch, rows) + '.']);
    return out;
  }
  /** The checks a step's own script makes (pm.test titles), in words: "Player 1 logged in", "Session created". */
  function scriptChecks(it) {
    const { rest } = F.splitScript(M.script(it, 'test'));
    const out = [];
    for (const m of rest.matchAll(/pm\.test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
      const t = m[2].replace(/\$\{[^}]*\}/g, '…').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*[—:(-]\s*$/, '').trim();
      if (t && !out.includes(t)) out.push(t);
    }
    return out.map((t) => `"${t}"`);
  }
  /** What a request sends, in one line: the JSON body's or form's fields as name = value. */
  function sentWords(it) {
    if (T.isWaitStep(it) || T.isSocketStep(it)) return '';
    const b = M.req(it).body;
    if (!b || !b.mode) return '';
    let pairs = [];
    if (b.mode === 'raw') {
      const raw = String(b.raw || '').trim();
      if (!raw) return '';
      try { const j = JSON.parse(raw.replace(/\{\{[^}]+\}\}/g, (m) => JSON.stringify(m).slice(1, -1))); if (j && typeof j === 'object' && !Array.isArray(j)) pairs = Object.entries(j).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]); }
      catch (e) { return raw.replace(/\s+/g, ' ').slice(0, 140) + (raw.length > 140 ? '…' : ''); }
    } else if (Array.isArray(b[b.mode])) pairs = b[b.mode].filter((x) => !x.disabled).map((x) => [x.key, x.type === 'file' ? '(file)' : String(x.value == null ? '' : x.value)]);
    if (!pairs.length) return '';
    const text = pairs.map(([k, v]) => `${k} = ${v === '' ? '""' : v}`).join(' · ');
    return (text.length > 180 ? text.slice(0, 180) + '…' : text) + (b.mode === 'raw' ? '' : ' (form)');
  }

  const SECRET = /pass|token|secret|key|signature/i;
  /** The value a {{name}} has right now (after a run in this page), shortened; secrets masked. */
  function currentValue(v) {
    const val = T.localStore().has(v) ? T.localStore().get(v) : null;   // set by a run in this page
    if (val === null || val === undefined || String(val) === '') return '';
    const text = String(val);
    return SECRET.test(v) ? '•••• (set)' : text.length > 40 ? text.slice(0, 40) + '…' : text;
  }
  const savesOf = (it) => (T.isWaitStep(it) ? [] : F.stepOf(it).save.map((x) => x[1]).concat(F.varsSetByScripts(it, ['test'])));
  const setsBeforeSending = (it) => (T.isWaitStep(it) ? [] : F.varsSetByScripts(it, ['prerequest']));
  /** Step numbers after `me` that send {{v}}, until a later step saves it again. */
  function laterUsers(rows, me, v) {
    const out = [];
    for (let j = me + 1; j < rows.length; j++) {
      const it = rows[j].it;
      if (setsBeforeSending(it).includes(v)) break;   // that step makes its own value
      if (!T.isWaitStep(it) && F.varsUsed(it).includes(v)) out.push(j + 1);
      if (savesOf(it).includes(v)) break;
    }
    return out;
  }
  /** The step number before `me` that last saved {{v}}, or 0. */
  function savedBy(rows, me, v) {
    for (let j = me - 1; j >= 0; j--) if (savesOf(rows[j].it).includes(v)) return j + 1;
    return 0;
  }
  const LINE_ICON = { wait: '⏱', who: '⚡', send: '➚', pass: '✓', need: '↳', keep: '⤓', ask: '✎', retry: '↻', branch: '⑂' };

  /* ── the flow page ─────────────────────────────────────────────────────── */

  function selectedFlow() {
    const list = T.flowList();
    return list.find((f) => f.id === S.flowSel) || list[0] || null;
  }

  function flowRows(flow, steps) {
    return steps.map((x) => {
      const m = S.marks[x.id];
      const res = S.results.get(x.id);
      if (res && !res.pending) {
        const j = T.judge(res);
        const state = res.branch ? 'pass' : j.verdict;
        return { it: x, on: true, state, reason: res.branch ? 'shortcut taken: ' + res.branch : j.reason, branch: res.branch || null, result: res };
      }
      const state = m && m.status === 'verified' ? 'pass' : m && m.status === 'failing' ? 'fail' : 'queued';
      return { it: x, on: true, state, reason: m && m.note ? m.note.replace(/^Auto run: /, '') : '', result: null };
    });
  }

  T.renderFlowsMain = function (el) {
    const flow = selectedFlow();
    if (!flow) {
      el.replaceChildren(h('div.flows-empty', {},
        h('h2', { text: 'Flows' }),
        h('p', { text: 'A flow is a list of API calls that run one after another, like a real game: log in, start a match, finish it, check the coins.' }),
        h('div.inline', {}, h('button.primary', { text: '+ Create your first flow', onclick: () => T.flowBuilder() }), h('a', { href: '/apitestingbruno/guide', target: '_blank', rel: 'noopener', text: '📖 How flows work' }))));
      return;
    }
    const st = F.flowState(flow);
    const rows = flowRows(flow, st.steps);
    const desc = typeof flow.description === 'string' ? flow.description : (flow.description && flow.description.content) || '';
    const advanced = T.ls.get('qaView', 'list') === 'graph';
    const failedRow = rows.find((r) => r.state === 'fail');
    const more = h('button.ghost', {
      text: '⋯', title: 'More', 'aria-label': 'More actions',
      onclick: (ev) => T.menu(ev.currentTarget, [
        { label: advanced ? '☰ Simple list view' : '⬡ Advanced view (graph)', run: () => { T.ls.set('qaView', advanced ? 'list' : 'graph'); T.renderEditor(); } },
        T.flowBuilderClassic ? { label: 'Edit in the classic builder', run: () => T.flowBuilderClassic(flow) } : null,
        '-',
        { label: 'Duplicate flow', run: () => duplicate(flow) },
        { label: 'Duplicate for another game…', run: () => T.duplicateForGame(flow) },
        { label: '🔗 Share last result', run: () => T.shareReport(flow.name, [{ name: flow.name, rows }]) },
        T.loadDialog ? { label: '⚡ Load test this flow', run: () => T.loadDialog(flow) } : null,
        '-',
        { label: 'Delete flow', danger: true, run: () => remove(flow) }
      ].filter(Boolean))
    });
    el.replaceChildren(h('div.flow-page', {},
      h('div.flow-hero', {},
        h('div.flow-title', {},
          h('span.flow-state', { class: 'k-' + st.kind, text: F.KIND_LABEL[st.kind] }),
          h('h2', { text: flow.name }),
          desc ? h('p', { text: desc }) : '',
          h('p.hint', { text: `${st.steps.length} steps · ✓ ${st.n.pass} passed · ✕ ${st.n.fail} failed · ${st.n.pending} not run` + (st.last ? ` · last run ${F.ago(st.last)}${st.by ? ' by ' + st.by : ''}` : '') }),
          failedRow ? h('p.flow-failed', {}, h('b', { text: `✕ Failed at step ${rows.indexOf(failedRow) + 1}: ` }), failedRow.it.name,
            failedRow.reason ? h('span', { text: ' — ' + T.plainReason(failedRow.reason) }) : '') : ''),
        h('div.flow-actions', {},
          h('button.primary.big', { text: '▶ Run flow', title: 'Run every step, top to bottom', disabled: !st.steps.length, onclick: () => T.runDialog(flow) }),
          h('button', { text: '✎ Edit', onclick: () => T.flowBuilder(flow) }),
          more)),
      st.steps.length ? F.setupCard(flow) : '',
      !st.steps.length ? h('p.hint', { text: 'This flow has no steps yet — press Edit to add some.' })
        : advanced ? F.flowView(rows, flow) : stepList(rows)));
  };

  function stepList(rows) {
    const refresh = () => T.renderEditor();
    return h('ol.qa-steps', {}, rows.map((r, i) => {
      const it = r.it;
      const st = T.isWaitStep(it) ? null : F.stepOf(it);
      const who = st && !T.isSocketStep(it) ? whoLabel(it, st.runAs) : null;
      const res = r.result && r.result.res ? r.result : null;
      let open = false;
      const respBox = h('div.qa-resp', { hidden: true });
      const toggle = h('button.ghost.qa-mini', {
        text: 'Response', title: 'Show what came back the last time this step ran in this page', hidden: !res,
        onclick: () => {
          open = !open; respBox.hidden = !open;
          if (open && !respBox.firstChild) {
            let body = res.res.body || '';
            try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (e) { /* not JSON */ }
            respBox.append(h('p.hint', { text: `HTTP ${res.res.status} · ${res.res.timeMs} ms` }), h('pre.code', { text: body.slice(0, 20000) }),
              (res.out && res.out.tests.length) ? h('ul.step-tests', {}, res.out.tests.map((t) => h('li', { class: t.ok ? 'mk-verified' : 'mk-failing', text: (t.ok ? '✓ ' : '✕ ') + t.name + (t.error ? ' — ' + t.error : '') }))) : '');
          }
        }
      });
      const verdict = r.state === 'pass' ? '✓ Passed' : r.state === 'fail' ? '✕ Failed' : r.state === 'skip' ? '– Skipped' : '';
      return h('li.qa-step', { class: 's-' + r.state },
        h('div.qa-head', {},
          h('span.qa-num', { text: String(i + 1) }),
          h('div.qa-title', {},
            h('b', { text: it.name }),
            h('div.qa-sub', {},
              who ? h('span.qa-who', { class: 'w-' + st.runAs, text: who }) : '',
              h('span.meth', { class: 'm-' + methodOf(it), text: methodOf(it).slice(0, 6) }),
              T.isWaitStep(it) ? '' : h('code.qa-url', { text: T.isSocketStep(it) ? (it.socket.url || '') : pathOf(M.req(it)) }))),
          h('div.qa-tools', {},
            h('button.ghost.qa-mini', { text: '▶ Run to here', title: `Run steps 1–${i + 1} now`, onclick: () => T.runUpTo(rows, i, refresh) }),
            toggle)),
        h('ul.qa-lines', {}, stepLines(it, rows).map(([k, text]) => h('li', { class: 'l-' + k }, h('span.qa-ico', { text: LINE_ICON[k] }), text))),
        verdict ? h('div.qa-result', { class: 'r-' + r.state }, h('b', { text: verdict }), r.reason && r.state !== 'pass' ? ' — ' + T.plainReason(r.reason) : '') : '',
        respBox);
    }));
  }

  function duplicate(flow) {
    const root = F.flowsRoot();
    const copy = M.freshIds(M.clone(flow));
    copy.name = flow.name + ' copy';
    root.item.splice(root.item.indexOf(flow) + 1, 0, copy);
    S.flowSel = copy.id; T.markDirty(); T.renderTree(); T.renderEditor(); T.saveColl();
  }
  function remove(flow) {
    if (!confirm(`Delete the flow "${flow.name}"?`)) return;
    const root = F.flowsRoot();
    root.item.splice(root.item.indexOf(flow), 1);
    S.flowSel = null; T.markDirty(); T.renderTree(); T.renderEditor(); T.saveColl();
  }

  /* ── folders in the Flows list ─────────────────────────────────────────── */

  // A flow's folder is the start of its name: "Auth · Login — …" is the flow "Login — …" in the folder "Auth".
  // Kept in the name (not a nested folder) so the runner, reports, marks and the graph see flows exactly as before.
  const SEP = ' · ';
  T.flowFolder = (name) => { const i = String(name || '').indexOf(SEP); return i > 0 ? name.slice(0, i).trim() : ''; };
  T.flowShortName = (name) => { const i = String(name || '').indexOf(SEP); return i > 0 ? name.slice(i + SEP.length) : name; };
  const closedGroups = () => { try { return new Set(JSON.parse(T.ls.get('flowGroupsClosed', '[]'))); } catch (e) { return new Set(); } };

  let sideTools = null;
  function sideToolsBox() {
    if (sideTools) return sideTools;
    const search = h('input', { type: 'search', placeholder: 'Find a flow — folder, game, word', 'aria-label': 'Find a flow', oninput: () => { S.flowQuery = search.value.trim().toLowerCase(); T.renderTree(); } });
    const chips = h('div.flow-chips', { role: 'group', 'aria-label': 'Show flows by result' });
    const runAll = h('button.primary', { text: '▶ Run all', title: 'Run every flow in this list, one after another, and get one report', onclick: () => T.runFlowsDialog(T.flowsShown()) });
    sideTools = { box: h('div.flow-tools', {}, search, h('div.inline', {}, chips, h('span.grow'), runAll)), chips, runAll };
    return sideTools;
  }

  T.renderFlowsSide = function (el) {
    const all = T.flowList();
    const cur = selectedFlow();
    if (!all.length) {
      el.replaceChildren(h('div.empty-tree', {}, h('p', { text: 'No flows yet.' }), h('p.hint', { text: 'A flow runs a set of APIs in order — log in, play, settle, check the balance.' })));
      return;
    }
    const tools = sideToolsBox();
    const counts = { all: all.length, fail: 0, pass: 0, new: 0 };
    all.forEach((f) => { const k = F.flowState(f).kind; if (k === 'fail') counts.fail++; else if (k === 'pass') counts.pass++; else counts.new++; });
    tools.chips.replaceChildren(...[['all', 'All'], ['fail', '✕ Failing'], ['pass', '✓ Passed'], ['new', '◌ Not run']].map(([k, label]) => h('button.chip', {
      class: S.flowKind === k ? 'on' : '', 'aria-pressed': String(S.flowKind === k), text: `${label} ${counts[k]}`,
      onclick: () => { S.flowKind = k; T.ls.set('flowKind', k); T.renderTree(); }
    })));
    const list = T.flowsShown();
    tools.runAll.disabled = !list.length;
    tools.runAll.textContent = list.length && list.length < all.length ? `▶ Run ${list.length}` : '▶ Run all';
    if (!list.length) { el.replaceChildren(tools.box, h('p.hint.flow-none', { text: 'No flow matches — clear the search or pick another filter.' })); return; }

    const groups = new Map();
    list.forEach((f) => { const g = T.flowFolder(f.name); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); });
    const closed = closedGroups();
    const searching = !!S.flowQuery;
    const row = (f, inFolder) => {
      const st = F.flowState(f);
      return h('div.row.flow-row', {
        class: (cur === f ? 'sel' : '') + (inFolder ? ' in-folder' : ''), role: 'button', tabindex: 0, title: `${f.name}\n${F.KIND_LABEL[st.kind]}`,
        onclick: () => { S.flowSel = f.id; T.renderTree(); T.renderEditor(); },
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); S.flowSel = f.id; T.renderTree(); T.renderEditor(); } }
      },
        h('span.flow-dot', { class: 'k-' + st.kind, 'aria-label': F.KIND_LABEL[st.kind] }),
        h('span.label', { text: inFolder ? T.flowShortName(f.name) : f.name }),
        h('span.count', { text: String(st.steps.length) }));
    };
    const blocks = [];
    [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b))).forEach((g) => {
      const flows = groups.get(g);
      if (!g) { if (groups.size > 1) blocks.push(h('div.flow-group-head.plain', {}, h('span.label', { text: 'Not in a folder' }))); flows.forEach((f) => blocks.push(row(f, false))); return; }
      const open = searching || !closed.has(g) || flows.includes(cur);
      const failing = flows.filter((f) => F.flowState(f).kind === 'fail').length;
      const toggle = () => { const c = closedGroups(); if (c.has(g)) c.delete(g); else c.add(g); T.ls.set('flowGroupsClosed', JSON.stringify([...c])); T.renderTree(); };
      blocks.push(h('div.flow-group-head', { role: 'button', tabindex: 0, 'aria-expanded': String(open), onclick: toggle, onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } } },
        h('span.flow-caret', { text: open ? '▾' : '▸' }),
        h('span.flow-folder-ico', { text: '📁' }),
        h('span.label', { text: g }),
        failing ? h('span.flow-group-fail', { text: `✕ ${failing}`, title: `${failing} failing` }) : '',
        h('span.count', { text: String(flows.length) }),
        h('button.ghost.qa-mini', { text: '▶', title: `Run the ${flows.length} flows in ${g}`, 'aria-label': `Run folder ${g}`, onclick: (ev) => { ev.stopPropagation(); T.runFlowsDialog(flows); } })));
      if (open) flows.forEach((f) => blocks.push(row(f, true)));
    });
    el.replaceChildren(tools.box, ...blocks);
  };

  /* ── the editor ────────────────────────────────────────────────────────── */

  T.flowBuilderClassic = T.flowBuilder;

  T.flowBuilder = function (folder) {
    if (!S.coll) return T.toast('Open a collection first', 'error');
    if (folder && !T.isFlowFolder(folder)) folder = null;
    const editingId = folder ? folder.id : null;
    let name = folder ? T.flowShortName(folder.name) : '';
    let group = folder ? T.flowFolder(folder.name) : (T.ls.get('flowLastFolder', '') || '');
    let desc = folder ? (typeof folder.description === 'string' ? folder.description : (folder.description && folder.description.content) || '') : '';
    let steps = folder ? folder.item.filter((x) => !M.isFolder(x)).map((x) => F.stepOf(M.clone(x))) : [];
    let dirty = false, busy = false, picker = null;   // picker: {at} while choosing an API to add
    const touch = () => { dirty = true; };

    const overlay = document.getElementById('overlay');
    const close = (force) => {
      if (!force && dirty && !confirm('Close without saving this flow?')) return;
      overlay.replaceChildren(); document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev) => { if (ev.key === 'Escape' && !ev.target.closest('input, textarea, select')) close(); };
    document.addEventListener('keydown', onKey);

    const library = F.flowsRoot ? (() => {
      const out = [];
      M.walk(S.coll.data.item, (it) => {
        if (M.isFolder(it) || T.isInFlows(it)) return;
        const parents = M.parentsOf(S.coll.data.item, it) || [];
        out.push({ it, trail: parents.map((p) => p.name).join(' › '), risk: T.riskOf(it) });
      });
      return out;
    })() : [];

    const nameIn = h('input', { id: 'qa-name', value: name, placeholder: 'e.g. Ludo multiplayer — Player 1 wins', oninput: () => { name = nameIn.value; touch(); } });
    const folders = [...new Set(T.flowList().map((f) => T.flowFolder(f.name)).filter(Boolean))].sort();
    const folderIn = h('input', { id: 'qa-folder', value: group, list: 'qa-folders', placeholder: 'e.g. Auth, Multiplayer, AI games — empty for none', oninput: () => { group = folderIn.value.replace(/·/g, '').trim(); touch(); } });
    const folderList = h('datalist', { id: 'qa-folders' }, folders.map((g) => h('option', { value: g })));
    const descIn = h('input', { id: 'qa-desc', value: desc, placeholder: 'What this flow proves (optional)', oninput: () => { desc = descIn.value; touch(); } });
    const list = h('div.qa-edit-list');
    const top = h('div.qa-start');

    /** Values kept before step idx: name → step number (for "compared with" and the uses line). */
    function keptBefore(idx) {
      const map = new Map();
      steps.slice(0, idx).forEach((st, i) => {
        if (st.wait) return;
        const it = F.finalItem(st);
        F.varsSetByScripts(it).concat(st.ask.map((a) => a.var)).forEach((v) => { if (v && !map.has(v)) map.set(v, i + 1); });
      });
      return map;
    }

    function usesLine(st, idx) {
      if (st.wait) return '';
      const it = F.finalItem(st);
      const kept = keptBefore(idx);
      const own = new Set(F.varsSetByScripts(it, ['prerequest']).concat(st.ask.map((a) => a.var)));
      const scopes = T.scopes();
      // A variable that only rides in a header other than Authorization (App Check, APK signature) is optional.
      const req = M.req(it);
      const hard = new Set([...M.varsIn(M.urlRaw(req)), ...M.varsIn(req.body && req.body.mode === 'raw' ? req.body.raw || '' : '')]);
      (req.header || []).filter((x) => !x.disabled && /^authorization$/i.test(x.key)).forEach((x) => M.varsIn(x.value).forEach((v) => hard.add(v)));
      if (req.auth && req.auth.type === 'bearer') M.varsIn(M.bearerToken(req.auth)).forEach((v) => hard.add(v));
      if (T.isSocketStep(it)) M.varsIn(JSON.stringify(it.socket)).forEach((v) => hard.add(v));
      const parts = F.varsUsed(it).map((k) => {
        if (own.has(k)) return h('span.qa-var.ok', { text: `{{${k}}} — this step` });
        if (kept.has(k)) return h('span.qa-var.ok', { text: `{{${k}}} ← step ${kept.get(k)}` });
        const sc = scopes.find((s) => s.has(k));
        const v = sc ? String(sc.get(k) == null ? '' : sc.get(k)) : null;
        let chip;
        if (v !== null && v.trim()) chip = h('span.qa-var', { text: `{{${k}}} — Variables`, title: 'A fixed value from Variables — not from this run' });
        else if (!hard.has(k)) return h('span.qa-var', { text: `{{${k}}} — optional, empty`, title: 'Only sent as an extra header; the call works without it' });
        else chip = h('span.qa-var.bad', { text: `{{${k}}} — no value!`, title: 'Save it in an earlier step, ask the tester for it, or fill it in Variables' });
        if (!kept.size || /_url$|^base_?url$/i.test(k)) return chip;   // server addresses are not per-run values
        // One click to take it from an earlier step instead (e.g. a library call that still says {{agp_session_id}}).
        const swap = h('select.qa-swap', { 'aria-label': `Use a saved value instead of {{${k}}}`, onchange: () => {
          if (!swap.value) return;
          T.stepUseVar(st.it, k, swap.value); touch(); draw();
          T.toast(`This step now uses {{${swap.value}}} instead of {{${k}}}`);
        } }, h('option', { value: '', text: '↺ use a saved value instead…' }), [...kept.keys()].map((n) => h('option', { value: n, text: `{{${n}}} from step ${kept.get(n)}` })));
        return h('span.qa-var-fix', {}, chip, swap);
      });
      return parts.length ? h('div.qa-uses', {}, h('span.hint', { text: 'Uses ' }), parts) : '';
    }

    function draw() {
      top.replaceChildren(...(steps.length || editingId ? [] : startChoices()));
      const cards = steps.map((st, i) => card(st, i));
      list.replaceChildren(...cards, picker ? apiPicker() : addBar());
      saveBtn.disabled = runBtn.disabled = busy;
    }

    function startChoices() {
      const flows = T.flowList();
      const sel = h('select', { 'aria-label': 'Flow to copy' }, h('option', { value: '', text: 'Copy steps from an existing flow…' }), flows.map((f) => h('option', { value: f.id, text: f.name })));
      sel.onchange = () => {
        const f = flows.find((x) => x.id === sel.value); if (!f) return;
        steps = f.item.filter((x) => !M.isFolder(x)).map((x) => { const c = F.stepOf(M.clone(x)); c.it.id = M.uid(); return c; });
        if (!name.trim()) { name = T.flowShortName(f.name) + ' copy'; nameIn.value = name; if (!group) { group = T.flowFolder(f.name); folderIn.value = group; } }
        touch(); draw();
      };
      return [h('b', { text: 'Start from' }),
        h('div.inline', {},
          h('button', { text: '+ Add the first step', onclick: () => { picker = { at: 0 }; draw(); } }),
          sel,
          F.EXAMPLES.map((ex) => h('button.ghost', { text: '✨ ' + ex.label, onclick: () => loadExample(ex) })))];
    }

    function loadExample(ex) {
      const built = [];
      for (const spec of ex.steps) {
        const src = library.find((x) => M.urlRaw(M.req(x.it)).includes(spec.url) && (!spec.method || (M.req(x.it).method || 'GET').toUpperCase() === spec.method));
        if (!src) return T.toast(`This collection has no API for ${spec.url}`, 'error');
        const st = F.copyFromLibrary(src.it);
        st.it.name = spec.name;
        st.ask = (spec.ask || []).map((a) => Object.assign({}, a));
        st.rules = (spec.rules || []).map((r) => Object.assign({}, r));
        st.save = (spec.save || []).map((x) => [...x]);
        built.push(st);
      }
      steps = built;
      if (!name.trim()) { name = ex.name; nameIn.value = name; }
      if (!desc.trim()) { desc = ex.desc; descIn.value = desc; }
      touch(); draw();
    }

    function addBar() {
      return h('div.qa-add', {},
        h('button.primary', { text: '+ Add an API call', onclick: () => { picker = { at: steps.length }; draw(); } }),
        h('button', { text: '⏱ + Wait', title: 'Pause — e.g. a payout that arrives a few seconds later', onclick: () => { steps.push(F.stepOf(T.waitStep(10))); touch(); draw(); } }),
        h('button', { text: '⚡ + Socket', title: 'Listen on a player\'s socket, or wait for an event on it', onclick: (ev) => T.menu(ev.currentTarget, [
          { label: '👂 Start listening on a player\'s socket', run: () => addSocket({ mode: 'listen', channel: 'p2', url: '{{socket_url}}', token: '{{p2_token}}', name: '👂 Player 2 starts listening on the socket' }) },
          { label: '⏳ Wait for an event on an open socket', run: () => addSocket({ mode: 'wait', channel: 'p2', wait: { event: '', timeout: 30 }, name: '⏳ Player 2 gets the socket event' }) },
          { label: '⚡ Connect, send, wait (one step)', run: () => addSocket({ url: '{{socket_url}}', query: [['type', 'mobile-client']], token: '{{p1_token}}', wait: { event: '', timeout: 30 }, name: '⚡ Socket message' }) }]) }));
    }

    function addSocket(cfg) {
      const st = F.stepOf(T.socketStep(Object.assign({ query: [], wait: { event: '', timeout: 30 } }, cfg)));
      st.open = true; steps.push(st); touch(); draw();
    }

    function apiPicker() {
      const search = h('input', { type: 'search', placeholder: 'Search APIs — name or URL, e.g. login, session/join', 'aria-label': 'Search APIs' });
      const results = h('div.qa-pick-list');
      const fill = () => {
        const q = search.value.trim().toLowerCase();
        const hits = library.filter((x) => !q || `${x.it.name} ${M.urlRaw(M.req(x.it))} ${x.trail}`.toLowerCase().includes(q)).slice(0, 80);
        results.replaceChildren(...(hits.length ? hits.map((x) => h('button.qa-pick', {
          title: M.urlRaw(M.req(x.it)) + (x.risk ? '\n⚠ ' + x.risk : ''),
          onclick: () => { const st = F.copyFromLibrary(x.it); st.open = true; steps.splice(picker.at, 0, st); picker = null; touch(); draw(); }
        },
          h('span.meth', { class: 'm-' + (M.req(x.it).method || 'GET').toUpperCase(), text: (M.req(x.it).method || 'GET').toUpperCase().slice(0, 6) }),
          h('span.qa-pick-name', {}, h('b', { text: x.it.name }), h('span.faint', { text: ' ' + pathOf(M.req(x.it)) }), h('span.qa-pick-trail', { text: x.trail })),
          x.risk ? h('span.fb-risk', { text: '⚠', title: x.risk }) : '')) : [h('p.hint', { text: 'No API matches.' })]));
      };
      search.oninput = fill;
      const box = h('div.qa-picker', {},
        h('div.inline', {}, h('b', { text: `Add step ${picker.at + 1}: pick an API` }), h('span.grow'), h('button.ghost', { text: 'Cancel', onclick: () => { picker = null; draw(); } })),
        search, results);
      fill();
      setTimeout(() => search.focus(), 0);
      return box;
    }

    function card(st, idx) {
      const it = st.it;
      const move = (d) => { const j = idx + d; if (j < 0 || j >= steps.length) return; steps.splice(idx, 1); steps.splice(j, 0, st); touch(); draw(); };
      const preview = F.finalItem(st);
      const head = h('div.qa-head', {},
        h('span.qa-num', { text: String(idx + 1) }),
        st.wait ? h('div.qa-title', {}, h('b', { text: `⏱ Wait` }), h('div.qa-sub', {}, 'Wait ',
          h('input', { type: 'number', min: 1, max: 600, value: it.wait, style: 'width:80px', 'aria-label': 'Seconds', oninput: (ev) => { it.wait = Number(ev.target.value) || 1; it.name = `⏱ Wait ${it.wait} s`; touch(); } }), ' seconds'))
          : h('div.qa-title', {},
            h('input.qa-step-name', { value: it.name, 'aria-label': 'Step name', oninput: (ev) => { it.name = ev.target.value; touch(); } }),
            h('div.qa-sub', {},
              !T.isSocketStep(it) ? h('span.qa-who', { class: 'w-' + st.runAs, text: whoLabel(it, st.runAs) }) : '',
              h('span.meth', { class: 'm-' + methodOf(it), text: methodOf(it).slice(0, 6) }),
              h('code.qa-url', { text: T.isSocketStep(it) ? (it.socket.url || '') : pathOf(M.req(it)) }))),
        h('div.qa-tools', {},
          st.wait ? '' : h('button', { class: st.open ? 'on' : '', text: st.open ? 'Done' : '✎ Edit', onclick: () => { st.open = !st.open; draw(); } }),
          h('button.ghost', { text: '↑', title: 'Move up', 'aria-label': 'Move up', disabled: idx === 0, onclick: () => move(-1) }),
          h('button.ghost', { text: '↓', title: 'Move down', 'aria-label': 'Move down', disabled: idx === steps.length - 1, onclick: () => move(1) }),
          h('button.ghost', { text: '+', title: 'Add a step after this one', 'aria-label': 'Add after', onclick: () => { picker = { at: idx + 1 }; draw(); } }),
          h('button.ghost', { text: '⧉', title: 'Duplicate this step', 'aria-label': 'Duplicate', onclick: () => { const c = F.stepOf(M.clone(F.finalItem(st))); c.it.id = M.uid(); c.it.name = it.name + ' (again)'; steps.splice(idx + 1, 0, c); touch(); draw(); } }),
          h('button.ghost.danger', { text: '✕', title: 'Remove this step', 'aria-label': 'Remove', onclick: () => { steps.splice(idx, 1); touch(); draw(); } })));
      const rowsForText = steps.map((s) => ({ it: s.it }));
      return h('div.qa-card', { class: st.open ? 'open' : '' },
        head,
        st.open ? form(st, idx) : h('ul.qa-lines', {}, stepLines(preview, rowsForText).map(([k, text]) => h('li', { class: 'l-' + k }, h('span.qa-ico', { text: LINE_ICON[k] }), text))),
        usesLine(st, idx));
    }

    /* the questions for one step */
    function form(st, idx) {
      const it = st.it;
      const redraw = () => { touch(); draw(); };
      const tried = st.tried || (S.results.get(it.id) && S.results.get(it.id).res ? S.results.get(it.id) : S.results.get(st.srcId) && S.results.get(st.srcId).res ? S.results.get(st.srcId) : null);
      const paths = tried && tried.res ? F.jsonPaths(tried.res.body) : [];
      const listId = 'qa-paths-' + it.id;
      const datalist = h('datalist', { id: listId }, paths.map((p) => h('option', { value: p.path, label: p.value.slice(0, 40) })));
      const kept = keptBefore(idx);
      const refList = 'qa-refs-' + it.id;
      const refs = h('datalist', { id: refList }, [...kept.keys()].map((k) => h('option', { value: `{{${k}}}`, label: `kept by step ${kept.get(k)}` })));

      const section = (n, title, hint, ...kids) => h('section.qa-q', {}, h('div.qa-q-title', {}, h('span.qa-q-n', { text: n }), h('b', { text: title }), hint ? h('span.hint', { text: hint }) : ''), ...kids);

      /* 1 · the request itself */
      let requestPart;
      if (T.isSocketStep(it)) {
        const c = it.socket;
        c.emit = c.emit || { event: '', data: '' }; c.wait = c.wait || { event: '', timeout: 20 }; c.query = c.query || [];
        const mode = c.mode || 'once';
        const setMode = (m) => {
          if (m === 'once') { delete c.mode; delete c.channel; } else { c.mode = m; c.channel = c.channel || (c.token === '{{p2_token}}' ? 'p2' : 'p1'); }
          if (m === 'listen' && !c.url) c.url = '{{socket_url}}';
          redraw();
        };
        const modeSel = h('select', { 'aria-label': 'What this socket step does', onchange: (ev) => setMode(ev.target.value) },
          [['listen', 'Start listening — connect and stay open for later steps'], ['wait', 'Wait for an event on an open socket'], ['once', 'Connect, send, wait for the answer (all in this step)']]
            .map(([v, l]) => h('option', { value: v, text: l, selected: mode === v })));
        const chanSel = h('select', { 'aria-label': 'Which socket', onchange: (ev) => { c.channel = ev.target.value; if (mode === 'listen') c.token = ev.target.value === 'p2' ? '{{p2_token}}' : '{{p1_token}}'; redraw(); } },
          [['p1', "Player 1's socket"], ['p2', "Player 2's socket"]].map(([v, l]) => h('option', { value: v, text: l, selected: (c.channel || 'p1') === v })));
        const tokenSel = h('select', { 'aria-label': 'Connect as', onchange: () => { c.token = tokenSel.value === 'custom' ? c.token : tokenSel.value; redraw(); } },
          [['{{p1_token}}', 'Player 1 (JWT {{p1_token}})'], ['{{p2_token}}', 'Player 2 (JWT {{p2_token}})'], ['', 'No login'], ['custom', 'Other token…']].map(([v, l]) => h('option', { value: v, text: l, selected: v === 'custom' ? !['{{p1_token}}', '{{p2_token}}', ''].includes(c.token || '') : (c.token || '') === v })));
        const connectRows = [
          h('label', { text: 'Socket URL' }), h('input.mono', { value: c.url || '', placeholder: '{{socket_url}}  (main socket) or {{socket_url}}/emit', oninput: (ev) => { c.url = ev.target.value; it.request.url = { raw: c.url }; touch(); } }),
          h('label', { text: 'Connect as' }), h('div.inline', {}, tokenSel, !['{{p1_token}}', '{{p2_token}}', ''].includes(c.token || '') ? h('input.mono', { value: c.token || '', placeholder: '{{token}}', oninput: (ev) => { c.token = ev.target.value; touch(); } }) : '', h('span.hint', { text: 'The login JWT goes in the handshake (auth.token), like the app.' })),
          h('label', { text: 'Query' }), h('input.mono', { value: (c.query || []).map(([k, v]) => `${k}=${v}`).join('&'), placeholder: 'e.g. type=mobile-client (empty for the main socket)', oninput: (ev) => { c.query = ev.target.value.split('&').filter(Boolean).map((q) => { const i = q.indexOf('='); return i < 0 ? [q, ''] : [q.slice(0, i), q.slice(i + 1)]; }); touch(); } }),
          h('label', { text: 'Send event' }), h('input.mono', { value: c.emit.event || '', placeholder: 'optional — sent right after connecting', oninput: (ev) => { c.emit.event = ev.target.value; touch(); } }),
          h('label', { text: 'With data' }), h('textarea.mono', { rows: 2, value: c.emit.data || '', placeholder: '{"transaction_id": "{{flow_tx}}"}', oninput: (ev) => { c.emit.data = ev.target.value; touch(); } })];
        const waitRows = [
          h('label', { text: 'Wait for event' }), h('input.mono', { value: c.wait.event || '', placeholder: 'e.g. childActivated (empty = the next event)', oninput: (ev) => { c.wait.event = ev.target.value; touch(); } }),
          h('label', { text: 'Give up after' }), h('div.inline', {}, h('input', { type: 'number', min: 1, max: 300, value: c.wait.timeout || 20, style: 'width:80px', oninput: (ev) => { c.wait.timeout = Number(ev.target.value) || 20; touch(); } }), ' seconds')];
        const hint = mode === 'listen' ? 'Opens the socket now and keeps it open. Events that arrive while later steps run (e.g. after "P1 accepts P2") are kept until a "Wait for an event" step on the same socket reads them.'
          : mode === 'wait' ? 'Reads the next matching event from a socket an earlier "Start listening" step opened — also one that arrived while the steps in between ran. The answer is checked like a response: {"event": …, "payload": …}.'
          : 'Connects, sends one event (optional), waits for the answer and disconnects. An event sent before this step connects is missed — use Start listening for that.';
        requestPart = section('1', 'Socket', hint,
          h('div.qa-grid', {},
            h('label', { text: 'This step' }), modeSel,
            mode !== 'once' ? h('label', { text: 'Socket' }) : '', mode !== 'once' ? chanSel : '',
            ...(mode === 'wait' ? waitRows : mode === 'listen' ? connectRows : connectRows.concat(waitRows))));
      } else {
        const req = M.req(it);
        const who = h('select', { 'aria-label': 'Who sends it', onchange: () => { st.runAs = who.value; redraw(); } },
          Object.entries(WHO).map(([k, v]) => h('option', { value: k, text: v, selected: st.runAs === k })));
        const bodyRaw = req.body && req.body.mode === 'raw';
        // "Insert a saved value": puts {{name}} where the cursor was in the URL or the body.
        let lastField = null, lastPos = null;
        const remember = (el) => { lastField = el; lastPos = [el.selectionStart, el.selectionEnd]; };
        const kept = keptBefore(idx);
        const insert = kept.size ? h('select.qa-swap', { 'aria-label': 'Insert a saved value', onchange: (ev) => {
          const name = ev.target.value; ev.target.value = '';
          if (!name) return;
          const el = lastField || bodyEl || urlEl;   // a form field counts too once clicked
          const [a, b] = lastField && lastPos ? lastPos : [el.value.length, el.value.length];
          el.value = el.value.slice(0, a) + `{{${name}}}` + el.value.slice(b);
          el.dispatchEvent(new Event('input'));
          redraw();
        } }, h('option', { value: '', text: '+ Insert a saved value…' }), [...kept.keys()].map((n) => h('option', { value: n, text: `{{${n}}} — saved by step ${kept.get(n)}` }))) : '';
        const urlEl = h('input.mono', { value: M.urlRaw(req), 'aria-label': 'URL', onblur: (ev) => remember(ev.target), onclick: (ev) => remember(ev.target), onkeyup: (ev) => remember(ev.target), oninput: (ev) => { if (typeof req.url === 'string' || !req.url) req.url = { raw: ev.target.value }; else { req.url.raw = ev.target.value; delete req.url.host; delete req.url.path; delete req.url.query; } touch(); } });
        const bodyEl = bodyRaw ? h('textarea.mono', { rows: Math.min(10, Math.max(3, String(req.body.raw || '').split('\n').length)), value: req.body.raw || '', 'aria-label': 'Body', onblur: (ev) => remember(ev.target), onclick: (ev) => remember(ev.target), onkeyup: (ev) => remember(ev.target), oninput: (ev) => { req.body.raw = ev.target.value; touch(); } }) : null;
        // The body in any shape the API uses: JSON text, or form fields (name = value rows, sent as a form), or none.
        const bmode = !req.body || !req.body.mode ? 'none' : req.body.mode === 'raw' ? 'raw' : ['urlencoded', 'formdata'].includes(req.body.mode) ? req.body.mode : 'other';
        const bodyKind = h('select', { 'aria-label': 'Body type', onchange: (ev) => {
          const v = ev.target.value;
          const rows = bmode === 'urlencoded' || bmode === 'formdata' ? (req.body[bmode] || []) : [];
          if (v === 'none') delete req.body;
          else if (v === 'raw') req.body = { mode: 'raw', raw: rows.length ? JSON.stringify(Object.fromEntries(rows.filter((x) => !x.disabled).map((x) => [x.key, x.value])), null, 2) : '{\n  \n}', options: { raw: { language: 'json' } } };
          else req.body = { mode: v, [v]: bmode === 'raw' ? (() => { try { return Object.entries(JSON.parse(req.body.raw || '{}')).map(([key, value]) => ({ key, value: String(value), type: 'text' })); } catch (e) { return []; } })() : rows };
          redraw();
        } }, [['none', 'No body'], ['raw', 'JSON'], ['urlencoded', 'Form fields'], ['formdata', 'Form fields + files']].map(([v, l]) => h('option', { value: v, text: l, selected: bmode === v })),
          bmode === 'other' ? h('option', { value: 'other', text: req.body.mode, selected: true, disabled: true }) : '');
        let formEl = null;
        if (bmode === 'urlencoded' || bmode === 'formdata') {
          const list = req.body[bmode] = req.body[bmode] || [];
          formEl = h('div.qa-form-fields', {},
            list.map((f, i) => f.type === 'file'
              ? h('div.qa-row', {}, h('input.mono', { value: f.key, 'aria-label': 'Field name', oninput: (ev) => { f.key = ev.target.value; touch(); } }), h('span.hint', { text: '(a file — choose it in the APIs tab)' }), h('button.ghost', { text: '✕', 'aria-label': 'Remove field', onclick: () => { list.splice(i, 1); redraw(); } }))
              : h('div.qa-row', {},
                h('input.mono.qa-fkey', { value: f.key, placeholder: 'name', 'aria-label': 'Field name', oninput: (ev) => { f.key = ev.target.value; touch(); } }),
                h('span', { text: '=' }),
                h('input.mono', { value: f.value == null ? '' : f.value, placeholder: 'value or {{name}}', 'aria-label': `Value of ${f.key}`, onblur: (ev) => remember(ev.target), onclick: (ev) => remember(ev.target), onkeyup: (ev) => remember(ev.target), oninput: (ev) => { f.value = ev.target.value; touch(); } }),
                h('label.qa-mini-check', { title: 'Untick to leave this field out' }, h('input', { type: 'checkbox', checked: !f.disabled, onchange: (ev) => { if (ev.target.checked) delete f.disabled; else f.disabled = true; touch(); } }), 'send'),
                h('button.ghost', { text: '✕', 'aria-label': 'Remove field', onclick: () => { list.splice(i, 1); redraw(); } }))),
            h('div.inline', {}, h('button.ghost', { text: '+ Add a field', onclick: () => { list.push({ key: '', value: '', type: 'text' }); redraw(); } })));
        }
        requestPart = section('1', 'What is sent', 'Who sends it decides which login token goes with it.',
          h('div.qa-grid', {},
            h('label', { text: 'Who sends it' }), who,
            h('label', { text: 'Call' }), h('div.inline.qa-call', {},
              h('select', { 'aria-label': 'Method', onchange: (ev) => { req.method = ev.target.value; redraw(); } }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => h('option', { text: m, selected: (req.method || 'GET').toUpperCase() === m }))),
              urlEl),
            h('label', { text: 'Body' }), bodyKind,
            bodyEl ? h('span') : '', bodyEl || '',
            formEl ? h('span') : '', formEl || '',
            insert ? h('span') : '', insert ? h('div.inline', {}, insert, h('span.hint', { text: 'Click in the URL or body first, then pick — it goes where the cursor is.' })) : ''));
      }

      /* 2 · when it passes */
      const ruleRow = (r, i, list, onRemove) => {
        const whatVal = ['@ok', '@status', '@time'].includes(r.field) ? r.field : 'field';
        const what = h('select', { 'aria-label': 'What to check', onchange: () => { r.field = what.value === 'field' ? '' : what.value; if (r.field === '@status') { r.op = 'is'; r.value = '200'; } redraw(); } },
          WHAT.map(([k, l]) => h('option', { value: k, text: l, selected: whatVal === k })));
        if (r.field === '@ok') return h('div.qa-row', {}, what, h('span.hint', { text: 'HTTP 2xx and no "status": false' }), h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { onRemove(i); redraw(); } }));
        const c = condOf(r.op);
        const op = h('select', { 'aria-label': 'Condition', onchange: () => { r.op = op.value; redraw(); } }, CONDS.map(([k, l]) => h('option', { value: k, text: l, selected: r.op === k })));
        return h('div.qa-row', {},
          what,
          whatVal === 'field' ? h('input.mono', { value: r.field, list: listId, placeholder: 'e.g. data.status', 'aria-label': 'Field', oninput: (ev) => { r.field = ev.target.value.trim(); touch(); } }) : '',
          op,
          c[2] ? h('input.mono', { value: r.value == null ? '' : r.value, placeholder: 'value or {{name}}', 'aria-label': 'Value', oninput: (ev) => { r.value = ev.target.value; touch(); } }) : '',
          c[3] ? h('span.inline', {}, r.op === 'same' ? '' : 'since', h('input.mono', { value: r.ref || '', list: refList, placeholder: '{{balance kept earlier}}', 'aria-label': 'Compared with', oninput: (ev) => { r.ref = ev.target.value.trim(); touch(); } })) : '',
          h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { onRemove(i); redraw(); } }));
      };
      const scripted = scriptChecks(F.finalItem(st));
      const passPart = section('2', 'It passes when', st.rules.length ? 'Every line must be true.' : scripted.length ? '' : 'Nothing added: it passes when the response looks OK (HTTP 2xx, no "status": false).',
        scripted.length ? h('p.qa-scripted', {}, h('span', { text: 'Already checked by this step\'s script: ' }), scripted.join(' · '), h('span.faint', { text: ' — conditions you add here are checked as well.' })) : '',
        st.rules.map((r, i) => ruleRow(r, i, st.rules, (k) => st.rules.splice(k, 1))),
        h('div.inline', {},
          h('button.ghost', { text: '+ Add a condition', onclick: () => { if (!st.rules.length) st.rules.push({ field: '@ok' }); st.rules.push({ field: '', op: 'is', value: '' }); redraw(); } }),
          !st.rules.some((r) => r.field === '@ok') ? h('button.ghost', { text: '+ Response looks OK', onclick: () => { st.rules.unshift({ field: '@ok' }); redraw(); } }) : '',
          !st.rules.some((r) => r.field === 'status') ? h('button.ghost', { text: '+ "status" is true', onclick: () => { st.rules.push({ field: 'status', op: 'true' }); redraw(); } }) : ''));

      /* 3 · remember */
      const keepPart = section('3', 'Save from the answer, use in later steps', 'Example: save data.transaction_id as flow_tx — every later step can write {{flow_tx}} (in its URL, body or token) and the real id goes there when it runs.',
        st.save.map((row, i) => h('div.qa-row', {},
          h('input.mono', { value: row[0], list: listId, placeholder: 'value in the answer, e.g. data.transaction_id', 'aria-label': 'Value in the answer', oninput: (ev) => { row[0] = ev.target.value.trim(); touch(); } }),
          h('span', { text: 'as' }),
          h('input.mono', { value: row[1], placeholder: 'name, e.g. flow_tx', 'aria-label': 'Name', oninput: (ev) => { row[1] = ev.target.value.trim(); touch(); }, onchange: redraw }),
          row[1] ? h('span.hint', { text: (() => { const u = laterUsers(steps.map((x) => ({ it: x.it })), idx, row[1]); return u.length ? `used by step${u.length === 1 ? '' : 's'} ${u.join(', ')}` : 'no later step uses it yet'; })() }) : '',
          h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { st.save.splice(i, 1); redraw(); } }))),
        h('div.inline', {}, h('button.ghost', { text: '+ Save a value', onclick: () => { st.save.push(['', '']); redraw(); } })));

      /* 4 · ask the tester */
      const askPart = section('4', 'Ask the tester while it runs', 'Only for what a person has — an OTP from SMS, a new password.',
        st.ask.map((a, i) => h('div.qa-row', {},
          h('input.mono', { value: a.var, placeholder: 'name, e.g. otp', 'aria-label': 'Name', oninput: (ev) => { a.var = ev.target.value.trim(); touch(); }, onchange: redraw }),
          h('input', { value: a.label || '', placeholder: 'Question, e.g. Enter the OTP from the SMS', 'aria-label': 'Question', oninput: (ev) => { a.label = ev.target.value; touch(); } }),
          h('button.ghost', { text: '✕', 'aria-label': 'Remove', onclick: () => { st.ask.splice(i, 1); redraw(); } }))),
        h('div.inline', {}, h('button.ghost', { text: '+ Ask for a value', onclick: () => { st.ask.push({ var: '', label: '' }); redraw(); } })));

      /* 5 · if it does not pass */
      const rep = it.repeat && Number(it.repeat.max) > 1;
      const every = h('input', { type: 'number', min: 1, max: 600, value: rep ? it.repeat.every : 5, style: 'width:70px', 'aria-label': 'Seconds between tries', oninput: () => { if (it.repeat) { it.repeat.every = Number(every.value) || 5; touch(); } } });
      const max = h('input', { type: 'number', min: 2, max: 200, value: rep ? it.repeat.max : 10, style: 'width:70px', 'aria-label': 'Tries', oninput: () => { if (it.repeat) { it.repeat.max = Math.max(2, Number(max.value) || 10); touch(); } } });
      const failPart = section('5', 'If it does not pass', '',
        h('label.qa-radio', {}, h('input', { type: 'radio', name: 'qa-rep-' + it.id, checked: !rep, onchange: () => { delete it.repeat; redraw(); } }), 'Stop the flow and show what went wrong'),
        h('label.qa-radio', {}, h('input', { type: 'radio', name: 'qa-rep-' + it.id, checked: rep, onchange: () => { it.repeat = { every: Number(every.value) || 5, max: Math.max(2, Number(max.value) || 10) }; redraw(); } }),
          'Try again every ', every, ' seconds, up to ', max, ' times — e.g. waiting for a match server to be ready'));

      /* 6 · shortcut */
      const b = it.branch;
      const shortcutPart = section('6', 'Shortcut (optional)', 'Change what happens next when the answer matches — e.g. end the flow when there is no balance.',
        b ? h('div', {},
          h('div.qa-row', {}, h('span', { text: 'When' }), ...ruleRow(b, 0, null, () => { delete it.branch; }).childNodes),
          h('div.qa-row', {}, h('span', { text: 'then' }),
            h('select', { 'aria-label': 'Then', onchange: (ev) => { b.then = ev.target.value; if (b.then !== 'jump') delete b.to; redraw(); } }, Object.entries(THEN).map(([k, l]) => h('option', { value: k, text: l, selected: b.then === k }))),
            b.then === 'jump' ? h('select', { 'aria-label': 'Go to step', onchange: (ev) => { b.to = ev.target.value; touch(); } },
              h('option', { value: '', text: 'pick a step' }), steps.map((s, i) => i === idx ? '' : h('option', { value: s.it.id, text: `${i + 1}. ${s.it.name}`, selected: b.to === s.it.id }))) : ''))
          : h('div.inline', {}, h('button.ghost', { text: '+ Add a shortcut', onclick: () => { it.branch = { field: '@status', op: 'is', value: '200', then: 'end' }; redraw(); } })));

      /* try it */
      const tryBtn = h('button', {
        text: tried ? '▶ Try again' : '▶ Try this step now',
        onclick: async () => {
          const risk = T.riskOf(it);
          if (risk && !confirm(`This call ${risk}. Send it anyway?`)) return;
          for (const a of st.ask) {
            const cur = T.localStore().get(a.var);
            const v = prompt(a.label || `Value for {{${a.var}}}`, cur == null ? '' : cur);
            if (v === null) return;
            T.localStore().set(a.var, v);
          }
          tryBtn.disabled = true; tryBtn.textContent = 'Sending…';
          st.tried = await T.execute(F.finalItem(st));
          if (S.envDirty) T.saveEnv(true);
          draw();
        }
      });
      let answer = '';
      if (tried && tried.res) {
        let j = null; try { j = JSON.parse(tried.res.body); } catch (e) { /* not JSON */ }
        answer = h('div.qa-answer', {},
          h('div.inline', {}, h('b', { class: tried.res.status < 300 ? 'mk-verified' : 'mk-failing', text: `HTTP ${tried.res.status}` }), h('span.faint', { text: `${tried.res.timeMs} ms` }),
            j !== null ? h('span.hint', { text: 'Click ✓ to make it a condition, ⤓ to save it for later steps' }) : ''),
          (tried.out && tried.out.tests.length) ? h('ul.step-tests', {}, tried.out.tests.map((t) => h('li', { class: t.ok ? 'mk-verified' : 'mk-failing', text: (t.ok ? '✓ ' : '✕ ') + t.name + (t.error && !t.name.includes(t.error) ? ' — ' + t.error : '') }))) : '',
          j !== null ? h('div.qa-paths', {}, paths.slice(0, 60).map((p) => h('div.qa-path', {},
            h('code', { text: p.path }), h('span.faint', { text: ' = ' + p.value.slice(0, 80) }),
            h('button.ghost.qa-mini', { text: '✓', title: `Pass only when ${p.path} is ${p.value}`, onclick: () => {
              if (!st.rules.length) st.rules.push({ field: '@ok' });
              const op = p.value === 'true' ? 'true' : p.value === 'false' ? 'false' : 'is';
              st.rules.push({ field: p.path, op, value: op === 'is' ? p.value : '' }); redraw();
            } }),
            h('button.ghost.qa-mini', { text: '⤓', title: `Save ${p.path} for later steps`, onclick: () => {
              const key = (p.path.split('.').filter((x) => !/^\d+$/.test(x)).pop() || 'value').replace(/^_/, '').replace(/[^A-Za-z0-9_]/g, '_');
              st.save.push([p.path, key]); redraw();
            } }))))
            : h('pre.code', { text: String(tried.res.body || '').slice(0, 1200) }));
      } else if (tried) answer = h('p.warn', { text: tried.error || tried.skipped || '' });

      return h('div.qa-form', {}, datalist, refs, requestPart, passPart, keepPart, askPart, failPart, shortcutPart,
        h('div.qa-try', {}, tryBtn, tried ? '' : h('span.hint', { text: 'Send just this step and see the answer — then click values instead of typing names.' })), answer);
    }

    async function save(andRun) {
      if (!name.trim()) { nameIn.focus(); return T.toast('Give the flow a name', 'error'); }
      if (!steps.length) return T.toast('Add at least one step', 'error');
      const broken = steps.findIndex((st) => st.it.branch && st.it.branch.then === 'jump' && !steps.some((s) => s.it.id === st.it.branch.to));
      if (broken >= 0) return T.toast(`Step ${broken + 1}: pick the step its shortcut goes to`, 'error');
      busy = true; draw();
      let root = F.flowsRoot();
      if (!root) { root = { id: M.uid(), name: '🧪 Flows', auth: { type: 'noauth' }, item: [] }; S.coll.data.item.unshift(root); }
      let target = editingId ? M.findById(S.coll.data.item, editingId) : null;
      if (!target) { target = { id: M.uid(), name: '', auth: { type: 'noauth' }, item: [] }; root.item.push(target); }
      const shortName = T.flowShortName(name.trim());   // a pasted "Folder · Name" keeps one folder
      target.name = group ? `${group} · ${shortName}` : shortName;
      T.ls.set('flowLastFolder', group);
      if (desc.trim()) target.description = desc.trim(); else delete target.description;
      target.auth = target.auth || { type: 'noauth' };
      target.item = steps.map((st) => { const it = F.finalItem(st); it.name = String(it.name || '').trim() || 'Step'; return it; });
      T.markDirty();
      await T.saveColl();
      busy = false;
      if (S.dirty) { draw(); return T.toast('Not saved yet — see the message above and try again', 'error'); }
      dirty = false;
      S.flowSel = target.id; S.view = 'flows'; T.ls.set('view', 'flows');
      T.renderTree(); T.renderEditor(); T.renderResponse();
      close(true);
      T.toast(`Saved "${target.name}"`);
      if (andRun) T.runDialog(target);
    }

    const saveBtn = h('button.primary', { text: 'Save flow', onclick: () => save(false) });
    const runBtn = h('button', { text: 'Save & run', onclick: () => save(true) });
    const box = h('div.modal.qa-editor', { role: 'dialog', 'aria-label': 'Flow editor' },
      h('header', {}, h('span.grow', { text: folder ? `Edit flow — ${folder.name}` : 'New flow' }), h('button.ghost', { text: '×', title: 'Close', onclick: () => close() })),
      h('div.qa-edit-body', {},
        h('div.qa-meta', {}, h('label', { for: 'qa-folder', text: 'Folder' }), h('div', {}, folderIn, folderList), h('label', { for: 'qa-name', text: 'Flow name' }), nameIn, h('label', { for: 'qa-desc', text: 'What it proves' }), descIn),
        top, list),
      h('footer', {},
        h('span.hint.grow', {}, 'Steps run top to bottom and stop at the first one that does not pass. ', h('a', { href: '/apitestingbruno/guide#8-edit-a-step--the-six-questions', target: '_blank', rel: 'noopener', text: '📖 Guide' })),
        h('button', { text: 'Cancel', onclick: () => close() }), runBtn, saveBtn));
    overlay.replaceChildren(box);
    overlay.onclick = (ev) => { if (ev.target === overlay) close(); };
    draw();
    (folder ? nameIn : nameIn).focus();
  };
})();
