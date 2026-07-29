import { useMemo, useState, useEffect } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, Build, fmtTime, Game, IssueRow } from '../api'
import { Severity, Status } from '../components/Badges'
import { isUnresolved, STATUS_FLOW, STATUS_LABEL } from '../status'

const NO_GAME = '\u0000' // sentinel key for issues with no game

// Day buckets are computed in the VIEWER's timezone, not UTC — a report filed at 2am local would
// otherwise land on the previous day and "Today" would read wrong.
const keyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayKey = (unix: number) => keyOf(new Date(unix * 1000))

// Deterministic vivid colour per game name, so each section reads at a glance.
function hue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}
const avatarStyle = (name: string) => ({
  background: `linear-gradient(135deg, hsl(${hue(name)} 65% 45%), hsl(${(hue(name) + 40) % 360} 65% 38%))`,
})

interface Group { key: string; name: string; rows: IssueRow[]; unresolved: number; crash: number }

export default function Issues() {
  const { pid = '' } = useParams()
  const nav = useNavigate()

  // Filters live in the URL, not local state — so opening an issue and pressing Back restores the exact
  // filtered view (and a filtered list is a shareable link). Replace-mode keeps each keystroke out of history.
  const [sp, setSp] = useSearchParams()
  const setParam = (key: string, val: string) => setSp(prev => {
    const next = new URLSearchParams(prev)
    if (val) next.set(key, val); else next.delete(key)
    return next
  }, { replace: true })
  const build = sp.get('build') || ''
  const game = sp.get('game') || ''
  const status = sp.get('status') || ''
  const date = sp.get('date') || ''
  const q = sp.get('q') || ''
  const setBuild = (v: string) => setParam('build', v)
  const setGame = (v: string) => setParam('game', v)
  const setStatus = (v: string) => setParam('status', v)
  const setDate = (v: string) => setParam('date', v)
  const setQ = (v: string) => setParam('q', v)

  const [issues, setIssues] = useState<IssueRow[] | null>(null)
  const [builds, setBuilds] = useState<Build[]>([])
  const [games, setGames] = useState<Game[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set([NO_GAME]))

  useEffect(() => { api.builds(pid).then(setBuilds).catch(() => {}) }, [pid])
  useEffect(() => { api.games(pid).then(setGames).catch(() => {}) }, [pid])
  useEffect(() => {
    setIssues(null)
    api.issues(pid, { build, game }).then(setIssues).catch(() => setIssues([]))
  }, [pid, build, game])

  const needle = q.trim().toLowerCase()
  // Status is filtered here rather than in the query: one fetch then holds every state, so each tab
  // can carry a live count and switching tabs costs no round trip.
  const scoped = useMemo(
    () => (issues ?? []).filter(i =>
      (!needle || i.title.toLowerCase().includes(needle) || (i.game ?? '').toLowerCase().includes(needle)) &&
      (!date || dayKey(i.created_at) === date)),
    [issues, needle, date],
  )
  const rows = useMemo(() => scoped.filter(i => !status || i.status === status), [scoped, status])

  // Counted over `scoped` — every filter EXCEPT status — so a tab reports what it would show instead
  // of collapsing to the tab you are already standing on.
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { '': scoped.length }
    for (const s of STATUS_FLOW) c[s] = 0
    for (const i of scoped) c[i.status] = (c[i.status] ?? 0) + 1
    return c
  }, [scoped])

  // Date options come from the loaded issues (not a fixed calendar) so every entry has something behind it.
  // Derived from `issues`, not `rows`, so picking a date doesn't collapse the list you're picking from.
  const dateOptions = useMemo(() => {
    const today = keyOf(new Date())
    const y = new Date(); y.setDate(y.getDate() - 1)
    const yesterday = keyOf(y)
    const thisYear = new Date().getFullYear()

    const counts = new Map<string, number>()
    for (const i of issues ?? []) {
      const k = dayKey(i.created_at)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))   // newest day first
      .map(([key, n]) => {
        let label: string
        if (key === today) label = 'Today'
        else if (key === yesterday) label = 'Yesterday'
        else {
          const [yy, mm, dd] = key.split('-').map(Number)
          const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
          if (yy !== thisYear) opts.year = 'numeric'
          label = new Date(yy, mm - 1, dd).toLocaleDateString(undefined, opts)
        }
        return { key, n, label }
      })
  }, [issues])
  const stats = useMemo(() => ({
    total: rows.length,
    unresolved: rows.filter(i => isUnresolved(i.status)).length,
    crash: rows.filter(i => i.severity === 'crash').length,
  }), [rows])

  // Sessions that appear on more than one report = multi-device incidents; badge those cards.
  const linkedSessions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of issues ?? []) if (i.session) counts.set(i.session, (counts.get(i.session) ?? 0) + 1)
    return new Set([...counts].filter(([, n]) => n > 1).map(([s]) => s))
  }, [issues])

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>()
    for (const i of rows) {
      const key = i.game || NO_GAME
      let g = map.get(key)
      if (!g) { g = { key, name: i.game || 'No game', rows: [], unresolved: 0, crash: 0 }; map.set(key, g) }
      g.rows.push(i)
      if (isUnresolved(i.status)) g.unresolved++
      if (i.severity === 'crash') g.crash++
    }
    return [...map.values()].sort((a, b) => {
      if (a.key === NO_GAME) return 1
      if (b.key === NO_GAME) return -1
      return b.crash - a.crash || b.unresolved - a.unresolved || b.rows.length - a.rows.length
    })
  }, [rows])

  // Land on the newest day that actually has issues — Today, or Yesterday if today is quiet, and so on.
  // Runs once on first load only, so it never overrides a date the user picked (filter changes refetch).
  const [dateDefaulted, setDateDefaulted] = useState(false)
  useEffect(() => {
    if (dateDefaulted || issues === null) return
    setDateDefaulted(true)
    // Fresh visit only — if the URL already carries filters (Back from an issue, or a shared link),
    // respect them instead of forcing Today.
    if ([...sp.keys()].length === 0 && dateOptions.length > 0) setDate(dateOptions[0].key)
  }, [issues, dateOptions, dateDefaulted, sp])

  const filtered = !!(build || game || status || date || needle)
  const toggle = (k: string) => setCollapsed(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Issues</h1>
          <div className="sub">Grouped by game — reports file themselves from each title.</div>
        </div>
        <Link className="btn" to={`/p/${pid}/settings`}>⚙ Settings</Link>
      </div>

      <div className="stat-grid">
        <div className="stat"><div className="n">{stats.total}</div><div className="k">{filtered ? 'Matching' : 'Total'}</div></div>
        <div className="stat accent-amber"><div className="n">{stats.unresolved}</div><div className="k">Unresolved</div></div>
        <div className="stat accent-red"><div className="n">{stats.crash}</div><div className="k">Crashes</div></div>
        <div className="stat accent-blue"><div className="n">{games.length}</div><div className="k">Games</div></div>
      </div>

      <div className="status-tabs">
        {['', ...STATUS_FLOW].map(s => (
          <button key={s} onClick={() => setStatus(s)}
                  className={`status-tab${s ? ` st-tab-${s}` : ''}${status === s ? ' active' : ''}`}>
            {s === '' ? 'All' : STATUS_LABEL[s]}<span className="n">{statusCounts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <div className="search">
          <input placeholder="Search issues by title or game…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {dateOptions.length > 0 && (
          <select value={date} onChange={e => setDate(e.target.value)}>
            <option value="">All dates</option>
            {dateOptions.map(d => <option key={d.key} value={d.key}>{d.label} ({d.n})</option>)}
          </select>
        )}
        {games.length > 0 && (
          <select value={game} onChange={e => setGame(e.target.value)}>
            <option value="">All games</option>
            {games.map(g => <option key={g.game} value={g.game}>{g.game} ({g.open_count} unresolved)</option>)}
          </select>
        )}
        <select value={build} onChange={e => setBuild(e.target.value)}>
          <option value="">All builds</option>
          {builds.map(b => <option key={b.version} value={b.version}>{b.version} ({b.open_count} unresolved)</option>)}
        </select>
      </div>

      {issues === null ? <div className="card"><div className="empty">Loading…</div></div>
        : groups.length === 0 ? (
          <div className="card"><div className="empty">
            <div className="big">No issues{filtered ? ' match this filter' : ' yet'}.</div>
            <span className="small">{filtered ? 'Try clearing the search or filters.' : 'Reports filed from the game show up here.'}</span>
          </div></div>
        ) : groups.map(g => {
          const isOpen = !collapsed.has(g.key)
          const noGame = g.key === NO_GAME
          return (
            <div key={g.key} className={`card game-group ${isOpen ? 'open' : ''}`}>
              <div className="gg-head" onClick={() => toggle(g.key)}>
                <span className="gg-caret">▶</span>
                <span className="gg-avatar" style={noGame ? { background: '#30363d' } : avatarStyle(g.name)}>
                  {noGame ? '?' : g.name.charAt(0).toUpperCase()}
                </span>
                <span className="gg-name">{g.name}</span>
                <span className="gg-counts">
                  {g.crash > 0 && <span className="gg-count crash">{g.crash} crash</span>}
                  {g.unresolved > 0 && <span className="gg-count open">{g.unresolved} unresolved</span>}
                  <span className="gg-count">{g.rows.length}</span>
                </span>
              </div>
              {isOpen && (
                <div className="issue-grid">
                  {g.rows.map(i => (
                    <div key={i.id} className={`issue-card row-${i.severity}`} onClick={() => nav(`/i/${i.id}`)}>
                      {i.session && linkedSessions.has(i.session) && <span className="link-badge" title="Linked multiplayer session">🔗 linked</span>}
                      {i.has_screenshot > 0
                        ? <img className="issue-thumb" src={api.thumbUrl(i.id)} loading="lazy" decoding="async" alt="" />
                        : <div className="issue-thumb placeholder">🐞</div>}
                      <div className="issue-body">
                        <div className="issue-title">{i.title}</div>
                        <div className="issue-meta">
                          <Severity v={i.severity} />
                          <Status v={i.status} fixedIn={i.fixed_in_build} />
                        </div>
                        <div className="issue-foot">
                          <span className="mono">{i.build_version}</span> · {i.platform ?? '—'} · {fmtTime(i.created_at)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
    </div>
  )
}
