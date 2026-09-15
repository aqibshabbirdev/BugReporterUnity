import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, fmtTime, IssueDetail as Detail, Me, Member } from '../api'
import LogViewer from '../components/LogViewer'
import { Severity, Status } from '../components/Badges'
import { STATUS_FLOW, STATUS_HINT, STATUS_LABEL } from '../status'

// Prefilled when an issue has no test case yet, so whoever picks it up just fills the blanks
// instead of facing an empty box.
const TEST_CASE_TEMPLATE = `Steps to reproduce:
1.
2.
3.
Expected:
Actual: `

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

export default function IssueDetail({ me }: { me: Me }) {
  const { iid = '' } = useParams()
  const nav = useNavigate()
  const [issue, setIssue] = useState<Detail | null>(null)
  const [zoom, setZoom] = useState(false)
  const [fixedIn, setFixedIn] = useState('')
  const [notes, setNotes] = useState('')
  const [notesDirty, setNotesDirty] = useState(false)
  const [notesSaved, setNotesSaved] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const [delCode, setDelCode] = useState('')
  const [delErr, setDelErr] = useState('')
  const [deleting, setDeleting] = useState(false)
  // Which device's evidence (screenshot/clip/logs) is showing. The test case + status are incident-level.
  const [activeIid, setActiveIid] = useState(iid)
  const [members, setMembers] = useState<Member[]>([])
  const [assignErr, setAssignErr] = useState('')
  useEffect(() => { api.team().then(t => setMembers(t.members)).catch(() => {}) }, [])
  useEffect(() => { setActiveIid(iid) }, [iid])

  // Seed the build box from the issue so an already-stamped build is visible (and survives a
  // re-save) instead of showing blank next to a "waiting for test in 0.9.53" badge.
  const load = () => {
    api.issue(iid).then(d => {
      setIssue(d)
      setFixedIn(d.fixed_in_build ?? '')
      // Don't clobber unsaved edits if a reload lands mid-typing. Empty test case → show the template.
      setNotes(prev => (notesDirty ? prev : (d.test_case || TEST_CASE_TEMPLATE)))
    }).catch(() => {})
  }
  useEffect(load, [iid])

  if (!issue) return <div className="page"><div className="empty">Loading…</div></div>

  // Every device that reported this one incident: this report + its same-session, same-time siblings.
  // Creator first, then joiners by time — so the tabs read Device 1, Device 2…
  const devices = [
    { id: iid, side: issue.side, device_model: issue.device_model, platform: issue.platform,
      severity: issue.severity, has_screenshot: issue.has_screenshot, has_logs: issue.has_logs, created_at: issue.created_at },
    ...issue.siblings.map(s => ({ id: s.id, side: s.side, device_model: s.device_model, platform: s.platform,
      severity: s.severity, has_screenshot: s.has_screenshot, has_logs: s.has_logs, created_at: s.created_at })),
  ].sort((a, b) => (a.side === 'Creator' ? -1 : b.side === 'Creator' ? 1 : a.created_at - b.created_at))
  const active = devices.find(d => d.id === activeIid) ?? devices[0]

  const setStatus = async (status: string) => {
    // The build stamp only travels with the state that means "a fix exists"; the server clears it
    // on open/pending and keeps the stored one when we send nothing.
    await api.setStatus(iid, status, status === 'waiting_for_test' ? fixedIn || undefined : undefined)
    load()
  }
  const setAssignee = async (uid: string) => {
    setAssignErr('')
    try { await api.setAssignee(iid, uid || null); load() }
    catch (e) { setAssignErr(e instanceof Error ? e.message : 'could not assign') }
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
      {/* nav(-1) returns to the exact filtered issues list (filters live in that URL), not a blank list. */}
      <button className="btn" onClick={() => nav(-1)} style={{ marginBottom: 14 }}>← Back to issues</button>
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

      {/* Triage first — the primary action on any issue. */}
      <div className="card pad" style={{ marginBottom: 14 }}>
        <div className="assignee-row">
          <label htmlFor="assignee">Assigned to</label>
          <span className={`assignee-avatar${issue.assignee_id ? '' : ' none'}`} aria-hidden="true">
            {issue.assignee_email ? issue.assignee_email.charAt(0).toUpperCase() : '?'}
          </span>
          <select id="assignee" value={issue.assignee_id ?? ''} onChange={e => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {issue.assignee_id && !members.some(m => m.id === issue.assignee_id) && (
              <option value={issue.assignee_id}>{issue.assignee_email ?? 'former member'}</option>
            )}
            {members.map(m => <option key={m.id} value={m.id}>{m.email}{m.id === me.id ? ' (me)' : ''}</option>)}
          </select>
          {issue.assignee_id !== me.id && <button onClick={() => setAssignee(me.id)}>Assign to me</button>}
          {assignErr && <span className="error">{assignErr}</span>}
        </div>
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

      {devices.length > 1 && (
        <div className="card pad linked" style={{ marginBottom: 14 }}>
          <label>🔗 Same multiplayer session — {devices.length} devices reported this. Switch to see each device's evidence:</label>
          <div className="device-tabs">
            {devices.map((d, n) => (
              <button key={d.id} className={`device-tab row-${d.severity} ${d.id === activeIid ? 'active' : ''}`}
                      onClick={() => setActiveIid(d.id)}>
                <span className="side-badge">{d.side || `Device ${n + 1}`}</span>
                <span className="dt-dev">{d.device_model || 'device'}</span>
                <span className="muted small">{d.platform ?? '—'} · {fmtTime(d.created_at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="detail-grid">
        {/* Left: what a human writes + the logs to read against it — logs fill the space under the test case. */}
        <div className="col">
          {issue.description && (
            <div className="card pad tester-note">
              <label>🗒 Tester's note</label>
              <div style={{ whiteSpace: 'pre-wrap' }}>{issue.description}</div>
            </div>
          )}
          <div className="card pad">
            <label>Test case</label>
            <div className="muted small" style={{ marginBottom: 8 }}>
              Testers can't type this mid-game — fill it in here: the steps, what should happen, what happened.
            </div>
            <textarea className="notes" rows={8} value={notes}
                      onChange={e => { setNotes(e.target.value); setNotesDirty(true); setNotesSaved(false) }} />
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <button className="primary" onClick={saveNotes} disabled={!notesDirty}>Save test case</button>
              <button onClick={() => { setNotes(TEST_CASE_TEMPLATE); setNotesDirty(true); setNotesSaved(false) }}>
                Reset to template
              </button>
              {notesSaved && <span className="small" style={{ color: 'var(--green)' }}>Saved ✓</span>}
              {notesDirty && <span className="muted small">unsaved changes</span>}
            </div>
          </div>
          <div className="card pad">
            <label>Logs{devices.length > 1 && active.side ? ` — ${active.side}` : ''}</label>
            <LogViewer iid={activeIid} />
          </div>
        </div>

        {/* Right: the visual evidence for the selected device — screenshot + clip. */}
        <div className="col">
          {active.has_screenshot > 0 && (
            <div className="card pad">
              <label>Screenshot{devices.length > 1 && active.side ? ` — ${active.side}` : ''}</label>
              <img className="shot" src={api.screenshotUrl(activeIid)} onClick={() => setZoom(true)} />
              {zoom && (
                <div className="shot-full" onClick={() => setZoom(false)}>
                  <img src={api.screenshotUrl(activeIid)} />
                </div>
              )}
            </div>
          )}
          <ClipPlayer iid={activeIid} />

          {Object.keys(issue.metadata).length > 0 && (
            <div className="card pad">
              <label>Game state at report time</label>
              <div className="chips">
                {Object.entries(issue.metadata).map(([k, v]) => (
                  <span className="chip mono" key={k}><b>{k}</b>{String(v)}</span>
                ))}
              </div>
            </div>
          )}
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
