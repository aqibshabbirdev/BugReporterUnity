/* API tester — security scan: checks a team's own APIs for common weaknesses (defensive QA). */
(function () {
  'use strict';

  const { h, S } = T;

  // Response-header names an API should carry, and what a missing one means.
  const WANT_HEADERS = [
    { key: 'strict-transport-security', label: 'Strict-Transport-Security (HSTS)', why: 'browsers may fall back to http', httpsOnly: true, sev: 'low' },
    { key: 'x-content-type-options', label: 'X-Content-Type-Options: nosniff', why: 'the response type can be guessed by the browser', sev: 'low' }
  ];
  // Headers that quietly disclose the server or framework version.
  const REVEAL_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator'];
  // Response fields whose name means a secret — these should never be returned to a client.
  const SECRET_KEYS = /^(password|pass|pwd|pw_hash|password_hash|hash|secret|client_secret|private_key|api_key|apikey|otp|reset_token|salt)$/i;
  // Signatures a database/framework prints when an input broke a query — an unhandled-input tell.
  const DB_ERROR = /(SQL syntax|SQLSTATE|mysqli?|pg_query|psql|ORA-\d|ODBC|SQLite|syntax error at or near|Unclosed quotation|QueryException|Sequelize|MongoError|unterminated|stack trace|Traceback \(most recent|at [\w.$]+\([\w./]+:\d+\))/i;

  const now = () => performance.now();

  /* ── sending (outside the request pane) ────────────────────────────────── */

  function baseTemplate(it, coll) {
    const parents = M.parentsOf(coll.item, it) || [];
    const env = T.envStore(), collVars = T.collStore(), local = T.localStore();
    const template = M.build(it, parents, coll);
    for (const s of M.scriptsFor(it, parents, coll, 'prerequest')) {
      try { M.runScript(s.code, { env, coll: collVars, local, request: template, name: it.name }); } catch (e) { /* pre-request best effort */ }
    }
    return template;
  }

  /** Send a built template, optionally after a transform (strip auth, tweak a field). Returns the raw response. */
  async function send(template, transform) {
    const scopes = T.scopes();
    const missing = new Set();
    const t = M.clone(template);
    if (transform) transform(t);
    const final = M.finalize(t, scopes, missing);
    if (missing.size) return { skipped: 'missing ' + [...missing].map((k) => '{{' + k + '}}').join(', ') };
    try {
      const res = await T.api('POST', '/api/tester/send', Object.assign({}, final, { verifyTls: S.verifyTls }));
      return { res, final };
    } catch (e) {
      return { error: (e && e.message) || String(e), status: e && e.status };
    }
  }

  const bodyJson = (res) => { try { return JSON.parse(res.body); } catch (e) { return null; } };
  const headerOf = (res, name) => { const x = (res.headers || []).find(([k]) => k.toLowerCase() === name); return x ? x[1] : null; };
  const looksAuthError = (res) => {
    if (res.status === 401 || res.status === 403) return true;
    const j = bodyJson(res);
    const msg = (j && (j.message || j.error) ? String(j.message || j.error) : res.body || '').toLowerCase();
    return /unauth|forbidden|not allowed|invalid token|no token|token .*(missing|required|expired)|login required|permission/.test(msg);
  };
  const hasData = (res) => {
    if (res.status < 200 || res.status >= 300) return false;
    const j = bodyJson(res);
    if (j && typeof j === 'object') {
      if (j.status === false || j.success === false) return false;
      const keys = Object.keys(j).filter((k) => !/^(status|message|success|code)$/i.test(k));
      return keys.length > 0;
    }
    return (res.body || '').length > 2;
  };

  /* ── the checks ────────────────────────────────────────────────────────── */

  // Each finding: {sev, title, detail, fix}. sev: high | medium | low | info.
  function inspectResponse(res, final, it) {
    const found = [];
    const url = final.url || '';
    const isHttps = /^https:/i.test(url);

    if (!isHttps && /^http:/i.test(url)) {
      found.push({ sev: 'high', title: 'Sent over plain HTTP', detail: url.slice(0, 90), fix: 'Serve this API only over HTTPS; redirect http → https.' });
    }
    // Secrets echoed back in the body.
    const j = bodyJson(res);
    if (j) {
      const hits = [];
      const walk = (v, path, depth) => {
        if (hits.length > 6 || depth > 6 || !v || typeof v !== 'object') return;
        for (const [k, val] of Object.entries(v)) {
          if (SECRET_KEYS.test(k) && val != null && val !== '' && String(val).toLowerCase() !== 'null') hits.push((path ? path + '.' : '') + k);
          if (val && typeof val === 'object') walk(val, (path ? path + '.' : '') + k, depth + 1);
        }
      };
      walk(j, '', 0);
      if (hits.length) found.push({ sev: 'high', title: 'Secret-looking field in the response', detail: hits.slice(0, 6).join(', '), fix: 'Never return password hashes, OTPs, reset tokens or secrets to the client — drop these from the API response.' });
    }
    // Verbose server error.
    if (res.status >= 500 && DB_ERROR.test(res.body || '')) {
      found.push({ sev: 'medium', title: 'Server error leaks internals', detail: `HTTP ${res.status} — ${(res.body || '').replace(/\s+/g, ' ').slice(0, 120)}`, fix: 'Return a generic error to clients; log the detail server-side only.' });
    }
    // Missing hardening headers.
    for (const w of WANT_HEADERS) {
      if (w.httpsOnly && !isHttps) continue;
      if (!headerOf(res, w.key)) found.push({ sev: w.sev, title: 'Missing header — ' + w.label, detail: w.why, fix: `Add "${w.label}" to API responses.` });
    }
    // Version disclosure.
    for (const rk of REVEAL_HEADERS) {
      const v = headerOf(res, rk);
      if (v && /\d/.test(v)) { found.push({ sev: 'low', title: 'Server version disclosed', detail: `${rk}: ${v}`.slice(0, 90), fix: 'Hide version numbers from response headers.' }); break; }
    }
    // Wide-open CORS.
    const acao = headerOf(res, 'access-control-allow-origin');
    const acc = headerOf(res, 'access-control-allow-credentials');
    if (acao === '*' && acc && /true/i.test(acc)) {
      found.push({ sev: 'high', title: 'CORS allows any site with credentials', detail: 'Access-Control-Allow-Origin: * with Allow-Credentials: true', fix: 'List the exact allowed origins instead of "*" when credentials are allowed.' });
    } else if (acao === '*') {
      found.push({ sev: 'info', title: 'CORS open to any site', detail: 'Access-Control-Allow-Origin: *', fix: 'Fine for public reads; restrict it for anything user-specific.' });
    }
    return found;
  }

  /** Was this request sending a token? (so "works without it" is meaningful) */
  function sendsAuth(final) {
    return (final.headers || []).some(([k, v]) => k.toLowerCase() === 'authorization' && v) ||
      (final.headers || []).some(([k, v]) => /token|apikey|api-key|gameplaytoken/i.test(k) && v);
  }
  function stripAuth(t) {
    t.headers = (t.headers || []).filter(([k]) => !/^(authorization|token|apikey|api-key|gameplaytoken)$/i.test(k));
    if (t.auth) t.auth = { type: 'noauth' };
  }

  /* ── scan one request ──────────────────────────────────────────────────── */

  async function scanOne(it, coll, opts) {
    const template = baseTemplate(it, coll);
    const base = await send(template);
    if (base.skipped) return { name: it.name, skipped: base.skipped, findings: [] };
    if (base.error) return { name: it.name, error: base.error, findings: [] };
    const res = base.res, final = base.final;
    const findings = inspectResponse(res, final, it);

    // Missing auth: re-send with the token removed; a working data response means the check is absent.
    if (opts.noauth && sendsAuth(final) && res.status >= 200 && res.status < 300) {
      const naked = await send(template, stripAuth);
      if (naked.res && !looksAuthError(naked.res) && hasData(naked.res)) {
        findings.push({ sev: 'high', title: 'Works without a token', detail: `Sent again with no Authorization → HTTP ${naked.res.status} with data.`, fix: 'Require and verify the token on this endpoint; reject requests without a valid one.' });
      }
    }

    // Input handling: append one harmless canary to a string field/param; a 500 or DB error means input
    // reaches the query unchecked. This is passive detection — the canary is inert, not an exploit.
    if (opts.input) {
      const probed = await send(template, (t) => {
        const CANARY = "zz'\"";
        if (t.body && t.body.mode === 'raw' && /"/.test(t.body.raw)) {
          t.body = Object.assign({}, t.body, { raw: t.body.raw.replace(/("[^"]*)"/, '$1' + CANARY + '"') });
        } else if (t.body && t.body.fields && t.body.fields.length) {
          t.body = Object.assign({}, t.body, { fields: t.body.fields.map(([k, v], i) => (i === 0 ? [k, (v || '') + CANARY] : [k, v])) });
        } else {
          t.url = t.url + (t.url.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(CANARY);
        }
      });
      if (probed.res && probed.res.status >= 500 && DB_ERROR.test(probed.res.body || '') && !(res.status >= 500)) {
        findings.push({ sev: 'high', title: 'Unusual input breaks the server', detail: `A test string caused HTTP ${probed.res.status} — ${(probed.res.body || '').replace(/\s+/g, ' ').slice(0, 100)}`, fix: 'Validate and parameterise inputs so a stray character cannot reach the database or crash the handler.' });
      }
    }
    return { name: it.name, status: res.status, findings };
  }

  /* ── dialog ────────────────────────────────────────────────────────────── */

  const SEV = { high: { label: 'High', rank: 3 }, medium: { label: 'Medium', rank: 2 }, low: { label: 'Low', rank: 1 }, info: { label: 'Info', rank: 0 } };

  T.securityDialog = function (target) {
    if (!S.coll || !target) return;
    const items = [];
    if (M.isFolder(target)) M.walk(target.item, (it) => { if (!M.isFolder(it)) items.push(it); });
    else items.push(target);
    if (!items.length) return T.toast('Nothing to scan in here', 'error');

    let phase = 'setup', stop = false;
    const opts = { noauth: true, input: false };
    const results = [];
    let done = 0;

    const body = h('div.sec');
    const startBtn = h('button.primary', { text: '🛡 Start scan' });
    const stopBtn = h('button', { text: 'Stop', hidden: true });
    const copyBtn = h('button', { text: 'Copy report', hidden: true, onclick: copyReport });

    const toggle = (key, label, hint) => {
      const box = h('input', { type: 'checkbox', id: 'sec-' + key, checked: opts[key], onchange: () => { opts[key] = box.checked; } });
      return h('label.sec-opt', { for: 'sec-' + key }, box, h('span', {}, h('b', { text: label }), h('span.hint', { text: hint })));
    };

    function counts() {
      const c = { high: 0, medium: 0, low: 0, info: 0 };
      results.forEach((r) => r.findings.forEach((f) => { c[f.sev]++; }));
      return c;
    }

    function draw() {
      const c = counts();
      const head = phase === 'setup'
        ? h('div.sec-setup', {},
          h('p.lt-warn', {}, h('b', { text: '⚠ This sends real requests to your API. ' }), `${items.length} request${items.length === 1 ? '' : 's'} will be checked; on a live server that means real calls.`),
          h('p.hint', { text: 'It reads each endpoint’s own response and its headers, and can re-send a request in two extra ways:' }),
          h('div.sec-opts', {},
            toggle('noauth', 'Retry without the token', 'catches endpoints that return data with no valid login (broken access control).'),
            toggle('input', 'Send one harmless test string', 'catches inputs that crash the server or reach the database unchecked. Sends one extra request per endpoint.')),
          h('p.hint', { text: 'Everything here is defensive: it flags weaknesses so they can be fixed. The test string is inert — it is not an exploit.' }))
        : h('div.sec-live', {},
          h('div.sec-scoreline', {},
            h('span.sec-score.high', { text: `${c.high} high` }), h('span.sec-score.medium', { text: `${c.medium} medium` }),
            h('span.sec-score.low', { text: `${c.low} low` }), h('span.sec-score.info', { text: `${c.info} info` }),
            h('span.faint', { text: `  · ${done} of ${items.length} checked` })),
          h('div.lt-progress', {}, h('span', { style: `width:${Math.round(done / items.length * 100)}%` })),
          phase === 'done' && !Object.values(c).some(Boolean) ? h('p.sec-clean', { text: '✓ No issues found in what could be checked.' }) : '');

      // findings grouped by severity, then endpoint
      const flat = [];
      results.forEach((r) => r.findings.forEach((f) => flat.push(Object.assign({ endpoint: r.name }, f))));
      flat.sort((a, b) => SEV[b.sev].rank - SEV[a.sev].rank);
      const list = h('div.sec-findings', {}, flat.length ? flat.map((f) => h('div.sec-find', { class: 's-' + f.sev },
        h('div.sec-find-head', {}, h('span.sec-badge', { class: f.sev, text: SEV[f.sev].label }), h('b', { text: f.title }), h('span.faint.sec-ep', { text: f.endpoint })),
        h('div.sec-find-detail', { text: f.detail }),
        h('div.sec-find-fix', {}, h('b', { text: 'Fix: ' }), f.fix))) : (phase === 'done' ? '' : h('p.hint', { text: 'Running…' })));

      const skipped = results.filter((r) => r.skipped || r.error);
      const note = phase === 'done' && skipped.length
        ? h('p.hint', { text: `${skipped.length} not checked (missing variables or send error): ${skipped.slice(0, 4).map((r) => r.name).join(', ')}${skipped.length > 4 ? '…' : ''}` }) : '';

      body.replaceChildren(head, list, note);
      startBtn.hidden = phase !== 'setup';
      stopBtn.hidden = phase !== 'running';
      copyBtn.hidden = phase !== 'done';
    }

    function copyReport() {
      const c = counts();
      const flat = [];
      results.forEach((r) => r.findings.forEach((f) => flat.push(Object.assign({ endpoint: r.name }, f))));
      flat.sort((a, b) => SEV[b.sev].rank - SEV[a.sev].rank);
      const lines = [
        `Security scan — ${target.name}`,
        `${items.length} endpoints · ${c.high} high · ${c.medium} medium · ${c.low} low · ${c.info} info`,
        `Checks: response + headers${opts.noauth ? ' · retry without token' : ''}${opts.input ? ' · test string' : ''}`,
        ''
      ];
      flat.forEach((f) => lines.push(`[${SEV[f.sev].label}] ${f.endpoint} — ${f.title}\n    ${f.detail}\n    Fix: ${f.fix}`));
      if (!flat.length) lines.push('No issues found in what could be checked.');
      navigator.clipboard.writeText(lines.join('\n')).then(() => T.toast('Report copied'), () => T.toast('Could not copy', 'error'));
    }

    const close = T.modal(`Security scan: ${target.name}`, body, [{ label: 'Close', run: (c) => c() }], () => { stop = true; });
    document.querySelector('#overlay .modal').classList.add('wide');
    const footer = document.querySelector('#overlay .modal footer');
    footer.prepend(stopBtn, startBtn, copyBtn);
    stopBtn.onclick = () => { stop = true; stopBtn.disabled = true; };

    startBtn.onclick = async () => {
      if (S.sending) return T.toast('A request is still sending — wait a moment', 'error');
      phase = 'running'; stop = false; results.length = 0; done = 0;
      S.sending = true; draw();
      try {
        for (const it of items) {
          if (stop) break;
          const r = await scanOne(it, S.coll.data, opts);
          results.push(r); done++;
          draw();
        }
      } finally {
        S.sending = false;
        phase = 'done';
        draw();
        if (S.envDirty) T.saveEnv(true);
      }
    };
    draw();
  };
})();
