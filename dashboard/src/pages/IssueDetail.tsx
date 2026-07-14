import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, fmtTime, IssueDetail as Detail } from '../api'
import { Severity, Status } from '../components/Badges'

// ── Unity rich text ──────────────────────────────────────────────────────────
// Game logs arrive with Unity's console markup (<color=…>, <b>, <i>, <u>, <size=…>). We render it as
// real styling instead of raw tags. Input is untrusted log text, so we NEVER use innerHTML — every text
// node goes through React (auto-escaped); tags only ever become inline style, never markup.
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

function RichLine({ text, needle }: { text: string; needle: string }) {
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

function LogViewer({ iid }: { iid: string }) {
  const [text, setText] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(api.logsUrl(iid), { credentials: 'include' })
      .then(r => (r.ok ? r.text() : Promise.reject()))
      .then(setText)
      .catch(() => setText(''))
  }, [iid])

  // Errors usually sit at the tail — start the reader there.
  useEffect(() => { endRef.current?.scrollIntoView() }, [text])

  const lines = useMemo(() => (text ?? '').split('\n'), [text])
  const needle = q.trim().toLowerCase()

  if (text === null) return <div className="empty">Loading logs…</div>
  if (text === '') return <div className="empty">No logs attached.</div>

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <input placeholder="Search logs… (e.g. Exception, KeeperState)" value={q}
               onChange={e => setQ(e.target.value)} style={{ flex: 1 }} />
        <span className="muted small">
          {needle ? `${lines.filter(l => l.toLowerCase().includes(needle)).length} matching / ` : ''}{lines.length} lines
        </span>
      </div>
      <div className="logview">
        {lines.map((l, n) => {
          if (needle && !l.toLowerCase().includes(needle)) return null
          const cls = /\[(Exception|Error|Assert)\]/.test(l) ? 'err'
                    : /\[Warning\]/.test(l) ? 'warn' : ''
          return <div key={n} className={`ln ${cls}`}><RichLine text={l} needle={needle} /></div>
        })}
        <div ref={endRef} />
      </div>
    </>
  )
}

export default function IssueDetail() {
  const { iid = '' } = useParams()
  const [issue, setIssue] = useState<Detail | null>(null)
  const [zoom, setZoom] = useState(false)
  const [fixedIn, setFixedIn] = useState('')
  const [comment, setComment] = useState('')

  const load = () => { api.issue(iid).then(setIssue).catch(() => {}) }
  useEffect(load, [iid])

  if (!issue) return <div className="page"><div className="empty">Loading…</div></div>

  const setStatus = async (status: string) => {
    await api.setStatus(iid, status, status === 'fixed_in_build' ? fixedIn || undefined : undefined)
    load()
  }
  const addComment = async () => {
    if (!comment.trim()) return
    await api.comment(iid, comment.trim())
    setComment('')
    load()
  }

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <h1 style={{ margin: 0 }}>{issue.title}</h1>
        <div className="row">
          <Severity v={issue.severity} />
          <Status v={issue.status} fixedIn={issue.fixed_in_build} />
        </div>
      </div>
      <div className="muted small" style={{ marginBottom: 18 }}>
        {issue.game && <><span className="mono">{issue.game}</span> · </>}
        build <span className="mono">{issue.build_version}</span> · {issue.device_model || 'unknown device'} ·{' '}
        {issue.os_version} · {issue.screen_resolution} · {issue.memory_mb} MB · reported {fmtTime(issue.created_at)}
      </div>

      {issue.description && <div className="card pad" style={{ marginBottom: 14 }}>{issue.description}</div>}

      {Object.keys(issue.metadata).length > 0 && (
        <div className="card pad" style={{ marginBottom: 14 }}>
          <label>Game state at report time</label>
          <div className="chips">
            {Object.entries(issue.metadata).map(([k, v]) => (
              <span className="chip mono" key={k}><b>{k}</b>{String(v)}</span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: issue.has_screenshot ? '1fr 1fr' : '1fr', gap: 14 }}>
        {issue.has_screenshot > 0 && (
          <div className="card pad">
            <label>Screenshot</label>
            <img className="shot" src={api.screenshotUrl(iid)} onClick={() => setZoom(true)} />
            {zoom && (
              <div className="shot-full" onClick={() => setZoom(false)}>
                <img src={api.screenshotUrl(iid)} />
              </div>
            )}
          </div>
        )}
        <div className="card pad">
          <label>Logs</label>
          <LogViewer iid={iid} />
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 14 }}>
        <label>Status</label>
        <div className="row">
          <button onClick={() => setStatus('open')}>Open</button>
          <input placeholder="fixed in build… (e.g. 0.9.53)" value={fixedIn}
                 onChange={e => setFixedIn(e.target.value)} className="mono" />
          <button onClick={() => setStatus('fixed_in_build')}>Fixed in build</button>
          <button onClick={() => setStatus('verified')}>Verified</button>
          <button onClick={() => setStatus('wont_fix')}>Won't fix</button>
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 14 }}>
        <label>Comments</label>
        {issue.comments.length === 0 && <div className="muted small" style={{ margin: '6px 0 10px' }}>None yet.</div>}
        {issue.comments.map((c, i) => (
          <div key={i} style={{ margin: '10px 0' }}>
            <span className="small"><b>{c.author}</b> <span className="muted">{fmtTime(c.created_at)}</span></span>
            <div>{c.text}</div>
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="Add a comment…" value={comment} onChange={e => setComment(e.target.value)}
                 onKeyDown={e => e.key === 'Enter' && addComment()} style={{ flex: 1 }} />
          <button className="primary" onClick={addComment}>Comment</button>
        </div>
      </div>
    </div>
  )
}
