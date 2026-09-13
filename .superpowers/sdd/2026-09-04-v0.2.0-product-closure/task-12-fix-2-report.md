# Task 12 Review Fix Round 2 Report

## Scope

- Base: `0e75f71c268896b1f2f5bbdf0f2e9af86f6b490e`
- Code commit: `3a9484e7831678be5f4d631330a0fadac9fe9f1a`
- Commit subject: `fix(web): close task center review gaps`
- Review source: `task-12-rereview-1.md`

The change is confined to Task 12 cancellation provenance, task-center refresh convergence, accessible task controls, their strict Browser mirror, and directly affected tests. It does not change the storage-domain version, package versions, compatibility declaration, supported DSH checkout, or Tasks 13–15 feature bodies.

## Finding proofs

### 1. Independent refresh adoption and successful-action convergence

`WorkspaceTasks.refresh` now waits for the durable and activity reads independently with `Promise.allSettled`. Each fulfilled result is published immediately through the existing store callbacks even when the other read rejects. The store remains the owner of monotonic durable snapshot selection, so an older read still cannot replace a newer mutation or subscription result.

A stale mutation now retains its exact keyed manual retry after the independent refresh. When the durable leg returns revision 13 and the activity leg fails, the revision-13 snapshot is installed and the retry submits revision 13. The failed leg displays the localized manual-recovery warning instead of discarding the successful leg.

Delivery retry, activity stop, and child stop responses contain no durable snapshot. A successful response therefore records an exact local convergence marker. Only the matching control is disabled, and its marker remains until the authoritative task, activity, or child projection proves that action is no longer applicable. An unrelated successful read cannot clear the marker. Successful mutations remove only their own stale retry and submitted draft and are never represented as uncommitted.

Deterministic DOM tests cover both one-sided refresh failures, stale recovery with a successful durable read and failed activity read, delivery retry with each failed leg, `not-active` activity stop with failed activity refresh, and child stop with failed durable refresh. No sleeps, ports, listeners, or process-global work coordination were added.

### 2. Authoritative backward-compatible cancellation provenance

New `task/cancelled` events carry optional-on-read `cancellationScope: 'root-cascade' | 'derived-only'`. Root cancellation writes `root-cascade` to the root and every then-open descendant cancelled by that operation. Direct derived cancellation writes `derived-only`. Host invariants reject `derived-only` on a root and reject descendant `root-cascade` metadata without a matching human-authored root-cascade event for the same root.

The field remains optional in the Host Zod schema and Browser parser so existing version-0 aggregates and events parse unchanged. The domain remains at version `0`. Both parsers reject invented scope values. Browser projection reads only the event field; historical events without it render the localized `unknown` scope and are never reclassified from current root state or event-sequence coincidence. The two-operation counterexample proves a derived cancellation remains derived-only after a later independent root cancellation.

Host task and invariant tests prove new event writing and relationship checks. Host legacy tests and Browser wire-parser tests prove missing metadata remains accepted. Projection and bilingual DOM tests prove all three presentation states: root cascade, derived-only, and unknown.

### 3. Distinguishable localized accessible controls

Every repeated Task Center mutation control now has a locale-owned accessible name containing the durable subject: cancellation and delivery retry include task title and id; grant includes title, grantee, and task id; revocation includes title, grantee, and grant id; task-turn stop includes title, agent, and activity id; child stop includes title and child id. Stale retry names use the localized human action description rather than an internal action key. Repeated result disclosures include task title and id, while child disclosures already include the child id in visible text.

The real React/jsdom suite no longer locates task controls through `data-task-id` ancestry. It exercises mutations by accessible button name and assignment inputs by their labels in both locales. It also verifies distinct bilingual result disclosure names. `data-*` values remain implementation metadata only.

## RED and GREEN evidence

The initial RED command was:

```text
pnpm vitest run tests/tasks.spec.ts tests/invariant.spec.ts tests/workspace-task-view.spec.ts tests/workspace-task-dom.spec.ts
Test Files 4 failed (4)
Tests 20 failed | 100 passed (120)
```

Failures matched the three findings: new cancellation scope was absent or rejected, historical/independent cancellation was inferred incorrectly, proposed bilingual accessible names were missing, and one-sided refresh/convergence scenarios left actions replayable or failed to adopt the successful result.

After the minimum implementation, the same command passed 4 files / 120 tests. The final focused and affected runs included the Browser parser compatibility cases and the expanded repeated-control coverage.

## Verification

- `pnpm vitest run tests/tasks.spec.ts tests/invariant.spec.ts tests/workspace-task-view.spec.ts tests/workspace-task-dom.spec.ts tests/workspace-web-upgrade.spec.ts` — passed, 5 files / 210 tests.
- `pnpm vitest run tests/tasks.spec.ts tests/invariant.spec.ts tests/host-consistency.spec.ts tests/activity-controller.spec.ts tests/task-delivery.spec.ts tests/task-delivery-coordinator.spec.ts tests/workspace-task-view.spec.ts tests/workspace-task-dom.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts tests/workspace-rpc.spec.ts tests/workspace-activity-stream.spec.ts tests/workspace-async-dispatch.spec.ts tests/workspace-web-upgrade.spec.ts tests/workspace-ui-registration.spec.ts tests/client-copy-verifier.spec.ts` — passed, 16 files / 459 tests.
- `pnpm verify:client-copy` — passed.
- `pnpm run typecheck` — passed.
- `pnpm run build:host` — passed.
- `pnpm run build:web` — passed.
- `pnpm test` — passed, 31 files / 628 tests.
- `pnpm verify:compatibility` — passed with `Compatibility declaration verified.`
- `git diff --check` — passed before the code commit.
- `git diff --cached --check` — passed before the code commit.

## Remaining risks

- A no-snapshot success deliberately keeps its exact control disabled if every authoritative refresh still reports the old action as applicable. This prevents duplicate mutation while the Host catches up, but recovery depends on a later outer Workspace refresh or stream update.
- Historical cancellation events cannot recover provenance that was never recorded. They intentionally display an unavailable scope instead of guessing.
- jsdom proves React scheduling, DOM events, labels, accessible names, and per-control disabled behavior; assembled-profile Browser behavior remains part of the later release-level acceptance task.
