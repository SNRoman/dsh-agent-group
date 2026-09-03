# Task 4 report: make aborted and reconnected turns converge once

## Status

COMPLETE. The Task 4 implementation is verified on `codex/v0.1.1-stabilization` and is committed with message `fix: converge cancelled workspace turns`; the controller report records the resulting commit OID.

## Files

- Host: `packages/host/src/turn-tracker.ts`, `packages/host/src/dispatcher.ts`, `packages/host/src/index.ts`.
- Browser: `packages/web/src/client/WorkspaceUi.tsx`.
- Tests: `tests/dispatcher.spec.ts`, `tests/runtime.spec.ts`, `tests/turn-tracker-errors.spec.ts`, `tests/workspace-async-dispatch.spec.ts`, `tests/workspace-turn-stream.spec.ts`, `tests/workspace-view.spec.ts`.
- `packages/host/src/turn-stream.ts` needed no production edit. Its existing identity key, observer-only abort path, and idempotent `retire` behavior already meet the required semantics; focused tests now pin those behaviors.
- `tests/workspace-view.spec.ts` is the one adjacent test file beyond the brief. It already owns the real `WorkspaceOverlay` component harness, so extending it tests reconnect rendering and subscription effects without introducing a second mock UI or a new renderer dependency.

## RED

- `pnpm vitest run tests/runtime.spec.ts` exited `1` with 1 intended failure: the tracker returned only `stopReason: "aborted"` and omitted `interrupted`, instead of preserving `{ kind: "aborted", reason: { kind: "user" } }` and the authoritative `assistant/message.interrupted: true` marker.
- `pnpm vitest run tests/dispatcher.spec.ts tests/runtime.spec.ts tests/turn-tracker-errors.spec.ts tests/workspace-async-dispatch.spec.ts tests/workspace-turn-stream.spec.ts` exited `1`: 2 files failed, 3 passed, and 6/34 tests failed. The aborted partial output was committed as three cascading agent replies because its mention was parsed and scheduled; tracker cases also exposed the lossy reason and missing interruption field. Observer cancellation, disposal cleanup, and repeated retirement characterization cases already passed.
- `pnpm vitest run tests/workspace-view.spec.ts` exited `1` with 1/11 failures. A durable reply observed with the immediately preceding settled stream snapshot rendered three message rows instead of the two logical rows. The same deterministic case uses an explicit wait-entry barrier to cover the inverse reconnect ordering, where stream retirement is observed before the initial durable snapshot.
- During self-review, `pnpm vitest run tests/dispatcher.spec.ts -t "token ceiling"` exited `1` because a nonblank `max-tokens` reply produced zero durable agent messages. DSH defines both `completed` and `max-tokens` as successful step terminal reasons, so this prevented the aborted-turn filter from discarding valid capped output.

## GREEN

```text
pnpm vitest run tests/dispatcher.spec.ts tests/runtime.spec.ts tests/turn-tracker-errors.spec.ts tests/workspace-async-dispatch.spec.ts tests/workspace-turn-stream.spec.ts tests/workspace-view.spec.ts
```

Exit `0`: 6 files passed, 48/48 tests passed.

```text
pnpm test
```

Exit `0`: 21 files passed, 196/196 tests passed.

```text
pnpm typecheck
```

Exit `0`: Host, Web client, and compile-time fixture projects passed.

```text
git diff --check
```

Exit `0` with no output before staging.

## Race model

- `agent/inbox/claimed` creates the sole Workspace turn identity `{ roomId, agentId, sessionId, turn }`. The tracker returns that same object with the terminal outcome; the dispatcher passes it into the durable reply commit; the Host retires that exact stream key only after the table update resolves.
- Repeated terminal notifications find no pending turn after the first settlement. The deterministic dispatcher/tracker integration case emits the same `turn/end` object twice and proves one durable reply and one retirement.
- Before reply commit, a settled stream row remains visible because the durable snapshot revision has not passed the stream's recorded Workspace revision. When a reconnect pairs a newer durable snapshot with the older settled stream snapshot, the Browser suppresses only the covered settled row; running rows remain visible.
- In the inverse ordering, an initial stream snapshot may already record the post-commit revision while the concurrently fetched durable snapshot is older. The subscription refetches the durable snapshot once before entering the long poll, so retirement cannot leave the Browser permanently missing the final row.
- Stream waits and tests use abort events, version transitions, and explicit deferred barriers. No sleep, wall clock, or scheduler-dependent ordering decides an assertion.

## Cleanup and idempotency self-review

- `WorkspaceTurnTracker` centralizes map removal behind a `settled` guard. Synchronous `followup` failure, inbox discard, terminal outcome, and agent disposal therefore choose one terminal settlement even when callbacks re-enter or repeat.
- A terminal event is forwarded to the transient stream before the pending correlation is removed, preserving the final stop reason for display. Any duplicate terminal event is ignored because the correlation no longer exists.
- Long-poll `AbortSignal` cancellation removes only its waiter and listener, rejects only that observer, and leaves the tracked agent outcome and stream snapshot unchanged. It never calls `Agent.cancel`; DSH's `{ kind: "user" }, { keepInbox: true }` semantics therefore remain solely an agent-runtime concern.
- Empty output and non-successful turn reasons retire the same Workspace identity without a durable reply or downstream mention parsing. Successful `completed` and `max-tokens` outcomes commit only nonblank terminal text, then retire through the same identity in `execute`.
- Repeated `retire` calls with the same identity/revision are no-ops and publish no additional version. Agent disposal repeated before a late claim leaves no stream row.
- The DSH Session log is untouched. The implementation consumes the typed `turn/end.data.reason` and `assistant/message.data.interrupted` fields and does not infer cancellation from text.

## Concerns

The Browser convergence rule uses the stream's recorded Workspace revision because the released durable room event has no turn-identity field and the storage format cannot change in `0.1.1`. The Host still supplies the exact turn identity to the in-memory commit/retirement operation, while the revision comparison handles only cross-request snapshot ordering. No durable schema, storage-domain version, Task 5 locale, dependency, tag, publication, or push was added.

## Commit

`fix: converge cancelled workspace turns`
