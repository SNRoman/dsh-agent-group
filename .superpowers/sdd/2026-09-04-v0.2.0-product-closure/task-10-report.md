# Task 10 Report

## Mutation inventory

The Browser RPC owns 19 mutation paths. Every payload requires a non-negative integer `expectedRevision`, uses strict parsing, converts identifiers to their branded Host types, and returns `{ revision, value }`.

1. `definition/create`
2. `definition/revise`
3. `definition/synchronize`
4. `agent/create`
5. `agent/depart`
6. `agent/employ`
7. `room/create`
8. `room/direct/open`
9. `room/join`
10. `room/leave`
11. `room/post`
12. `task/assign`
13. `task/grant`
14. `task/revoke`
15. `task/cancel`
16. `task/retry-delivery`
17. `runtime/activity/stop`
18. `runtime/child/stop`
19. `runtime/failure/acknowledge`

Read endpoints added for `memory/query`, `runtime/activity/snapshot`, `runtime/activity/wait`, and `definition/history`. The existing snapshot, runtime status, and stream aliases remain explicit. No arbitrary command endpoint is registered.

## TDD evidence

Initial RED command:

```text
pnpm vitest run tests/workspace-rpc.spec.ts tests/host-consistency.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-async-dispatch.spec.ts
```

Observed exit code 1: 3 files failed, 1 passed; 18 tests failed and 42 passed. The failures named missing revision forwarding/result wrappers, absent named endpoints, and both same-revision CAS races.

Additional focused RED controls caught two ordering defects:

- `a converged runtime stop validates CAS without changing durable revision` observed revision `1` instead of `0`.
- `a stale human post fails before durable recording or runtime lookup` received the unavailable-dispatcher error instead of `stale-revision`.
- `task assignment rejects a missing delivery runtime before committing` observed a committed task, assignment, event, and memory row.

Final GREEN evidence:

```text
pnpm vitest run tests/workspace-rpc.spec.ts tests/host-consistency.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-async-dispatch.spec.ts
# 4 files passed; 92 tests passed

pnpm vitest run tests/workspace-rpc.spec.ts tests/host-consistency.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-async-dispatch.spec.ts tests/tasks.spec.ts tests/task-delivery.spec.ts tests/task-delivery-coordinator.spec.ts tests/activity-controller.spec.ts tests/child-runs.spec.ts tests/memory-query.spec.ts tests/definition-history.spec.ts tests/workspace-activity-stream.spec.ts tests/dispatcher.spec.ts tests/runtime.spec.ts tests/restart.integration.spec.ts
# 15 files passed; 231 tests passed

pnpm exec tsc -p tests/types/tsconfig.json --noEmit
# exit 0

pnpm run typecheck
# exit 0

pnpm run build:host
# exit 0

git diff --check
# exit 0
```

## Implementation and ordering

`AgentWorkspaceDomainService` centralizes Browser mutations in a helper that checks cancellation and compares `expectedRevision` with `current.revision` inside the serialized `table.update` callback before calling the domain mutation. A mismatch throws `WorkspaceBusinessError('stale-revision', { expectedRevision, actualRevision })` before id allocation, event creation, state publication, or runtime work.

Host-owned delivery, settlement, session-binding, and repair writes retain an explicitly named internal command path. This keeps their authoritative current-state serialization without accepting a stale Browser revision.

Human room posting now resolves direct-room policy, wake targets, authorization, message creation, and the source event in the same CAS-protected update. The dispatcher receives only the committed event and schedules wake work afterward. A deterministic same-revision race proves one message commits and only that winner starts continuation.

Task cancellation captures affected queued deliveries, live activities, and child runs inside the committed mutation. Inbox removal, activity cancellation, and child stopping run only after the update returns. Task assignment resolves the delivery coordinator inside the CAS callback before domain mutation, commits the assignment, then starts delivery after commit. Delivery failures remain owned by the coordinator's durable safe failure projection.

Runtime-only activity stop and failure acknowledgement perform a serialized CAS check without advancing the durable aggregate revision. Child stop and retry perform the same check before their existing convergence/delivery operations; their returned revision is read after those operations settle.

## Changed files

- `packages/host/src/index.ts`
- `packages/host/src/rpc.ts`
- `packages/host/src/errors.ts`
- `packages/host/src/dispatcher.ts`
- `tests/workspace-rpc.spec.ts`
- `tests/host-consistency.spec.ts`
- `tests/workspace-direct-room.spec.ts`
- `tests/workspace-async-dispatch.spec.ts`
- `tests/types/workspace-errors.ts`
- `tests/activity-controller.spec.ts`
- `tests/runtime.spec.ts`
- `tests/restart.integration.spec.ts`
- `tests/fixtures/browser/task-tools-profile.ts`

The last four test/support files outside the original primary list were migrated because public Host mutation methods now require `expectedRevision`; their Host-owned setup calls use the private internal command path or supply the committed revision explicitly. `packages/host/src/dispatcher.ts` is the sole additional production file and exposes continuation of an already committed human message so Browser CAS remains inside the durable update.

## Commit and remaining risks

Implementation commit: `f28055156192b4c8d7fa574c3a2c1d1ce37b4280` (`feat(host): expose revisioned workspace operations`).

The Host layer is complete, but the existing Browser client still sends the pre-Task-10 mutation payloads and consumes unwrapped mutation values. The next Browser integration task must add `expectedRevision`, unwrap `{ revision, value }`, and handle stale refresh/retry behavior. Runtime-only controls intentionally do not create durable facts or revision increments; their exact controllers remain responsible for idempotent `already-stopping` and `not-active` convergence after the CAS check.

## Review fix round 1

Review-fix commit: `1691662` (`fix(host): close revisioned mutation races`).

The review fix additionally changes `packages/host/src/child-controller.ts`, `packages/host/src/task-delivery-coordinator.ts`, and `tests/child-runs.spec.ts`. The controllers own reservation rollback and delivery continuation, so keeping those lifecycle changes in `index.ts` would duplicate their settlement state machines. The Browser task-tools fixture uses a test-local narrow cast solely to seed its recorded-session state after the generic methods became private.

Child stop now reserves the exact controller and creates `child/run-finished` inside the caller's revision-checked table callback. Persistence rejection rolls the reservation back to a live controller and releases any waiting runtime settlement; persistence success aborts and removes the exact controller only after commit. Task retry creates `task/delivery-started` in that same caller-owned update, continues runtime delivery afterward, and returns the revision of the delivery-start commit rather than a later snapshot revision.

A human post with wake targets captures the current dispatcher after the cancellation and revision checks but before message mutation. An unavailable dispatcher leaves the aggregate unchanged. If the runtime generation tears down after capture, the captured dispatcher owns continuation and the pending counter always converges through its completion handler.

The generic unrevisioned `executeInternal` and `apply` methods are private. Dispatcher, child settlement, task delivery, and task tools receive only explicitly assembled internal capability objects. `memory/query` constructs `RoomId`, `TaskId`, or `ChildRunId` according to `sourceKind` and rejects an ambiguous `sourceId` before invoking the service.

The expanded acceptance matrix now covers all 19 mutations for strict extra-field parsing, required numeric revision, pre-cancellation, named forwarding and branded conversion, stable human identity, committed result wrapping, and real-service stale details with unchanged durable/runtime/activity projections. Real committed-revision coverage includes all 11 existing mutations, all five task mutations, and all three controls. Named read/control coverage includes memory filters, cursor success and failure, all three source kinds, exact and unresolved history, activity snapshot/wait cancellation, both stop methods' three convergence results, persisted child cancellation and rollback, and failure acknowledgement.

Review-fix RED evidence:

```text
pnpm vitest run tests/workspace-rpc.spec.ts tests/host-consistency.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-async-dispatch.spec.ts
# exit 1; 1 of 4 files failed; 4 tests failed and 110 passed

pnpm exec tsc -p tests/types/tsconfig.json --noEmit
# exit 1; two TS2578 errors proved the unrevisioned methods remained public

pnpm vitest run tests/child-runs.spec.ts
# exit 1; 1 test failed and 5 passed; a rollback discarded the waiting runtime winner
```

Review-fix GREEN evidence:

```text
pnpm vitest run tests/workspace-rpc.spec.ts tests/host-consistency.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-async-dispatch.spec.ts
# 4 files passed; 160 tests passed

pnpm vitest run tests/workspace-rpc.spec.ts tests/host-consistency.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-async-dispatch.spec.ts tests/tasks.spec.ts tests/task-delivery.spec.ts tests/task-delivery-coordinator.spec.ts tests/activity-controller.spec.ts tests/child-runs.spec.ts tests/memory-query.spec.ts tests/definition-history.spec.ts tests/workspace-activity-stream.spec.ts tests/dispatcher.spec.ts tests/runtime.spec.ts tests/restart.integration.spec.ts tests/task-tools.spec.ts
# 16 files passed; 313 tests passed

pnpm exec tsc -p tests/types/tsconfig.json --noEmit
pnpm run typecheck
pnpm run build:host
git diff --check
# all exit 0
```
