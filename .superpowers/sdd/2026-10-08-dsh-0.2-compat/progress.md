# SDD ledger — plan: docs/superpowers/plans/2026-10-08-dsh-0.2-compat.md

Ruling: bundled SDD shell helpers are not used because this Windows checkout previously proved inaccessible through the installed WSL launcher; the plan brief and ledger are managed directly — if wrong, only helper-generated formatting is lost, not product behavior.

Pre-flight: Task 1 produces the exact DSH worktree path and identity consumed by Tasks 2–5; version and commit agree with the spec.
Pre-flight: Task 2 produces version, range, manifest, workflow, lockfile, and documentation metadata consumed by Tasks 3–5; all exact values agree with the spec.
Pre-flight: Task 3 produces Host/Web code and tests consumed by Task 4; package ids, Browser factory id, RPC path, storage version, and durable format remain unchanged.
Pre-flight: Task 4 produces final tarballs and Browser evidence consumed by Task 5; verification commands and cleanup policy agree with the spec.
Pre-flight: Task 5's DSH 0.2.1 canary is isolated from Task 2's supported range; it may record evidence but cannot mutate release compatibility claims.

Task 1 complete: prepared `E:/003code/deepseek-harness-plugins/.tmp/dsh-source-020` at commit `639ed015397290b3745d163aafe02ffee4aa3f84`; `apps/cli/package.json` reports `0.2.0-rc.2`; `pnpm install --frozen-lockfile` completed successfully.

Task 2 RED: `pnpm exec vitest run tests/compatibility.spec.ts tests/release-contract.spec.ts` failed five release-contract assertions against the old `0.3.0`, DSH `0.1.7-alpha.2`, source commit, documentation, and workflow declarations.

Task 2 GREEN: `pnpm verify:compatibility` passed; `pnpm exec vitest run tests/compatibility.spec.ts tests/release-contract.spec.ts` passed 31 tests after updating manifests, peer ranges, exact dependencies, source pins, compatibility matrix, release notes, workflow refs, and lockfile.

Task 3 setup RED: the first `pnpm test:dsh-source` attempt reached the isolated plugin copy but failed module resolution because the DSH source checkout had no generated `lib` exports. This was a missing documented CI prerequisite rather than an API incompatibility.

Task 3 GREEN: after `pnpm build:lib` completed in the exact DSH checkout, `pnpm test:dsh-source -- --dsh E:/003code/deepseek-harness-plugins/.tmp/dsh-source-020 --scratch-root E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-source-020` built Host, Web, and bundle, passed typecheck, and passed 41 test files / 784 tests. No Host or Web production-code adaptation was required beyond the versioned forward-export constant.

Task 4 RED 1: the packed Browser run showed DSH 0.2 already owned `deepseek-official`; the fixture's duplicate adapter prevented complete Host startup. A release-contract assertion was added before moving the deterministic fixture to `agent-workspace-scripted` / `workspace-smoke` and explicitly selecting it in the overlay.

Task 4 setup RED: after Host startup recovered, the Browser root returned 404 because `--skip-dsh-prepare` was used before the required DSH `build:web`; `pnpm build:web` restored the pinned checkout's frontend artifact.

Task 4 RED 2: the DSH 0.2 `Preview Notice` replaced the older testing-notice title and intercepted the workspace picker. A release-contract assertion was added before extending the bilingual dialog selector.

Task 4 RED 3: a direct-room transition cleared the one-shot Playwright `fill` during a controlled-input rerender. A release-contract assertion was added before changing the driver to `pressSequentially`, which keeps the controlled draft synchronized across the transition.

Task 4 GREEN: the final `pnpm release:pack` passed 41 files / 784 tests and produced the three `0.4.0` tarballs. Two consecutive packed Browser smokes passed with evidence `packed-0.4.0-2026-10-08T14-22-25-361Z-e31cbed7` and `packed-0.4.0-2026-10-08T14-24-48-849Z-f91293ec` under `E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-smoke-040/evidence`.

Task 5 canary: direct `pnpm test:dsh-source` against DSH `0.2.1-alpha.1` commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc` failed at the intended compatibility gate (`expected 0.2.0-rc.2, actual 0.2.1-alpha.1`). Source comparison confirms that the canary removes `@deepseek-ai/dsh-invariants` and package-local invariant exports. Plugin production code imports none of them; the root-only development dependency must be removed when a separate `0.2.1` plugin line is prepared. The `0.4.x` range remains unchanged.

Independent review: found one important documentation issue and no critical issues. The unversioned install/update examples could move an older DSH deployment across plugin lines. A release-contract test was added RED before pinning current examples to `dsh-agent-group@0.4.0` and documenting that updates must remain within the DSH-specific plugin line.
