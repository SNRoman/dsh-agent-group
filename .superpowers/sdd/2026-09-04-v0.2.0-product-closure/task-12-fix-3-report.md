# Task 12 Review Fix Round 3 Report

## Scope

- Base: `51be1d0a44bcfb7e883948fdbb9d9b4d6fb9eb7f`
- Code commit: `3e731ef`
- Commit subject: `fix(web): publish task refreshes independently`
- Review source: `task-12-rereview-2b.md`

The change is confined to Task Center refresh publication, stale-revision recovery, asynchronous component lifetime handling, real-DOM regression coverage, and the existing private React test dispatchers that render the changed component. It does not change Host behavior, durable formats, RPC endpoints, package versions, compatibility declarations, the supported DSH checkout, or Tasks 13–15.

## Root cause and lifetime design

`WorkspaceTasks.refresh` previously awaited one `Promise.allSettled` covering the durable and activity reads. Although rejected reads were contained, neither fulfilled result was published until both reads settled. A permanently pending activity request therefore blocked a newer durable snapshot and stale retry; a pending durable request symmetrically blocked a newer activity snapshot. `execute` awaited that combined refresh, so the exact action remained pending as well.

The replacement starts the two reads as separate guarded promise chains. Each fulfilled result is published immediately while the component is mounted, and each rejection is converted into a localized recovery state without an unhandled rejection. A stale mutation waits only for the durable leg and exposes its exact retry only when the returned snapshot reaches the `actualRevision` reported by the Host. An older successful response is insufficient: it displays recovery, exposes no knowingly obsolete replay, and releases the exact pending action.

Successful responses that already contain a committed snapshot publish that state and release immediately while both refresh legs continue safely. Successful no-snapshot operations wait only for their authoritative convergence source: activity stops wait for activity, while delivery retry, child stop, and durable task operations wait for the durable snapshot. The unrelated sibling cannot hold the action pending. Existing convergence markers continue to suppress only the exact stale visible control until canonical state removes it.

A mounted ref guards every asynchronous publication and post-await state update. Effect setup restores the ref before returning cleanup, preserving React development StrictMode's setup-cleanup-setup cycle. Both refresh legs retain rejection handlers after unmount, so late fulfillment or rejection produces neither parent publication nor unhandled rejection.

## TDD evidence

The first RED command was:

```text
pnpm vitest run tests/workspace-task-dom.spec.ts
Test Files 1 failed (1)
Tests 3 failed | 20 passed (23)
```

The three failures were the intended missing behaviors: a newer durable snapshot was not published while activity remained pending, a newer activity snapshot was not published while durable remained pending, and both results were published after unmount. The real-DOM tests use deferred promises as barriers and contain no sleeps or `data-*` selectors.

After the independent chains were implemented, the focused DOM suite passed 23/23. A targeted StrictMode test then failed 1/24 because a cleanup-only mounted effect left the ref false after React's development effect replay. Updating effect setup to restore the mounted state made the full DOM suite pass 24/24.

A final requirement audit added a stale recovery counterexample. It failed 1/25 because a successfully returned revision-12 snapshot opened a retry even though the Host stale error reported revision 13. The final implementation gates retry publication on the reported `actualRevision`; the focused DOM and projection run then passed 2 files / 41 tests before the full verification set.

The existing structural test harnesses failed when they first encountered the new `useRef` hook. Their private dispatchers now implement persistent per-hook ref objects, matching the existing state ownership model. The real React/jsdom suite remains the authoritative lifecycle and DOM evidence.

## Verification

- `pnpm vitest run tests/tasks.spec.ts tests/invariant.spec.ts tests/host-consistency.spec.ts tests/activity-controller.spec.ts tests/task-delivery.spec.ts tests/task-delivery-coordinator.spec.ts tests/workspace-task-view.spec.ts tests/workspace-task-dom.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/workspace-rpc.spec.ts tests/workspace-activity-stream.spec.ts tests/workspace-async-dispatch.spec.ts tests/workspace-web-upgrade.spec.ts tests/workspace-ui-registration.spec.ts tests/client-copy-verifier.spec.ts` — passed, 16 files / 464 tests.
- `pnpm verify:client-copy` — passed.
- `pnpm run typecheck` — passed.
- `pnpm run build:web` — passed.
- `pnpm test` — passed, 31 files / 633 tests.
- `git diff --check 51be1d0a44bcfb7e883948fdbb9d9b4d6fb9eb7f` — passed before the code commit.
- `git diff --cached --check` — passed before the code commit.

## Remaining risks

- A no-snapshot operation remains pending when its own authoritative read remains pending. This is intentional: the change prevents an unrelated sibling read from blocking convergence but does not claim convergence without evidence from the owning source.
- A stale retry is withheld until a durable snapshot reaches the Host-reported revision. Recovery then depends on the existing outer manual Refresh action or a later stream update, which avoids repeated known-stale writes.
- jsdom covers deterministic React scheduling, StrictMode effect replay, unmount, DOM controls, and promise settlement. Assembled-profile Browser acceptance remains part of the later release-level task.
