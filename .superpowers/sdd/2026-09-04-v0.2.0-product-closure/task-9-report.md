# Task 9 Report: Role History and Synchronization

## Commit

Implementation commit: `c3e7d6b2e9730d357355123a094287eda005b26f` (`feat(host): project and synchronize role history`).

## RED evidence

The inherited implementation had one failing focused case: empty later synchronization advanced the aggregate revision instead of preserving the established rejection contract. After changing the test to require rejection without mutation, this command exited 1 with the expected failure:

```text
pnpm vitest run tests/state.spec.ts -t "rejects an empty later synchronization selection without mutation"
```

The role-refresh test initially used a permissive installer double. A duplicate-aware installer then reproduced the real system-prompt registry rule and exposed the replacement-order bug: both refresh cases failed because the new `agent-workspace:role` section was registered while the prior section still occupied that scoped name.

```text
pnpm vitest run tests/runtime.spec.ts -t "refreshes one resident role|keeps the prior role"
```

## GREEN evidence

After restoring empty-selection rejection, the focused state test passed 1/1. After changing role replacement to dispose the prior section before registration and reinstall it on registration failure, the two focused lifecycle cases passed 2/2.

The final focused command after all implementation changes exited 0 with 5 files and 101 tests passing:

```text
pnpm vitest run tests/state.spec.ts tests/definition-history.spec.ts tests/runtime.spec.ts tests/dispatcher.spec.ts tests/task-delivery-coordinator.spec.ts
```

The final runtime-only command passed 26/26 tests. An expanded task, activity, memory, and restart regression run before the final lifecycle-order correction passed 12 files and 222 tests; the final correction is covered by the runtime and five-file commands above.

The final type and build checks exited 0:

```text
pnpm run typecheck
pnpm run build:host
```

`git diff --check` and the staged pre-commit diff check exited 0 without output.

## Changed files

- `packages/host/src/definition-history.ts` adds immutable, number-ordered definition history with exact, derived, and unresolved creation-event attribution plus current/previous status and pinned agents.
- `packages/host/src/state.ts` records exact revision ids on new definition events, validates complete synchronization selections before mutation, supports selected employed and departed agents, and retains explicit rejection for an empty later synchronization.
- `packages/host/src/runtime.ts` serializes plugin-owned deliveries and role refresh, retains the Agent handle and Session across an idle barrier, replaces the scoped role section, and rolls back to the prior revision after registration failure.
- `packages/host/src/index.ts` installs exact role revisions, refreshes materialized selected employees after the durable mutation commits, and captures the installed revision at delivery admission.
- `packages/host/src/dispatcher.ts`, `packages/host/src/task-delivery-coordinator.ts`, `packages/host/src/task-delivery.ts`, and `packages/host/src/turn-tracker.ts` carry the captured claim revision through room replies, task acceptance, live completion, and recovery.
- `packages/host/src/invariant.ts` validates definition, room-reply, task-acceptance, and task-result revision ownership while allowing valid legacy events without revision ids.
- `packages/host/src/types.ts` exposes optional role revision attribution on agent-authored room-message commands.
- `tests/definition-history.spec.ts`, `tests/state.spec.ts`, `tests/runtime.spec.ts`, `tests/dispatcher.spec.ts`, and `tests/task-delivery-coordinator.spec.ts` cover projection purity, selective atomic synchronization, exact barriers, failure cleanup, and live/recovered revision attribution.

## Concurrency and recovery decisions

- Each employee has one promise lane for Host-owned room and task deliveries plus role refresh. A refresh waits behind earlier deliveries, waits for `Agent.whenIdle()`, performs the replacement inside `runMaintenance()`, and releases later deliveries only after replacement or rollback settles.
- The prompt registry permits one scoped section for a name. Refresh therefore disposes the prior section before installing the replacement. If installation fails, it reinstalls the prior immutable revision; if teardown fails, it keeps the prior revision recorded and releases the lane for retry. A double replacement-and-rollback failure reports both causes and leaves the lane retryable.
- The durable synchronization mutation commits before resident role refresh. A live turn retains the role revision captured when its serialized delivery starts; later deliveries capture the refreshed revision.
- New task acceptance events persist that captured revision. Recovery first uses the accepted event's exact revision; legacy recovery derives a revision only from ordered definition history, employment start, and assignment events at or before the acceptance sequence. Completed evidence with no provable revision settles as interrupted instead of using the agent's current revision.
- Role refresh changes only the scoped prompt contribution. Agent identity, Session binding, employment history, room membership, and personal memory remain in the durable aggregate and are not rematerialized.

## Remaining risks

- Legacy claim attribution remains intentionally unresolved when the persisted event sequence cannot prove the revision. Such completed evidence is not converted into a model-visible result.

## Review fix round 1

Fix commit: `9567209220f3fbafa40c2a8559f1b27bd67919db` (`fix(host): converge role refresh and recovery`).

The deterministic review RED command covered the four reported defects and exited 1 with five failures:

```text
pnpm vitest run tests/runtime.spec.ts tests/task-delivery-coordinator.spec.ts tests/definition-history.spec.ts -t "departure invalidates queued delivery|whole-pool teardown invalidates queued refresh|returns a committed revision|pending accepted recovery retains|derives authentic"
```

The failures proved that a queued delivery rematerialized a disposed employee, whole-pool teardown allowed a queued refresh to run, post-commit refresh failure rejected the committed command, pending accepted recovery wrote R2 instead of durable claim revision R1, and a count-matched `definition/revised`/`definition/revised` legacy sequence received invented provenance. A further deterministic maintenance barrier proved that disposal between `runMaintenance()` admission and its callback allowed a stale role write. A final refresh-after-departure RED proved that refresh could rematerialize under the new generation.

The fix captures each operation's generation when it enters the per-agent lane and checks it before execution. Single-agent disposal invalidates queued work; whole-pool disposal becomes terminal, invalidates every handle, admission, and operation id, disposes published handles, and awaits both admissions and operation tails. Fresh admission checks invalidation before hiding or recording its Session binding. Refresh requires a resident handle and rechecks generation inside the maintenance callback; refresh failure retires the resident before queued work can advance.

Host validates employment before pool delivery admission. After a revise or synchronize mutation commits, a resident refresh failure records `agent-role-refresh-failed`, retires the failed runtime while preserving its durable Session binding, and returns the committed state. A later delivery rematerializes from that binding and reads the durable revision; callers do not retry and create a duplicate revision or event.

Pending recovery now distinguishes an attempt accepted before restart from one first claimed during recovery. The former uses only the durable accepted-event revision, exact or provably derived, even when the recovered runtime reports a newer role. The latter may use the recovery-time role captured by its claim. Legacy definition history derives positions only for exactly one leading `definition/created` followed by `definition/revised` events.

Final review-fix verification:

```text
pnpm vitest run tests/state.spec.ts tests/definition-history.spec.ts tests/runtime.spec.ts tests/dispatcher.spec.ts tests/task-delivery-coordinator.spec.ts
pnpm vitest run tests/state.spec.ts tests/definition-history.spec.ts tests/runtime.spec.ts tests/dispatcher.spec.ts tests/task-delivery-coordinator.spec.ts tests/task-delivery.spec.ts tests/tasks.spec.ts tests/task-tools.spec.ts tests/activity-controller.spec.ts tests/workspace-activity-stream.spec.ts tests/memory.spec.ts tests/memory-query.spec.ts tests/restart.integration.spec.ts
pnpm run typecheck
pnpm run build:host
git diff --check
git diff --cached --check
```

The focused command passed 5 files and 108 tests. The expanded command passed 13 files and 179 tests. Typecheck and Host build exited 0, and both diff checks produced no output.

The remaining legacy-attribution behavior is deliberate: an accepted attempt without exact or structurally provable revision provenance settles as interrupted rather than inheriting a current role.

## Review fix round 2

Fix commit: `6f6d13729da50c91a9c780c49aafcfc63c4d98b4` (`fix(host): close employee admission teardown race`).

The deterministic RED command placed both single-agent and whole-pool teardown inside the awaited fresh-session hiding operation:

```text
pnpm vitest run tests/runtime.spec.ts -t "fresh-session hiding|started binding write"
```

It exited 1 with two failures because both hide-window cases called `recordSessionId()` after invalidation. The binding-write cases passed and established the supported ordering for a write already in progress: the binding may finish, but the invalidated handle and role are never published and the created handle is disposed exactly once.

`EmployeeAgentPool` now uses one admission-token assertion for `stopped` and per-agent generation. Create and resume admission revalidate that token after each awaited preparation or hiding operation and before the next side effect. Fresh creation checks before `agents.create()`, before and after hiding, and after the binding write. Teardown during option preparation therefore prevents agent creation; teardown during hiding disposes the already-created handle without writing a binding; teardown during a started binding write preserves the completed binding but disposes the handle without publishing it.

Final review-fix verification:

```text
pnpm vitest run tests/runtime.spec.ts
pnpm vitest run tests/state.spec.ts tests/definition-history.spec.ts tests/runtime.spec.ts tests/dispatcher.spec.ts tests/task-delivery-coordinator.spec.ts
pnpm vitest run tests/state.spec.ts tests/definition-history.spec.ts tests/runtime.spec.ts tests/dispatcher.spec.ts tests/task-delivery-coordinator.spec.ts tests/task-delivery.spec.ts tests/tasks.spec.ts tests/task-tools.spec.ts tests/activity-controller.spec.ts tests/workspace-activity-stream.spec.ts tests/memory.spec.ts tests/memory-query.spec.ts tests/restart.integration.spec.ts
pnpm run typecheck
pnpm run build:host
git diff --check
git diff --cached --check
```

The final runtime command passed 36/36 tests, the focused command passed 5 files and 112 tests, and the expanded command passed 13 files and 183 tests. Typecheck and Host build exited 0, and both diff checks produced no output.
