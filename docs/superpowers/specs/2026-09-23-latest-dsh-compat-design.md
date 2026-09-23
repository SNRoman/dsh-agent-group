# Agent Workspace v0.3.0 Latest DSH Compatibility Design

## Status

Approved in chat on 2026-09-23. This design defines the compatibility-only `0.3.0` release and supersedes the DSH-version assumptions in the earlier compatibility-foundation proposal. Multi-workspace management, import, backup UI, and public extension APIs remain future work.

## Goal

Make the released Agent Workspace product surface from `0.2.0` install, load, and operate on DeepSeek Harness `0.1.7-alpha.2` without changing its durable workspace semantics. Preserve `0.2.x` as the supported line for DSH `>=0.1.1-rc.2 <0.1.2-0`.

## Version Policy

| Plugin line | Supported DSH range | Verified DSH point |
|---|---|---|
| `0.2.x` | `>=0.1.1-rc.2 <0.1.2-0` | `0.1.1-rc.2` at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| `0.3.x` | `>=0.1.7-alpha.2 <0.1.8-0` | `0.1.7-alpha.2` at `00102833dfaee1da9f48a3a8eae9d34005a75218` |

One package artifact does not support both client architectures. Users on the old Harness line retain `0.2.x`; the `0.3.x` manifests reject it through peer ranges.

## Client Migration

DSH `0.1.7-alpha.2` removed `@deepseek-ai/dsh-client-runtime`. The plugin imports `Context` from `@deepseek-ai/cordis`, imports `defineStore` and `EngineStoreHandle` from `@deepseek-ai/dsh-client-store`, and keeps locale, layout, sidebar, and Connection relationships type-only where applicable.

The browser bundle uses the latest shell baseline exactly: React, React JSX runtime, Cordis, client store, UI slots, and UI primitives remain external module-table requests. Feature plugins are not value-imported or declared through `dsh.client.external`. All other browser dependencies remain private bundle content. The emitted factory id remains `@dsh-agent-group/web`.

## Host Migration

The Host retains storage-domain version `0`, workspace record fields, event ids, memories, tasks, employment periods, and session bindings. Source compilation against the exact verified DSH checkout determines API adaptations. Adaptations may update renamed types or lifecycle calls but may not change agent rights, mention routing, delegation authority, child behavior, or unified memory.

## Compatibility Evidence

`compatibility.json` remains the machine-readable source for candidate version, peer range, registry development version, and exact source commit. The root README adds the two-line compatibility matrix and clearly separates historical `0.2.x` evidence from current `0.3.x` evidence. Package READMEs describe only the line they ship.

The release gate must prove:

1. manifests, README text, workflow source checkout, and compatibility metadata agree;
2. TypeScript and unit tests run against exact `0.1.7-alpha.2` packages;
3. the browser bundle does not request the removed client runtime and can resolve every external from the latest DSH module table;
4. packed Host, Web, and bundle artifacts install into a clean latest-DSH profile;
5. the real Web page opens and the deterministic browser workflow exercises definition, colleague, room, task, memory, runtime, restart persistence, and uninstall behavior.

## Temporary Data Policy

All compatibility copies, profile homes, Playwright evidence, and smoke output live under the plugin worktree or another explicit E-drive directory. Test commands set `TEMP` and `TMP` to that E-drive scratch directory. The workflow removes its owned scratch directory after verification and never creates a worktree or persistent test home on C.

## Non-goals

- Dual compatibility in one `0.3.0` artifact.
- Multi-workspace lifecycle or migration.
- Import or restore support for the existing forward export.
- New external extension APIs.
- Publishing, tagging, or creating a GitHub Release.

## Acceptance Criteria

`0.3.0` compatibility work is complete when the compatibility declaration and README matrix are current, all packages build and typecheck against exact DSH `0.1.7-alpha.2`, focused and full tests pass, packed artifacts complete the clean-profile browser smoke on that source commit, no removed runtime request remains in the browser artifact, and all owned E-drive smoke data is cleaned. Publication remains a separately authorized action.
