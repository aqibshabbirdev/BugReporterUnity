// Thin fetch wrapper. Same-origin (Flask serves this SPA), so the session cookie just travels.

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!r.ok) {
    let msg = r.statusText
    try { msg = (await r.json()).error ?? msg } catch { /* non-json error body */ }
    throw new ApiError(r.status, msg)
  }
  return r.json() as Promise<T>
}

export interface Me { id: string; email: string; role: string }
export interface Project { id: string; name: string; created_at: number; apiKey?: string }
export interface Build {
  version: string; platform: string | null
  first_seen_at: number; report_count: number; open_count: number
}
export interface Game {
  game: string; report_count: number; open_count: number
}
export interface IssueRow {
  id: string; title: string; severity: string; status: string
  fixed_in_build: string | null; build_version: string; game: string; session: string; platform: string | null
  has_screenshot: number; created_at: number
}
export interface Sibling {
  id: string; title: string; severity: string; status: string
  platform: string | null; device_model: string; has_screenshot: number; created_at: number
}
export interface IssueDetail extends IssueRow {
  description: string; device_model: string; os_version: string
  screen_resolution: string; memory_mb: number
  metadata: Record<string, unknown>
  has_screenshot: number; has_logs: number; updated_at: number
  comments: { author: string; text: string; created_at: number }[]
  siblings: Sibling[]
}

export const api = {
  me: () => req<Me>('/api/auth/me'),
  login: (email: string, password: string) =>
    req<Me>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string, invite: string) =>
    req<Me>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, invite }) }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  projects: () => req<Project[]>('/api/projects'),
  createProject: (name: string) =>
    req<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  rotateKey: (pid: string) =>
    req<{ apiKey: string }>(`/api/projects/${pid}/rotate-key`, { method: 'POST' }),

  issues: (pid: string, filters: { build?: string; game?: string; status?: string }) => {
    const q = new URLSearchParams()
    if (filters.build) q.set('build', filters.build)
    if (filters.game) q.set('game', filters.game)
    if (filters.status) q.set('status', filters.status)
    const qs = q.toString()
    return req<IssueRow[]>(`/api/projects/${pid}/issues${qs ? `?${qs}` : ''}`)
  },
  issue: (iid: string) => req<IssueDetail>(`/api/issues/${iid}`),
  setStatus: (iid: string, status: string, fixedInBuild?: string) =>
    req<{ ok: boolean }>(`/api/issues/${iid}`, {
      method: 'PATCH', body: JSON.stringify({ status, fixedInBuild }),
    }),
  comment: (iid: string, text: string) =>
    req<{ ok: boolean }>(`/api/issues/${iid}/comments`, { method: 'POST', body: JSON.stringify({ text }) }),

  builds: (pid: string) => req<Build[]>(`/api/projects/${pid}/builds`),
  games: (pid: string) => req<Game[]>(`/api/projects/${pid}/games`),

  logsUrl: (iid: string) => `/api/issues/${iid}/logs.txt`,
  screenshotUrl: (iid: string) => `/api/issues/${iid}/screenshot.jpg`,
  thumbUrl: (iid: string) => `/api/issues/${iid}/thumb.jpg`,
}

export const fmtTime = (unix: number) => {
  const d = new Date(unix * 1000)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 90) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`
  return d.toLocaleDateString()
}
