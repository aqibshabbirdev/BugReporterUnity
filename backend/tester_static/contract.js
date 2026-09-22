/* API tester — contract check: remember a response's shape, and notice when the backend changes it. */
(function () {
  'use strict';

  const { h, S, R } = T;

  /* ── shape ─────────────────────────────────────────────────────────────── */

  // A shape is the response with values replaced by type names, so it stays small and readable:
  //   {status:'boolean', data:{_id:'number', name:'string'}, items:['number']}
  // An array becomes a one-element array holding the shape of its first item ([] when empty).
  function shapeOf(v, depth) {
    depth = depth || 0;
    if (v === null) return 'null';
    if (Array.isArray(v)) return depth > 6 || !v.length ? [] : [shapeOf(v[0], depth + 1)];
    if (typeof v === 'object') {
      if (depth > 6) return 'object';
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = shapeOf(val, depth + 1);
      return out;
    }
    return typeof v;
  }

  const kindOf = (s) => (Array.isArray(s) ? 'array' : s && typeof s === 'object' ? 'object' : String(s));

  /**
   * What changed between the recorded shape and a fresh response.
   * gone  — a field the contract had is not in the response any more (breaks apps)
   * type  — the same field now holds a different kind of value
   * null  — a field that had a value came back null
   * extra — a field the backend added (safe, worth knowing)
   */
  function diffShape(want, got, path, out) {
    out = out || [];
    path = path || '';
    const wk = kindOf(want), gk = kindOf(got);
    if (wk === 'object' && gk === 'object') {
      for (const [k, wv] of Object.entries(want)) {
        const at = path ? path + '.' + k : k;
        if (!(k in got)) out.push({ kind: 'gone', path: at, was: kindOf(wv) });
        else diffShape(wv, got[k], at, out);
      }
      for (const k of Object.keys(got)) if (!(k in want)) out.push({ kind: 'extra', path: path ? path + '.' + k : k, now: kindOf(got[k]) });
      return out;
    }
    if (wk === 'array' && gk === 'array') {
      if (want.length && got.length) diffShape(want[0], got[0], path + '[]', out);
      return out;
    }
    if (wk === gk) return out;
    if (gk === 'null') out.push({ kind: 'null', path, was: wk });
    else if (wk === 'null') out.push({ kind: 'extra', path, now: gk });     // was null when recorded — now has a value
    else out.push({ kind: 'type', path, was: wk, now: gk });
    return out;
  }

  const breaking = (diffs) => diffs.filter((d) => d.kind === 'gone' || d.kind === 'type');
  const wordFor = (d) => d.kind === 'gone' ? `${d.path} is gone (was ${d.was})`
    : d.kind === 'type' ? `${d.path} is now ${d.now} (was ${d.was})`
      : d.kind === 'null' ? `${d.path} came back null (was ${d.was})`
        : `${d.path} is new (${d.now})`;

  /* ── stored on the request ─────────────────────────────────────────────── */

  T.contractOf = (it) => (it && it.contract && it.contract.shape !== undefined ? it.contract : null);

  T.recordContract = function (it, res, quiet) {
    let body = null;
    try { body = JSON.parse(res.body); } catch (e) { return T.toast('That response is not JSON — nothing to record', 'error'); }
    it.contract = { shape: shapeOf(body, 0), at: Math.floor(Date.now() / 1000), by: (S.me && S.me.email) || '' };
    T.markDirty();
    if (!quiet) { T.saveColl(); T.renderResponse(); T.toast('Response shape recorded'); }
  };

  T.clearContract = function (it) {
    delete it.contract;
    T.markDirty(); T.saveColl(); T.renderResponse();
  };

  /** Compare a response against the recorded shape. Returns null when nothing is recorded. */
  T.contractCheck = function (it, res) {
    const c = T.contractOf(it);
    if (!c || !res || res.body == null) return null;
    let body = null;
    try { body = JSON.parse(res.body); } catch (e) { return { diffs: [{ kind: 'type', path: '(body)', was: 'JSON', now: 'not JSON' }], ok: false }; }
    const diffs = diffShape(c.shape, shapeOf(body, 0), '', []);
    return { diffs, ok: breaking(diffs).length === 0 };
  };

  /* ── every send is checked ─────────────────────────────────────────────── */

  // Wrap T.execute so a recorded shape is checked on every send — in the request pane, in a folder run
  // and inside a flow — and shows up as a normal test result.
  const execute = T.execute;
  T.execute = async function (it, opts) {
    const r = await execute.call(this, it, opts);
    try {
      if (r && r.res && r.out && T.contractOf(it)) {
        const c = T.contractCheck(it, r.res);
        if (c) {
          const bad = breaking(c.diffs);
          const extra = c.diffs.filter((d) => d.kind === 'extra' || d.kind === 'null');
          r.out.tests.push(bad.length
            ? { name: `Response shape changed — ${bad.slice(0, 3).map(wordFor).join('; ')}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ''}`, ok: false }
            : { name: `Response shape matches the contract${extra.length ? ` (${extra.length} new/null field${extra.length === 1 ? '' : 's'})` : ''}`, ok: true });
        }
      }
    } catch (e) { /* a contract must never break a send */ }
    return r;
  };

  /* ── the chip in the response pane ─────────────────────────────────────── */

  const renderResponse = T.renderResponse;
  T.renderResponse = function () {
    renderResponse.apply(this, arguments);
    const it = S.sel;
    if (!it || M.isFolder(it) || !R.response || R.response.hidden) return;
    const meta = R.response.querySelector('.res-meta');
    const r = S.results.get(it.id);
    if (!meta || !r || !r.res) return;

    const c = T.contractOf(it);
    if (!c) {
      meta.append(h('button.ghost.ct-btn', { text: '📐 Record shape', title: 'Remember this response’s fields and types, and warn when they change', onclick: () => T.recordContract(it, r.res) }));
      return;
    }
    const check = T.contractCheck(it, r.res) || { diffs: [], ok: true };
    const bad = breaking(check.diffs);
    const extra = check.diffs.filter((d) => d.kind === 'extra' || d.kind === 'null');
    const when = c.at ? new Date(c.at * 1000).toLocaleDateString() : '';
    meta.append(h('button.ct-chip', {
      class: bad.length ? 'bad' : extra.length ? 'warn' : 'ok',
      text: bad.length ? `📐 Shape changed · ${bad.length}` : extra.length ? `📐 ${extra.length} new` : '📐 Shape OK',
      title: `Recorded ${when}${c.by ? ' by ' + c.by : ''}\nClick for what changed`,
      onclick: () => showDiff(it, check, c)
    }));
  };

  function showDiff(it, check, c) {
    const rows = check.diffs.length
      ? h('div.ct-diffs', {}, check.diffs.map((d) => h('div.ct-diff', { class: 'k-' + d.kind },
        h('span.ct-kind', { text: d.kind === 'gone' ? 'GONE' : d.kind === 'type' ? 'CHANGED' : d.kind === 'null' ? 'NULL' : 'NEW' }),
        h('span.ct-path', { text: d.path }),
        h('span.faint', { text: d.kind === 'gone' ? `was ${d.was}` : d.kind === 'type' ? `${d.was} → ${d.now}` : d.kind === 'null' ? `was ${d.was}` : d.now }))))
      : h('p.hint', { text: 'The response matches the recorded shape exactly.' });
    const body = h('div.ct-box', {},
      h('p.hint', { text: `Shape recorded ${c.at ? new Date(c.at * 1000).toLocaleString() : ''}${c.by ? ' by ' + c.by : ''}. Fields that go missing or change type fail the test; new fields are only listed.` }),
      rows,
      h('details.ct-shape', {}, h('summary', { text: 'The recorded shape' }), h('pre.code', { text: JSON.stringify(c.shape, null, 2).slice(0, 8000) })));
    T.modal(`Response contract: ${it.name}`, body, [
      { label: 'Forget shape', run: (close) => { if (confirm('Stop checking this response’s shape?')) { T.clearContract(it); close(); } } },
      { label: 'Update to this response', kind: 'primary', run: (close) => { const r = S.results.get(it.id); if (r && r.res) T.recordContract(it, r.res); close(); } },
      { label: 'Close', run: (close) => close() }
    ]);
  }

  /* ── record a whole folder from what it last returned ──────────────────── */

  T.recordFolderContracts = function (folder) {
    const done = [];
    M.walk(folder.item, (it) => {
      if (M.isFolder(it)) return;
      const r = S.results.get(it.id);
      if (r && r.res && r.res.body) { T.recordContract(it, r.res, true); done.push(it.name); }
    });
    if (!done.length) return T.toast('Run this folder first — shapes are recorded from the last response', 'error');
    T.saveColl();
    T.renderTree(); T.renderResponse();
    T.toast(`Recorded ${done.length} response shape${done.length === 1 ? '' : 's'}`);
  };
})();
