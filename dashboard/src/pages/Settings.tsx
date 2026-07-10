import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, Build, fmtTime, Project } from '../api'

export default function Settings() {
  const { pid = '' } = useParams()
  const [project, setProject] = useState<Project | null>(null)
  const [builds, setBuilds] = useState<Build[]>([])
  const [rotated, setRotated] = useState('')
  const [confirmRotate, setConfirmRotate] = useState(false)

  useEffect(() => {
    api.projects().then(ps => setProject(ps.find(p => p.id === pid) ?? null)).catch(() => {})
    api.builds(pid).then(setBuilds).catch(() => {})
  }, [pid])

  const endpoint = `${window.location.origin}/api/report`
  const snippet = `[RuntimeInitializeOnLoadMethod]
static void InitBugReporter()
{
    BugReporter.BugReporter.Init(new BugReporter.BugReporterConfig {
        ApiKey   = "br_live_...",            // Settings me rotate karke fresh key lo
        Endpoint = "${endpoint}",
        Enabled  = Debug.isDebugBuild,       // release build me kabhi nahi chalega
    });
}`

  const rotate = async () => {
    const r = await api.rotateKey(pid)
    setRotated(r.apiKey)
    setConfirmRotate(false)
  }

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>{project?.name ?? '…'} — Settings</h1>
        <Link className="btn" to={`/p/${pid}`}>← Issues</Link>
      </div>

      <div className="card pad">
        <label>API key</label>
        <p className="small muted" style={{ marginTop: 0 }}>
          The key is stored hashed — it can't be shown again. Rotating creates a new key and
          immediately invalidates the old one (update the game's config after rotating).
        </p>
        {rotated ? (
          <>
            <div className="keybox mono">{rotated}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <button onClick={() => navigator.clipboard.writeText(rotated)}>Copy key</button>
              <button onClick={() => setRotated('')}>Done, I saved it</button>
            </div>
          </>
        ) : confirmRotate ? (
          <div className="row">
            <span className="small">Old key stops working instantly. Sure?</span>
            <button className="primary" onClick={rotate}>Yes, rotate</button>
            <button onClick={() => setConfirmRotate(false)}>Cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirmRotate(true)}>Rotate API key</button>
        )}
      </div>

      <div className="card pad" style={{ marginTop: 14 }}>
        <label>Unity integration</label>
        <p className="small muted" style={{ marginTop: 0 }}>
          Package Manager → <i>Add package from git URL</i>:
        </p>
        <pre className="mono small" style={{ background: 'var(--bg)', padding: 12, borderRadius: 6, overflowX: 'auto' }}>
{`https://github.com/aqibshabbirdev/BugReporterUnity.git?path=unity-sdk/Packages/com.bugreporter.sdk`}
        </pre>
        <pre className="mono small" style={{ background: 'var(--bg)', padding: 12, borderRadius: 6, overflowX: 'auto' }}>{snippet}</pre>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="pad"><label>Builds</label></div>
        {builds.length === 0 ? <div className="empty">No builds seen yet — they appear with the first report.</div> : (
          <table>
            <thead><tr><th>Version</th><th>Platform</th><th>Reports</th><th>Open</th><th>First seen</th></tr></thead>
            <tbody>
              {builds.map(b => (
                <tr key={b.version}>
                  <td className="mono">{b.version}</td>
                  <td className="muted">{b.platform ?? '—'}</td>
                  <td>{b.report_count}</td>
                  <td>{b.open_count > 0 ? <b style={{ color: 'var(--amber)' }}>{b.open_count}</b> : 0}</td>
                  <td className="muted small">{fmtTime(b.first_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
