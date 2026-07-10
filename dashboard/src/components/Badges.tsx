export const Severity = ({ v }: { v: string }) => (
  <span className={`badge sev-${v}`}>{v}</span>
)

const STATUS_LABEL: Record<string, string> = {
  open: 'open',
  fixed_in_build: 'fixed',
  verified: 'verified',
  wont_fix: "won't fix",
}

export const Status = ({ v, fixedIn }: { v: string; fixedIn?: string | null }) => (
  <span className={`badge st-${v}`}>
    {STATUS_LABEL[v] ?? v}{v === 'fixed_in_build' && fixedIn ? ` in ${fixedIn}` : ''}
  </span>
)
