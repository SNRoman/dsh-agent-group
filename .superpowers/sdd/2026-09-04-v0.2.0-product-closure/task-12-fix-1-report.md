# Task 12 Review Fix Round 1 Report

## Scope

- Base: `6298c683220ffdf688427aa8b110c1ee116dab29`
- Code commit: `2fedec627cfc140737b64edc18183bf07dcec72b`
- Commit subject: `fix(web): preserve task center convergence`
- Review source: `task-12-review-2.md`

The change is confined to Task 12 task-center state, projection, rendering, locale copy, direct test dependencies, and tests. It does not add Task 13–15 feature bodies or change Host authority, RPC endpoints, versions, published artifacts, tags, or the supported DSH checkout.

## Finding proofs

### 1. Committed mutation versus follow-up reads

`WorkspaceTasks.execute` now treats the named mutation as the success point. It extracts and installs a returned committed `WorkspaceSnapshot` directly (including the `value.state` returned by assignment and grant), clears only that action's retry and submitted draft, and then performs snapshot/activity reads in an independent failure block. A failed post-commit read renders localized `workspace.streamFailed`; it does not enter the mutation-error path or create a replay control.

The real DOM suite covers both independent read failures (`snapshot` and `activity`) after a committed assignment. In both cases the revision-13 committed snapshot is delivered, title and assignee are cleared, the stream notice is rendered, and no mutation Retry button exists.

### 2. Exact action-keyed manual retries

The former single `RetryAction | undefined` is now a `ReadonlyMap<string, RetryAction>`. Stale failures replace only their exact action key. Successful actions delete only their own key. Retry buttons carry localized action-specific accessible names, and retrying one key leaves unrelated retry controls intact.

Deterministic deferred DOM tests cover two stale cancellation actions settling in both orders, then retry one at the refreshed revision while the other remains. Separate deferred tests cover one stale and one successful cancellation settling stale-first and success-first, proving unrelated success cannot erase the manual retry.

### 3. Monotonic durable snapshot adoption

`selectNewerWorkspaceSnapshot` rejects any candidate below the currently installed durable revision. The shared store's `setSnapshot` action owns this rule, so subscription reads, manual refresh, Task 12 refreshes, and mutation results all pass through one revision-aware action instead of implementing local race checks.

The deterministic selector test proves revision N cannot replace N+1 in either arrival order and that a same-revision candidate remains admissible. The Task DOM harness also adopts snapshots monotonically while exercising the committed-mutation/read race.

### 4. Canonical provenance and cancellation history

The pure projection retains grant expiration reason (`revoked`, `root-terminal`, or unavailable) from canonical revocation events and root status. It also retains the cancellation event sequence and distinguishes a root-tree cascade from derived-only cancellation. The renderer now shows grantor, child parent, explicit revocation versus terminal expiry, cancellation scope and event sequence, and a localized unknown actor when no canonical assignment actor exists. It no longer substitutes `System` for missing actor evidence.

Projection assertions cover explicit revocation, terminal expiry, root cascade, and derived-only cancellation. Real DOM bilingual assertions cover Simplified Chinese and English grantor, child parent, explicit revocation, terminal expiry, both cancellation scopes, and missing assignment actor.

### 5. Real React DOM interaction and accessibility evidence

`tests/workspace-task-dom.spec.ts` uses the maintained React 18 `createRoot` renderer in a jsdom Vitest environment. It mounts the actual `WorkspaceTasks` component, updates native input/select values, dispatches DOM change/click events, and queries rendered labels, buttons, roles, disabled state, action-specific accessible names, and visible status text. It does not replace React's private dispatcher.

The suite exercises all seven named actions through rendered controls: root assignment, grant, revoke, task cancellation, delivery retry, exact task-turn stop, and exact child stop. It also covers exact per-control pending, concurrent stale/manual retries, committed mutation followed by each read failure, `not-active` convergence, current-revision retry, and bilingual control discovery. Existing private structural tests remain supplementary evidence only.

## TDD evidence

The initial environment attempt exposed that the Node-only suite could not import the Browser store and that `.spec.tsx` was outside the configured test include. The test was moved to the configured `.spec.ts` surface using `createElement`, and the pure durable selector was placed in the projection module so the store could consume it without making the unit suite load the Browser runtime.

The first behavioral RED run was:

```text
pnpm vitest run tests/workspace-task-view.spec.ts tests/workspace-task-dom.spec.ts
Test Files 2 failed (2)
Tests 8 failed | 15 passed (2 projection failures and 6 DOM failures)
```

The failures were the intended missing behavior: absent `expirationReason` and cancellation projection, missing durable selector, committed assignment not installed when activity refresh rejected, one global retry unable to expose two action-specific retry controls, and missing rendered provenance/localized unknown actor.

After the minimum implementation, the focused projection and DOM run passed 2 files / 23 tests. After adding both completion orders, both post-commit read failures, and bilingual accessibility/provenance assertions, the final focused Task/UI run passed 4 files / 62 tests.

## Dependency changes

The root development dependencies now declare the real DOM test runtime directly:

- `react` and `react-dom` for the actual React 18 root renderer;
- `@types/react` and `@types/react-dom` for its TypeScript surface;
- `jsdom` for Vitest's deterministic DOM environment.

`pnpm-lock.yaml` was updated by pnpm 11.7.0. No production package dependency or peer range changed.

## Verification

- `pnpm vitest run tests/workspace-task-view.spec.ts tests/workspace-task-dom.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts` — passed, 4 files / 62 tests.
- `pnpm vitest run tests/workspace-task-view.spec.ts tests/workspace-task-dom.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/workspace-rpc.spec.ts tests/workspace-activity-stream.spec.ts tests/workspace-async-dispatch.spec.ts tests/workspace-web-upgrade.spec.ts tests/workspace-ui-registration.spec.ts tests/client-copy-verifier.spec.ts` — passed, 10 files / 263 tests (before the final test-only expansion from 10 to 11 DOM cases).
- `pnpm verify:client-copy` — passed.
- `pnpm run typecheck` — passed.
- `pnpm run build:web` — passed.
- `pnpm test` — passed after the final test expansion, 31 files / 611 tests.
- `git diff --check` — passed before the code commit.
- `git diff --cached --check` — passed before the code commit.

## Remaining risk

- jsdom verifies React scheduling, DOM events, accessible labels/names, and exact disabled controls, but it does not replace the assembled-profile Browser acceptance scenario reserved for the later release-level task.
- Root-cascade presentation is derived from the canonical root cancellation record and current root-tree terminal state because the existing event schema has no mutation/cause identifier. No new durable field or storage version was introduced in this Task 12 repair.
- Post-commit read failure leaves canonical mutation state installed and exposes the existing outer workspace Refresh control through the surrounding overlay; the task center does not add a second refresh implementation.
