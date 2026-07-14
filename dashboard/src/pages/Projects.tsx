import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, fmtTime, Project } from '../api'

export default function Projects() {
  const nav = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState<Project | null>(null)
  const [error, setError] = useState('')

  const load = () => { api.projects().then(setProjects).catch(e => setError(e.message)) }
  useEffect(load, [])

  const create = async () => {
    if (!name.trim()) return
    try {
      const p = await api.createProject(name.trim())
      setNewKey(p)           // apiKey is only ever present on this response
      setName('')
      load()
    } catch (e) { setError(e instanceof Error ? e.message : 'failed') }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <div className="sub">Each game project has its own API key and issue stream.</div>
        </div>
      </div>

      {newKey && (
        <div className="card pad" style={{ marginBottom: 18 }}>
          <b>{newKey.name}</b> created. This API key is shown <b>once</b> — put it in your game's
          BugReporter config now:
          <div className="keybox mono">{newKey.apiKey}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => navigator.clipboard.writeText(newKey.apiKey ?? '')}>Copy key</button>
            <button onClick={() => setNewKey(null)}>Done, I saved it</button>
          </div>
        </div>
      )}

      {projects.length === 0
        ? <div className="card"><div className="empty"><div className="big">No projects yet.</div><span className="small">Create your first project below.</span></div></div>
        : (
          <div className="proj-grid">
            {projects.map(p => (
              <div key={p.id} className="proj-card" onClick={() => nav(`/p/${p.id}`)}>
                <div className="avatar">{p.name.trim().charAt(0).toUpperCase() || '?'}</div>
                <div className="pname">{p.name}</div>
                <div className="pfoot">
                  <span className="muted small">{fmtTime(p.created_at)}</span>
                  <a href="#" onClick={e => { e.preventDefault(); e.stopPropagation(); nav(`/p/${p.id}/settings`) }}>Settings →</a>
                </div>
              </div>
            ))}
          </div>
        )}

      <div className="card pad" style={{ marginTop: 18 }}>
        <label>Create a new project</label>
        <div className="row">
          <input placeholder="New project name" value={name}
                 onChange={e => setName(e.target.value)}
                 onKeyDown={e => e.key === 'Enter' && create()} style={{ flex: 1 }} />
          <button className="primary" onClick={create}>Create project</button>
        </div>
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </div>
  )
}
