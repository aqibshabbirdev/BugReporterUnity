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

  T.send = async function () {
    const it = S.sel;
    if (!it || M.isFolder(it) || S.sending) return;
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

    S.sending = true;
    S.results.set(it, { pending: true });
    T.renderResponse();
    R.sendBtn && (R.sendBtn.disabled = true);

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

      let res;
      if (S.mode === 'browser') res = await sendFromBrowser(final);
      else {
        try {
          res = await T.api('POST', '/api/tester/send', Object.assign({}, final, { verifyTls: S.verifyTls }));
          res.via = 'server';
        } catch (e) {
          if (e.status === 401) { location.reload(); return; }
          throw e;
        }
      }

      for (const s of M.scriptsFor(it, parents, coll, 'test')) {
        absorb(M.runScript(s.code, { env, coll: collVars, local, response: res, name: it.name }), s.from, 'post-response');
      }
      S.results.set(it, { res, sent: final, out });
    } catch (e) {
      S.results.set(it, { error: e.message, missing: e.missing, out });
    } finally {
      S.sending = false;
      if (R.sendBtn) R.sendBtn.disabled = false;
      if (S.sel === it) { T.renderResponse(); T.renderVarWarning(); }
      if (S.envDirty) T.saveEnv(true);   // scripts setting {{token}} should stick for the next request
    }
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

  T.renderResponse = function () {
    if (!R.response) return;
    const it = S.sel;
    const r = it && !M.isFolder(it) ? S.results.get(it) : null;
    if (!r) {
      R.response.replaceChildren(h('div.idle', {}, it && !M.isFolder(it) ? ['Press ', h('b', { text: 'Send' }), ' to see the response.', h('br'), h('span.faint', { text: 'Ctrl/Cmd+Enter sends · Ctrl/Cmd+S saves' })] : ''));
      return;
    }
    if (r.pending) { R.response.replaceChildren(h('div.idle', {}, h('span.spinner'), ' Sending…')); return; }

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
      res.note ? h('span.warn', { text: res.note }) : ''));
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

  T.modal = function (title, body, buttons) {
    const overlay = document.getElementById('overlay');
    const close = () => { overlay.replaceChildren(); document.removeEventListener('keydown', onKey); };
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

  T.conflictDialog = function (info) {
    T.modal('Someone saved this collection meanwhile', h('p', { text: `${(info && info.updatedBy) || 'A teammate'} saved a newer version while you were editing. Saving now would overwrite their changes.` }), [
      { label: 'Keep editing', run: (close) => close() },
      {
        label: 'Save mine as a copy', run: async (close) => {
          const data = M.clone(S.coll.data); data.info.name += ' (my copy)';
          const r = await T.api('POST', '/api/tester/collections', { data });
          S.colls.push(r); S.dirty = false; close(); await T.openColl(r.id); T.toast('Saved as a new collection');
        }
      },
      { label: 'Load theirs (discard mine)', kind: 'danger', run: async (close) => { S.dirty = false; close(); await T.openColl(S.coll.id); } }
    ]);
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
