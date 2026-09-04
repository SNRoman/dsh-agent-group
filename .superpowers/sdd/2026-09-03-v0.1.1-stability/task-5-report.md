# Task 5 report: localize all plugin-owned client copy

## Status

DONE. The implementation is ready for independent review on `codex/v0.1.1-stabilization`.

## Implementation

- Added the typed `agentWorkspace` locale namespace with complete Simplified Chinese and English dictionaries. Both additive slots declare the namespace and receive `PropsLocale<'agentWorkspace'>`.
- Routed workspace chrome, empty states, live-turn labels, accessibility text, room and actor fallbacks, and definition controls through `t` while leaving user, model, tool, and external diagnostic values unchanged.
- Preserved `WorkspaceApiError` objects in UI state so business codes and their correlated details are localized at render time without parsing Host messages.
- Declared `@deepseek-ai/dsh-client-locale` in Browser injection, peer dependencies, development dependencies, and the root reproducible development pin.
- Added an AST-based client-copy verifier with source coordinates and guarded categories for JSX text, accessibility/display attributes, and display-helper literal returns. Its named exceptions cover hidden glyphs, the `@all` protocol token, event sequence markers, and member-name mention prefixes.
- Wired `verify:client-copy` into `release:check` and CI as a named step.

## TDD evidence

### RED

- `pnpm vitest run tests/client-copy-verifier.spec.ts` failed because `scripts/verify-client-copy.mjs` did not exist.
- The first locale import failed before product assertions because the published Browser module reads `window` during evaluation. The harness was narrowed to load the real `LocaleRuntime` with browser globals and test-only aliases for Browser-only runtime/primitives; this infrastructure failure was not counted as behavioral RED.
- `pnpm vitest run tests/workspace-locale.spec.ts --testTimeout=15000 --hookTimeout=15000` then failed 5/5 on missing English copy, missing locale injection/registration, hardcoded UI text, and business errors displaying their Host diagnostic instead of stable code/details localization.
- The first real client-tree verifier run rejected four remaining literals, including the product-owned `Revision` label. The protocol token and user-data markers were covered by narrow structural rules; `Revision` moved into the dictionaries.

### GREEN

- `pnpm vitest run tests/workspace-locale.spec.ts tests/workspace-ui-registration.spec.ts tests/workspace-view.spec.ts tests/client-copy-verifier.spec.ts --testTimeout=15000 --hookTimeout=15000`: 4 files, 22/22 tests passed.
- `pnpm verify:client-copy`: passed against the real client tree.
- `pnpm build`: Host, Web, and bundle builds passed.
- `pnpm typecheck`: passed.
- `pnpm test -- --maxWorkers=1 --testTimeout=15000`: 23 files, 203/203 tests passed.

## Test infrastructure

Vitest resolves the Browser-only store factory and UI primitive bundle to two test fixtures. Production builds and typechecks still resolve the published packages. The fixtures expose only the functions needed to register and render the real Agent Workspace components; the locale test itself instantiates the published `LocaleRuntime`, registers the real plugin, changes locale, and disposes plugin registrations. Browser globals and React dispatcher state are restored by the test harness.

## Self-review

- Confirmed the English dictionary statically satisfies every key owned by the Chinese dictionary.
- Confirmed both slot registrations declare `locale: 'agentWorkspace'` and the Cordis inject list includes `locale`.
- Confirmed business presentation switches on the closed Task 3 code union and formats only safe structured details.
- Confirmed the AST verifier rejects every required category with file, line, column, and category, while its exceptions are structural rather than a general string whitelist.
- Confirmed storage state and storage-domain version are unchanged.

## Concerns

The real locale Browser bundle needs a small module-loader harness in Node tests because it is not a Node entry point. The release Browser smoke in Task 6 remains the authoritative assembled-profile proof.

## Review fix round 1

Independent review found that stream failures were formatted and cached in the current locale before render, and that the AST gate missed literals inside TSX expressions and compound display-helper returns. It also noted that the Browser test aliases applied to the whole suite.

RED evidence:

- A real overlay subscription failure rendered two rows after a locale change: a generic English request failure and a stream failure containing the cached Chinese prefix.
- Extended verifier fixtures using JSX string expressions, expression accessibility attributes, conditional display returns, and interpolated template returns failed their expected diagnostic counts.

The stream now stores its raw display-safe error and formats it once with the current locale and stream-specific fallback. The verifier inspects direct and compound display expressions while preserving only structurally identified technical markers. Vitest uses separate unit and locale projects, so the two Browser-only aliases apply only to the locale test.

Final fresh verification after the fixes:

- Task 5 focused tests: 4 files, 23/23 passed.
- `pnpm verify:client-copy`: passed.
- `pnpm release:check`: AST gate, all three builds, typecheck, and 23 files with 204/204 tests passed.
