import { useEffect, useState } from 'react'
import { api, fmtTime, Invite, Me, Team, TeamSummary } from '../api'

// Members and invite codes of the signed-in user's team. The owner additionally sees every team's name
// and head-count and can create a team — but never another team's data.
export default function TeamPage({ me }: { me: Me }) {
  const [team, setTeam] = useState<Team | null>(null)
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [error, setError] = useState('')
  const [inviteRole, setInviteRole] = useState('dev')
  const [newTeam, setNewTeam] = useState('')
  const [created, setCreated] = useState<{ name: string; invite: Invite } | null>(null)
  const [copied, setCopied] = useState('')
  const isAdmin = me.role === 'admin'
  const joinUrl = `${window.location.origin}/login`

  const load = () => {
    api.team().then(setTeam).catch(e => setError(e.message))
    if (me.is_owner) api.teams().then(setTeams).catch(() => {})
  }
  useEffect(load, [])

  const act = async (fn: () => Promise<unknown>) => {
    setError('')
    try { await fn(); load() } catch (e) { setError(e instanceof Error ? e.message : 'failed') }
  }
  const copy = (text: string) => { navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(''), 1500) }
  const shareText = (code: string, teamName: string) =>
    `Join ${teamName} on Bug Reporter: open ${joinUrl}, choose "Register with an invite" and use the code ${code}`

  if (!team) return <div className="page">{error ? <div className="error">{error}</div> : null}</div>

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{team.name}</h1>
          <div className="sub">Everything in this team — projects, bug reports and API Tester collections — is visible only to its members.</div>
        </div>
        {isAdmin && (
          <button onClick={() => { const n = prompt('Team name', team.name); if (n && n.trim()) act(() => api.renameTeam(n.trim())) }}>Rename team</button>
        )}
      </div>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="card">
        <div className="pad"><label style={{ margin: 0 }}>Members · {team.members.length}</label></div>
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Joined</th>{isAdmin && <th />}</tr></thead>
          <tbody>
            {team.members.map(m => (
              <tr key={m.id}>
                <td>{m.email}{m.id === me.id && <span className="muted small"> (you)</span>}</td>
                <td>
                  {isAdmin && m.id !== me.id ? (
                    <select value={m.role} onChange={e => act(() => api.setMemberRole(m.id, e.target.value))} aria-label={`Role of ${m.email}`}>
                      <option value="dev">Dev</option>
                      <option value="admin">Admin</option>
                    </select>
                  ) : <span className={`role-badge ${m.role}`}>{m.role}</span>}
                </td>
                <td className="muted small">{fmtTime(m.created_at)}</td>
                {isAdmin && (
                  <td style={{ textAlign: 'right' }}>
                    {m.id !== me.id && (
                      <button className="danger" onClick={() => confirm(`Remove ${m.email} from ${team.name}? They are signed out and can't log in again.`) && act(() => api.removeMember(m.id))}>Remove</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="pad">
            <label>Invite codes</label>
            <p className="small muted" style={{ marginTop: 0 }}>
              Someone joins this team by registering at <span className="mono">{joinUrl}</span> → <i>Register with an invite</i> with one of these codes.
              A code keeps working until you revoke it.
            </p>
            <div className="row">
              <select value={inviteRole} onChange={e => setInviteRole(e.target.value)} aria-label="Role for the new code">
                <option value="dev">Joins as Dev</option>
                <option value="admin">Joins as Admin</option>
              </select>
              <button className="primary" onClick={() => act(() => api.createInvite(inviteRole))}>Create invite code</button>
            </div>
          </div>
          {team.invites.length === 0 ? <div className="empty">No invite codes yet.</div> : (
            <table>
              <thead><tr><th>Code</th><th>Joins as</th><th>Used</th><th>Created</th><th /></tr></thead>
              <tbody>
                {team.invites.map(i => (
                  <tr key={i.id}>
                    <td><span className="code-pill">{i.code}</span></td>
                    <td><span className={`role-badge ${i.role}`}>{i.role}</span></td>
                    <td>{i.uses}</td>
                    <td className="muted small">{fmtTime(i.created_at)} · {i.created_by}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button onClick={() => copy(shareText(i.code, team.name))}>{copied === shareText(i.code, team.name) ? 'Copied' : 'Copy message'}</button>{' '}
                      <button className="danger" onClick={() => confirm('Revoke this code? Nobody new can join with it.') && act(() => api.revokeInvite(i.id))}>Revoke</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {me.is_owner && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="pad">
            <label>All teams (owner)</label>
            <p className="small muted" style={{ marginTop: 0 }}>
              A new team starts empty and separate. You get one admin invite code for it; after that only its members see its data — you see just the name and counts here.
            </p>
            {created && (
              <div className="card pad" style={{ marginBottom: 12 }}>
                <b>{created.name}</b> created. Send this admin invite code to the person who will run that team:
                <div className="keybox mono">{created.invite.code}</div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button onClick={() => copy(shareText(created.invite.code, created.name))}>{copied === shareText(created.invite.code, created.name) ? 'Copied' : 'Copy message'}</button>
                  <button onClick={() => setCreated(null)}>Done</button>
                </div>
              </div>
            )}
            <div className="row">
              <input placeholder="New team name" value={newTeam} onChange={e => setNewTeam(e.target.value)} style={{ flex: 1 }}
                     onKeyDown={e => e.key === 'Enter' && newTeam.trim() && act(async () => { const r = await api.createTeam(newTeam.trim()); setCreated(r); setNewTeam('') })} />
              <button className="primary" disabled={!newTeam.trim()}
                      onClick={() => act(async () => { const r = await api.createTeam(newTeam.trim()); setCreated(r); setNewTeam('') })}>Create team</button>
            </div>
          </div>
          <table>
            <thead><tr><th>Team</th><th>Members</th><th>Projects</th><th>Created</th></tr></thead>
            <tbody>
              {teams.map(t => (
                <tr key={t.id}>
                  <td>{t.name}{t.id === me.team_id && <span className="muted small"> (yours)</span>}</td>
                  <td>{t.members}</td>
                  <td>{t.projects}</td>
                  <td className="muted small">{fmtTime(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
