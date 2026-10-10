# dsh-agent-group · Agent Organization（智能体组织）

Agent Organization（智能体组织）is a persistent organization of AI colleagues for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Reusable agent roles become named colleagues with employment history and unified personal memory. Colleagues join rooms, remember admitted events even while silent, reply to mentions, receive human-authorized tasks, and run one-shot child agents. The npm package name remains `dsh-agent-group`.

This branch contains unreleased organization-recovery development. Registry version `0.4.0` remains the released single-organization product; installing it does not enable the multi-organization or Browser recovery features described below. Package versions and DSH compatibility ranges have not been changed.

## Features

- **Agent definitions and instances** — define reusable roles, create multiple named instances, and keep each instance's employment lifecycle, memory, memberships, tasks, and durable DSH session independent.
- **Group rooms and direct chat** — create group rooms, open a stable direct room for an employed agent, and retain durable room history in the plugin-owned `agent_workspace` domain.
- **Explicit join memory** — every group join requires the human to choose either events created after the join or an inclusive historical event range; joining never silently selects a history policy.
- **Mention routing** — `@agent` wakes only the selected employed room members; lowercase `@all` expands to all active employed members of a group. Agent-to-agent chains remain bounded by the workspace dispatcher.
- **Live turns** — stream assistant text, reasoning, and tool activity into the Agent Organization UI while a DSH employee turn is in flight, then converge to the durable room event.
- **DSH-native rendering** — final and streaming text use DeepSeek Harness Markdown primitives; reasoning and tool calls use disclosure rows instead of a second conversation renderer.
- **Tasks and delegation** — ordinary mentions are communication. Formal peer delegation requires a human-created, task-scoped `DelegationGrant`.
- **Child agents** — an employed agent can run a one-shot DSH child agent and retain the terminal result in personal memory without turning the child into a workspace colleague.
- **Additive integration** — the Browser package registers only `sidebar.footer.action` and `shell.overlay`; it does not replace the core `sidebar`, `conversation`, or `details` surfaces and does not intercept `/api`.
- **Localized policy feedback** — Simplified Chinese and English dictionaries own plugin UI copy, while stable Host error codes keep localization independent from exception text.
- **Four product views** — Definitions manages reusable roles and immutable definition revision history; Tasks shows assignment, grants, attempts, cancellation, child work, and results; Memory exposes each colleague's unified event history; Runtime shows live activity and exact stop controls.
- **Memory with sources** — colleagues can search their own admitted event history by keyword and read original events on demand, with source and event identifiers for follow-up. Room replies and formal tasks draw on the same personal history.
- **Independent organizations (development)** — create, rename and select persistent organizations with separate colleagues, rooms, tasks, personal memory, runtime streams and DSH sessions. Identical internal entity IDs in different organizations do not select the same employee.
- **Recoverable organizations (development)** — archive with an explicit stop-or-wait choice, reopen after work settles, and export or restore through the Browser. Restoration creates a new organization after a read-only preview and human confirmation; it never replaces the source or restores its DSH sessions.
- **Forward compatibility export** — the read-only `export:forward-v1` command creates a canonical, checksummed handoff for a future importer while leaving the source storage untouched. Version `0.4.0` does not include an importer.

## Requirements

- DeepSeek Harness on the `0.2.0` release-candidate line, starting at `0.2.0-rc.2`.
- Node.js `^22.19.0` or `>=24.0.0`.
- `pnpm` available on `PATH`. The official `dsh plugin` command delegates profile package management to pnpm.

DeepSeek Harness compatibility: >=0.2.0-rc.2 <0.2.1-0; registry development: 0.2.0-rc.2; verified source: 0.2.0-rc.2 (639ed015397290b3745d163aafe02ffee4aa3f84).

### Compatibility matrix

| Plugin line | Supported DeepSeek Harness | Verified point |
|---|---|---|
| `0.2.x` | `>=0.1.1-rc.2 <0.1.2-0` | `0.1.1-rc.2` (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`) |
| `0.3.x` | `>=0.1.7-alpha.2 <0.1.8-0` | `0.1.7-alpha.2` (`00102833dfaee1da9f48a3a8eae9d34005a75218`) |
| `0.4.x` | `>=0.2.0-rc.2 <0.2.1-0` | `0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`) |

Install `0.2.x` when the Harness deployment remains on the `0.1.1` line, or `0.3.x` for the `0.1.7` line. The current `0.4.x` package targets DSH `0.2.0` and does not include a dual-runtime compatibility layer.

## Install

Install the profile bundle through the official DeepSeek Harness plugin command:

```sh
dsh plugin --profile web add dsh-agent-group@0.4.0
```

Then start the normal Harness web profile:

```sh
dsh web
```

The bundle declares `dsh.bundle.patch`; Harness adds it to the profile layer stack automatically. You do not need to clone this repository, patch DeepSeek Harness, or manually edit the profile bundle list.

For a domain/runtime-only deployment, the same bundle can be added to a profile that already provides the DSH core and storage stack, such as `headless`. The Browser half is a no-op on the Node side and activates only on the web client platform.

### Update

Do not update across plugin lines: keep plugin `0.2.x` on DSH `0.1.1`, plugin `0.3.x` on DSH `0.1.7`, and plugin `0.4.x` on DSH `0.2.0`. Within the supported line, run:

```sh
dsh plugin --profile web update dsh-agent-group@0.4.0
```

### Remove

```sh
dsh plugin --profile web remove dsh-agent-group
```

## Packages

| Package | Role |
|---|---|
| `@dsh-agent-group/host` | Durable organization domain, persistence boundary, colleague runtime, dispatcher, turn stream, tasks, memory, and invariants. |
| `@dsh-agent-group/web` | Additive Agent Organization Browser UI and Connection RPC client. |
| `dsh-agent-group` | Installable DeepSeek Harness profile bundle that mounts Host and Browser packages. |

Users should normally install only `dsh-agent-group`; the two scoped packages are published dependencies of the bundle.

## Runtime integration

The Host service is exposed as `ctx.agentWorkspace`. Development source stores each organization descriptor and aggregate in one versioned record in the existing DSH storage-domain stack. `ctx.agentWorkspace.forWorkspace(id)` selects a fixed organization runtime; it does not read the Browser's current selection. Optional Harness services such as `agents`, `subagents`, and `connection` remain dynamically attached.

The Browser transport uses the existing Harness Connection RPC service on the plugin-local Agent Workspace channel. There is no second HTTP/WebSocket server, no core API interception, and no replacement of the standard Harness conversation store.

## Organization workflow

Create a definition, then create named colleagues from it. Add colleagues to a group with an explicit memory start, use mentions for conversation, and use Tasks when work needs durable ownership or human-authorized delegation. Memory belongs to the colleague rather than to one chat: a silent member remembers admitted room events, task results, and child results. Saving a new definition revision offers none, all, or a selected subset of existing colleagues for synchronization; every colleague remains pinned to an immutable revision.

Keyword memory search returns references and short excerpts; colleagues can request the original events when they need detail. Each retrieved event retains its source and sequence. Search covers only events admitted to that colleague's memory, including room history explicitly chosen at joining. This is keyword retrieval, not semantic or vector search. An event from another room may be recalled by a colleague who owns it; room secrecy is not enforced.

Runtime activity is intentionally ephemeral. The durable task attempt and result remain authoritative, while the drawer shows queued, responding, stopping, and settled activity for the current Host process. Exact stop targets one activity identity; an interrupted task remains open and retryable, does not acquire a task result, and does not cancel unrelated queued work.

## Organization recovery (development)

Use the organization directory at the top of the overlay to create, rename or switch organizations. Switching clears entity selection and drafts and cancels the old organization's subscriptions and refreshes. The original unversioned `local` record is validated and wrapped once on startup without changing its business history or Session bindings; the storage domain remains version `0`.

Archiving first prevents new work and durably marks the organization read-only. Choose **Stop current work** to stop that organization's exact queued deliveries, claimed turns and children, or **Wait for current work** to let admitted work finish. The archive request waits for full settlement and cleanup. Reopening restores admission without rewriting history or assigning tasks.

Export requires an idle organization and explicit confirmation because the file contains role instructions, messages and personal memory. The development exporter writes checksummed portable format version `2`, including the label and archive state but excluding local Session bindings and creation/import operation metadata. A busy organization or an unfinished durable delivery cannot be exported.

Choose a JSON file under **Import organization** to validate and preview it without writing. Check the source version and entity counts, edit the destination label, then confirm creation of a new organization. The importer accepts frozen version `1` and development version `2` files, retains entity IDs and history, and rebases task-delivery identities to the new organization ID. It rejects invalid or unfinished work instead of running it automatically. Imported archived organizations remain read-only until reopened; their colleagues acquire new local DSH Sessions only when explicitly given work.

The checksum detects corruption, not authorship. Keep exported files private and obtain authorization before sharing their complete organization history. Import size, string, entity, event and depth budgets are deployment settings; see the [Host configuration](packages/host/README.md#organization-recovery-development).

## Forward export

v0.2.0 introduced portable format `dsh-agent-workspace` version `1`; v0.4.0 preserves that read-only exporter. Build the Host package, then export an explicit storage-domain document:

```sh
pnpm build:host
pnpm export:forward-v1 -- --input E:/exports/agent-workspace.json --output E:/exports/workspace-portable-v1.json --exported-at 2026-09-04T00:00:00.000Z
```

The command validates one version-`0` local aggregate, preserves definitions, colleagues, employment history, rooms, Tasks, Memory, child results, and events, omits local DSH session bindings, refuses to overwrite its output, and never changes the source. This release deliberately provides no import endpoint and no Browser backup control.

## Development

This repository is a pnpm workspace. Default development installs the verified DeepSeek Harness packages from the public registry.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Maintainers can check the declared Harness source point without changing either checkout:

```sh
pnpm test:dsh-source -- --dsh <absolute-path-to-deepseek-harness> --scratch-root E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-source
```

The command copies this plugin to an operating-system temporary directory, generates source overrides only in that copy, and removes it after the check. CI runs the default registry verification and this explicit source check separately.

## Release

Before publishing, run the packed release gate:

```sh
pnpm exec playwright install chromium
pnpm release:pack
pnpm smoke:packed -- --dsh <absolute-path-to-deepseek-harness-0.2.0-rc.2> --scratch-root E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-smoke
```

The Playwright command installs the Chromium runtime used by the smoke. `release:pack` runs build, typecheck, tests, packs the three npm artifacts in dependency order into `release/`, clears any earlier smoke receipt, and records their hashes together with the deterministic build-input hash. `smoke:packed` rejects stale or changed artifacts, verifies the named Harness checkout, builds its host and Browser artifacts, installs only those packed plugin artifacts into a new Web profile, starts it through `pnpm dsh --profile web`, and runs `tests/e2e/workspace-browser.mjs` against the assembled UI. A successful full smoke writes a receipt bound to the source hash, the Browser smoke driver and fixtures, all three tarball hashes, and the verified DSH commit. `release:publish` requires that receipt and publishes those exact tarballs instead of repacking the workspaces.

After all three packages are published, verify the exact immutable registry version:

```sh
pnpm smoke:registry -- --version 0.4.0 --dsh <absolute-path-to-deepseek-harness-0.2.0-rc.2> --scratch-root E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-smoke
```

Before publishing a candidate, maintainers may prove registry-only installation and startup mechanics against the existing public version without applying newer Browser assertions:

```sh
pnpm smoke:registry -- --version 0.2.0 --installation-only --dsh <absolute-path-to-deepseek-harness-0.1.1-rc.2>
```

Publishing is intentionally ordered so the bundle never references packages that do not exist yet:

1. `@dsh-agent-group/host`
2. `@dsh-agent-group/web`
3. `dsh-agent-group`

After authenticating to npm, publish all three in that order with:

```sh
pnpm release:publish
```

Extra `pnpm publish` arguments can be forwarded, for example:

```sh
pnpm release:publish -- --tag next
```

The `Release smoke` GitHub Actions workflow runs the packed command above and retains assembled configuration, Host logs, ARIA milestones, console diagnostics, and the final durable aggregate. The manual `Registry smoke` workflow waits with bounded retries for all three exact package manifests, then runs the same installation, startup, and Browser scenario from registry specifications only.

See the [v0.4.0 release notes](docs/releases/v0.4.0.md) for the current DSH compatibility migration. The [v0.3.0 release notes](docs/releases/v0.3.0.md) and [v0.2.0 release notes](docs/releases/v0.2.0.md) remain the records for older Harness lines, and the earlier [v0.1.1 release notes](docs/releases/v0.1.1.md) remain available for the stabilization release.

## Known limitations

- **Released recovery availability** — registry version `0.4.0` is single-organization; multiple organizations and Browser recovery are unreleased source features.
- **No per-agent model/tool/skill selection** — top-level agents currently inherit the deployment's model, tools, skills, and permissions.
- **No hard room secrecy** — unified personal memory can recall an event from another room; secrecy is not enforced as a domain boundary.
- **One-shot children only** — child agents are task-scoped, terminal, and not resumable colleagues.
- **Pre-1.0 compatibility** — DeepSeek Harness and this plugin are both evolving quickly. The npm peer ranges intentionally require a verified Harness release line rather than claiming compatibility with every prerelease.

## License

MIT
