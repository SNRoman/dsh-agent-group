# Task 11 Report

## Browser contract inventory

The Browser now mirrors the complete Task 10 wire model in `packages/web/src/client/contracts.ts`: durable workspace snapshots and revisions; definitions and definition revisions; agents and employment periods; rooms and explicit membership history policy; closed workspace events; memory entries, filters, cursors, provenance, and pages; tasks, assignments, grants, and child runs; exact, derived, and unresolved definition history; activity records, blocks, identities, agent summaries, and stop results; committed mutation wrappers; and every correlated business, bad-request, cancellation, and internal RPC error variant.

`WorkspaceApi.mutate(endpoint, payload, expectedRevision)` is the single Browser write path for all 19 Task 10 mutations:

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

The adapter rejects client-owned revision and actor fields before transport, adds the current non-negative aggregate revision, and validates the `{ revision, value }` response. Existing state-valued convenience methods unwrap the validated `value`. Task assignment, delegation grant, delivery retry, activity stop, child stop, and failure acknowledgement retain the wrapper because their non-state values do not otherwise carry the committed revision. Browser ids remain JSON wire strings; Task 10's strict RPC parsers convert them to branded Host ids before service invocation.

Read methods cover `snapshot`, `runtime/status`, `runtime/activity/snapshot`, `runtime/activity/wait`, `memory/query`, and `definition/history`. The Browser no longer calls the pre-Task-10 stream aliases or consumes unwrapped mutation responses.

## Navigation, stale writes, and reconnects

The store's closed view union is exactly `conversations | colleagues | tasks | memory`, defaulting to conversations. Snapshot replacement clones only authoritative durable state and does not change the selected view, room, or definition. The overlay maintains one cancellation-aware snapshot/activity subscription, replaces each activity projection by version, and renders messages and activities with durable event/activity ids. Snapshot and reconnect replacement therefore converge without appending duplicate projected rows.

A stale mutation is never replayed automatically. The overlay performs one authoritative snapshot refresh, preserves React-owned form values, records a retry state, and exposes a localized explicit retry control. That control invokes the retained operation with the refreshed revision. Non-stale typed errors retain their code and details for locale-owned presentation; unknown failures are rendered through display-safe fallback copy.

Group membership begins without a selected history policy. A join is enabled only after the user selects `new-events` or supplies a positive, ascending, bounded `event-range`; the API validates the range before transport. No client default opts an agent into historical events.

Tasks and Memory intentionally remain localized foundation placeholders. Their complete experiences, along with the expanded colleague and conversation workflows, remain owned by Tasks 12–15.

## TDD and verification evidence

Inherited RED evidence from the Task 11 implementation session:

```text
pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts
# exit 1; 8 tests failed because the Browser still exposed Chat/Agents, omitted mutation revisions, and lacked the new stale/history/accessibility behavior
```

The initial implementation reached 38/38 focused tests. The final API ambiguity regression added one test proving that the central mutation method returns the committed wrapper while state-valued convenience methods unwrap only their state value.

Fresh takeover verification on implementation commit `eb3dfd501ce3945af8b3c36ac17108110b187760`:

```text
pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts
# 4 files passed; 39 tests passed

pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts tests/workspace-rpc.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-activity-stream.spec.ts tests/workspace-async-dispatch.spec.ts tests/web-bundle-platform.spec.ts
# 9 files passed; 165 tests passed

pnpm verify:client-copy
pnpm run typecheck
pnpm run build:web
git diff --check d8a3ab2b8bb4e2a53ded51b5770f9d90e7e926c7 HEAD
git diff --check
# all exited 0
```

The focused tests use deferred activity waits and explicit effect cleanup; they contain no timing sleeps. Both Simplified Chinese and English dictionaries cover all four navigation labels plus loading, retry, dialog, close, empty, and error accessibility copy.

## Changed files

- `packages/web/src/client/contracts.ts`
- `packages/web/src/client/api.ts`
- `packages/web/src/client/store.ts`
- `packages/web/src/client/WorkspaceUi.tsx`
- `packages/web/src/client/locales.ts`
- `packages/web/src/client/styles.ts`
- `tests/workspace-web-upgrade.spec.ts`
- `tests/workspace-view.spec.ts`
- `tests/workspace-locale.spec.ts`
- `tests/client-copy-verifier.spec.ts`

No additional implementation or test/support files changed, and the implementation diff contains no `vendor/` path.

## Commit and remaining risks

Implementation commit: `eb3dfd501ce3945af8b3c36ac17108110b187760` (`feat(web): add workspace product navigation`).

The four-view foundation intentionally does not yet expose the Task 10 task, memory, definition-history, or runtime-control methods as full product workflows. Tasks 12–15 own those interfaces and their assembled Browser coverage. Task 11 verifies the shared state, contracts, revision handling, reconnect convergence, localization, and accessibility behavior on which those workflows depend.
