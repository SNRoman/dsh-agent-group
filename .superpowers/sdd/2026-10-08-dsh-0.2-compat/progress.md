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
