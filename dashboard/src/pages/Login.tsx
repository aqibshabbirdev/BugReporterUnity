import { FormEvent, useState } from 'react'
import { api, Me } from '../api'

export default function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const me = mode === 'login'
        ? await api.login(email, password)
        : await api.register(email, password, invite)
      onLogin(me)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <h1>🐞 Bug Reporter</h1>
        <p className="sub">In-game bug reports, with the evidence attached.</p>
        <div className="card pad">
          <form onSubmit={submit}>
            <div>
              <label>Email</label>
              <input style={{ width: '100%' }} type="email" value={email}
                     onChange={e => setEmail(e.target.value)} autoFocus required />
            </div>
            <div>
              <label>Password</label>
              <input style={{ width: '100%' }} type="password" value={password}
                     onChange={e => setPassword(e.target.value)} required minLength={8} />
            </div>
            {mode === 'register' && (
              <div>
                <label>Invite code</label>
                <input style={{ width: '100%' }} value={invite}
                       onChange={e => setInvite(e.target.value)}
                       placeholder="from your team admin" />
              </div>
            )}
            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={busy}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        </div>
        <p className="sub" style={{ marginTop: 14 }}>
          {mode === 'login'
            ? <>New here? <a href="#" onClick={e => { e.preventDefault(); setMode('register') }}>Register with an invite</a></>
            : <>Have an account? <a href="#" onClick={e => { e.preventDefault(); setMode('login') }}>Sign in</a></>}
        </p>
      </div>
    </div>
  )
}
