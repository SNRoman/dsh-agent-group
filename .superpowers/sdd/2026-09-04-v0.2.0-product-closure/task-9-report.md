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

- A failure of both replacement registration and prior-role rollback leaves no installed role section until a later synchronization retries the refresh. The failure retains both causes and does not strand the per-agent delivery lane.
- Legacy claim attribution remains intentionally unresolved when the persisted event sequence cannot prove the revision. Such completed evidence is not converted into a model-visible result.
