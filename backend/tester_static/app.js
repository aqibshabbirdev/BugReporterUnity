/* API tester — shell: state, sign-in, top bar, collection tree, request editor.
 * panels.js adds sending, the response pane, dialogs and import/export on the same `T` namespace.
 */
(function () {
  'use strict';

  const T = {};
  window.T = T;

  /* ── tiny DOM + storage helpers ────────────────────────────────────────── */

  /** h('button.primary', {onclick, title}, 'Send') — class shorthand after the tag, children as text/nodes. */
  const h = (T.h = function (sel, props, ...kids) {
    const [tag, ...classes] = sel.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  });

  const ls = (T.ls = {
    get: (k, d) => { try { const v = localStorage.getItem('apitester.' + k); return v === null ? d : v; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem('apitester.' + k, v); } catch (e) { /* private mode */ } }
  });

  T.toast = function (msg, kind) {
    const el = h('div.toast', { class: kind || '', text: msg });
    document.getElementById('toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 2600);
  };

  /* ── API ───────────────────────────────────────────────────────────────── */

  T.api = async function (method, path, body) {
    const r = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body === undefined ? { 'X-Tester': '1' } : { 'Content-Type': 'application/json', 'X-Tester': '1' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* non-JSON error page */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || `HTTP ${r.status}`);
      err.status = r.status; err.data = data;
      throw err;
    }
    return data;
  };

  /* ── state ─────────────────────────────────────────────────────────────── */

  const S = (T.S = {
    me: null,
    colls: [], envs: [],
    coll: null,            // {id, name, version, data}
    env: null,             // {id, name, version, data}
    base: null,            // coll.data as last saved on the server (coll.version) — the common ancestor for merges
    envBase: null,
    sel: null,             // the selected item object inside coll.data
    open: new Set(),       // ids of expanded folders
    dirty: false, envDirty: false,
    saving: false, envSaving: false,
    remote: null,          // a newer saved version of the open collection, while there are unsaved edits here
    filter: '',
    tab: 'params',
    mode: ls.get('mode', 'server'),
    verifyTls: ls.get('verifyTls', '1') === '1',
    local: [],             // pm.variables for this page session
    results: new Map(),    // item id -> last {res | error, scripts}
    marks: {},             // item id -> {status: verified|failing, note, responseCode, markedBy, markedAt}; absent = pending
    statusFilter: ls.get('statusFilter', 'all'),
    markSaving: 0
  });

  T.markDirty = function () {
    if (!S.dirty) { S.dirty = true; T.renderSaveState(); if (S.remote) T.renderBanner(); }
  };

  T.envStore = () => M.varStore(() => (S.env ? S.env.data.values : S.local), () => { if (S.env) S.envDirty = true; });
  T.collStore = () => M.varStore(() => (S.coll.data.variable = S.coll.data.variable || []), T.markDirty);
  T.localStore = () => M.varStore(() => S.local);
  T.scopes = () => [T.localStore(), T.envStore(), T.collStore()];

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ── boot + sign-in ────────────────────────────────────────────────────── */

  T.boot = async function () {
    try {
      S.me = await T.api('GET', '/api/auth/me');
    } catch (e) {
      if (e.status === 401) return renderGate();
      document.getElementById('app').replaceChildren(h('div.boot', { text: 'Could not reach the server: ' + e.message }));
      return;
    }
    [S.colls, S.envs] = await Promise.all([T.api('GET', '/api/tester/collections'), T.api('GET', '/api/tester/environments')]);
    T.listSig = listSignature(S.colls, S.envs);
    renderShell();
    const envId = ls.get('env', '');
    if (S.envs.some((x) => x.id === envId)) await T.openEnv(envId);
    const collId = ls.get('coll', '');
    const first = S.colls.find((x) => x.id === collId) || S.colls[0];
    if (first) await T.openColl(first.id); else T.renderAll();
  };

  function renderGate(error) {
    const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
    const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
    const msg = h('div.error-box', { style: error ? '' : 'display:none', text: error || '' });
    const form = h('form', {
      onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          await T.api('POST', '/api/auth/login', { email: email.value, password: pw.value });
          T.boot();
        } catch (e) { msg.textContent = e.message; msg.style.display = ''; }
      }
    },
      h('h1', { text: 'API Tester' }),
      h('p.muted', { text: 'Sign in with your Bug Reporter account.' }),
      h('div.field', {}, h('label', { text: 'Email' }), email),
      h('div.field', {}, h('label', { text: 'Password' }), pw),
      msg,
      h('div.inline', { style: 'justify-content:space-between;margin-top:12px' },
        h('a', { href: '/', text: 'No account? Open the dashboard' }),
        h('button.primary', { type: 'submit', text: 'Sign in' }))
    );
    document.getElementById('app').replaceChildren(h('div.gate', {}, form));
    email.focus();
  }

  /* ── shell ─────────────────────────────────────────────────────────────── */

  const R = (T.R = {});   // live region elements

  function renderShell() {
    R.top = h('header.top');
    R.tree = h('div.tree');
    R.filter = h('input', {
      type: 'search', placeholder: 'Filter requests', value: S.filter,
      oninput: () => { S.filter = R.filter.value.trim().toLowerCase(); T.renderTree(); }
    });
    R.side = h('aside.side', {},
      h('div.side-tools', {}, R.filter,
        h('button', { title: 'New request', text: '+ Request', onclick: () => T.addItem(M.newRequest(), T.targetFolder()) }),
        h('button', { title: 'New folder', text: '+ Folder', onclick: () => T.addItem(M.newFolder(), T.targetFolder()) })),
      R.statusBar = h('div.status-bar', { role: 'group', 'aria-label': 'Show requests by test status' }),
      R.tree);
    R.editor = h('section.editor');
    R.response = h('section.response');
    R.banner = h('div.banner', { hidden: true });
    document.getElementById('app').replaceChildren(R.top, R.banner, h('div.main', {}, R.side, h('div.work', {}, R.editor, R.response)));
    T.startPolling();
  }

  T.renderAll = function () {
    T.renderTop(); T.renderBanner(); T.renderTree(); T.renderEditor(); T.renderResponse();
  };

  T.renderSaveState = function () {
    if (!R.saved) return;
    R.saved.className = 'saved' + (S.dirty ? ' dirty' : '');
    R.saved.textContent = !S.coll ? '' : S.saving ? 'Saving…' : S.dirty ? '● Unsaved' : 'Saved';
    if (R.saveBtn) R.saveBtn.disabled = !S.dirty || S.saving;
  };

  T.renderTop = function () {
    const collSel = h('select', {
      title: 'Collection',
      onchange: async () => {
        if (S.dirty && !confirm('Discard unsaved changes to this collection?')) { collSel.value = S.coll.id; return; }
        await T.openColl(collSel.value);
      }
    }, S.colls.length ? S.colls.map((c) => h('option', { value: c.id, text: c.name, selected: S.coll && c.id === S.coll.id })) : h('option', { text: 'No collections yet' }));

    const envSel = h('select', {
      title: 'Environment',
      onchange: async () => { await T.openEnv(envSel.value); T.renderEditor(); }
    }, h('option', { value: '', text: 'No environment' }), S.envs.map((e) => h('option', { value: e.id, text: e.name, selected: S.env && e.id === S.env.id })));

    R.saved = h('span.saved');
    R.saveBtn = h('button.primary', { text: 'Save', title: 'Save collection (Ctrl/Cmd+S)', onclick: () => T.saveColl() });

    // Grouped so a narrow window wraps whole groups instead of splitting "Unsaved" from its Save button.
    R.top.replaceChildren(
      h('div.group', {},
        h('span.brand', { text: '🐞 API Tester' }),
        collSel,
        h('button', { text: 'Import', title: 'Import a Postman collection or environment (.json)', onclick: () => T.importFile() }),
        h('button.ghost', { text: '⋯', title: 'Collection actions', onclick: (ev) => T.collMenu(ev.currentTarget) })),
      h('div.group', {}, envSel, h('button', { text: 'Variables', onclick: () => T.envDialog() })),
      h('span.grow'),
      h('div.group', {}, R.saved, R.saveBtn, h('span.faint.who', { text: S.me.email }), h('a', { href: '/', text: 'Dashboard' }))
    );
    T.renderSaveState();
  };

  /* ── documents ─────────────────────────────────────────────────────────── */

  const summary = (d) => ({ id: d.id, name: d.name, version: d.version, updatedAt: d.updatedAt, updatedBy: d.updatedBy });
  const sameDoc = (a, b) => M.stable(a) === M.stable(b);
  const modalOpen = () => document.getElementById('overlay').childElementCount > 0;

  T.openColl = async function (id) {
    const [doc, marks] = await Promise.all([T.api('GET', '/api/tester/collections/' + id), T.api('GET', `/api/tester/collections/${id}/marks`)]);
    S.marks = marks || {};
    M.ensureIds(doc.data.item);
    S.coll = doc; S.base = M.clone(doc.data); S.dirty = false; S.sel = null; S.open = new Set(); S.remote = null;
    ls.set('coll', id);
    // Open the first folder and select its first request, so the page never starts blank.
    const firstFolder = doc.data.item.find(M.isFolder);
    if (firstFolder) S.open.add(firstFolder.id);
    let firstReq = null;
    M.walk(doc.data.item, (it) => { if (!firstReq && !M.isFolder(it)) firstReq = it; });
    S.sel = firstReq;
    if (firstReq) (M.parentsOf(doc.data.item, firstReq) || []).forEach((p) => S.open.add(p.id));
    T.renderAll();
  };

  T.openEnv = async function (id) {
    if (S.envDirty && S.env) await T.saveEnv(true);
    S.env = id ? await T.api('GET', '/api/tester/environments/' + id) : null;
    S.envBase = S.env ? M.clone(S.env.data) : null;
    S.envDirty = false;
    ls.set('env', id || '');
    T.renderTop();
  };

  /**
   * Swap in a new document for the open collection (a teammate's version, or a merge onto it). The
   * selection, expanded folders and last responses follow item ids, so the page stays where it was.
   */
  function applyColl(latest, data) {
    const selId = S.sel && S.sel.id;
    S.coll = Object.assign(summary(latest), { data });
    S.base = M.clone(latest.data);
    S.dirty = !sameDoc(data, latest.data);
    S.sel = M.findById(data.item, selId);
    S.remote = null;
    const entry = S.colls.find((c) => c.id === latest.id); if (entry) Object.assign(entry, summary(latest));
    T.renderAll();
  }

  /**
   * Bring the newest saved version of the open collection in. Without local edits it just replaces the
   * document; with edits, those are three-way merged onto it — only fields both sides changed need a
   * decision. Resolves false if the user cancels or the collection is gone.
   */
  T.pullColl = async function () {
    const id = S.coll.id;
    let latest;
    try { latest = await T.api('GET', '/api/tester/collections/' + id); } catch (e) {
      if (e.status !== 404) throw e;
      S.remote = { id, gone: true }; T.renderBanner();
      return false;
    }
    if (!S.coll || S.coll.id !== id) return false;
    M.ensureIds(latest.data.item);
    if (!S.dirty) { applyColl(latest, M.clone(latest.data)); return true; }
    M.ensureIds(S.coll.data.item);
    const first = M.merge3(S.base, S.coll.data, latest.data);
    let doc = first.doc;
    if (first.conflicts.length) {
      const choices = await T.conflictDialog(first.conflicts, latest.updatedBy);
      if (!choices) { S.remote = summary(latest); T.renderBanner(); return false; }
      doc = M.merge3(S.base, S.coll.data, latest.data, choices).doc;   // again: the dialog may have taken a while
    }
    applyColl(latest, M.clone(doc));
    return true;
  };

  T.saveColl = async function () {
    if (!S.coll || !S.dirty || S.saving) return;
    S.saving = true;
    T.renderSaveState();
    let mergedFrom = null;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        M.ensureIds(S.coll.data.item);
        const sent = M.clone(S.coll.data);
        try {
          const r = await T.api('PUT', '/api/tester/collections/' + S.coll.id, { data: sent, version: S.coll.version });
          Object.assign(S.coll, summary(r));
          S.base = sent;
          S.dirty = !sameDoc(S.coll.data, sent);      // edits typed while the save was in flight stay unsaved
          S.remote = null;
          const entry = S.colls.find((c) => c.id === r.id); if (entry) Object.assign(entry, summary(r));
          T.renderTop(); T.renderBanner();
          T.toast(mergedFrom ? `Saved — merged with ${mergedFrom}'s changes` : 'Collection saved');
          return;
        } catch (e) {
          if (e.status !== 409) throw e;
          // Someone saved first: merge onto their version and try again.
          if (!(await T.pullColl())) return;
          mergedFrom = S.coll.updatedBy || 'a teammate';
          if (!S.dirty) { T.toast(`${mergedFrom} had already saved the same changes`); return; }
        }
      }
      T.toast('Could not save — the collection keeps changing. Try again in a moment.', 'error');
    } catch (e) {
      if (e.status === 404) { S.remote = { id: S.coll.id, gone: true }; T.renderBanner(); }
      T.toast('Save failed: ' + e.message, 'error');
    } finally {
      S.saving = false;
      T.renderSaveState();
    }
  };

  T.saveEnv = async function (quiet) {
    if (!S.env || !S.envDirty || S.envSaving) return;
    S.envSaving = true;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const sent = M.clone(S.env.data);
        try {
          const r = await T.api('PUT', '/api/tester/environments/' + S.env.id, { data: sent, version: S.env.version });
          S.env.version = r.version; S.env.updatedBy = r.updatedBy;
          S.envBase = sent;
          S.envDirty = !sameDoc(S.env.data, sent);
          if (!quiet) T.toast('Environment saved');
          return;
        } catch (e) {
          if (e.status !== 409) throw e;
          // Merge by variable name onto the newer version; a variable both changed keeps this page's value.
          const latest = await T.api('GET', '/api/tester/environments/' + S.env.id);
          const merged = M.mergeEnvValues(S.envBase.values, S.env.data.values, latest.data.values);
          const data = Object.assign(M.clone(latest.data), { values: M.clone(merged.values) });
          if (S.env.data.name !== S.envBase.name) data.name = S.env.data.name;
          S.envBase = M.clone(latest.data);
          S.env = Object.assign(latest, { name: data.name, data });
          if (merged.overridden.length) T.toast(`${latest.updatedBy} also changed ${merged.overridden.join(', ')} — kept your value`);
        }
      }
      T.toast('Could not save the environment — it keeps changing. Try again.', 'error');
    } catch (e) {
      T.toast('Environment save failed: ' + e.message, 'error');
    } finally {
      S.envSaving = false;
    }
  };

  /* ── live updates ──────────────────────────────────────────────────────── */

  // Every few seconds (and when the tab comes back into view) look at the version numbers. A newer
  // collection loads by itself when there's nothing unsaved here; otherwise a banner offers the merge.
  const POLL_MS = 12000;
  let polling = false;
  const listSignature = (colls, envs) => M.stable([colls.map((c) => [c.id, c.name]), envs.map((e) => [e.id, e.name])]);
  // A field in the editor has focus: re-rendering under it would drop the caret, so offer instead of loading.
  const editing = () => { const a = document.activeElement; return !!(a && R.editor && R.editor.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };

  T.poll = async function () {
    if (polling || document.hidden || !S.me || !R.banner) return;
    polling = true;
    try {
      const [colls, envs] = await Promise.all([T.api('GET', '/api/tester/collections'), T.api('GET', '/api/tester/environments')]);
      const sig = listSignature(colls, envs);
      S.colls = colls; S.envs = envs;

      if (S.coll && !S.saving) {
        const cur = colls.find((c) => c.id === S.coll.id);
        if (!cur) {
          if (S.dirty) { S.remote = { id: S.coll.id, gone: true }; T.renderBanner(); }
          else { T.toast(`"${S.coll.name}" was deleted`); S.coll = null; S.sel = null; if (colls[0]) await T.openColl(colls[0].id); else T.renderAll(); }
        } else if (cur.version > S.coll.version) {
          if (!S.dirty && !modalOpen() && !editing()) { if (await T.pullColl()) T.toast(`Updated — ${cur.updatedBy} saved changes`); }
          else if (!S.remote || S.remote.version !== cur.version) { S.remote = cur; T.renderBanner(); }
        }
      }
      if (S.coll && !S.markSaving) {
        const id = S.coll.id;
        const marks = await T.api('GET', `/api/tester/collections/${id}/marks`);
        if (S.coll && S.coll.id === id && !S.markSaving && M.stable(marks) !== M.stable(S.marks)) {
          S.marks = marks; T.renderTree(); T.renderMarkBar();
        }
      }
      if (S.env && !S.envDirty && !S.envSaving && !modalOpen()) {
        const cur = envs.find((e) => e.id === S.env.id);
        if (cur && cur.version > S.env.version) {
          S.env = await T.api('GET', '/api/tester/environments/' + cur.id);
          S.envBase = M.clone(S.env.data);
          T.renderVarWarning();
        }
      }
      if (sig !== T.listSig) { T.listSig = sig; T.renderTop(); }
    } catch (e) {
      if (e.status === 401) location.reload();     // signed out elsewhere
    } finally {
      polling = false;
    }
  };

  T.startPolling = function () {
    if (T.pollTimer) return;
    T.pollTimer = setInterval(T.poll, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) T.poll(); });
    window.addEventListener('focus', () => T.poll());
  };

  T.renderBanner = function () {
    if (!R.banner) return;
    const r = S.remote;
    R.banner.replaceChildren();
    R.banner.hidden = !(r && S.coll && r.id === S.coll.id);
    if (R.banner.hidden) return;
    if (r.gone) {
      R.banner.append(h('span', { text: `"${S.coll.name}" was deleted by an admin. Your unsaved edits are only on this page.` }),
        h('button', { text: 'Save them as a new collection', onclick: () => T.saveAsCopy() }));
    } else if (S.dirty) {
      R.banner.append(h('span', { text: `${r.updatedBy || 'A teammate'} saved changes to "${r.name}". Your unsaved edits are kept — merge to bring theirs in.` }),
        h('button.primary', { text: 'Merge now', onclick: async () => { if (await T.pullColl()) T.toast(S.dirty ? 'Merged — your edits are still unsaved' : 'Merged — nothing left to save'); } }));
    } else {
      R.banner.append(h('span', { text: `${r.updatedBy || 'A teammate'} saved changes to "${r.name}".` }),
        h('button.primary', { text: 'Load them', onclick: () => T.pullColl() }));
    }
  };

  /* ── tree ──────────────────────────────────────────────────────────────── */

  /** Folder that "+ Request" / "+ Folder" add into: the selected folder, or the selected request's folder. */
  T.targetFolder = function () {
    if (!S.coll || !S.sel) return null;
    if (M.isFolder(S.sel)) return S.sel;
    const parents = M.parentsOf(S.coll.data.item, S.sel) || [];
    return parents[parents.length - 1] || null;
  };

  T.addItem = function (item, folder) {
    if (!S.coll) return T.toast('Create or import a collection first', 'error');
    const name = prompt(M.isFolder(item) ? 'Folder name' : 'Request name', item.name);
    if (name === null) return;
    item.name = name.trim() || item.name;
    (folder ? folder.item : S.coll.data.item).push(item);
    if (folder) S.open.add(folder.id);
    S.sel = item; S.tab = 'params';
    T.markDirty(); T.renderTree(); T.renderEditor(); T.renderResponse();
  };

  /* ── test marks ────────────────────────────────────────────────────────── */

  // A request is pending until a tester marks it; marks live on the server, outside the collection.
  const MARKS = {
    pending: { label: 'Pending', icon: '○' },
    verified: { label: 'Tested & verified', short: 'Verified', icon: '✓' },
    failing: { label: 'Not working as expected', short: 'Not working', icon: '✕' }
  };
  const statusOf = (it) => (S.marks[it.id] && MARKS[S.marks[it.id].status] ? S.marks[it.id].status : 'pending');
  T.statusOf = statusOf;

  function ago(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function markTitle(it) {
    const m = S.marks[it.id];
    if (!m || !MARKS[m.status]) return 'Pending — not tested yet';
    return `${MARKS[m.status].label} · ${m.markedBy} · ${ago(m.markedAt)}${m.responseCode ? ' · HTTP ' + m.responseCode : ''}${m.note ? '\n' + m.note : ''}`;
  }

  /** Set a request's mark for everyone. Shows at once; reverts if the server refuses. */
  T.setMark = async function (it, status, note) {
    if (!S.coll || !it || M.isFolder(it)) return;
    const collId = S.coll.id, prev = S.marks[it.id];
    const last = S.results.get(it.id);
    const responseCode = last && last.res ? last.res.status : null;
    const optimistic = status === 'pending' ? undefined : { status, note: note || '', responseCode, markedBy: S.me.email, markedAt: Math.floor(Date.now() / 1000) };
    const apply = (m) => { if (m) S.marks[it.id] = m; else delete S.marks[it.id]; T.renderTree(); T.renderMarkBar(); T.renderResponse(); };
    apply(optimistic);
    S.markSaving++;
    try {
      const r = await T.api('PUT', `/api/tester/collections/${collId}/marks/${encodeURIComponent(it.id)}`, { status, note: note || '', responseCode });
      if (S.coll && S.coll.id === collId) apply(r.status === 'pending' ? undefined : r);
    } catch (e) {
      if (S.coll && S.coll.id === collId) apply(prev);
      T.toast('Could not save the mark: ' + e.message, 'error');
    } finally {
      S.markSaving--;
    }
  };

  /** "Not working" asks what went wrong, so whoever fixes it knows where to look. */
  T.markFailing = function (it) {
    const m = S.marks[it.id];
    const last = S.results.get(it.id);
    const note = h('textarea', { id: 'mark-note', rows: 4, style: 'width:100%', placeholder: 'What went wrong? e.g. 500 when oldpassword is wrong, expected 400', value: m && m.status === 'failing' ? m.note : '' });
    T.modal(`Not working: ${it.name}`, h('div', {},
      h('label', { for: 'mark-note', class: 'section-title', style: 'display:block;margin-top:0', text: 'Note (optional)' }), note,
      h('p.hint', { text: last && last.res ? `Last response here: HTTP ${last.res.status} — saved with the mark.` : 'No response on this page yet; send the request first to save its status code with the mark.' })), [
      { label: 'Cancel', run: (close) => close() },
      { label: '✕ Mark not working', kind: 'danger', run: (close) => { close(); T.setMark(it, 'failing', note.value.trim()); } }
    ]);
    setTimeout(() => note.focus(), 0);
  };

  /** Verdict controls under the URL bar of the open request. */
  T.renderMarkBar = function () {
    if (!R.markBar) return;
    const it = S.sel;
    if (!S.coll || !it || M.isFolder(it)) { R.markBar.replaceChildren(); return; }
    const status = statusOf(it), m = S.marks[it.id];
    const btn = (key, run) => h('button', {
      class: 'mk-btn mk-' + key + (status === key ? ' on' : ''), 'aria-pressed': status === key ? 'true' : 'false',
      title: MARKS[key].label, onclick: run
    }, h('span.mk-ico', { text: MARKS[key].icon }), MARKS[key].short || MARKS[key].label);
    const parts = [
      h('div.mk-group', { role: 'group', 'aria-label': 'Test status' },
        btn('pending', () => status !== 'pending' && T.setMark(it, 'pending')),
        btn('verified', () => status !== 'verified' && T.setMark(it, 'verified')),
        btn('failing', () => T.markFailing(it)))
    ];
    parts.push(h('span.mk-who', { text: m && MARKS[m.status] ? `${m.markedBy} · ${ago(m.markedAt)}${m.responseCode ? ' · HTTP ' + m.responseCode : ''}` : 'Not tested yet' }));
    R.markBar.replaceChildren(...parts);
    if (m && m.status === 'failing' && m.note) R.markBar.append(h('div.mk-note', { text: m.note }));
  };

  const filtering = () => !!S.filter || S.statusFilter !== 'all';

  const matches = (it) => {
    if (M.isFolder(it)) {
      if (!filtering()) return true;
      if (S.statusFilter === 'all' && it.name.toLowerCase().includes(S.filter)) return true;
      return it.item.some(matches);
    }
    if (S.statusFilter !== 'all' && statusOf(it) !== S.statusFilter) return false;
    if (!S.filter) return true;
    return it.name.toLowerCase().includes(S.filter) || M.urlRaw(M.req(it)).toLowerCase().includes(S.filter);
  };

  function tally(items) {
    const t = { total: 0, pending: 0, verified: 0, failing: 0 };
    M.walk(items, (it) => { if (!M.isFolder(it)) { t.total++; t[statusOf(it)]++; } });
    return t;
  }

  function renderStatusBar() {
    if (!R.statusBar) return;
    if (!S.coll) { R.statusBar.replaceChildren(); return; }
    const t = tally(S.coll.data.item);
    const chip = (key, label, n) => h('button', {
      class: 'st-chip st-' + key + (S.statusFilter === key ? ' on' : ''), 'aria-pressed': S.statusFilter === key ? 'true' : 'false',
      title: key === 'all' ? 'Show every request' : 'Show only: ' + (MARKS[key] ? MARKS[key].label : label),
      onclick: () => { S.statusFilter = key; ls.set('statusFilter', key); T.renderTree(); }
    }, key !== 'all' ? h('span.mk-ico', { text: MARKS[key].icon }) : '', label, h('span.n', { text: n }));
    R.statusBar.replaceChildren(
      chip('all', 'All', t.total), chip('pending', 'Pending', t.pending),
      chip('verified', 'Verified', t.verified), chip('failing', 'Not working', t.failing));
  }

  function highlight(text) {
    if (!S.filter) return text;
    const i = text.toLowerCase().indexOf(S.filter);
    if (i < 0) return text;
    return [text.slice(0, i), h('mark', { text: text.slice(i, i + S.filter.length) }), text.slice(i + S.filter.length)];
  }

  T.renderTree = function () {
    if (!R.tree) return;
    if (!S.coll) {
      R.tree.replaceChildren(h('div.empty-tree', {},
        h('p', { text: 'No collection open.' }),
        h('button.primary', { text: 'Import Postman collection', onclick: () => T.importFile() }),
        h('p', {}, h('a', { href: '#', text: 'or start an empty one', onclick: (e) => { e.preventDefault(); T.newCollection(); } }))));
      renderStatusBar();
      return;
    }
    const frag = document.createDocumentFragment();
    const draw = (items, depth) => {
      for (const it of items) {
        if (!matches(it)) continue;
        const pad = `padding-left:${8 + depth * 14}px`;
        const more = h('button.ghost.more', { text: '⋯', title: 'Actions', onclick: (ev) => { ev.stopPropagation(); T.itemMenu(ev.currentTarget, it); } });
        if (M.isFolder(it)) {
          const open = S.open.has(it.id) || filtering();
          const t = tally(it.item);
          frag.append(h('div.row', {
            class: S.sel === it ? 'sel' : '', style: pad,
            onclick: () => { if (S.open.has(it.id) && S.sel === it) S.open.delete(it.id); else S.open.add(it.id); S.sel = it; T.renderTree(); T.renderEditor(); T.renderResponse(); }
          }, h('span.caret', { text: open ? '▾' : '▸' }), h('span.label', {}, highlight(it.name)),
            h('span.count', { title: `${t.verified} verified · ${t.failing} not working · ${t.pending} pending` },
              t.failing ? h('span.c-bad', { text: '✕' + t.failing + ' ' }) : '',
              t.verified ? h('span.c-ok', { text: t.verified }) : '', t.verified ? '/' : '', String(t.total)), more));
          if (open) draw(it.item, depth + 1);
        } else {
          const method = (M.req(it).method || 'GET').toUpperCase();
          frag.append(h('div.row', {
            class: S.sel === it ? 'sel' : '', style: pad, title: M.urlRaw(M.req(it)),
            onclick: () => { S.sel = it; T.renderTree(); T.renderEditor(); T.renderResponse(); }
          }, h('span.meth', { class: 'm-' + method, text: method.slice(0, 6) }), h('span.label', {}, highlight(it.name)),
            h('span.mk', { class: 'mk-' + statusOf(it), title: markTitle(it), 'aria-label': MARKS[statusOf(it)].label, text: MARKS[statusOf(it)].icon }), more));
        }
      }
    };
    draw(S.coll.data.item, 0);
    if (!frag.childNodes.length) frag.append(h('div.empty-tree', { text: filtering() ? 'Nothing matches.' : 'Empty collection — add a request.' }));
    R.tree.replaceChildren(frag);
    renderStatusBar();
  };

  /* ── menus ─────────────────────────────────────────────────────────────── */

  T.menu = function (anchor, entries) {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
    const menu = h('div.menu', {}, entries.map((e) => (e === '-' ? h('hr') : h('button', { class: e.danger ? 'danger' : '', text: e.label, onclick: () => { menu.remove(); e.run(); } }))));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, hgt = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    menu.style.top = (r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4) + 'px';
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  };

  T.itemMenu = function (anchor, it) {
    const entries = [];
    if (M.isFolder(it)) {
      entries.push({ label: 'New request here', run: () => T.addItem(M.newRequest(), it) });
      entries.push({ label: 'New folder here', run: () => T.addItem(M.newFolder(), it) });
      entries.push('-');
    }
    entries.push({ label: 'Rename', run: () => { const n = prompt('Name', it.name); if (n && n.trim()) { it.name = n.trim(); T.markDirty(); T.renderTree(); T.renderEditor(); } } });
    entries.push({
      label: 'Duplicate', run: () => {
        const list = M.containerOf(S.coll.data, it); const copy = M.freshIds(M.clone(it));
        copy.name = it.name + ' copy'; list.splice(list.indexOf(it) + 1, 0, copy);
        S.sel = copy; T.markDirty(); T.renderTree(); T.renderEditor(); T.renderResponse();
      }
    });
    entries.push({ label: 'Move up', run: () => move(it, -1) }, { label: 'Move down', run: () => move(it, 1) });
    entries.push('-');
    entries.push({
      label: 'Delete', danger: true, run: () => {
        const what = M.isFolder(it) ? `folder "${it.name}" and its ${M.countRequests(it.item)} requests` : `"${it.name}"`;
        if (!confirm(`Delete ${what}? (Only takes effect when you Save.)`)) return;
        const list = M.containerOf(S.coll.data, it); list.splice(list.indexOf(it), 1);
        if (S.sel === it || (M.isFolder(it) && S.sel && (M.parentsOf(it.item, S.sel) || it.item.includes(S.sel)))) S.sel = null;
        T.markDirty(); T.renderTree(); T.renderEditor(); T.renderResponse();
      }
    });
    T.menu(anchor, entries);
  };

  function move(it, delta) {
    const list = M.containerOf(S.coll.data, it); const i = list.indexOf(it); const j = i + delta;
    if (j < 0 || j >= list.length) return;
    list.splice(i, 1); list.splice(j, 0, it);
    T.markDirty(); T.renderTree();
  }

  /* ── key/value table ───────────────────────────────────────────────────── */

  /**
   * Editable rows over a Postman list ([{key, value, disabled}] or [{key, value, enabled}]). Edits write
   * straight into the list objects; a blank trailing row becomes real once typed into.
   */
  T.kvTable = function (list, { flag = 'disabled', onChange, keyHint = 'Key', valueHint = 'Value', canToggle = true } = {}) {
    const table = h('table.kv');
    const isOff = (row) => (flag === 'enabled' ? row.enabled === false : !!row.disabled);
    const setOff = (row, off) => { if (flag === 'enabled') row.enabled = !off; else if (off) row.disabled = true; else delete row.disabled; };

    const addRow = (row, blank) => {
      const tr = h('tr', { class: !blank && isOff(row) ? 'off' : '' });
      const chk = h('input', { type: 'checkbox', checked: blank || !isOff(row), title: 'Enabled', onchange: () => { setOff(row, !chk.checked); tr.className = chk.checked ? '' : 'off'; onChange(); } });
      const key = h('input', { type: 'text', placeholder: keyHint, value: row.key || '' });
      const val = h('input', { type: 'text', placeholder: valueHint, value: row.value == null ? '' : String(row.value) });
      const del = h('button.ghost.x', { text: '×', title: 'Remove', onclick: () => { const i = list.indexOf(row); if (i >= 0) list.splice(i, 1); tr.remove(); onChange(); } });
      const input = () => {
        row.key = key.value; row.value = val.value;
        if (blank) { blank = false; list.push(row); chk.disabled = false; addRow({ key: '', value: '' }, true); }
        onChange();
      };
      key.addEventListener('input', input); val.addEventListener('input', input);
      if (blank) chk.disabled = true;
      tr.append(h('td.chk', {}, canToggle ? chk : ''), h('td', {}, key), h('td', {}, val), h('td.del', {}, del));
      table.append(tr);
    };
    list.forEach((row) => addRow(row, false));
    addRow({ key: '', value: '' }, true);
    return table;
  };

  /* ── editor ────────────────────────────────────────────────────────────── */

  T.renderEditor = function () {
    const it = S.sel;
    if (!S.coll || !it) {
      R.editor.replaceChildren(h('div.idle', { style: 'padding:40px 0' },
        S.coll ? 'Pick a request on the left, or add one.' : 'Import your Postman collection to get started.'));
      return;
    }
    const parents = M.parentsOf(S.coll.data.item, it) || [];
    const name = h('input.ed-name', { value: it.name, oninput: () => { it.name = name.value; T.markDirty(); T.renderTree(); } });
    const crumbs = h('span.crumbs', { text: parents.map((p) => p.name).join(' › ') });
    if (M.isFolder(it)) return renderFolderEditor(it, parents, name, crumbs);

    const req = M.req(it);
    const method = h('select', {
      class: 'm-' + (req.method || 'GET').toUpperCase(),
      onchange: () => { req.method = method.value; method.className = 'm-' + method.value; T.markDirty(); T.renderTree(); }
    }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => h('option', { value: m, text: m, selected: (req.method || 'GET').toUpperCase() === m })));

    const url = h('input.url', {
      value: M.urlRaw(req), placeholder: '{{BaseUrl}}path/to/endpoint', spellcheck: 'false',
      oninput: () => { M.setUrl(req, url.value); T.markDirty(); renderVarWarning(); if (S.tab === 'params') renderTab(); updateTabCounts(); },
      onkeydown: (ev) => { if (ev.key === 'Enter') T.send(); }
    });
    R.url = url;
    const sendBtn = h('button.primary', { text: 'Send', title: 'Send (Ctrl/Cmd+Enter)', onclick: () => T.send() });
    R.sendBtn = sendBtn;

    const mode = h('select', {
      title: 'Where the request is sent from', style: 'padding:2px 6px;font-size:12px',
      onchange: () => { S.mode = mode.value; ls.set('mode', S.mode); tls.style.display = S.mode === 'server' ? '' : 'none'; }
    }, h('option', { value: 'server', text: 'Send via server', selected: S.mode === 'server' }), h('option', { value: 'browser', text: 'Send from my browser', selected: S.mode === 'browser' }));
    const tlsBox = h('input', { type: 'checkbox', checked: S.verifyTls, onchange: () => { S.verifyTls = tlsBox.checked; ls.set('verifyTls', S.verifyTls ? '1' : '0'); } });
    const tls = h('label', { style: S.mode === 'server' ? '' : 'display:none', title: 'Untick for self-signed certificates' }, tlsBox, 'Verify TLS');
    R.varWarn = h('span.warn');
    R.markBar = h('div.markbar');

    R.tabs = h('div.tabs');
    R.tabBody = h('div');
    R.editor.replaceChildren(
      h('div.ed-head', {}, name, crumbs),
      h('div.ed-bar', {}, method, url, sendBtn),
      h('div.ed-sub', {}, mode, tls, R.varWarn),
      R.markBar,
      R.tabs, R.tabBody
    );
    renderVarWarning();
    T.renderMarkBar();
    renderTabs();
    renderTab();
  };

  function renderFolderEditor(it, parents, name, crumbs) {
    R.tabs = h('div.tabs'); R.tabBody = h('div');
    if (!['auth', 'scripts'].includes(S.tab)) S.tab = 'auth';
    R.editor.replaceChildren(
      h('div.ed-head', {}, h('span', { text: '📁' }), name, crumbs),
      h('p.hint', { text: (() => { const t = tally(it.item); return `${t.total} requests — ${t.verified} verified, ${t.failing} not working, ${t.pending} pending. Auth and scripts set here apply to every request inside that doesn't set its own.`; })() }),
      h('div.inline', {},
        h('button', { text: '+ Request here', onclick: () => T.addItem(M.newRequest(), it) }),
        h('button', { text: '+ Folder here', onclick: () => T.addItem(M.newFolder(), it) })),
      R.tabs, R.tabBody
    );
    renderTabs(); renderTab();
  }

  function renderVarWarning() {
    if (!R.varWarn || !S.sel || M.isFolder(S.sel)) return;
    const req = M.req(S.sel);
    const used = new Set([...M.varsIn(M.urlRaw(req)), ...(req.header || []).filter((x) => !x.disabled).flatMap((x) => M.varsIn(x.key + x.value))]);
    const auth = M.effectiveAuth(S.sel, M.parentsOf(S.coll.data.item, S.sel) || [], S.coll.data).auth;
    if (auth && auth.type === 'bearer') M.varsIn(M.bearerToken(auth)).forEach((v) => used.add(v));
    const scopes = T.scopes();
    const missing = [...used].filter((k) => !scopes.some((s) => s.has(k)));
    R.varWarn.replaceChildren();
    if (!missing.length) return;
    R.varWarn.append(`Not defined: ${missing.map((k) => '{{' + k + '}}').join(', ')}`,
      h('button', { text: S.env ? 'Set values' : 'Create environment', onclick: () => T.envDialog(missing) }));
  }
  T.renderVarWarning = renderVarWarning;

  const TABS = {
    params: { label: 'Params', count: (req) => M.query(req).length + M.pathVars(req).length },
    headers: { label: 'Headers', count: (req) => (req.header || []).length },
    auth: { label: 'Auth' },
    body: { label: 'Body', count: (req) => (req.body && req.body.mode && (req.body.raw || (req.body[req.body.mode] || []).length) ? '●' : '') },
    scripts: { label: 'Scripts', count: (req, it) => ((it.event || []).filter((e) => M.script(it, e.listen).trim()).length || '') }
  };

  function renderTabs() {
    const it = S.sel;
    const names = M.isFolder(it) ? ['auth', 'scripts'] : Object.keys(TABS);
    if (!names.includes(S.tab)) S.tab = names[0];
    R.tabs.replaceChildren(...names.map((key) => {
      const t = TABS[key];
      const n = !M.isFolder(it) && t.count ? t.count(M.req(it), it) : '';
      return h('button.tab', { class: S.tab === key ? 'on' : '', 'data-tab': key, onclick: () => { S.tab = key; renderTabs(); renderTab(); } },
        t.label, n ? h('span.n', { text: n }) : '');
    }));
  }

  function updateTabCounts() { renderTabs(); }

  function renderTab() {
    const it = S.sel;
    const req = M.isFolder(it) ? null : M.req(it);
    const changed = () => { T.markDirty(); updateTabCounts(); renderVarWarning(); };
    let body;
    if (S.tab === 'params') {
      const q = M.query(req).map((x) => ({ key: x.key, value: x.value, disabled: x.disabled }));
      body = h('div', {},
        h('div.section-title', { text: 'Query parameters' }),
        T.kvTable(q, { onChange: () => { M.setQuery(req, q); R.url.value = M.urlRaw(req); changed(); } }));
      const vars = M.pathVars(req);
      if (vars.length) {
        body.append(h('div.section-title', { text: 'Path variables' }),
          T.kvTable(vars, { canToggle: false, onChange: changed, keyHint: 'name' }),
          h('p.hint', { text: 'From :name segments in the URL.' }));
      }
    } else if (S.tab === 'headers') {
      req.header = req.header || [];
      body = h('div', {}, T.kvTable(req.header, { onChange: () => { req.header.forEach((x) => { if (!x.type) x.type = 'text'; }); changed(); } }));
    } else if (S.tab === 'auth') {
      body = renderAuth(it, changed);
    } else if (S.tab === 'body') {
      body = renderBody(req, changed);
    } else {
      body = renderScripts(it, changed);
    }
    R.tabBody.replaceChildren(body);
  }

  function renderAuth(it, changed) {
    const target = M.isFolder(it) ? it : M.req(it);
    const parents = M.parentsOf(S.coll.data.item, it) || [];
    const wrap = h('div');
    const draw = () => {
      const type = target.auth ? (target.auth.type === 'noauth' ? 'noauth' : target.auth.type === 'bearer' ? 'bearer' : 'other') : 'inherit';
      const sel = h('select', {
        onchange: () => {
          if (sel.value === 'inherit') delete target.auth;
          else if (sel.value === 'noauth') target.auth = { type: 'noauth' };
          else if (sel.value === 'bearer') target.auth = { type: 'bearer', bearer: [{ key: 'token', value: M.bearerToken(target.auth) || '{{token}}', type: 'string' }] };
          changed(); draw();
        }
      }, [['inherit', 'Inherit from parent'], ['noauth', 'No auth'], ['bearer', 'Bearer token']].concat(type === 'other' ? [['other', target.auth.type + ' (kept as is)']] : [])
        .map(([v, l]) => h('option', { value: v, text: l, selected: v === type })));
      const rows = [h('div.field', {}, h('label', { text: 'Type' }), sel)];
      if (type === 'bearer') {
        const entry = target.auth.bearer.find((x) => x.key === 'token') || (target.auth.bearer.push({ key: 'token', value: '', type: 'string' }), target.auth.bearer[target.auth.bearer.length - 1]);
        const token = h('textarea', { rows: 3, spellcheck: 'false', value: entry.value || '', oninput: () => { entry.value = token.value; changed(); } });
        rows.push(h('div.field', {}, h('label', { text: 'Token' }), token), h('p.hint', { text: 'Tip: use {{token}} and let the login request\'s script set it: pm.environment.set("token", pm.response.json().access_token)' }));
      } else if (type === 'inherit') {
        const inherited = M.isFolder(it)
          ? (parents.slice().reverse().find((p) => p.auth) || (S.coll.data.auth ? { name: 'collection', auth: S.coll.data.auth } : null))
          : null;
        const eff = M.isFolder(it) ? (inherited ? { auth: inherited.auth, from: inherited.name } : { auth: null }) : M.effectiveAuth(it, parents, S.coll.data);
        rows.push(h('p.hint', { text: eff.auth ? `Uses ${eff.auth.type} auth from "${eff.from}".` : 'No auth is set above this, so none is sent.' }));
      } else if (type === 'other') {
        rows.push(h('p.hint', { text: `This ${target.auth.type} auth isn't editable here; it's kept unchanged and not applied when sending.` }));
      }
      wrap.replaceChildren(...rows);
    };
    draw();
    return wrap;
  }

  function renderBody(req, changed) {
    const wrap = h('div');
    const draw = () => {
      const b = req.body;
      const mode = b && b.mode ? b.mode : 'none';
      const pick = h('select', {
        onchange: () => {
          const m = pick.value;
          if (m === 'none') delete req.body;
          else {
            req.body = req.body || {};
            req.body.mode = m;
            if (m === 'raw') { req.body.raw = req.body.raw || ''; req.body.options = req.body.options || { raw: { language: 'json' } }; }
            else req.body[m] = req.body[m] || [];
          }
          changed(); draw();
        }
      }, [['none', 'None'], ['raw', 'Raw'], ['urlencoded', 'x-www-form-urlencoded'], ['formdata', 'form-data']].map(([v, l]) => h('option', { value: v, text: l, selected: v === mode })));
      const head = h('div.inline', { style: 'margin-bottom:8px' }, pick);
      const parts = [head];
      if (mode === 'raw') {
        b.options = b.options || { raw: { language: 'json' } };
        b.options.raw = b.options.raw || { language: 'json' };
        const lang = h('select', { onchange: () => { b.options.raw.language = lang.value; changed(); } },
          [['json', 'JSON'], ['text', 'Text'], ['xml', 'XML']].map(([v, l]) => h('option', { value: v, text: l, selected: (b.options.raw.language || 'json') === v })));
        const area = h('textarea', { rows: 12, spellcheck: 'false', value: b.raw || '', style: 'width:100%', oninput: () => { b.raw = area.value; changed(); } });
        area.addEventListener('keydown', (ev) => {
          if (ev.key === 'Tab') { ev.preventDefault(); const s = area.selectionStart; area.setRangeText('  ', s, area.selectionEnd, 'end'); b.raw = area.value; changed(); }
        });
        const pretty = h('button', {
          text: 'Beautify', onclick: () => {
            // {{vars}} may sit unquoted where a number goes ("id": {{userId}}) — park them as unique
            // strings, format, then put them back exactly as they were.
            const parked = [];
            const src = parkBareVars(area.value, parked);
            try {
              const out = JSON.stringify(JSON.parse(src), null, 2).replace(/"@@tester-var-(\d+)@@"/g, (m, i) => parked[+i]);
              area.value = out; b.raw = out; changed();
            } catch (e) { T.toast('Not valid JSON: ' + e.message, 'error'); }
          }
        });
        head.append(lang, pretty);
        parts.push(area);
      } else if (mode === 'urlencoded' || mode === 'formdata') {
        const list = b[mode] = b[mode] || [];
        const files = list.filter((f) => f.type === 'file');
        const editable = list.filter((f) => f.type !== 'file');
        parts.push(T.kvTable(editable, {
          onChange: () => { b[mode] = files.concat(editable.map((f) => (mode === 'formdata' && !f.type ? Object.assign(f, { type: 'text' }) : f))); changed(); }
        }));
        if (files.length) parts.push(h('p.hint', { text: `${files.length} file field(s) (${files.map((f) => f.key).join(', ')}) are kept in the collection but can't be sent from here.` }));
      } else {
        parts.push(h('p.hint', { text: 'This request sends no body.' }));
      }
      wrap.replaceChildren(...parts);
    };
    draw();
    return wrap;
  }

  /** Swap {{vars}} that stand outside JSON strings for placeholder strings; ones inside strings are fine as is. */
  function parkBareVars(text, parked) {
    let out = '', inString = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        out += c;
        if (c === '\\') out += text[++i] || '';
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; out += c; continue; }
      if (c === '{' && text[i + 1] === '{') {
        const end = text.indexOf('}}', i + 2);
        if (end > 0) { parked.push(text.slice(i, end + 2)); out += `"@@tester-var-${parked.length - 1}@@"`; i = end + 1; continue; }
      }
      out += c;
    }
    return out;
  }

  function renderScripts(it, changed) {
    const box = (listen, title, hint) => {
      const area = h('textarea', { rows: 7, spellcheck: 'false', style: 'width:100%', value: M.script(it, listen), placeholder: hint, oninput: () => { M.setScript(it, listen, area.value); changed(); } });
      return [h('div.section-title', { text: title }), area];
    };
    return h('div', {},
      box('prerequest', 'Pre-request script', '// runs before the request is sent\npm.environment.set("ts", Date.now())'),
      box('test', 'Post-response script', '// runs after the response arrives\nconst body = pm.response.json();\npm.environment.set("token", body.access_token);\npm.test("status 200", () => pm.response.to.have.status(200));'),
      h('p.hint', { text: 'Supported: pm.environment / pm.collectionVariables / pm.variables (get, set, unset), pm.request.headers, pm.response (code, json(), text(), headers.get), pm.test, pm.expect, console.log.' }));
  }

  document.addEventListener('DOMContentLoaded', () => T.boot());
})();
