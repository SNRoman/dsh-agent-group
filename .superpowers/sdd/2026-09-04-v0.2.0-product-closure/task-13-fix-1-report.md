# Task 13 review fix 1 report

## Result

The implementation commit is `c3700da` (`fix(web): preserve definition workflow state`).

## RED evidence

Before changing production code, the following real-DOM suite ran against the review tests:

```text
pnpm vitest run tests/workspace-definition-view.spec.ts
```

After adding the aggregate-revision replacement case, it reported 21 tests with 10 failures. The failures covered reversed revision order in both locales, history retained during definition and aggregate-revision replacement loading, modal-hidden save stale/error recovery, duplicate pending-save Escape requests, stale-save Escape changing the workflow, pending later-sync Escape closing the dialog, and absent later-dialog initial focus.

## GREEN evidence by finding

1. History now sorts unordered RPC items by ascending revision number and then id. The DOM fixture is deliberately unordered (`3`, `1`, `2`) and asserts display order `1`, `2`, `3` in both locales.
2. History carries its definition/revision owner. A changed owner renders loading and no cards before the replacement request resolves; generation and abort checks continue to suppress late responses. Deferred DOM tests cover both definition selection and aggregate-revision replacement.
3. Save stale and safe-error messages, plus their explicit retry controls, render inside the save dialog. Tests scope all recovery actions to the active `aria-modal` dialog and verify the preserved subset and safe error text.
4. Save Escape and close submit synchronize-none only from idle state. Pending, stale, and error save workflows keep their preserved choice; request refs prevent duplicate in-flight calls. Later-sync Escape dismisses only idle state, while pending, stale, and error keep their recovery workflow. Deferred DOM tests cover repeated pending-save Escape, stale-save Escape, pending later-sync Escape, rejection, and explicit retry.
5. The later-sync cancel button receives initial focus when its dialog opens. A post-render focus restoration state returns focus to the exact save or later-sync trigger after safe dismissal and successful mutation. DOM tests assert initial and restored focus for both dialogs.

## Verification

```text
pnpm vitest run tests/workspace-memory-view.spec.ts tests/workspace-definition-view.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts
# PASS: 4 files, 65 tests

pnpm vitest run tests/memory-query.spec.ts tests/memory.spec.ts tests/definition-history.spec.ts tests/workspace-rpc.spec.ts tests/workspace-web-upgrade.spec.ts tests/workspace-async-dispatch.spec.ts tests/workspace-memory-view.spec.ts tests/workspace-definition-view.spec.ts tests/workspace-view.spec.ts tests/workspace-locale.spec.ts
# PASS: 10 files, 272 tests

pnpm verify:client-copy
# PASS

pnpm run typecheck
# PASS

pnpm run build:web
# PASS

pnpm test
# PASS: 33 files, 662 tests

git diff --check
# PASS
```

## Remaining risks

The focused coverage uses jsdom; assembled Browser workflow and runtime presentation remain assigned to Tasks 15 and 14 respectively. This fix does not change named CAS APIs, snapshot adoption, memory behavior, or supported DSH checkout state.
