import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, Build, fmtTime, Game, IssueRow } from '../api'
import { Severity, Status } from '../components/Badges'

const STATUSES = ['', 'open', 'fixed_in_build', 'verified', 'wont_fix']

export default function Issues() {
  const { pid = '' } = useParams()
  const nav = useNavigate()
  const [issues, setIssues] = useState<IssueRow[] | null>(null)
  const [builds, setBuilds] = useState<Build[]>([])
  const [games, setGames] = useState<Game[]>([])
  const [build, setBuild] = useState('')
  const [game, setGame] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => { api.builds(pid).then(setBuilds).catch(() => {}) }, [pid])
  useEffect(() => { api.games(pid).then(setGames).catch(() => {}) }, [pid])
  useEffect(() => {
    setIssues(null)
    api.issues(pid, { build, game, status }).then(setIssues).catch(() => setIssues([]))
  }, [pid, build, game, status])

  const needle = q.trim().toLowerCase()
  const rows = useMemo(
    () => (issues ?? []).filter(i => !needle || i.title.toLowerCase().includes(needle) || (i.game ?? '').toLowerCase().includes(needle)),
    [issues, needle],
  )
  const stats = useMemo(() => ({
    total: rows.length,
    open: rows.filter(i => i.status === 'open').length,
    crash: rows.filter(i => i.severity === 'crash').length,
  }), [rows])

  const filtered = !!(build || game || status || needle)

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Issues</h1>
          <div className="sub">Reports filed from the game land here automatically.</div>
        </div>
        <Link className="btn" to={`/p/${pid}/settings`}>⚙ Settings</Link>
      </div>

      <div className="stat-grid">
        <div className="stat"><div className="n">{stats.total}</div><div className="k">{filtered ? 'Matching' : 'Total'}</div></div>
        <div className="stat accent-amber"><div className="n">{stats.open}</div><div className="k">Open</div></div>
        <div className="stat accent-red"><div className="n">{stats.crash}</div><div className="k">Crashes</div></div>
        <div className="stat accent-blue"><div className="n">{games.length}</div><div className="k">Games</div></div>
      </div>

      <div className="toolbar">
        <div className="search">
          <input placeholder="Search issues by title or game…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {games.length > 0 && (
          <select value={game} onChange={e => setGame(e.target.value)}>
            <option value="">All games</option>
            {games.map(g => <option key={g.game} value={g.game}>{g.game} ({g.open_count} open)</option>)}
          </select>
        )}
        <select value={build} onChange={e => setBuild(e.target.value)}>
          <option value="">All builds</option>
          {builds.map(b => <option key={b.version} value={b.version}>{b.version} ({b.open_count} open)</option>)}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)}>
          {STATUSES.map(s => <option key={s} value={s}>{s === '' ? 'All statuses' : s.replace(/_/g, ' ')}</option>)}
        </select>
      </div>

      <div className="card">
        {issues === null ? <div className="empty">Loading…</div>
          : rows.length === 0 ? (
            <div className="empty">
              <div className="big">No issues{filtered ? ' match this filter' : ' yet'}.</div>
              <span className="small">{filtered ? 'Try clearing the search or filters.' : 'Reports filed from the game show up here.'}</span>
            </div>
          ) : (
            <table>
              <thead>
                <tr><th>Title</th><th>Game</th><th>Severity</th><th>Status</th><th>Build</th><th>Platform</th><th>When</th></tr>
              </thead>
              <tbody>
                {rows.map(i => (
                  <tr key={i.id} className={`click row-${i.severity}`} onClick={() => nav(`/i/${i.id}`)}>
                    <td className="cell-title"><b>{i.title}</b></td>
                    <td>{i.game ? <span className="pill"><span className="dot" />{i.game}</span> : <span className="faint small">—</span>}</td>
                    <td><Severity v={i.severity} /></td>
                    <td><Status v={i.status} fixedIn={i.fixed_in_build} /></td>
                    <td className="mono small muted">{i.build_version}</td>
                    <td className="muted small">{i.platform ?? '—'}</td>
                    <td className="muted small" style={{ whiteSpace: 'nowrap' }}>{fmtTime(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  )
}
