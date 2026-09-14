# Task 14 review fix round 1 report

Implementation commit: `0de0edb fix(web): preserve runtime stream ownership`

## Review findings

### One monotonic activity adoption path

RED: `pnpm exec vitest run tests/workspace-activity-dom.spec.ts` reproduced the deferred race. An initial version-5 wait remained pending, manual refresh adopted version 10, the wait returned version 6, and the next `waitForActivity` call incorrectly used version 6.

GREEN: `WorkspaceOverlay` now routes initial snapshots, wait responses, manual refreshes, task refreshes, and drawer refreshes through one `adoptActivity` function. It raises `activityVersionRef` synchronously before publishing React projections. Each wait records its requested version: a response that advanced beyond that request but is below the greatest adopted version is ignored and the loop immediately waits from the greatest version; a response that did not advance beyond its own request still stops with retry UI. The deterministic version-10/version-6 barrier now observes the next wait at version 10 without a duplicate or stream error.

### Manual refresh lifecycle ownership

RED: the same first run showed all eight close/unmount matrix cases failing because manual refresh passed no signals; both recorded arguments were `undefined`, so neither request could be aborted.

GREEN: manual refresh owns an `AbortController` and generation token. Replacement refresh, workspace close, reconnect-effect cleanup, and component unmount invalidate the generation and abort both RPC calls. Completion, rejection, and `finally` publish only while the controller and generation remain current. Real-DOM deferred tests cover snapshot and activity completion/rejection after close and unmount, plus replacement refresh; they assert no late durable/activity projection, error, or busy write.

### Drawer focus and selection semantics

RED: the drawer focus assertion observed the external trigger after open, and both activity choices returned no `aria-pressed` value.

GREEN: opening the drawer focuses its stable close button. Close and Escape restore the exact trigger. Activity choice buttons expose `aria-pressed`, and real-DOM coverage exercises open, selection, rerendered selection state, Escape close, and focus restoration. Existing locale coverage continues to verify localized drawer names in Chinese and English.

### Narrow Browser source fixtures

The aliases were removed from the project containing every unit test. A dedicated `browser-source` project now includes only the seven suites that directly execute Browser source components or the source store:

- `workspace-activity-dom.spec.ts`
- `workspace-activity-store.spec.ts`
- `workspace-definition-view.spec.ts`
- `workspace-memory-view.spec.ts`
- `workspace-task-dom.spec.ts`
- `workspace-task-view.spec.ts`
- `workspace-view.spec.ts`

The existing locale project retains the same fixtures for its source renderer. All other unit suites retain normal installed-package resolution. An intermediate run without any narrow source project confirmed why those direct source suites need the fixtures: Node cannot execute the Browser runtime's `window.__ModuleLoader__` wrapper, and the published UI primitives load CSS modules. This is test-environment isolation, not evidence of installed client integration. `pnpm build` is the current real installed-module resolution gate. Assembled execution of the built client in a real Browser remains Task 15.

## Added real-DOM coverage

The drawer/overlay suite now covers queued, unclaimed, and foreign no-stop presentation; stopping and already-stopping convergence; stale stop retry pruning after identity replacement; successful acknowledgement convergence; display-safe generic errors; exact selection semantics; open and restore focus; and suppression after unmount. Existing assertions continue to cover exact stop/acknowledgement payloads, per-action pending, `not-active`, and independent stale refresh.

## Verification

| Command | Result |
| --- | --- |
| `pnpm exec vitest run tests/workspace-activity-dom.spec.ts` before production changes | RED: 14 tests, 11 expected failures covering findings 1–3 |
| `pnpm exec vitest run tests/workspace-activity-dom.spec.ts` after minimum fixes | GREEN: 14 tests passed |
| `pnpm exec vitest run tests/workspace-activity-dom.spec.ts` after coverage audit | 21 tests passed |
| `pnpm exec vitest run tests/workspace-activity-dom.spec.ts tests/workspace-activity-store.spec.ts tests/workspace-activity-view.spec.ts tests/workspace-view.spec.ts tests/workspace-task-view.spec.ts tests/workspace-locale.spec.ts tests/workspace-web-upgrade.spec.ts` | 7 files, 172 tests passed |
| `pnpm exec vitest run tests/workspace-activity-stream.spec.ts tests/turn-tracker-errors.spec.ts tests/workspace-rpc.spec.ts tests/workspace-view.spec.ts tests/workspace-activity-dom.spec.ts tests/workspace-task-view.spec.ts tests/workspace-task-dom.spec.ts tests/workspace-memory-view.spec.ts tests/client-copy-verifier.spec.ts tests/workspace-web-upgrade.spec.ts` | 10 files, 301 tests passed |
| `pnpm verify:client-copy` | passed |
| `pnpm typecheck` | passed |
| `pnpm build` | Host, Web, and bundle passed |
| `pnpm test` | 36 files, 694 tests passed |
| `git diff --check` and `git diff --cached --check` | passed with no output |

## Risks

- The activity cursor is process-local by design and resets only when the workspace closes; reconnect within an open workspace retains the greatest adopted version.
- Manual refresh and the long-poll subscription have separate controllers. Closing or replacing the subscription cancels both, while completing one path cannot cancel the other during normal open operation.
- Source-component tests still use intentionally narrow Browser fixtures. They do not replace Task 15's assembled real-Browser evidence.
