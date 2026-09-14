# Task 13 Implementation Report

## Result

Implemented the Browser product surfaces for read-only unified personal memory and immutable definition-revision history with explicit none/all/subset synchronization. The implementation commit is `dbe61e4a08ff0dd5d2f56aaa2a8a6d114e414191` (`feat(web): expose memory and role history`).

## RED evidence

Before adding production files, ran:

```text
pnpm vitest run tests/workspace-memory-view.spec.ts tests/workspace-definition-view.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts
```

Observed two failing suites because `WorkspaceMemory.tsx` and `WorkspaceDefinitionHistory.tsx` did not exist. The two pre-existing workspace suites remained green with 36 passing tests. This established that the new tests failed for the missing product behavior rather than an unrelated regression.

## Implemented behavior

### Unified personal memory

- Added an employed/departed agent selector and a newest-first, read-only event timeline.
- Displays durable event id context through sequence/type, first provenance, source kind/id/label, actor, subject, text, child terminal status, and active or explicitly unresolved definition revision.
- Added source-kind/source-id coupling, provenance, multi-event-type, minimum/maximum sequence, and case-preserving text filters. Every active filter is included in every query and the Host remains authoritative for case-insensitive matching.
- Uses a named page size of 25. Pagination retains server order, de-duplicates by canonical event id, and appends only pages from the adopted revision.
- Agent/filter/revision changes invalidate the current request generation, clear accumulated pages/cursor, and issue a first-page query. Late, aborted, stale, and unmounted requests cannot publish results.
- A stale rejection or page revision mismatch refreshes the canonical snapshot monotonically and restarts from page one while preserving the selected agent and filters.
- Added localized accessible loading, empty, end, safe error/retry, and no-agent states. No memory mutation control exists.

### Definition history and synchronization

- Added number-ordered immutable history with exact, derived, and unresolved creation provenance, current/previous status, and pinned instance id/name/employment state.
- History reads are cancellation- and generation-aware, so a response for a prior definition cannot replace the current selection. Successful revision creation or synchronization changes the adopted revision and therefore refreshes history.
- Replaced the old synchronization checkbox with an explicit save dialog for none, all existing instances, or a validated non-empty subset. Closing or pressing Escape submits synchronize-none exactly once and still saves the revision.
- Save-time draft, mode, and subset are retained through stale refresh. Only the dedicated retry action can replay the request against the newly adopted revision; success, editor cancel, or definition switch releases draft ownership.
- Added later synchronization from every history revision to a validated non-empty subset. A bilingual confirmation states that names, employment periods, rooms, sessions, and personal memory remain unchanged and that only future-turn instructions change.
- Later-sync stale state retains the exact revision and selected ids for explicit retry. Cancel/Escape performs no mutation.
- Closing either dialog restores focus to the exact button that opened it; this behavior was added through a separate observed RED focus regression.
- Mutation results always pass through monotonic snapshot adoption. A late success for an earlier selection cannot reset the current editor, and editor reset after success is derived from the currently adopted snapshot rather than an older response.

## Component and request ownership

- `WorkspaceMemory` owns selected-agent/filter/page state, request generations, pagination de-duplication, stale restart, and read-only presentation.
- `WorkspaceDefinitionHistory` owns history request generations and both synchronization dialogs. It does not broaden the API; it uses the existing named `definitionHistory`, `reviseDefinition`, `synchronizeDefinition`, and `snapshot` methods.
- `WorkspaceUi` retains the definition editor draft and the shared monotonic snapshot store. A dialog reservation prevents background refresh from replacing a draft involved in a save workflow.
- Pending state is scoped to the exact memory page, revision save, or later synchronization request. It does not globally disable unrelated workspace actions.

## Tests

New real React DOM tests exercise controls through accessible labels, roles, and visible names. They cover:

- employed and departed selection, all memory fields, all query filters, source coupling, provenance, pagination, de-duplication, stale restart, late suppression, loading/empty/error/retry/end/unresolved states, and the absence of edit/delete controls;
- exact/derived/unresolved revision provenance, current/previous state, pinned instances, selection races, none/all/subset payloads, subset validation, close/Escape-as-none exactly once, save stale preservation/retry, later older-revision synchronization, preservation copy in both locales, later stale retry, and cancel-without-mutation;
- existing Workspace overlay draft tests were updated to pass through the new explicit save prompt;
- locale runtime coverage now renders the memory and history views in Simplified Chinese and English.

No sleeps were added. Races use deferred promises and request generations. No process-global resources, ports, files, clocks, or subprocesses were introduced.

## Verification

All commands were run from the Task 13 worktree after the implementation commit:

```text
pnpm vitest run tests/workspace-memory-view.spec.ts tests/workspace-definition-view.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts
# 4 files passed, 58 tests passed

pnpm vitest run tests/memory-query.spec.ts tests/memory.spec.ts tests/definition-history.spec.ts tests/workspace-rpc.spec.ts tests/workspace-web-upgrade.spec.ts tests/workspace-async-dispatch.spec.ts tests/workspace-memory-view.spec.ts tests/workspace-definition-view.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts
# 10 files passed, 265 tests passed

pnpm verify:client-copy
# passed

pnpm run typecheck
# passed

pnpm run build:web
# passed; client bundle built

pnpm test
# 33 files passed, 655 tests passed

git diff --check
# passed
```

## Changed files and deviations

- Added `packages/web/src/client/WorkspaceMemory.tsx`.
- Added `packages/web/src/client/WorkspaceDefinitionHistory.tsx`.
- Updated `WorkspaceUi.tsx`, `locales.ts`, and `styles.ts`.
- Added `tests/workspace-memory-view.spec.ts` and `tests/workspace-definition-view.spec.ts`.
- Updated `tests/workspace-view.spec.ts` and `tests/workspace-locale.spec.ts`.
- `api.ts` required no change because Task 10 already supplied strict named read and mutation methods with the needed response validation.
- No Task 14 runtime drawer/status integration, Task 15 assembled scenario, phase-three compatibility work, version change, publish, tag, push, merge, or supported DSH checkout change was performed.

## Remaining risk

This task proves the Browser components, API projections, race handling, localization, type contracts, and built bundle. The full assembled Browser workflow and restart convergence remain deliberately assigned to Task 15; runtime presentation remains Task 14. The remaining Task 13 review risk is whether product design prefers server-returned source ordering over the current deterministic label/id ordering of filter choices.
