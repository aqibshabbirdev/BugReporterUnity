import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, fmtTime, IssueDetail as Detail } from '../api'
import { Severity, Status } from '../components/Badges'
import { STATUS_FLOW, STATUS_HINT, STATUS_LABEL } from '../status'

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

function ClipPlayer({ iid }: { iid: string }) {
  const [frames, setFrames] = useState(-1)   // -1 loading, 0 none
  const [fps, setFps] = useState(6)
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [zoom, setZoom] = useState(false)

  useEffect(() => {
    api.clipMeta(iid).then(m => { setFrames(m.frames); setFps(m.fps || 6) }).catch(() => setFrames(0))
  }, [iid])
  // Warm the browser cache — but with limited concurrency. Firing all N frame requests at once (a clip is
  // hundreds) stampeded the server's tiny DB connection pool and 500'd the whole app. Chain a few at a time.
  useEffect(() => {
    if (frames <= 0) return
    let cancelled = false, next = 0
    const CONCURRENCY = 4
    const pump = () => {
      if (cancelled || next >= frames) return
      const img = new Image()
      img.onload = img.onerror = () => { if (!cancelled) pump() }
      img.src = api.clipFrameUrl(iid, next++)
    }
    for (let k = 0; k < CONCURRENCY; k++) pump()
    return () => { cancelled = true }
  }, [iid, frames])
  useEffect(() => {
    if (frames <= 0 || !playing) return
    // Play at the rate it was captured at (scaled) — a fixed guess makes clips run fast or in slow motion.
    const t = setInterval(() => setI(x => (x + 1) % frames), 1000 / (fps * speed))
    return () => clearInterval(t)
  }, [frames, fps, playing, speed])

  const step = (d: number) => { setPlaying(false); setI(x => (x + d + frames) % frames) }

  if (frames <= 0) return null
  return (
    <div className="card pad" style={{ marginBottom: 14 }}>
      <label>🎞 Clip — last {(frames / fps).toFixed(1)}s before the report · {frames} frames @ {fps}fps</label>
      <img className="clip-frame" src={api.clipFrameUrl(iid, i)} onClick={() => setZoom(true)} alt="" />
      {zoom && (
        <div className="shot-full" onClick={() => setZoom(false)}>
          <img src={api.clipFrameUrl(iid, i)} />
        </div>
      )}
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setPlaying(p => !p)}>{playing ? '⏸ Pause' : '▶ Play'}</button>
        <button onClick={() => step(-1)} title="Previous frame">◀</button>
        <button onClick={() => step(1)} title="Next frame">▶</button>
        <input type="range" min={0} max={frames - 1} value={i}
               onChange={e => { setPlaying(false); setI(Number(e.target.value)) }} style={{ flex: 1, minWidth: 140 }} />
        <span className="muted small mono">{i + 1}/{frames}</span>
        <select value={speed} onChange={e => setSpeed(Number(e.target.value))} title="Playback speed">
          <option value={0.25}>0.25×</option>
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
      </div>
      <div className="muted small" style={{ marginTop: 6 }}>Click the frame to enlarge · ◀ ▶ step frame-by-frame</div>
    </div>
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
  const nav = useNavigate()
  const [issue, setIssue] = useState<Detail | null>(null)
  const [zoom, setZoom] = useState(false)
  const [fixedIn, setFixedIn] = useState('')
  const [comment, setComment] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [commentErr, setCommentErr] = useState('')
  const [notes, setNotes] = useState('')
  const [notesDirty, setNotesDirty] = useState(false)
  const [notesSaved, setNotesSaved] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const [delCode, setDelCode] = useState('')
  const [delErr, setDelErr] = useState('')
  const [deleting, setDeleting] = useState(false)

  // Seed the build box from the issue so an already-stamped build is visible (and survives a
  // re-save) instead of showing blank next to a "waiting for test in 0.9.53" badge.
  const load = () => {
    api.issue(iid).then(d => {
      setIssue(d)
      setFixedIn(d.fixed_in_build ?? '')
      // Don't clobber unsaved edits if a reload lands mid-typing.
      setNotes(prev => (notesDirty ? prev : (d.description ?? '')))
    }).catch(() => {})
  }
  useEffect(load, [iid])

  if (!issue) return <div className="page"><div className="empty">Loading…</div></div>

  const setStatus = async (status: string) => {
    // The build stamp only travels with the state that means "a fix exists"; the server clears it
    // on open/pending and keeps the stored one when we send nothing.
    await api.setStatus(iid, status, status === 'waiting_for_test' ? fixedIn || undefined : undefined)
    load()
  }
  const addComment = async () => {
    if (!comment.trim() || commenting) return
    setCommenting(true); setCommentErr('')
    try {
      await api.comment(iid, comment.trim())
      setComment('')
      load()
    } catch (e) {
      setCommentErr(e instanceof Error ? e.message : 'could not post comment')  // was failing silently
    } finally {
      setCommenting(false)
    }
  }
  const saveNotes = async () => {
    setNotesSaved(false)
    try {
      await api.setNotes(iid, notes)
      setNotesDirty(false)
      setNotesSaved(true)
      load()
    } catch {
      setNotesSaved(false)
    }
  }
  const doDelete = async () => {
    if (!issue) return
    setDeleting(true); setDelErr('')
    try {
      await api.deleteIssue(iid, delCode)
      nav(`/p/${issue.project_id}`)
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : 'delete failed')
      setDeleting(false)
    }
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

      {issue.siblings.length > 0 && (
        <div className="card pad linked" style={{ marginBottom: 14 }}>
          <label>🔗 Same multiplayer session — {issue.siblings.length} other device{issue.siblings.length > 1 ? 's' : ''}</label>
          <div className="sib-list">
            {issue.siblings.map(s => (
              <div key={s.id} className={`sib row-${s.severity}`} onClick={() => nav(`/i/${s.id}`)}>
                {s.has_screenshot > 0
                  ? <img className="sib-thumb" src={api.thumbUrl(s.id)} loading="lazy" alt="" />
                  : <div className="sib-thumb placeholder">🐞</div>}
                <div className="sib-body">
                  <div className="sib-title">{s.title}</div>
                  <div className="muted small">{s.device_model || 'unknown device'} · {s.platform ?? '—'} · {fmtTime(s.created_at)}</div>
                  <div className="row" style={{ gap: 6, marginTop: 4 }}><Severity v={s.severity} /><Status v={s.status} /></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card pad" style={{ marginBottom: 14 }}>
        <label>Repro steps / notes</label>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Testers can't type this mid-game — write the test case here: what you did, what should happen, what happened.
        </div>
        <textarea className="notes" rows={4} placeholder="1. Open Cricket online…&#10;2. …&#10;Expected: …&#10;Got: …"
                  value={notes}
                  onChange={e => { setNotes(e.target.value); setNotesDirty(true); setNotesSaved(false) }} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" onClick={saveNotes} disabled={!notesDirty}>Save notes</button>
          {notesSaved && <span className="small" style={{ color: 'var(--green)' }}>Saved ✓</span>}
          {notesDirty && <span className="muted small">unsaved changes</span>}
        </div>
      </div>

      <ClipPlayer iid={iid} />

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
        <div className="status-picker">
          {STATUS_FLOW.map(s => (
            <button key={s} title={STATUS_HINT[s]}
                    className={`status-btn st-btn-${s}${issue.status === s ? ' active' : ''}`}
                    onClick={() => setStatus(s)}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>{STATUS_HINT[issue.status] ?? ''}</div>
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="fixed in build… (e.g. 0.9.53)" value={fixedIn}
                 onChange={e => setFixedIn(e.target.value)} className="mono" />
          <span className="muted small">stamped on the issue when you move it to “Waiting for test”</span>
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
        <div style={{ marginTop: 10 }}>
          <textarea className="notes" rows={2} placeholder="Add a comment…  (⌘/Ctrl+Enter to post)"
                    value={comment} onChange={e => setComment(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment() }} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={addComment} disabled={commenting || !comment.trim()}>
              {commenting ? 'Posting…' : 'Comment'}
            </button>
            {commentErr && <span className="error small">{commentErr}</span>}
          </div>
        </div>
      </div>

      <div className="card pad danger-zone" style={{ marginTop: 14 }}>
        <label>Danger zone</label>
        {!delOpen ? (
          <button className="danger" onClick={() => setDelOpen(true)}>🗑 Delete this issue</button>
        ) : (
          <>
            <div className="muted small" style={{ marginBottom: 8 }}>
              This permanently removes the report, its screenshot and logs. Enter the delete password to confirm.
            </div>
            <div className="row">
              <input type="password" placeholder="Delete password" value={delCode} autoFocus
                     onChange={e => setDelCode(e.target.value)}
                     onKeyDown={e => e.key === 'Enter' && !deleting && doDelete()} style={{ flex: 1, maxWidth: 240 }} />
              <button className="danger" onClick={doDelete} disabled={deleting || !delCode}>
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button onClick={() => { setDelOpen(false); setDelCode(''); setDelErr('') }} disabled={deleting}>Cancel</button>
            </div>
          </>
        )}
        {delErr && <div className="error" style={{ marginTop: 8 }}>{delErr}</div>}
      </div>
    </div>
  )
}
