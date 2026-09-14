# Task 14 implementation report

## Scope

Task 14 adds one canonical runtime activity projection and an accessible workspace drawer for exact Host-owned controls.

Implementation commit: `e68970a feat(web): add exact runtime controls`

## Evidence

Inherited controller evidence reported before takeover:

- The previous implementer ran the initial focused suite: 8 files, 180 tests passed.
- The previous implementer ran an affected suite: 14 files, 328 tests passed.
- The inherited implementation covered shared projection across the header, rooms, colleagues, tasks, and drawer; monotonic reconnect replacement; independent stale-acknowledgement refresh; and stale stop-retry pruning when an identity changes.

The prior terminal transcript did not include a preserved RED run. This takeover did not rewrite already-present production code merely to recreate a historical RED result. The inherited test additions remain the regression coverage, and fresh GREEN evidence follows.

Fresh takeover evidence:

| Command | Result |
| --- | --- |
| `pnpm exec vitest run tests/workspace-activity-dom.spec.ts tests/workspace-activity-store.spec.ts tests/workspace-activity-view.spec.ts` | 3 files, 8 tests passed |
| `pnpm exec vitest run tests/workspace-activity-dom.spec.ts tests/workspace-activity-store.spec.ts tests/workspace-activity-view.spec.ts tests/workspace-view.spec.ts tests/workspace-task-view.spec.ts tests/workspace-locale.spec.ts tests/workspace-web-upgrade.spec.ts` | 7 files, 155 tests passed |
| `pnpm exec vitest run tests/workspace-activity-stream.spec.ts tests/turn-tracker-errors.spec.ts tests/workspace-rpc.spec.ts tests/workspace-task-view.spec.ts tests/workspace-task-dom.spec.ts tests/workspace-memory-view.spec.ts tests/client-copy-verifier.spec.ts tests/workspace-web-upgrade.spec.ts` | 8 files, 249 tests passed |
| `pnpm verify:client-copy` | passed |
| `pnpm typecheck` | passed |
| `pnpm build` | passed: host, web, and bundle |
| `pnpm test` | 36 files, 677 tests passed |
| `git diff --check` and `git diff --cached --check` | passed with no output |

## Decisions

- `projectWorkspaceActivity()` is pure, clones detail/error values, orders by `startOrder` then durable id, and selects duplicate ids deterministically. It resolves labels only from the canonical workspace and does not grant unknown subjects controls.
- Header, room rows, colleague rows, task projection, and the drawer consume that shared projection. Task delivery activity remains separate from durable-task cancellation.
- The drawer sends only the exact Host-provided stop identity. Per-action pending and convergence sets keep unrelated controls enabled. `not-active` is a successful convergence; stale writes refresh durable state and render an explicit retry.
- Acknowledgement refresh begins the activity refresh independently of the durable snapshot refresh, so its retry becomes available without waiting on the activity read. Retry/convergence entries expire when the authoritative activity or failed summary no longer matches.
- The long-poll cursor retains the greatest adopted activity version across reconnects. Full snapshots replace prior state through the monotonic selector; a non-advancing response stops the subscription and exposes the explicit reconnect control rather than spinning.
- The unit Vitest project aliases only the two browser-only runtime/primitives imports to existing test fixtures. The new direct store and React DOM suites need those fixtures; the locale project already used the same mappings. No production import resolution changes.

## Changed files and deviations

- Added `activity-view-model.ts`, `WorkspaceActivityDrawer.tsx`, and focused projection/store/DOM tests.
- Updated the planned workspace, task, turn, store, locale, styles, and view tests to use the shared runtime presentation and reconnect behavior.
- `task-view-model.ts` now consumes the shared projection instead of reimplementing task activity facts.
- `vitest.config.ts` is the only planned-file deviation. Its narrow unit-project aliases make the browser-only imports testable from the new source-level store and drawer tests.
- No Task 15 end-to-end completion or phase-three compatibility behavior was added.

## Risks

- Runtime activity is intentionally process-local and only reflects rows retained by the Host snapshot. The browser does not add timer-based retirement.
- A stale retry is deliberately manual after canonical refresh; automatic replay would risk applying an action to a different ownership identity.
