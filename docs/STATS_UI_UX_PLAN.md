# Match Analytics UI/UX implementation plan

Date: 2026-10-09
Page: https://pandabugsreporting.com/stats
Implementation: `backend/app/stats.py` (Flask-served standalone page)

## Goal
Make daily match activity easy to scan and player investigations easy to navigate. Preserve existing authenticated APIs, match timelines, server logs and AI prompt generation.

## Review evidence
The authenticated production page showed four colorful KPI cards, a large flagged-player section above the daily table, dense game breakdowns, and inline match/log expansion. Sample player records were marked individually. Local source inspection confirms that flag counts mix event occurrences with generated pattern signals; counts must not be relabeled as distinct flag types or summed into a misleading occurrence total.

## Phase 1 — implemented locally
- [x] Dashboard return link and clear Match Analytics title.
- [x] Separate Overview and Player flags views with selected-state feedback.
- [x] Period toolbar, refresh, PKT timezone and last-successful-update time.
- [x] Neutral KPI cards; explicit top-game and incomplete-today labels.
- [x] Daily bar chart with accessible counts and click-to-expand day navigation.
- [x] Hide inactive days option.
- [x] Keyboard-operable day and flag expansion with expanded-state attributes.
- [x] Friendly labels for repeated-roll, invalid-request, repeated-pair and fast-win signals.
- [x] Preserve backend count semantics with “review signals” labeling and pattern-count explanation.
- [x] Loading, request-failure and retry feedback for overview and flag summary.
- [x] Match-request errors remain distinct from empty days.
- [x] Guard stale daily/flag responses during period changes.
- [x] Responsive KPI layout, wrapping controls and larger touch targets.
- [x] Describe the AI action as prompt copying.

## Phase 2 — implementation progress
- [x] Inline match browsing with player/ID search, game filtering and 10-per-page pagination. Logs open in an accessible side-panel inspector; mobile uses full screen.
- [x] Project/game filters with team-scoped IDs and consistent game scope across daily counts, match lists, flag summaries and evidence.
- [x] Compact game breakdown chips and expandable full breakdown.
- [x] Copyable short player IDs in match cards and expanded flag evidence, with full ID tooltip and clipboard fallback.
- [x] Structured pattern evidence showing opponents and supporting matches.
- [x] Server-log severity filters, matching-line count, truncation notice, explicit close and retry actions.
- [x] Login return URL integration with the React dashboard. Only the exact `/stats` return target is allowed.
- [x] Demo-data banner driven by explicit `BR_STATS_SAMPLE_DATA=true` deployment metadata. Disabled by default for mixed/production datasets.
- [x] Previous-period comparison using two equally sized complete PKT day windows, excluding today, with a no-baseline state.
- [x] Loading skeletons and request-error/retry handling for match logs, server logs and AI prompt generation; stale server-log mode responses do not overwrite the active tab.

## Validation
- Python compilation and extracted inline JavaScript syntax checks passed.
- `git diff --check` passed.
- Local browser preview uses synthetic fixtures, not production data or credentials.
- Verified Overview/Player flags switching, chart-to-day expansion and inactive-day filtering.
- Inspected mobile overview at 390 × 844: two-column cards and wrapped toolbar fit the viewport.
- Phase 2 fixture checks: empty search state, 12-match pagination (10 then 2), server-log loading and error severity filtering (1 of 3 loaded lines).
- Five isolated SQL regression tests pass: team/project/game boundaries, invalid game input, complete-day comparison, period-scoped evidence and explicit sample metadata.
- Dashboard TypeScript/Vite production build passes; built assets included.
- Deployed via SFTP after saving previous stats source and dashboard index under `/tmp/pandabugs-stats-backup/`; Passenger restart marker uploaded.
- Live authenticated verification: overview, game filter (Ludo: 16 matches), scoped flags (2 players), paginated match list, event timeline and Raw JSON inspector.
- Live mobile check at 390 × 844: document scroll width equals viewport width (no horizontal overflow).
- Screenshots: `docs/screenshots/stats-desktop.jpg`, `docs/screenshots/stats-mobile.jpg`.
- Live sample-match server logs return an upstream XML ParseError. The UI correctly exposes the failure and retry control; successful server-log filtering was tested with fixture data. This external log-source issue is not represented as a successful live download.
- Fresh credential login and AI-token issuance were not exercised against production; login target is allowlisted and AI network errors are handled. No user credentials or AI tokens are stored in the report.

## Verification limits
The implemented scope is deployed. The tests above distinguish live verification from fixtures. No database migrations were required. Keep the saved source/index backup for rollback; older hashed JS assets remain on the server for cached pages. The sample-match upstream log-source failure remains an operational limitation.

## Visual refinement — 2026-10-09
- Replaced native edge-aligned select arrows with a consistent 16px chevron inset and 48px text clearance across all select controls.
- Grouped filters into labelled responsive columns; timezone and update metadata have a separate aligned row.
- Defined navy text, indigo actions, teal activity and amber review tokens, including dark-mode equivalents.
- Refined header hierarchy, underline navigation, tinted KPI surfaces, table spacing, chart guides and hover/focus/disabled states.
- Browser verification confirmed 48px right padding, 16px arrow inset and no horizontal overflow at 390px.
