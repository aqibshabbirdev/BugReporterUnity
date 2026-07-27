import { STATUS_BADGE } from '../status'

export const Severity = ({ v }: { v: string }) => (
  <span className={`badge sev-${v}`}>{v}</span>
)

export const Status = ({ v, fixedIn }: { v: string; fixedIn?: string | null }) => (
  <span className={`badge st-${v}`}>
    {STATUS_BADGE[v] ?? v}{v === 'waiting_for_test' && fixedIn ? ` in ${fixedIn}` : ''}
  </span>
)
