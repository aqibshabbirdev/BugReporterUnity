import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom'
import { api, Me } from './api'
import Login from './pages/Login'
import Projects from './pages/Projects'
import Issues from './pages/Issues'
import IssueDetail from './pages/IssueDetail'
import Settings from './pages/Settings'

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const nav = useNavigate()
  return (
    <>
      <div className="topbar">
        <span className="brand" style={{ cursor: 'pointer' }} onClick={() => nav('/')}>🐞 Bug Reporter</span>
        <span className="spacer" />
        <span className="muted small">{me.email}</span>
        <button onClick={async () => { await api.logout(); onLogout() }}>Sign out</button>
      </div>
      <Outlet />
    </>
  )
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null)).finally(() => setChecked(true))
  }, [])

  if (!checked) return null // one blank frame while the session check runs

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={me ? <Navigate to="/" /> : <Login onLogin={setMe} />} />
        {me ? (
          <Route element={<Shell me={me} onLogout={() => setMe(null)} />}>
            <Route path="/" element={<Projects />} />
            <Route path="/p/:pid" element={<Issues />} />
            <Route path="/p/:pid/settings" element={<Settings />} />
            <Route path="/i/:iid" element={<IssueDetail />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/login" />} />
        )}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  )
}
