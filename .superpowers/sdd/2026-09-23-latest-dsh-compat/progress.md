# SDD ledger — plan: docs/superpowers/plans/2026-09-23-latest-dsh-compat.md

Ruling: the bundled SDD bash helpers cannot access this Windows worktree through the installed WSL launcher, so task briefs and ledger updates are managed directly in the plan-scoped ignored directory — the cost if wrong is loss of helper-generated formatting, not product behavior.

Pre-flight: Task 1 produces the exact package versions and DSH dependencies consumed by Task 2; names and ranges agree.
Pre-flight: Task 1 produces exact source metadata consumed by Task 3; version and commit agree with the spec.
Pre-flight: Tasks 2 and 3 produce Web and Host artifacts consumed by Task 4; package ids and entry points remain unchanged.
Pre-flight: Task 4 produces verification evidence consumed by Task 5; acceptance commands match the spec.

Baseline: `pnpm build` passed on v0.2.0. Full `pnpm test` passed 767/768 and timed out only `build-layout.spec.ts`'s 5-second dynamic import at 5.9 seconds under full concurrency; the isolated test passed in 321 ms. This is recorded as a pre-existing concurrency-sensitive baseline, not treated as a compatibility regression.

Task 1: complete. RED: the focused compatibility/release-contract run failed on the old candidate version, peer range, source point, and missing `v0.3.0` note. GREEN: `pnpm verify:compatibility` passed and `pnpm vitest run tests/compatibility.spec.ts tests/release-contract.spec.ts` passed 30 tests after updating all current CI/smoke source refs, manifests, lockfile, documentation, and producer metadata.

Task 2: complete. RED: the built bundle requested `@deepseek-ai/dsh-client-runtime/client` and the new compatibility test did not observe `@deepseek-ai/dsh-client-store`; the latest Web build also rejected missing slots type augmentation and required Markdown labels. GREEN: `pnpm build:web` passed, the built artifact requests `@deepseek-ai/dsh-client-store`, and five focused Browser suites passed 93 tests. The migration imports Cordis `Context`, the renderer service merge, current store APIs, and locale-owned Markdown chrome labels.

Task 3: in progress
