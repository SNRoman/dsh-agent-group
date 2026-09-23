# Agent Workspace v0.3.0 Latest DSH Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an unpublished `0.3.0` candidate that preserves the `0.2.0` product behavior while installing and running on DeepSeek Harness `0.1.7-alpha.2`.

**Architecture:** Keep Host persistence and workspace behavior intact, migrate the Browser half from the removed client runtime to the latest static module-table baseline, and drive all dependency and release evidence from one exact compatibility declaration. Validate the result first at source/type boundaries, then through packed artifacts in a clean latest-DSH Web profile.

**Tech Stack:** TypeScript strict ESM, React 18, Cordis, DSH `0.1.7-alpha.2`, Zod 4, Vitest, pnpm 11.7.0, tsdown, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-latest-dsh-compat-design.md`

## Global Constraints

- Plugin `0.3.x` supports DSH `>=0.1.7-alpha.2 <0.1.8-0`; plugin `0.2.x` remains the line for DSH `>=0.1.1-rc.2 <0.1.2-0`.
- Verified source is DSH `0.1.7-alpha.2` commit `00102833dfaee1da9f48a3a8eae9d34005a75218`.
- Preserve storage-domain version `0`, durable records, session bindings, agent rights, mention behavior, delegation, child runs, employment lifecycle, and unified memory.
- Do not implement the broader multi-workspace/import/extension proposal in this release.
- All test scratch, DSH homes, browser evidence, and compatibility copies live on E; set `TEMP` and `TMP` explicitly for every command that creates temporary data.
- Do not publish, tag, push, merge, or create a GitHub Release.

## Review Focus

- A browser bundle that compiles but still emits `require('@deepseek-ai/dsh-client-runtime/client')` must fail before browser smoke.
- A manifest that allows old DSH to install `0.3.x` must fail compatibility validation.
- A latest-DSH API adaptation that changes durable workspace data or model-visible behavior must be rejected by existing domain and browser suites.
- A source check against the wrong DSH commit must fail before building.
- A smoke failure must retain enough E-drive evidence for diagnosis but cleanup must remove successful-run scratch and never leave C-drive test homes.

---

### Task 1: Declare the new release line and compatibility matrix

**Files:**
- Modify: `tests/release-contract.spec.ts`
- Modify: `tests/compatibility.spec.ts`
- Modify: `compatibility.json`
- Modify: `package.json`
- Modify: `packages/host/package.json`
- Modify: `packages/web/package.json`
- Modify: `packages/bundle/package.json`
- Modify: `packages/host/src/forward-export.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `packages/host/README.md`
- Modify: `packages/web/README.md`
- Modify: `packages/bundle/README.md`
- Create: `docs/releases/v0.3.0.md`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces `compatibility.json` candidate `0.3.0`, peer range `>=0.1.7-alpha.2 <0.1.8-0`, registry version `0.1.7-alpha.2`, and exact source commit.
- Produces a root README table that retains the historical `0.2.x` row and identifies `0.3.x` as the current line.
- Preserves forward export format name `dsh-agent-workspace` and format version `1`; only its producer plugin version becomes `0.3.0`.

- [ ] **Step 1: Write RED release-contract expectations**

Update the release-contract and compatibility tests to expect all three package versions and `candidatePluginVersion` to equal `0.3.0`, the new DSH range/version/commit, the historical and current README table rows, and the release note link. Keep literal expectations independent of `compatibility.json`.

- [ ] **Step 2: Run focused RED**

Run: `pnpm vitest run tests/compatibility.spec.ts tests/release-contract.spec.ts`

Expected: FAIL on the first `0.2.0` candidate/range assertion.

- [ ] **Step 3: Update declarations and documentation**

Set the three public manifests to `0.3.0`. Replace every DSH peer/dev/dependency range in public manifests with `>=0.1.7-alpha.2 <0.1.8-0`; set root DSH dev dependencies to `0.1.7-alpha.2`; add `@deepseek-ai/dsh-client-store`; remove `@deepseek-ai/dsh-client-runtime`. Update the exact CI source ref, compatibility declaration, forward-export producer version, package READMEs, root matrix, commands, and `v0.3.0` release notes. Regenerate the lockfile with `pnpm install --lockfile-only`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm verify:compatibility && pnpm vitest run tests/compatibility.spec.ts tests/release-contract.spec.ts`

Expected: PASS with the declaration, manifests, README, workflow, and tests aligned.

Commit: `build: target dsh 0.1.7-alpha.2`

---

### Task 2: Migrate the Browser module contract

**Files:**
- Modify: `tests/workspace-locale.spec.ts`
- Create: `tests/client-bundle-compat.spec.ts`
- Modify: `packages/web/src/client/index.ts`
- Modify: `packages/web/src/client/store.ts`
- Modify: `packages/web/tsdown.config.ts`
- Modify: `packages/web/package.json`

**Interfaces:**
- Consumes the Task 1 dependency on `@deepseek-ai/dsh-client-store`.
- Produces an `@dsh-agent-group/web` browser factory whose external requests are only latest shell baseline keys and whose `apply` accepts `Context` from Cordis.

- [ ] **Step 1: Write the failing bundle compatibility test**

Build Web, evaluate `lib/client.js` through a fake `window.__ModuleLoader__`, record every requested module id, and supply real latest-DSH-compatible baseline values for React, store, slots, and primitives. Assert activation does not request `@deepseek-ai/dsh-client-runtime/client`, the factory id is exact, and every request belongs to this literal set:

```ts
new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])
```

The production regression caught is reintroducing a removed/non-baseline external that makes latest DSH display “Failed to load plugins.”

- [ ] **Step 2: Run RED**

Run: `pnpm build:web && pnpm vitest run tests/client-bundle-compat.spec.ts tests/workspace-locale.spec.ts`

Expected: FAIL because the current artifact requests `@deepseek-ai/dsh-client-runtime/client`.

- [ ] **Step 3: Implement the minimum migration**

Use `import type { Context } from '@deepseek-ai/cordis'` in the client entry and `import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store` in the store. Update `SHARED_BROWSER_MODULES` to the latest baseline keys, keep the factory wrapper and private-bundle rule, and update locale-test module injection to provide the store package rather than the removed runtime.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm build:web && pnpm vitest run tests/client-bundle-compat.spec.ts tests/workspace-locale.spec.ts tests/workspace-ui-registration.spec.ts && pnpm typecheck`

Expected: PASS with no removed runtime request in source or artifact.

Commit: `fix: migrate the browser module contract`

---

### Task 3: Adapt Host APIs against the exact DSH source point

**Files:**
- Modify: `packages/host/src/index.ts`
- Modify: `packages/host/src/runtime.ts`
- Modify: `packages/host/src/activity-controller.ts`
- Modify: `packages/host/src/dispatcher.ts`
- Modify: `packages/host/src/task-delivery.ts`
- Modify: `packages/host/src/task-delivery-coordinator.ts`
- Modify: `packages/host/src/turn-tracker.ts`
- Modify: `tests/browser-scripted-protocol.spec.ts` if the DSH tool-call brand rename reaches the scripted adapter.
- Modify: `tests/runtime.spec.ts` only when its fixture no longer implements the latest public Agent contract.

**Interfaces:**
- Consumes Task 1 exact-source metadata and Task 2 browser build.
- Produces a source-compatible Host without changing `WorkspaceState`, its schema, or stored event variants.

- [ ] **Step 1: Run the exact source compatibility command as RED**

Run: `pnpm test:dsh-source -- --dsh E:/003code/deepseek-harness`

Expected: FAIL at compile/typecheck on concrete pre-stable API differences while accepting the exact DSH version and commit.

- [ ] **Step 2: Add a focused behavior test for each semantic API difference**

Before each production change, add or update the narrow test that would fail if the adaptation dropped a queued message, failed to dispose an employee handle, changed a task result, lost a model-visible source, or confused tool-call identity. Pure type-only renames require a compile RED rather than a runtime change-detector test.

- [ ] **Step 3: Implement only compiler-identified adaptations**

Preserve the plugin's declaration-merged `agent-workspace-delivery` and `agent-workspace-recall` message sources. Update renamed public types or changed lifecycle method calls directly at their consumers. Do not alter state/schema/migration code unless a latest public API makes the existing durable operation invalid and a RED test demonstrates the required behavior.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm build && pnpm typecheck && pnpm test:dsh-source -- --dsh E:/003code/deepseek-harness`

Expected: PASS against exact source commit `00102833dfaee1da9f48a3a8eae9d34005a75218`.

Commit: `fix: adapt the host to current dsh APIs`

---

### Task 4: Prove packed installation and real Browser behavior

**Files:**
- Modify: `scripts/source-compatibility.mjs`
- Modify: `scripts/release-smoke.mjs`
- Modify: `tests/release-contract.spec.ts`
- Modify: `tests/e2e/workspace-browser.mjs` only for latest-DSH UI selectors or protocol changes demonstrated by RED smoke evidence.

**Interfaces:**
- Consumes the `0.3.0` artifacts and exact DSH source point from Tasks 1–3.
- Produces packed-smoke evidence under an E-drive scratch root and removes it after success.

- [ ] **Step 1: Write RED scratch-location and latest-source assertions**

Add release-contract tests that pass an explicit E-drive scratch root into source compatibility and packed smoke helpers, assert owned paths are descendants of it, and reject a verified-source mismatch before install. The production regressions caught are falling back to `os.tmpdir()` on C and testing an unverified Harness checkout.

- [ ] **Step 2: Run focused RED**

Run: `pnpm vitest run tests/release-contract.spec.ts tests/compatibility.spec.ts`

Expected: FAIL because the current helpers always call `tmpdir()` and expose no explicit scratch root.

- [ ] **Step 3: Implement explicit E-drive scratch ownership**

Accept a `scratchRoot`/environment input, resolve every compatibility copy, profile home, evidence directory, and browser artifact below it, validate containment before recursive cleanup, and retain failing evidence only when the caller passes `--keep`. Update command documentation to show `TEMP`, `TMP`, and the scratch argument on E.

- [ ] **Step 4: Run complete local gates**

Run with `TEMP` and `TMP` set to the worktree `.tmp` directory:

```sh
pnpm verify:client-copy
pnpm verify:compatibility
pnpm build
pnpm typecheck
pnpm test
pnpm release:pack
pnpm smoke:packed -- --dsh E:/003code/deepseek-harness
git diff --check
```

Expected: all commands pass; browser evidence shows the Workspace opens and completes the deterministic product workflow; the browser console has no plugin import failure.

- [ ] **Step 5: Verify cleanup and commit**

Confirm no owned `dsh-agent-group*` test directory exists in C temp, no smoke server remains, and successful-run E scratch has been removed. Preserve only committed fixtures and release artifacts required by the candidate.

Commit: `test: verify dsh 0.1.7 packed compatibility`

---

### Task 5: Whole-branch review and candidate handoff

**Files:**
- Review all changes from tag `v0.2.0` through branch HEAD.

**Interfaces:**
- Consumes every prior task and the acceptance criteria in the design spec.
- Produces a reviewed, unpublished `0.3.0` candidate branch.

- [ ] **Step 1: Generate the review package and request one fresh review**

Review dependency ranges, module-table requests, Host behavior preservation, scratch containment, release evidence, README accuracy, and absence of publishing side effects.

- [ ] **Step 2: Resolve Critical/Important findings with RED→GREEN tests**

Run each reproducer before its fix, rerun its focused suite after the fix, then rerun `pnpm release:check` and the packed smoke for any finding touching shipped artifacts.

- [ ] **Step 3: Final completion audit**

Verify each design acceptance criterion against fresh command output, inspect `git status`, inspect the final diff, and report deferred Minor findings and recorded rulings. Do not publish or push.

Commit: `chore: finalize the dsh 0.1.7 compatibility candidate`
