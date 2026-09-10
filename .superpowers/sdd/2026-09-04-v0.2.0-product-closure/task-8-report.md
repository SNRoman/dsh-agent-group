# Task 8 Report: Unified Personal Memory Query

## Commit

Implementation commit: `631e7023070de52b0f1866273163ae219de98d83` (`feat(host): query unified personal memory`).

## RED evidence

The initial command was:

```text
pnpm vitest run tests/memory.spec.ts tests/memory-query.spec.ts tests/restart.integration.spec.ts
```

It exited 1. Two suites could not import the missing `memory-query` module, and the write-idempotence test received three entries (`memory-7`, `memory-8`, and `memory-9`) instead of retaining only the first. The seven pre-existing memory tests passed.

After the first implementation, a canonical-record test was added and run with:

```text
pnpm vitest run tests/memory-query.spec.ts
```

It exited 1 because the real `task/assigned` event had no task source and its `TaskAssignmentId` subject label remained the raw id. This pinned assignment and grant ownership resolution to the durable task records rather than handcrafted event conventions.

## GREEN evidence

The final focused command exited 0 with 3 files and 20 tests passing:

```text
pnpm vitest run tests/memory.spec.ts tests/memory-query.spec.ts tests/restart.integration.spec.ts
```

The directly related type and build checks both exited 0:

```text
pnpm run typecheck
pnpm run build:host
```

Both `git diff --check` before staging and `git diff --cached --check` after staging exited 0 without output.

## Changed files

- `packages/host/src/memory-query.ts`: adds the pure snapshot query, filters, source and label projection, cursor validation, stale-revision checks, defensive legacy deduplication, and newest-first pagination.
- `packages/host/src/state.ts`: makes memory admission idempotent by agent and event while preserving the first entry and provenance.
- `packages/host/src/memory.ts`: exposes snapshot querying through `MemoryReader` alongside model recall.
- `packages/host/src/index.ts`: exposes the query through the Host service and package exports.
- `packages/host/src/errors.ts`: extends `stale-revision` details with the generic aggregate revision pair while retaining the existing definition-revision variant.
- `tests/memory.spec.ts`: covers duplicate acquisition and first-provenance retention.
- `tests/memory-query.spec.ts`: covers projection, every filter, Unicode case folding, pagination and cursor rejection, purity, departed agents, defensive deduplication, canonical task/child ownership, and unresolved historical attribution.
- `tests/restart.integration.spec.ts`: proves departed-agent memory survives a real storage restart without changing storage version.

## Key decisions

- Admission and projection both deduplicate: new state cannot add duplicate agent/event associations, while legacy `0.1.x` aggregates still display only the first stored provenance.
- Query results are derived entirely from the supplied immutable snapshot. Missing historical `definitionRevisionId` values stay explicitly unresolved and never fall back to the agent's current revision.
- Assignment and delegation-grant subjects resolve through their durable owning task. Child sources carry both child identity/result and durable task identity/label.
- Cursors contain only version, agent id, exclusive upper sequence, and snapshot revision. Revision drift reports `stale-revision` with `expectedRevision` and `actualRevision`.
- Text search lowercases the complete display projection and performs exact substring matching; it does not alter model recall or add semantic retrieval.

## Remaining risks

- The query accepts a typed same-process request; cursor data is runtime-validated, while filter discriminants rely on TypeScript until the later RPC task adds transport parsing.
- Legacy memory entries whose canonical event record is absent are skipped because no event can be projected. Valid persisted aggregates retain their canonical events.
