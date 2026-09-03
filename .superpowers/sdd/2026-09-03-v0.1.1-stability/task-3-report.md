# Task 3 report: add stable business errors and reject direct-room `@all`

## Status

COMPLETE. The Task 3 implementation is verified on `codex/v0.1.1-stabilization` and is committed with message `fix: make workspace policy errors stable`; the controller report records the resulting commit OID.

## Files

- Host: `packages/host/src/errors.ts`, `packages/host/src/index.ts`, `packages/host/src/room-policy.ts`, `packages/host/src/rpc.ts`, `packages/host/src/state.ts`, `packages/host/src/task-policy.ts`, `packages/host/src/tasks.ts`.
- Browser: `packages/web/src/client/api.ts`, `packages/web/src/client/contracts.ts`.
- Tests: `tests/workspace-direct-room.spec.ts`, `tests/workspace-rpc.spec.ts`, `tests/workspace-view.spec.ts`.
- `packages/host/src/task-policy.ts` is the one additional source file beyond the brief. It owns dispatcher task admission, so converting its unassigned-agent failure is required for `invalid-task-authority` to be stable at the actual wake boundary.
- `packages/web/src/client/WorkspaceUi.tsx` needed no production edit: its existing success-only `setDraft('')` already preserves the draft on rejection. A real component interaction test now fixes that behavior.

## RED

- `pnpm vitest run tests/workspace-direct-room.spec.ts` exited `1` because `packages/host/src/errors.ts` did not exist. After the error type was added, the real durable-service case still failed with `agent workspace dispatcher is not available without the agent service`, proving direct text was not rejected at the service boundary.
- The policy cases exited `1` with ordinary `Error` values instead of stable codes/details for missing and departed agents, duplicate membership, a stale definition revision, and invalid delegated-task authority. The dispatcher admission helper likewise returned a generic unassigned-task error.
- `pnpm vitest run tests/workspace-rpc.spec.ts` exited `1` with four intended failures: a business error was flattened to `bad-request`, `bad-request` and `cancelled` lacked an explicit kind, and an unexpected exception leaked `sensitive backend failure` instead of returning a display-safe internal result.
- `pnpm vitest run tests/workspace-view.spec.ts -t "preserves stable business error code"` exited `1` because `WorkspaceApiError` did not exist and the Browser adapter retained only the message.
- The Unicode boundary refinement exited `1` because the first token regexp rejected `@all` adjacent to a combining mark. The final token-character set covers Unicode letters, marks, numbers, and connector punctuation.

## GREEN

```text
pnpm vitest run tests/workspace-direct-room.spec.ts tests/workspace-rpc.spec.ts tests/workspace-view.spec.ts
```

Exit `0`: 3 files passed, 34/34 tests passed.

```text
pnpm typecheck
```

Exit `0`: Host, Web client, and compile-time fixture projects passed.

```text
pnpm vitest run tests/state.spec.ts tests/tasks.spec.ts tests/host-consistency.spec.ts tests/dispatcher.spec.ts
```

Exit `0`: 4 adjacent files passed, 46/46 tests passed.

```text
git diff --check
```

Exit `0` with no output before staging.

## Self-review

- `WorkspaceBusinessError` exposes a closed six-code union and code-specific details containing only JSON-safe identifiers and the reserved token. Existing English messages remain diagnostics; RPC and Browser consumers use `kind`, `code`, and `details` instead of parsing them.
- Direct-room validation runs from `postHumanMessage` before dispatcher access. The real storage-backed test proves revision, events, and runtime delivery status remain unchanged after rejection.
- The token match is lowercase and Unicode-aware. `@all`, punctuation-delimited forms, and emoji-delimited forms reject; `@alloy`, `@All`, CJK-adjacent text, combining-mark adjacency, and connector-punctuation adjacency remain ordinary text. Group `@all` expansion remains covered by the unchanged view-model behavior.
- RPC maps only `WorkspaceBusinessError` to `business`; Zod and unknown endpoints remain `bad-request`, abort remains `cancelled`, and other exceptions become a fixed `internal` diagnostic without the original text.
- `WorkspaceApiError` retains the Host result fields for Task 5 locale mapping. No Task 5 locale dictionary or Chinese/English error mapping was added.
- The component regression drives the real `WorkspaceOverlay` and `ChatWorkspace` textarea and send button. Its 66-line test-only hook harness is necessary because this package declares no DOM or React test renderer, and importing the published DSH message primitives directly in Node loads unsupported CSS modules. Only the unused message-rendering module is replaced; composer hooks, submission, error handling, and rerendered draft state remain real.
- Reviewed the complete diff and confirmed no durable field, event representation, storage-domain version, localization implementation, tag, publication, or push was added.

## Concerns

The component test uses React 18's internal dispatcher because adding a renderer and DOM dependency would expand this maintenance task. The dependency is pinned by the Web package's React 18 peer range, the dispatcher is restored after each test, and the harness is isolated to this test file. No product implementation concern remains.

## Commit

`fix: make workspace policy errors stable`

## Independent review repair round 1

### Status

COMPLETE. The two confirmed type-safety findings are fixed without changing runtime policy, persistence, localization, or wire semantics.

### Files

- `packages/host/src/errors.ts` uses a non-mergeable object type for the closed business-code-to-details map.
- `packages/web/src/client/contracts.ts` declares separate `cancelled` and `internal` variants.
- `packages/web/src/client/api.ts` exposes the correlated RPC error payload as `WorkspaceApiError.error` while retaining the existing convenience fields.
- `tests/types/workspace-errors.ts` fixes the rejected unknown business code/details, mismatched stable details, crossed RPC kind/code, crossed API constructor input, and successful discriminant narrowing as compile-time expectations.
- `tests/types/tsconfig.json` includes the new focused type fixture.

### RED

`pnpm typecheck` exited `1` before the production edits. TypeScript reported four unused `@ts-expect-error` directives because an external declaration merge, an extended business code, a crossed RPC pair, and a crossed API constructor input were all accepted. It also reported two `TS2339` errors because `WorkspaceApiError` had no correlated payload that callers could narrow.

The declaration-merge probe was used only for RED evidence. Keeping an intentionally illegal augmentation after converting the interface to a type alias would make the fixture itself uncompilable, so the final fixture instead pins the public closed union through rejected unknown-code and mismatched-details constructions. A transient duplicate-identifier result after removing the probe came from the ignored incremental file `tests/types/tsconfig.tsbuildinfo`; removing that generated cache restored a clean typecheck.

### GREEN

```text
pnpm typecheck
```

Exit `0`: Host, Web client, and compile-time fixture projects passed.

```text
pnpm vitest run tests/workspace-direct-room.spec.ts tests/workspace-rpc.spec.ts tests/workspace-view.spec.ts
```

Exit `0`: 3 files passed, 34/34 tests passed.

### Self-review

- The details map is now a type alias, so module augmentation cannot extend its keys through interface declaration merging; its generic constructor still preserves the exact details type for each code.
- `cancelled` and `internal` are exact union members, preventing crossed discriminants in both the public RPC type and `WorkspaceApiError` construction.
- `WorkspaceApiError.error` preserves the relationship among `kind`, `code`, and `details` for caller narrowing. The existing top-level fields remain available to current consumers.
- The repair adds no runtime branch, storage field, domain-version change, locale mapping, dependency, or unrelated test surface.

### Concerns

No implementation concern remains. The compile fixture intentionally avoids a permanent illegal module augmentation and instead combines the non-mergeable source declaration with public-construction negative cases.

### Commit

`fix: close workspace error types`

## Final review repair round 2

### Status

COMPLETE. Business RPC failures now preserve the relationship between each stable code and its exact structured details in both Host and Browser public types.

### Files

- `packages/host/src/errors.ts` accepts code/details through a mapped tuple union, preserving their relationship at construction.
- `packages/host/src/rpc.ts` defines the business result as a mapped discriminated union and converts typed business errors through an exhaustive code switch and generic helper.
- `packages/web/src/client/contracts.ts` exports a closed Browser details-map type and derives its business code and RPC error union from that map.
- `tests/types/workspace-errors.ts` covers Host, Browser RPC, and `WorkspaceApiError.error` detail narrowing plus rejected Host and Browser code/details pairings.

### RED

`pnpm typecheck` exited `1` before the production edits. Host, Browser RPC, and `WorkspaceApiError.error` each produced `TS18047` and `TS2339` when code attempted to read `details.roomId` and `details.token` after narrowing to `kind === 'business'` and `code === 'reserved-direct-routing'`. The Host and Browser mismatched-pair expectations also produced `TS2578` because the widened result types accepted `agent-missing` with reserved-routing details. A focused constructor RED produced another `TS2578`: independently widened code and details unions were accepted even though they did not prove a matching pair.

### GREEN

```text
pnpm typecheck
```

Exit `0`: Host, Web client, and compile-time fixture projects passed.

```text
pnpm vitest run tests/workspace-direct-room.spec.ts tests/workspace-rpc.spec.ts tests/workspace-view.spec.ts
```

Exit `0`: 3 files passed, 34/34 tests passed.

### Self-review

- Both RPC business variants are mapped discriminated unions rather than independent code and details unions. Narrowing the code selects its declared details fields.
- The Host constructor's mapped tuple union rejects mismatched arguments even when its generic code parameter is a union. The RPC type guard therefore represents every class instance as the union of valid code-specialized instances.
- The exhaustive switch narrows each instance before the generic converter clones its details. The converter receives `code` and `details` from the same `WorkspaceBusinessError<Code>` and uses no type assertion.
- The Browser details map is a non-mergeable type alias. `WorkspaceApiError.error` retains the exact RPC union, while its existing top-level convenience fields remain unchanged.
- Runtime messages, persistence, domain versions, localization, and non-business RPC variants are unchanged.

### Concerns

No implementation concern remains.

### Commit

`fix: correlate workspace business error details`
