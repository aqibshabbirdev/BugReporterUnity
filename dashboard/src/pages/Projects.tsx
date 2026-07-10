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
      <h1>Projects</h1>

      {newKey && (
        <div className="card pad" style={{ marginBottom: 14 }}>
          <b>{newKey.name}</b> created. This API key is shown <b>once</b> — put it in your game's
          BugReporter config now:
          <div className="keybox mono">{newKey.apiKey}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => navigator.clipboard.writeText(newKey.apiKey ?? '')}>Copy key</button>
            <button onClick={() => setNewKey(null)}>Done, I saved it</button>
          </div>
        </div>
      )}

      <div className="card">
        {projects.length === 0
          ? <div className="empty">No projects yet — create your game below.</div>
          : (
            <table>
              <thead><tr><th>Name</th><th>Created</th><th /></tr></thead>
              <tbody>
                {projects.map(p => (
                  <tr key={p.id} className="click" onClick={() => nav(`/p/${p.id}`)}>
                    <td><b>{p.name}</b></td>
                    <td className="muted">{fmtTime(p.created_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <a href="#" onClick={e => { e.preventDefault(); e.stopPropagation(); nav(`/p/${p.id}/settings`) }}>settings</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      <div className="card pad" style={{ marginTop: 14 }}>
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
