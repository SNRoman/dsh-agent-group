# Task 12 Implementation Report

## Result

Implemented the Browser task center at implementation commit `bae27ad` (`feat(web): add the task center`). The view projects root task trees from the canonical Workspace snapshot and the current activity stream, then exposes human task mutations only through the named Task 11 API methods.

## Projection decisions

- `projectTaskRoots(snapshot, activity)` is pure and preserves both inputs. It associates events through durable task, assignment, grant, child-run, attempt, and activity ids.
- Root trees, derived tasks, grants, children, activities, and event sequences use deterministic canonical ordering. Root ordering uses the earliest event related to the entire tree, not only the root assignment.
- Assignments retain the assigning actor and assignee; grants retain the granting human, grantee, active/expired state, and grant/revoke sequences.
- Delivery attempts fold canonical started, accepted, failed/interrupted, and result events. Retry is exposed only for an open task whose latest canonical delivery state is retryable.
- Child runs retain exact child ids, parent identities, terminal states/results, and their canonical event sequences.
- Task activities retain exact activity, agent, attempt, message, Session, and turn identities. An older refresh cannot replace a newer activity stream version.

## Actions and concurrency

- Root assignment, grant, revoke, root/derived cancellation, delivery retry, exact task-turn stop, and exact child stop call named `WorkspaceApiClient` methods with the currently rendered aggregate revision.
- No Browser action supplies an actor field. The Host remains authoritative for employment, assignment, grant, and task-state policy.
- Pending state is keyed by action and durable identity. One request disables only its own control; unrelated task controls remain usable.
- Stale-revision responses refresh snapshot/activity, preserve root-assignment input, and require an explicit retry. A successful retry uses the refreshed revision and then clears the submitted draft.
- `not-active` is successful convergence and refreshes canonical state without an error. `stopping` and `already-stopping` retain distinct localized status presentation.
- Structured task business failures map to locale-owned copy; unknown failures use the generic safe message and never display the Host diagnostic.

## TDD evidence

The initial focused RED failed because `task-view-model.ts` did not exist while the two existing suites remained green. A second RED failed because `WorkspaceTasks.tsx` did not exist. Later focused RED cycles caught:

- a root-tree event sequence omitted derived cancellation;
- root ordering ignored an earlier grant event;
- stale assignment retry did not clear the successfully submitted draft;
- a stale activity refresh could replace a newer stream version;
- a structured task business error rendered only the generic fallback.

Each failure was observed before its minimum production fix. Final focused command:

`pnpm vitest run tests/workspace-task-view.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts`

Result: 3 files, 50 tests passed.

## Verification evidence

- Directly affected RPC/activity/reconnect/client-copy regression command: 8 files, 222 tests passed.
- `pnpm verify:client-copy`: passed.
- `pnpm run typecheck`: passed.
- `pnpm run build:web`: passed.
- `pnpm test`: 30 files, 599 tests passed.
- `git diff --check`: passed before staging.
- `git diff --cached --check`: passed before the implementation commit.

Tests use deterministic promises and direct snapshot replacement; no sleeps, fixed ports, or listeners were added.

## Changed files and planned-file deviations

- Added `packages/web/src/client/task-view-model.ts`.
- Added `packages/web/src/client/WorkspaceTasks.tsx`.
- Updated `WorkspaceUi.tsx`, `locales.ts`, and `styles.ts`.
- Added `tests/workspace-task-view.spec.ts` and updated `workspace-view.spec.ts` and `workspace-locale.spec.ts`.
- `packages/web/src/client/api.ts` was intentionally unchanged. Task 11 already supplies strict named helpers for all seven Task 12 mutations and validates their response contracts; duplicating or weakening that API was unnecessary.

## Remaining risks

- Browser assembled-profile acceptance remains owned by the later end-to-end closure task.
- Runtime child details are limited to the durable child-run fields currently exposed by the Host; no second client-side authority or child database was introduced.
- The task center intentionally does not implement memory, definition history/synchronization, colleague-management expansion, or conversation feature work reserved for Tasks 13–15.
