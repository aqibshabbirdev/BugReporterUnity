// The issue workflow, in the order work moves through it. Single source of truth: the filter tabs,
// the detail-page picker and the badges all read from here, so a new state is a one-line change.
// Mirrors api.STATUSES on the backend — keep the two in step.
export const STATUS_FLOW = ['open', 'pending', 'waiting_for_test', 'closed'] as const

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  pending: 'Pending',
  waiting_for_test: 'Waiting for test',
  closed: 'Closed',
}

// Badge form: lowercase to sit next to the severity pills, and short — the full "waiting for test"
// crowds the severity badge off a grid card.
export const STATUS_BADGE: Record<string, string> = {
  open: 'open',
  pending: 'pending',
  waiting_for_test: 'waiting',
  closed: 'closed',
}

// Shown under the picker so the middle two states don't get used interchangeably.
export const STATUS_HINT: Record<string, string> = {
  open: 'Reported, nobody on it yet.',
  pending: 'Someone is working on it.',
  waiting_for_test: 'Fix is in a build — a tester needs to retest it.',
  closed: 'Retested and done. Nothing left to do.',
}

// "Unresolved" = everything that still needs someone. Deliberately NOT the same as the `open` state —
// a pending or waiting-for-test issue is still unresolved. Matches the backend's open_count columns.
export const isUnresolved = (status: string) => status !== 'closed'
