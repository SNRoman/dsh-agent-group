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

The response adapter validates every required nested snapshot, activity, memory, definition-history, runtime-status, mutation-value, and RPC-error field before cloning it into client state. Closed event, source, block, status, provenance, history, stop-result, and business-error discriminants reject unknown variants. State-bearing mutation values must carry the same revision as their committed wrapper, so contradictory Host responses cannot install an obsolete snapshot.

The acknowledgement mutation has one endpoint-specific JSON representation. The Host's `value: undefined` field is omitted by the HTTP/JSON carrier, so `runtime/failure/acknowledge` accepts exact `{ revision }` and normalizes it to the typed `{ revision, value: undefined }` result. Missing or extra acknowledgement fields reject, and every other mutation continues to require exact `{ revision, value }`.

Read methods cover `snapshot`, `runtime/status`, `runtime/activity/snapshot`, `runtime/activity/wait`, `memory/query`, and `definition/history`. The Browser no longer calls the pre-Task-10 stream aliases or consumes unwrapped mutation responses.

## Navigation, stale writes, and reconnects

The store's closed view union is exactly `conversations | colleagues | tasks | memory`, defaulting to conversations. Snapshot replacement clones only authoritative durable state and does not change the selected view, room, or definition. The overlay maintains one cancellation-aware snapshot/activity subscription, replaces each activity projection by version, and renders messages and activities with durable event/activity ids. Snapshot and reconnect replacement therefore converge without appending duplicate projected rows.

A stale mutation is never replayed automatically. The overlay performs one authoritative snapshot refresh, preserves React-owned form values, records whether the refresh completed, and exposes a localized explicit retry control. Definition revision drafts record their selected definition, source revision, and dirty status. A background refresh updates a clean draft, while a dirty draft or pending definition retry keeps its visible description and instructions. Definition selection, cancel, and successful revision submission reset the draft from authoritative state. An explicit definition retry rebuilds its request from the visible fields, checkbox, refreshed agent set, and refreshed aggregate revision instead of retaining submitted hidden values. A failed refresh is converted to display-safe state without rejecting its event handler; the first retry refreshes only, and a later explicit retry invokes the retained operation with the refreshed revision. Non-stale typed errors retain their code and details for locale-owned presentation; unknown failures are rendered through display-safe fallback copy without retaining raw transport exceptions.

Group membership begins without a selected history policy. A join is enabled only after the user selects `new-events` or supplies a positive, ascending, bounded `event-range`; the API validates the range before transport. No client default opts an agent into historical events.

Tasks and Memory intentionally remain localized foundation placeholders. Their complete experiences, along with the expanded colleague and conversation workflows, remain owned by Tasks 12–15.

## TDD and verification evidence

Inherited RED evidence from the Task 11 implementation session:

```text
pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts
# exit 1; 8 tests failed because the Browser still exposed Chat/Agents, omitted mutation revisions, and lacked the new stale/history/accessibility behavior
```

The initial implementation reached 38/38 focused tests. The final API ambiguity regression added one test proving that the central mutation method returns the committed wrapper while state-valued convenience methods unwrap only their state value.

Review-fix RED evidence recorded before the production fixes:

```text
pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts
# 73 tests: 17 failed, 56 passed; 1 unhandled stale-refresh rejection

pnpm exec tsc -p tests/types/tsconfig.json --pretty false
# 6 errors: four unused @ts-expect-error directives exposed the open mutation signature; two exact-optional mismatches exposed Host/client parity gaps
```

The takeover began after the endpoint-map implementation had been partially applied. Its reproducible checkpoint was 39 failed and 34 passed focused tests with one unhandled rejection, plus seven compile errors from the unfinished validator dispatch and the remaining event parity mismatch.

Fresh review-fix verification on implementation commit `606262008cd51fd5fe7716845e44a9c453e46f91`:

```text
pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts
# 4 files passed; 112 tests passed

pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts tests/workspace-rpc.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-activity-stream.spec.ts tests/workspace-async-dispatch.spec.ts tests/web-bundle-platform.spec.ts
# 9 files passed; 238 tests passed

pnpm verify:client-copy
pnpm run typecheck
pnpm run build:web
git diff --check d8a3ab2b8bb4e2a53ded51b5770f9d90e7e926c7 HEAD
git diff --check
# all exited 0
```

The focused tests use deferred activity waits and explicit effect cleanup; they contain no timing sleeps. Both Simplified Chinese and English dictionaries cover all four navigation labels plus loading, retry, dialog, close, empty, and error accessibility copy.

Review-fix round 2 reproduced the acknowledgement failure with an in-memory JSON projection and the nineteenth routing-table row before the parser change. The endpoint-specific fix produced the following evidence:

```text
pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts
# 4 files passed; 116 tests passed

pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts tests/workspace-rpc.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-activity-stream.spec.ts tests/workspace-async-dispatch.spec.ts tests/web-bundle-platform.spec.ts
# 9 files passed; 242 tests passed

pnpm verify:client-copy
pnpm run typecheck
pnpm run build:web
# all exited 0
```

Review-fix round 3 replaced the in-memory projection with the installed Connection Host service and Browser bundle caller over a loopback HTTP server allocated through `listen(0)`. The Host handler returned `{ revision: 2, value: undefined }`; the captured `Response.json` envelope contained `{ revision: 2 }`; the Browser caller consumed it through `response.json`; and `WorkspaceApiClient` normalized the result to `{ revision: 2, value: undefined }`. The fixture restores its temporary globals exactly and awaits server, route, and Cordis fiber disposal. Two independent Vitest processes ran the carrier case concurrently and both passed.

Round-three RED evidence:

```text
pnpm vitest run tests/workspace-view.spec.ts -t "dirty definition draft|cancels the draft"
# exit 1; the stale refresh replaced both visible revision fields with the competing revision, and the revision editor had no cancel control

pnpm vitest run tests/workspace-web-upgrade.spec.ts -t "shipped Connection HTTP carrier"
# exit 1 under the old generic `{ revision, value }` parser mutation; the actual wire response was rejected as an invalid mutation result
```

Fresh round-three verification on implementation commit `8f580f7020d694cfb3d8d81aed03bca86bd65a37`:

```text
pnpm vitest run tests/workspace-view.spec.ts -t "definition draft|definition editor|draft ownership"
# 1 file passed; 5 tests passed

pnpm vitest run tests/workspace-web-upgrade.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/client-copy-verifier.spec.ts tests/workspace-rpc.spec.ts tests/workspace-direct-room.spec.ts tests/workspace-activity-stream.spec.ts tests/workspace-async-dispatch.spec.ts tests/web-bundle-platform.spec.ts
# 9 files passed; 247 tests passed

pnpm verify:client-copy
pnpm run typecheck
pnpm run build:web
git diff --check
# all exited 0
```

## Changed files

- `packages/web/src/client/contracts.ts`
- `packages/web/src/client/api.ts`
- `packages/web/src/client/store.ts`
- `packages/web/src/client/WorkspaceUi.tsx`
- `packages/web/src/client/locales.ts`
- `packages/web/src/client/styles.ts`
- `tests/types/tsconfig.json`
- `tests/types/workspace-client-contracts.ts`
- `tests/workspace-web-upgrade.spec.ts`
- `tests/workspace-view.spec.ts`
- `tests/workspace-locale.spec.ts`
- `tests/client-copy-verifier.spec.ts`

The type fixture and its owning TypeScript configuration are the only review-fix support files added outside the original Task 11 list. They compile-check Host-to-client response parity, strict endpoint/request/value pairing, client-actor exclusion, and exhaustiveness for the closed wire unions. The implementation diff contains no `vendor/` path.

## Commit and remaining risks

Original implementation commit: `eb3dfd501ce3945af8b3c36ac17108110b187760` (`feat(web): add workspace product navigation`).

Review-fix implementation commit: `606262008cd51fd5fe7716845e44a9c453e46f91` (`fix(web): validate workspace client contracts`).

JSON void-result fix commit: `bcb4271d2338546e54f66defc8a00ff250a1d471` (`fix(web): accept JSON void mutation result`).

Definition draft and real Connection carrier regression commit: `8f580f7020d694cfb3d8d81aed03bca86bd65a37` (`fix(web): preserve definition revision drafts`).

The Browser validators intentionally duplicate the Task 10 response field lists because the Web package has no runtime schema dependency and the Host's Zod schemas validate requests rather than exported responses. This makes Task 10 response changes an explicit Host/client update, reinforced by the compile fixture and malformed-response tests. The four-view foundation intentionally does not yet expose the Task 10 task, memory, definition-history, or runtime-control methods as full product workflows. Tasks 12–15 own those interfaces and their assembled Browser coverage.
