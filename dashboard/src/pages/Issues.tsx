import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, Build, fmtTime, IssueRow } from '../api'
import { Severity, Status } from '../components/Badges'

const STATUSES = ['', 'open', 'fixed_in_build', 'verified', 'wont_fix']

export default function Issues() {
  const { pid = '' } = useParams()
  const nav = useNavigate()
  const [issues, setIssues] = useState<IssueRow[] | null>(null)
  const [builds, setBuilds] = useState<Build[]>([])
  const [build, setBuild] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => { api.builds(pid).then(setBuilds).catch(() => {}) }, [pid])
  useEffect(() => {
    setIssues(null)
    api.issues(pid, { build, status }).then(setIssues).catch(() => setIssues([]))
  }, [pid, build, status])

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 18, justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>Issues</h1>
        <div className="row">
          <select value={build} onChange={e => setBuild(e.target.value)}>
            <option value="">All builds</option>
            {builds.map(b => (
              <option key={b.version} value={b.version}>
                {b.version} ({b.open_count} open)
              </option>
            ))}
          </select>
          <select value={status} onChange={e => setStatus(e.target.value)}>
            {STATUSES.map(s => <option key={s} value={s}>{s === '' ? 'All statuses' : s.replace(/_/g, ' ')}</option>)}
          </select>
          <Link className="btn" to={`/p/${pid}/settings`}>Settings</Link>
        </div>
      </div>

      <div className="card">
        {issues === null ? <div className="empty">Loading…</div>
          : issues.length === 0 ? (
            <div className="empty">
              No issues{build || status ? ' for this filter' : ' yet'}.<br />
              <span className="small">Reports filed from the game land here automatically.</span>
            </div>
          ) : (
            <table>
              <thead>
                <tr><th>Title</th><th>Severity</th><th>Status</th><th>Build</th><th>Platform</th><th>When</th></tr>
              </thead>
              <tbody>
                {issues.map(i => (
                  <tr key={i.id} className="click" onClick={() => nav(`/i/${i.id}`)}>
                    <td><b>{i.title}</b></td>
                    <td><Severity v={i.severity} /></td>
                    <td><Status v={i.status} fixedIn={i.fixed_in_build} /></td>
                    <td className="mono small">{i.build_version}</td>
                    <td className="muted small">{i.platform ?? '—'}</td>
                    <td className="muted small">{fmtTime(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  )
}
