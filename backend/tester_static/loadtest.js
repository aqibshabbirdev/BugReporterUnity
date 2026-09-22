/* API tester — load and stress testing: many virtual users hitting one request or a whole folder. */
(function () {
  'use strict';

  const { h, S } = T;

  const MAX_USERS = 300;           // the browser, not the API, is the limit past this
  const MAX_SECONDS = 1800;
  const SAMPLE_CAP = 60000;        // per endpoint, so a long soak test can't eat the tab's memory

  const now = () => performance.now();
  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))] : 0);
  const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms');

  /* ── sending ───────────────────────────────────────────────────────────── */

  /** One send, outside the normal request pane: no stored result, no marks, no re-render. */
  async function sendOnce(it, coll, scopes) {
    const parents = M.parentsOf(coll.item, it) || [];
    const env = scopes[1], collVars = scopes[2], local = scopes[0];
    const started = now();
    try {
      const template = M.build(it, parents, coll);
      for (const s of M.scriptsFor(it, parents, coll, 'prerequest')) {
        M.runScript(s.code, { env, coll: collVars, local, request: template, name: it.name });
      }
      const missing = new Set();
      const final = M.finalize(template, scopes, missing);
      if (missing.size) return { ok: false, ms: 0, error: 'missing ' + [...missing].map((k) => '{{' + k + '}}').join(', ') };

      const res = await T.api('POST', '/api/tester/send', Object.assign({}, final, { verifyTls: S.verifyTls }));
      const took = now() - started;
      for (const s of M.scriptsFor(it, parents, coll, 'test')) {
        M.runScript(s.code, { env, coll: collVars, local, response: res, name: it.name });
      }
      let bodyFailed = false;
      if (res.status >= 200 && res.status < 300) {
        try { const j = JSON.parse(res.body); bodyFailed = !!j && (j.status === false || j.success === false); } catch (e) { /* not JSON */ }
      }
      return { ok: res.status >= 200 && res.status < 400 && !bodyFailed, ms: took, status: res.status, bodyFailed };
    } catch (e) {
      return { ok: false, ms: now() - started, error: (e && e.message) || String(e), status: e && e.status };
    }
  }

  /* ── stats ─────────────────────────────────────────────────────────────── */

  function newStats() {
    return { sent: 0, ok: 0, fail: 0, samples: [], byName: new Map(), byOutcome: new Map(), seconds: new Map(), first: 0, last: 0 };
  }
  function record(st, name, r, startedAt) {
    st.sent++; r.ok ? st.ok++ : st.fail++;
    if (st.samples.length < SAMPLE_CAP) st.samples.push(r.ms);
    let e = st.byName.get(name);
    if (!e) st.byName.set(name, (e = { name, sent: 0, ok: 0, fail: 0, samples: [], max: 0 }));
    e.sent++; r.ok ? e.ok++ : e.fail++;
    if (e.samples.length < SAMPLE_CAP) e.samples.push(r.ms);
    if (r.ms > e.max) e.max = r.ms;
    const key = r.error ? 'error: ' + String(r.error).slice(0, 60) : r.bodyFailed ? `HTTP ${r.status} but body says failed` : 'HTTP ' + r.status;
    st.byOutcome.set(key, (st.byOutcome.get(key) || 0) + 1);
    const sec = Math.floor(startedAt / 1000);
    let bucket = st.seconds.get(sec);
    if (!bucket) st.seconds.set(sec, (bucket = { n: 0, fail: 0, total: 0, max: 0 }));
    bucket.n++; if (!r.ok) bucket.fail++; bucket.total += r.ms; if (r.ms > bucket.max) bucket.max = r.ms;
  }
  const summary = (list) => {
    const s = [...list].sort((a, b) => a - b);
    return { n: s.length, avg: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0, p50: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), p99: pct(s, 99), min: s[0] || 0, max: s[s.length - 1] || 0 };
  };

  /* ── chart ─────────────────────────────────────────────────────────────── */

  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    kids.forEach((k) => el.append(k.nodeType ? k : document.createTextNode(String(k))));
    return el;
  };

  /** Requests per second as bars (red where requests failed), with the slowest response of each second as a line. */
  function chart(st) {
    const secs = [...st.seconds.entries()].sort((a, b) => a[0] - b[0]).slice(-120);
    const W = 720, H = 170, padL = 44, padR = 46, top = 10, bottom = 22;
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'lt-chart', role: 'img', 'aria-label': 'Requests per second and slowest response per second' });
    if (!secs.length) return g;
    const maxRps = Math.max(1, ...secs.map(([, b]) => b.n));
    const maxMs = Math.max(1, ...secs.map(([, b]) => b.max));
    const t0 = secs[0][0];
    const bw = Math.max(1, (W - padL - padR) / secs.length);
    const y1 = (v) => H - bottom - (v / maxRps) * (H - top - bottom);
    const y2 = (v) => H - bottom - (v / maxMs) * (H - top - bottom);
    [0, 0.5, 1].forEach((f) => {
      const y = H - bottom - f * (H - top - bottom);
      g.append(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'lt-grid' }));
      g.append(svg('text', { x: padL - 6, y: y + 4, class: 'lt-axis', 'text-anchor': 'end' }, Math.round(maxRps * f)));
      g.append(svg('text', { x: W - padR + 6, y: y + 4, class: 'lt-axis lt-axis2' }, Math.round(maxMs * f) + 'ms'));
    });
    secs.forEach(([sec, b], i) => {
      const x = padL + i * bw;
      g.append(svg('rect', { x: x + 0.5, y: y1(b.n), width: Math.max(1, bw - 1), height: Math.max(1, H - bottom - y1(b.n)), class: 'lt-bar' }));
      if (b.fail) g.append(svg('rect', { x: x + 0.5, y: y1(b.fail), width: Math.max(1, bw - 1), height: Math.max(1, H - bottom - y1(b.fail)), class: 'lt-bar-fail' }));
    });
    g.append(svg('polyline', { points: secs.map(([, b], i) => `${padL + i * bw + bw / 2},${y2(b.max)}`).join(' '), class: 'lt-line', fill: 'none' }));
    g.append(svg('text', { x: padL, y: H - 6, class: 'lt-axis' }, '0s'));
    g.append(svg('text', { x: W - padR, y: H - 6, class: 'lt-axis', 'text-anchor': 'end' }, (secs[secs.length - 1][0] - t0 + 1) + 's'));
    return g;
  }

  /* ── dialog ────────────────────────────────────────────────────────────── */

  /** Load test for one request, or for a folder/flow (one virtual user = one pass through it, in order). */
  T.loadDialog = function (target) {
    if (!S.coll || !target) return;
    const items = [];
    if (M.isFolder(target)) M.walk(target.item, (it) => { if (!M.isFolder(it)) items.push(it); });
    else items.push(target);
    if (!items.length) return T.toast('Nothing to load test in here', 'error');

    const cfg = {
      users: Number(T.ls.get('lt.users', 10)) || 10,
      seconds: Number(T.ls.get('lt.seconds', 30)) || 30,
      ramp: Number(T.ls.get('lt.ramp', 5)) || 0,
      think: Number(T.ls.get('lt.think', 0)) || 0,
      stopAt: Number(T.ls.get('lt.stopAt', 0)) || 0        // % failures that aborts the run; 0 = never
    };
    let phase = 'setup', stop = false, stopped = '';
    let st = newStats(), t0 = 0, live = 0, timer = null;

    const body = h('div.lt');
    const num = (key, label, min, max, hint) => {
      const input = h('input', { type: 'number', min, max, value: cfg[key], id: 'lt-' + key, oninput: () => { cfg[key] = Math.max(min, Math.min(max, Number(input.value) || 0)); T.ls.set('lt.' + key, cfg[key]); } });
      return h('label.lt-field', { for: 'lt-' + key }, h('span', { text: label }), input, h('span.hint', { text: hint }));
    };

    const startBtn = h('button.primary', { text: '⚡ Start load test' });
    const stopBtn = h('button', { text: 'Stop', hidden: true });

    function draw() {
      const elapsed = t0 ? (now() - t0) / 1000 : 0;
      const all = summary(st.samples);
      const rate = elapsed > 0 ? st.sent / elapsed : 0;
      const head = phase === 'setup'
        ? h('div.lt-setup', {},
          h('p.lt-warn', {}, h('b', { text: '⚠ This sends real traffic. ' }),
            `${items.length === 1 ? 'This request' : items.length + ' requests, in order,'} will be sent over and over — on a live server that means real sessions, real coins and real SMS.`),
          h('div.lt-fields', {},
            num('users', 'Users at the same time', 1, MAX_USERS, `1–${MAX_USERS}`),
            num('seconds', 'For how long (seconds)', 1, MAX_SECONDS, 'the test stops by itself'),
            num('ramp', 'Ramp up over (seconds)', 0, 600, 'users join gradually'),
            num('think', 'Wait between requests (ms)', 0, 60000, 'per user'),
            num('stopAt', 'Stop if failures pass (%)', 0, 100, '0 = never stop')),
          h('p.hint', { text: items.length === 1 ? `Every user sends: ${items[0].name}` : `Every user walks through: ${items.slice(0, 6).map((x) => x.name).join(' → ')}${items.length > 6 ? ' → …' : ''}` }),
          h('p.hint', { text: 'Requests go out through this page, so keep the tab open. Scripts still run, so logins and saved variables work as usual.' }))
        : h('div.lt-live', {},
          h('div.lt-tiles', {},
            tile('Sent', st.sent),
            tile('Worked', st.ok, 'ok'),
            tile('Failed', st.fail, st.fail ? 'bad' : ''),
            tile('Requests / sec', rate.toFixed(1)),
            tile('Average', ms(all.avg)),
            tile('95% under', ms(all.p95)),
            tile('Slowest', ms(all.max)),
            tile('Users now', live)),
          h('div.lt-progress', {}, h('span', { style: `width:${Math.min(100, (elapsed / cfg.seconds) * 100)}%` })),
          h('div.lt-status', {}, h('b', { text: phase === 'done' ? (stopped || 'Finished') : `Running — ${Math.round(elapsed)}s of ${cfg.seconds}s` }),
            h('span.faint', { text: `  ${cfg.users} users · ${items.length === 1 ? items[0].name : items.length + ' requests per pass'}` })),
          chart(st),
          h('div.lt-legend', {}, h('span.lt-k1', { text: '▉ requests per second' }), h('span.lt-k2', { text: '▉ failed' }), h('span.lt-k3', { text: '— slowest response that second' })));

      const rows = [...st.byName.values()].sort((a, b) => b.sent - a.sent).map((e) => {
        const s = summary(e.samples);
        return h('tr', { class: e.fail ? 'bad-row' : '' },
          h('td', { text: e.name }), h('td.n', { text: e.sent }), h('td.n', { text: e.ok }),
          h('td.n', { class: e.fail ? 'bad' : '', text: e.fail }),
          h('td.n', { text: ms(s.avg) }), h('td.n', { text: ms(s.p95) }), h('td.n', { text: ms(e.max) }));
      });
      const table = st.byName.size ? h('table.lt-table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Request' }), h('th.n', { text: 'Sent' }), h('th.n', { text: 'Worked' }), h('th.n', { text: 'Failed' }), h('th.n', { text: 'Average' }), h('th.n', { text: '95%' }), h('th.n', { text: 'Slowest' }))),
        h('tbody', {}, rows)) : '';
      const outcomes = st.byOutcome.size ? h('div.lt-outcomes', {}, [...st.byOutcome.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([k, n]) => h('span.lt-chip', { class: /HTTP 2|HTTP 3/.test(k) ? 'ok' : 'bad', text: `${k} · ${n}` }))) : '';

      body.replaceChildren(head, table, outcomes);
      startBtn.hidden = phase !== 'setup';
      stopBtn.hidden = phase !== 'running';
    }
    const tile = (label, value, kind) => h('div.lt-tile', { class: kind || '' }, h('span.n', { text: String(value) }), h('span.k', { text: label }));

    const close = T.modal(`Load test: ${target.name}`, body, [{ label: 'Close', run: (c) => c() }], () => { stop = true; clearInterval(timer); });
    document.querySelector('#overlay .modal').classList.add('wide');
    const footer = document.querySelector('#overlay .modal footer');
    const copyBtn = h('button', { text: 'Copy report', hidden: true, onclick: () => copyReport() });
    footer.prepend(stopBtn, startBtn, copyBtn);
    stopBtn.onclick = () => { stop = true; stopped = 'Stopped'; stopBtn.disabled = true; };

    function copyReport() {
      const all = summary(st.samples);
      const secs = (st.last - st.first) / 1000 || 1;
      const lines = [
        `Load test — ${target.name}`,
        `${cfg.users} users · ${Math.round(secs)}s · ramp ${cfg.ramp}s · think ${cfg.think}ms`,
        `Sent ${st.sent} · worked ${st.ok} · failed ${st.fail} (${st.sent ? ((st.fail / st.sent) * 100).toFixed(1) : 0}%) · ${(st.sent / secs).toFixed(1)} req/s`,
        `Average ${ms(all.avg)} · p50 ${ms(all.p50)} · p90 ${ms(all.p90)} · p95 ${ms(all.p95)} · p99 ${ms(all.p99)} · slowest ${ms(all.max)}`,
        '',
        'Request\tSent\tWorked\tFailed\tAverage\tp95\tSlowest',
        ...[...st.byName.values()].sort((a, b) => b.sent - a.sent).map((e) => {
          const s = summary(e.samples);
          return `${e.name}\t${e.sent}\t${e.ok}\t${e.fail}\t${Math.round(s.avg)}ms\t${Math.round(s.p95)}ms\t${Math.round(e.max)}ms`;
        }),
        '',
        'Outcomes:',
        ...[...st.byOutcome.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} · ${n}`)
      ].join('\n');
      navigator.clipboard.writeText(lines).then(() => T.toast('Report copied'), () => T.toast('Could not copy', 'error'));
    }

    startBtn.onclick = async () => {
      if (S.sending) return T.toast('A request is still sending — wait a moment', 'error');
      phase = 'running'; stop = false; stopped = ''; st = newStats(); t0 = now(); live = 0;
      S.sending = true;
      draw();
      timer = setInterval(draw, 1000);
      const scopes = T.scopes();
      const endAt = t0 + cfg.seconds * 1000;

      const user = async (n) => {
        if (cfg.ramp > 0) await new Promise((r) => setTimeout(r, (cfg.ramp * 1000) * (n / cfg.users)));
        if (stop || now() >= endAt) return;
        live++;
        try {
          while (!stop && now() < endAt) {
            for (const it of items) {
              if (stop || now() >= endAt) break;
              const at = now() - t0;
              const r = await sendOnce(it, S.coll.data, scopes);
              if (!st.first) st.first = now();
              st.last = now();
              record(st, it.name, r, at);
              if (cfg.stopAt && st.sent >= 20 && (st.fail / st.sent) * 100 >= cfg.stopAt) {
                stop = true; stopped = `Stopped — more than ${cfg.stopAt}% of requests failed`;
              }
              if (cfg.think && !stop) await new Promise((r2) => setTimeout(r2, cfg.think));
            }
          }
        } finally { live--; }
      };

      try {
        await Promise.all(Array.from({ length: cfg.users }, (_, i) => user(i)));
      } finally {
        clearInterval(timer);
        S.sending = false;
        phase = 'done';
        if (!stopped) stopped = 'Finished';
        copyBtn.hidden = false;
        draw();
        if (S.envDirty) T.saveEnv(true);
      }
    };

    draw();
  };
})();
