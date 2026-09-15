import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'

// Reads the logs.txt a report carries and shows it one entry at a time: each log line (plus its stack trace)
// is its own card with a copy button, API calls get a method/URL/status header, and JSON inside a message is
// pretty-printed. Input is untrusted text — everything renders through React (auto-escaped), never innerHTML.

// ── Unity rich text ──────────────────────────────────────────────────────────
// Game logs arrive with Unity's console markup (<color=…>, <b>, <i>, <u>, <size=…>). We render it as real
// styling instead of raw tags; tags only ever become inline style, never markup.
const UNITY_COLORS: Record<string, string> = {
  red: '#f85149', green: '#3fb950', lime: '#7ee787', blue: '#4493f8', navy: '#4493f8',
  cyan: '#39c5cf', aqua: '#39c5cf', teal: '#39c5cf', yellow: '#e3b341', orange: '#f0883e',
  magenta: '#f778ba', fuchsia: '#f778ba', purple: '#bc8cff', white: '#e6edf3', silver: '#c9d1d9',
  grey: '#8b949e', gray: '#8b949e', black: '#6e7681', maroon: '#f85149', olive: '#d29922', brown: '#d29922',
}
function resolveColor(raw: string): string | undefined {
  const c = raw.trim().replace(/^["']|["']$/g, '')
  if (!c) return undefined
  return c[0] === '#' ? c : (UNITY_COLORS[c.toLowerCase()] ?? c)
}

interface Seg { text: string; bold: boolean; italic: boolean; underline: boolean; color?: string }
const RICH_RE = /<(\/?)(b|i|u|color|size)(?:=([^>]*))?>/gi
function parseRich(line: string): Seg[] {
  const segs: Seg[] = []
  let bold = 0, italic = 0, underline = 0
  const colors: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  RICH_RE.lastIndex = 0
  const push = (t: string) => {
    if (t) segs.push({ text: t, bold: bold > 0, italic: italic > 0, underline: underline > 0, color: colors[colors.length - 1] || undefined })
  }
  while ((m = RICH_RE.exec(line))) {
    push(line.slice(last, m.index))
    last = RICH_RE.lastIndex
    const close = m[1] === '/'
    switch (m[2].toLowerCase()) {
      case 'b': bold = Math.max(0, bold + (close ? -1 : 1)); break
      case 'i': italic = Math.max(0, italic + (close ? -1 : 1)); break
      case 'u': underline = Math.max(0, underline + (close ? -1 : 1)); break
      case 'color': if (close) colors.pop(); else colors.push(resolveColor(m[3] ?? '') ?? ''); break
      // <size=…> is consumed (so the tag doesn't show) but we don't scale log text
    }
  }
  push(line.slice(last))
  return segs
}
const stripRich = (s: string) => s.replace(RICH_RE, '')

function highlight(text: string, needle: string): React.ReactNode[] {
  if (!needle) return [text]
  const out: React.ReactNode[] = []
  const lower = text.toLowerCase()
  let i = 0, k = 0, idx: number
  while ((idx = lower.indexOf(needle, i)) !== -1) {
    if (idx > i) out.push(text.slice(i, idx))
    out.push(<mark key={k++}>{text.slice(idx, idx + needle.length)}</mark>)
    i = idx + needle.length
  }
  out.push(text.slice(i))
  return out
}

function RichText({ text, needle }: { text: string; needle: string }) {
  return (
    <>
      {parseRich(text).map((s, i) => (
        <span key={i} style={{
          fontWeight: s.bold ? 700 : undefined,
          fontStyle: s.italic ? 'italic' : undefined,
          textDecoration: s.underline ? 'underline' : undefined,
          color: s.color,
        }}>{highlight(s.text, needle)}</span>
      ))}
    </>
  )
}

// ── parsing ──────────────────────────────────────────────────────────────────

type Level = 'log' | 'warn' | 'error'
interface Api { method: string; url: string; status: string; ms: string; ok: boolean }
interface Entry {
  n: number
  time: string
  levelRaw: string
  level: Level
  message: string        // first line, without time/level
  more: string           // continuation lines (stack trace, multi-line message)
  raw: string            // exactly as in the file, for copying
  api?: Api
  json?: { before: string; value: unknown; after: string }
  url?: string
  response?: Entry       // an "After Response::{…}" entry paired with this API call
  pairedTo?: number      // on a response entry: the API call it belongs to
}

// Flutter SDK: "17:54:22 [Log] message" · Unity SDK: "[Error] message\nstack…" (no time).
const START_RE = /^(?:(\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?)\s+)?\[(Log|Info|Debug|Verbose|Warning|Warn|Error|Exception|Assert|Fatal|Severe)\]\s?(.*)$/i
const API_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/\S+)(?:\s+(\S+))?(?:\s+(\d+)\s*ms)?\b/i
const URL_RE = /https?:\/\/[^\s"'<>]+/

const levelOf = (raw: string): Level =>
  /^(error|exception|assert|fatal|severe)$/i.test(raw) ? 'error' : /^warn/i.test(raw) ? 'warn' : 'log'

/** The first {…} or […] in a message that is valid JSON, with the text around it. */
function findJson(msg: string): Entry['json'] {
  let tries = 0
  for (let i = 0; i < msg.length && tries < 6; i++) {
    const c = msg[i]
    if (c !== '{' && c !== '[') continue
    tries++
    const close = c === '{' ? '}' : ']'
    for (let j = msg.lastIndexOf(close); j > i; j = msg.lastIndexOf(close, j - 1)) {
      try {
        const value = JSON.parse(msg.slice(i, j + 1))
        // An empty {} / [] inside other text is usually part of a non-JSON dump (a Dart map's `data: []`).
        const empty = Array.isArray(value) ? value.length === 0 : Object.keys(value ?? {}).length === 0
        if (value && typeof value === 'object' && (!empty || msg.trim().length === j + 1 - i)) return { before: msg.slice(0, i), value, after: msg.slice(j + 1) }
        break
      } catch { if (msg.length - j > 200) break }
    }
  }
  return undefined
}

function parseLogs(text: string): Entry[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const structured = lines.some(l => START_RE.test(l))
  const entries: Entry[] = []
  for (const line of lines) {
    const m = structured ? START_RE.exec(line) : null
    if (m || !structured || !entries.length) {
      entries.push({
        n: entries.length, time: m?.[1] ?? '', levelRaw: m?.[2] ?? '', level: m ? levelOf(m[2]) : /exception|error/i.test(line) ? 'error' : 'log',
        message: m ? m[3] : line, more: '', raw: line,
      })
    } else {
      const e = entries[entries.length - 1]
      e.more += (e.more ? '\n' : '') + line
      e.raw += '\n' + line
    }
  }
  for (const e of entries) {
    const plain = stripRich(e.message)
    const a = API_RE.exec(plain)
    if (a) {
      const status = a[3] ?? ''
      e.api = { method: a[1].toUpperCase(), url: a[2], status, ms: a[4] ?? '', ok: !status || /^(ok|2\d\d|3\d\d)$/i.test(status) }
      if (!e.api.ok && e.level === 'log') e.level = 'error'
      continue
    }
    e.json = findJson(plain)
    if (!e.json) { const u = URL_RE.exec(plain); if (u) e.url = u[0] }
  }
  // "After Response::{…}" lands a line or two before the "GET url OK 120ms" it belongs to. Pair a response
  // with the next API call only when nothing else API-like sits between them, so a guess is never a stretch.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e.api) continue
    for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
      const r = entries[k]
      if (r.api) break
      if (r.json && r.pairedTo === undefined && /response/i.test(r.json.before)) { e.response = r; r.pairedTo = i; break }
    }
  }
  return entries
}

// ── JSON ─────────────────────────────────────────────────────────────────────

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
function JsonBlock({ value, needle }: { value: unknown; needle: string }) {
  const pretty = useMemo(() => JSON.stringify(value, null, 2), [value])
  const lineCount = useMemo(() => pretty.split('\n').length, [pretty])
  const [open, setOpen] = useState(lineCount <= 14)
  const shown = open ? pretty : pretty.split('\n').slice(0, 10).join('\n')
  const nodes: React.ReactNode[] = []
  let last = 0, k = 0, m: RegExpExecArray | null
  JSON_TOKEN.lastIndex = 0
  while ((m = JSON_TOKEN.exec(shown))) {
    if (m.index > last) nodes.push(shown.slice(last, m.index))
    const cls = m[1] ? (m[2] ? 'j-key' : 'j-str') : m[3] ? 'j-lit' : 'j-num'
    nodes.push(<span key={k++} className={cls}>{highlight(m[1] || m[0], needle)}</span>)
    if (m[2]) nodes.push(m[2])
    last = JSON_TOKEN.lastIndex
  }
  nodes.push(shown.slice(last))
  return (
    <div className="lv-json">
      <div className="lv-json-bar">
        <span>{Array.isArray(value) ? `JSON array · ${value.length} items` : `JSON · ${lineCount} lines`}</span>
        {lineCount > 14 && <button className="lv-link" onClick={() => setOpen(o => !o)}>{open ? 'Collapse' : `Show all ${lineCount} lines`}</button>}
        <CopyButton text={pretty} label="Copy JSON" />
      </div>
      <pre>{nodes}{!open && <span className="lv-fade">…</span>}</pre>
    </div>
  )
}

// ── bits ─────────────────────────────────────────────────────────────────────

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true } catch { /* fall back below */ }
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  return ok
}

function CopyButton({ text, label = 'Copy', big = false }: { text: string; label?: string; big?: boolean }) {
  const [state, setState] = useState<'' | 'ok' | 'fail'>('')
  return (
    <button className={big ? 'lv-copy-all' : 'lv-copy'} title={label}
            onClick={async e => { e.stopPropagation(); setState((await copyText(text)) ? 'ok' : 'fail'); setTimeout(() => setState(''), 1500) }}>
      {state === 'ok' ? 'Copied ✓' : state === 'fail' ? 'Copy failed' : big ? label : '⧉'}
    </button>
  )
}

function UrlLine({ url, needle }: { url: string; needle: string }) {
  let host = url, path = '', query: [string, string][] = []
  try {
    const u = new URL(url)
    host = u.host; path = u.pathname; query = [...u.searchParams.entries()]
  } catch { /* not a parseable URL — show as is */ }
  return (
    <div className="lv-url">
      <span className="lv-host">{highlight(host, needle)}</span><span className="lv-path">{highlight(path, needle)}</span>
      {query.length > 0 && (
        <span className="lv-query">
          {query.map(([k, v], i) => <span key={i} className="lv-qp"><b>{k}</b>={highlight(v, needle)}</span>)}
        </span>
      )}
    </div>
  )
}

function EntryCard({ e, needle, response }: { e: Entry; needle: string; response?: Entry }) {
  const [openMore, setOpenMore] = useState(e.level === 'error')
  const [openText, setOpenText] = useState(false)
  const long = e.message.length > 320
  const text = long && !openText ? e.message.slice(0, 320) + '…' : e.message
  const moreLines = e.more ? e.more.split('\n').length : 0
  const copy = response ? `${response.raw}\n${e.raw}` : e.raw

  return (
    <div className={`lv-entry lv-${e.api ? 'api' : e.level}`}>
      <div className="lv-head">
        {e.api
          ? <span className={`lv-method m-${e.api.method}`}>{e.api.method}</span>
          : e.levelRaw && <span className={`lv-level lv-level-${e.level}`}>{e.levelRaw.toUpperCase()}</span>}
        {e.api && (e.api.status || e.api.ms) && (
          <span className={`lv-status ${e.api.ok ? 'ok' : 'bad'}`}>{[e.api.status, e.api.ms && `${e.api.ms} ms`].filter(Boolean).join(' · ')}</span>
        )}
        {e.json && !e.api && <span className="lv-tag">JSON</span>}
        <span className="lv-spacer" />
        {e.time && <span className="lv-time">{e.time}</span>}
        <CopyButton text={copy} />
      </div>

      {e.api ? (
        <>
          <UrlLine url={e.api.url} needle={needle} />
          {response?.json && (
            <div className="lv-response">
              <div className="lv-sub">Response{response.time ? ` · logged ${response.time}` : ''}</div>
              <JsonBlock value={response.json.value} needle={needle} />
            </div>
          )}
        </>
      ) : e.json ? (
        <>
          {e.json.before.trim() && <div className="lv-msg"><RichText text={e.json.before.trim()} needle={needle} /></div>}
          <JsonBlock value={e.json.value} needle={needle} />
          {e.json.after.trim() && <div className="lv-msg"><RichText text={e.json.after.trim()} needle={needle} /></div>}
        </>
      ) : (
        <div className="lv-msg">
          <RichText text={text} needle={needle} />
          {long && <button className="lv-link" onClick={() => setOpenText(o => !o)}>{openText ? 'Show less' : 'Show all'}</button>}
        </div>
      )}

      {moreLines > 0 && (
        <div className="lv-more">
          <button className="lv-link" onClick={() => setOpenMore(o => !o)}>
            {openMore ? '▾' : '▸'} {e.level === 'error' ? 'Stack trace' : 'More'} · {moreLines} line{moreLines === 1 ? '' : 's'}
          </button>
          {openMore && <pre><RichText text={e.more} needle={needle} /></pre>}
        </div>
      )}
    </div>
  )
}

// ── viewer ───────────────────────────────────────────────────────────────────

type Tab = 'all' | 'api' | 'errors'

export default function LogViewer({ iid }: { iid: string }) {
  const [text, setText] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const [newestFirst, setNewestFirst] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setText(null)
    fetch(api.logsUrl(iid), { credentials: 'include' })
      .then(r => (r.ok ? r.text() : Promise.reject()))
      .then(setText)
      .catch(() => setText(''))
  }, [iid])

  const entries = useMemo(() => parseLogs(text ?? ''), [text])
  const needle = q.trim().toLowerCase()
  const counts = useMemo(() => ({
    all: entries.filter(e => e.pairedTo === undefined).length,
    api: entries.filter(e => e.api).length,
    errors: entries.filter(e => e.level === 'error').length,
  }), [entries])

  const visible = useMemo(() => {
    const list = entries.filter(e => {
      if (e.pairedTo !== undefined) return false          // shown inside its API call
      if (tab === 'api' && !e.api) return false
      if (tab === 'errors' && e.level !== 'error') return false
      if (!needle) return true
      return e.raw.toLowerCase().includes(needle) || (!!e.response && e.response.raw.toLowerCase().includes(needle))
    })
    return newestFirst ? list.reverse() : list
  }, [entries, tab, needle, newestFirst])

  // Errors usually sit at the tail — start the reader there (oldest-first view only).
  useEffect(() => {
    const box = boxRef.current
    if (box && !newestFirst) box.scrollTop = box.scrollHeight
  }, [text, tab, newestFirst])

  if (text === null) return <div className="empty">Loading logs…</div>
  if (text === '') return <div className="empty">No logs attached.</div>

  const copyAll = visible.map(e => (e.response ? `${e.response.raw}\n${e.raw}` : e.raw)).join('\n')
  const tabBtn = (t: Tab, label: string, n: number) => (
    <button className={`lv-tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)} aria-pressed={tab === t}>
      {label}<span className="n">{n}</span>
    </button>
  )

  return (
    <div className="lv">
      <div className="lv-tools">
        <div className="lv-tabs" role="group" aria-label="Show">
          {tabBtn('all', 'All', counts.all)}
          {tabBtn('api', 'API calls', counts.api)}
          {tabBtn('errors', 'Errors', counts.errors)}
        </div>
        <span className="lv-spacer" />
        <label className="lv-order"><input type="checkbox" checked={newestFirst} onChange={e => setNewestFirst(e.target.checked)} /> Newest first</label>
        <CopyButton text={copyAll} label={needle || tab !== 'all' ? `Copy ${visible.length} shown` : 'Copy all logs'} big />
      </div>
      <input className="lv-search" placeholder="Search logs… (e.g. Exception, conversations, 500)" value={q} onChange={e => setQ(e.target.value)} />
      <div className="lv-list" ref={boxRef}>
        {visible.length === 0
          ? <div className="empty">Nothing matches.</div>
          : visible.map(e => <EntryCard key={e.n} e={e} needle={needle} response={e.response} />)}
      </div>
      <div className="muted small lv-foot">
        {visible.length} of {counts.all} entries{counts.api ? ` · ${counts.api} API calls` : ''}{counts.errors ? ` · ${counts.errors} errors` : ''}
      </div>
    </div>
  )
}
