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
