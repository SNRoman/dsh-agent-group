# Task 13 review fix 2 report

## Result

The implementation commit is `ad08835` (`fix(web): preserve history recovery focus`).

History failures now retain the definition and aggregate-revision request owner, so the localized error and Retry control render for the active owner while all old cards remain absent. Retry starts another guarded request for that owner.

Successful later synchronization records the logical historical revision instead of the removed DOM element. While replacement history is loading, a stable focusable history status target receives focus. When the current-owner response mounts the matching trigger, focus moves to that new trigger; when the revision is absent, the history target remains the fallback. A changed definition clears the pending restoration, and safe cancellation still restores the original trigger directly.

The non-DOM presentation and locale harnesses now provide `useLayoutEffect`, matching the added synchronous browser focus hook.

## RED evidence

Before production changes, the focused real-DOM suite ran:

```text
pnpm vitest run tests/workspace-definition-view.spec.ts
```

It reported 24 tests with three expected failures: an initial rejected history response exposed no alert, a replacement rejection exposed no alert, and a deferred higher-revision history response left focus on `body` rather than the history status target.

## GREEN evidence

The same focused suite passed after the implementation: 1 file and 24 tests. Its real-DOM assertions cover initial and replacement history errors with retry and no stale cards, plus a deferred successful later synchronization that keeps focus on the history status target and then moves it to the freshly mounted `Synchronize revision 1` control rather than the detached trigger.

## Verification

```text
pnpm vitest run tests/workspace-memory-view.spec.ts tests/workspace-definition-view.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts
# PASS: 4 files, 68 tests

pnpm vitest run tests/memory-query.spec.ts tests/memory.spec.ts tests/definition-history.spec.ts tests/workspace-rpc.spec.ts tests/workspace-web-upgrade.spec.ts tests/workspace-async-dispatch.spec.ts tests/workspace-memory-view.spec.ts tests/workspace-definition-view.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts
# PASS: 10 files, 275 tests

pnpm verify:client-copy
# PASS

pnpm typecheck
# PASS

pnpm build:web
# PASS

pnpm test
# PASS: 33 files, 665 tests

git diff --check c917e6b..ad08835
# PASS
```

## Scope

No API, RPC, reconnect, memory, supported DSH checkout, Task 14, or Task 15 behavior changed. The affected history/API/RPC/reconnect/copy suites above remain green.
