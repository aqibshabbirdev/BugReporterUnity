import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, fmtTime, IssueDetail as Detail } from '../api'
import { Severity, Status } from '../components/Badges'

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
          let content: React.ReactNode = l
          if (needle) {
            const i = l.toLowerCase().indexOf(needle)
            content = <>{l.slice(0, i)}<mark>{l.slice(i, i + needle.length)}</mark>{l.slice(i + needle.length)}</>
          }
          return <div key={n} className={`ln ${cls}`}>{content}</div>
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
