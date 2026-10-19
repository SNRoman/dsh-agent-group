# dsh-agent-group · Agent Organization（智能体组织）

Agent Organization（智能体组织）is a persistent organization of AI colleagues for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Reusable agent roles become named colleagues with employment history and unified personal memory. Colleagues join rooms, remember admitted events even while silent, reply to mentions, receive human-authorized tasks, and run one-shot child agents. The npm package name remains `dsh-agent-group`.

Version `0.5.0` adds independent organizations with backup and restore, chat-first work assignment, message withdrawal, optional local file recovery, and scene-aware personal memory. It retains the DSH `0.2.0` compatibility range. See the [release notes](docs/releases/v0.5.0.md) for upgrade and rollback limits.

## Features

Work starts in chat: choose “交办工作” (Assign work), select an employed member, and send the complete instructions. Delegation is off unless the human explicitly authorizes it. Employee proposals remain pending work cards; edit and save their full brief, then bring them to a chat for explicit confirmation. Personal work cards link to the actual persisted instruction, not an inferred message. Historical tasks without a recorded chat source say so. Result handoffs and change requests require a staffed source chat and create a pending draft, not automatically executing work.

Withdrawal replaces already-read colleagues' Sessions and excludes affected messages and work from memory, retries, drafts, templates and result reuse. Old audit data remains stored. The confirmation preview identifies the affected colleagues and work; incomplete cleanup keeps colleagues paused and offers the same durable retry. Dependency information absent from older records causes conservative invalidation rather than an assertion that an old output is safe to reuse.

File recovery is separate and off by default. Only attributed local `write`/`edit` calls with trusted raw-byte checkpoints support recovery of existing, regular, single-link files. The journal checks workspace ownership, paths, current bytes and opened file identity; it preserves a recovery copy before modifying bytes. Conflicts, links, provider paths, missing backups, new-file deletion and missing-file recreation are unavailable and remain untouched. Recovery cannot undo arbitrary shell or network effects, and it does not provide atomic compare-and-write against another process changing the same open file. File recovery can be retried without another memory reset.

- **Agent definitions and instances** — define reusable roles, create multiple named instances, and keep each instance's employment lifecycle, memory, memberships, tasks, and durable DSH session independent.
- **Group rooms and direct chat** — create group rooms, open a stable direct room for an employed agent, and retain durable room history in the plugin-owned `agent_workspace` domain.
- **Complete group memory** — Add colleague opens a searchable multi-person picker; joining admits the group's complete chat history and future messages without a memory-range form. Successful joins survive a partial failure and retry admits the remaining selection. Existing members' previously admitted history is unchanged.
- **Optional group-memory removal** — removing a colleague retains personal memory by default. An explicit option removes their group acquisitions and traceable retellings, then replaces their Session; shared messages and other colleagues' memory remain stored. Rejoining admits the group's complete history again.
- **Mention routing** — `@agent` wakes only the selected employed room members; lowercase `@all` expands to all active employed members of a group. Agent-to-agent chains remain bounded by the workspace dispatcher.
- **Live turns** — stream assistant text, reasoning, and tool activity into the Agent Organization UI while a DSH employee turn is in flight, then converge to the durable room event.
- **DSH-native rendering** — final and streaming text use DeepSeek Harness Markdown primitives; reasoning and tool calls use disclosure rows instead of a second conversation renderer.
- **Tasks and delegation** — ordinary mentions are communication. Formal peer delegation requires a human-created, task-scoped `DelegationGrant`.
- **Child agents** — an employed agent can run a one-shot DSH child agent and retain the terminal result in personal memory without turning the child into a workspace colleague.
- **Additive integration** — the Browser package registers only `sidebar.footer.action` and `shell.overlay`; it does not replace the core `sidebar`, `conversation`, or `details` surfaces and does not intercept `/api`.
- **Localized policy feedback** — Simplified Chinese and English dictionaries own plugin UI copy, while stable Host error codes keep localization independent from exception text.
- **Colleague-first views** — Conversations provides named message bubbles, clickable mentions and profiles, group renaming and author-owned withdrawal. Colleagues manages people; shared role templates and immutable history stay secondary. Tasks shows personal work cards with chat sources; Memory groups searchable Chinese-labeled records by colleague. Shared headers, person cards and theme colors keep the four views consistent; Runtime keeps exact stop controls.
- **Memory with sources** — colleagues can search their own admitted event history by keyword and read original events on demand, with source and event identifiers for follow-up. Room replies and formal tasks draw on the same personal history.
- **Scene-aware personal memory** — each turn combines its room/task, actor, current Host-local time, newly admitted originals, applicable fact candidates and relevant history. MiniSearch supplies local keyword retrieval. Optional on-use v2 extraction uses the employee's model; source text and processing diagnostics remain inspectable.
- **Independent organizations** — create, rename and select persistent organizations with separate colleagues, rooms, tasks, personal memory, runtime streams and DSH sessions. Identical internal entity IDs in different organizations do not select the same employee.
- **Recoverable organizations** — archive with an explicit stop-or-wait choice, reopen after work settles, and export or restore through the Browser. Restoration creates a new organization after a read-only preview and human confirmation; it never replaces the source or restores its DSH sessions.
- **Company workflow** — prepare drafts and reusable task/company templates, explicitly confirm an assignee, and register, review or hand off exact task results. Employee proposals await human confirmation; templates and handoffs do not grant authority or start work automatically.
- **Forward compatibility export** — the read-only `export:forward-v1` command creates a canonical, checksummed handoff while leaving the source storage untouched. The current importer accepts that frozen format alongside formats 2, 3 and 4.

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
| `0.5.x` | `>=0.2.0-rc.2 <0.2.1-0` | `0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`) |

Install `0.2.x` when the Harness deployment remains on the `0.1.1` line, or `0.3.x` for the `0.1.7` line. The current `0.5.x` package and predecessor `0.4.x` target DSH `0.2.0` and do not include a dual-runtime compatibility layer.

## Install

Install the profile bundle through the official DeepSeek Harness plugin command:

```sh
dsh plugin --profile web add dsh-agent-group@0.5.0
```

Then start the normal Harness web profile:

```sh
dsh web
```

The bundle declares `dsh.bundle.patch`; Harness adds it to the profile layer stack automatically. You do not need to clone this repository, patch DeepSeek Harness, or manually edit the profile bundle list.

For a domain/runtime-only deployment, the same bundle can be added to a profile that already provides the DSH core and storage stack, such as `headless`. The Browser half is a no-op on the Node side and activates only on the web client platform.

### Update

Match the plugin to the Harness line: keep plugin `0.2.x` on DSH `0.1.1`, plugin `0.3.x` on DSH `0.1.7`, and use plugin `0.5.x` on DSH `0.2.0`. Before upgrading from `0.4.x`, stop the profile and back up its configuration, organization storage and Session files. Then run:

```sh
dsh plugin --profile web update dsh-agent-group@0.5.0
```

The first `0.5.0` startup upgrades organization records in place. Downgrading the npm package does not reverse that upgrade; rollback requires the complete pre-upgrade backup. Format-4 Browser exports restore into a new `0.5.x` organization and omit Sessions and file bytes.

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

The Host service is exposed as `ctx.agentWorkspace`. Each organization descriptor, aggregate, workflow and communication metadata share one versioned record in the existing DSH storage-domain stack. `ctx.agentWorkspace.forWorkspace(id)` selects a fixed organization runtime; it does not read the Browser's current selection. Optional Harness services such as `agents`, `subagents`, and `connection` remain dynamically attached.

The Browser transport uses the existing Harness Connection RPC service on the plugin-local Agent Workspace channel. There is no second HTTP/WebSocket server, no core API interception, and no replacement of the standard Harness conversation store.

## Organization workflow

Create a definition, then create named colleagues from it. Choose Add colleague, search by name or role, select one or more people, and confirm; the group history is admitted automatically. Use mentions for conversation and chat assignments for durable work ownership. Memory belongs to the colleague rather than to one chat: a silent member remembers admitted room events, task results, and child results. Saving a new definition revision offers none, all, or a selected subset of existing colleagues for synchronization; every colleague remains pinned to an immutable revision.

Keyword memory search returns references and short excerpts; colleagues can request the original events when they need detail. Each retrieved event retains its source and sequence. Search covers only events admitted to that colleague's memory, including group history admitted at joining; withdrawn content is excluded from effective memory. This is keyword retrieval, not semantic or vector search. An event from another room may be recalled by a colleague who owns it; room secrecy is not enforced.

The default `same-model-on-use` extraction mode sends only personally acquired source fragments exposed in an employee request to that employee's provider/model after the request streams. It adds bounded auxiliary calls; `disabled` stops new extraction. Dormant history is not extracted at startup or by opening Memory. Exact source text, extraction requests and raw outputs remain in local audit storage after withdrawal or group-memory removal. Candidate facts retain their evidence and applicability; extraction does not guarantee correct semantic classification or model answers. See [Host memory settings](packages/host/README.md#scene-memory) for budgets and diagnostics.

Runtime activity is intentionally ephemeral. The durable task attempt and result remain authoritative, while the drawer shows queued, responding, stopping, and settled activity for the current Host process. Exact stop targets one activity identity; an interrupted task remains open and retryable, does not acquire a task result, and does not cancel unrelated queued work.

## Organization recovery

Use the organization directory at the top of the overlay to create, rename or switch organizations. Switching clears entity selection and drafts and cancels the old organization's subscriptions and refreshes. Startup validates the whole directory, then upgrades bare `local` aggregates and version-1/2 organization records to version 3, adding missing workflow and communication metadata without changing business history or Session bindings or inventing facts. The storage domain remains version `0`.

Archiving first prevents new work and durably marks the organization read-only. Choose **Stop current work** to stop that organization's exact queued deliveries, claimed turns and children, or **Wait for current work** to let admitted work finish. The archive request waits for full settlement and cleanup. Reopening restores admission without rewriting history or assigning tasks.

Export requires an idle organization and explicit confirmation because the file contains role instructions, messages and personal memory. The Browser writes checksummed portable format version `4`, including the label, archive state, workflow and communication metadata. It excludes local Session bindings, Session proofs, file bytes and organization creation/import metadata; checkpoint metadata is marked unavailable. A busy organization or an unfinished durable delivery cannot be exported.

Choose a JSON file under **Import organization** to validate and preview it without writing. Check the source version and entity counts, edit the destination label, then confirm creation of a new organization. The importer accepts versions `1`, `2`, `3` and `4`, retains entity IDs and history, and rebases task-delivery identities to the new organization ID. Versions `1` and `2` supply empty workflow metadata; versions `3` and `4` preserve drafts, immutable templates, confirmed briefs, artifacts, reviews, handoffs and operation receipts. Version `4` also preserves withdrawals, context generations and pending/failed resets. Import starts no work; imported archived organizations remain read-only until reopened, and incomplete resets remain blocked until cleanup succeeds.

The checksum detects corruption, not authorship. Keep exported files private and obtain authorization before sharing their complete organization history. A backup retains raw withdrawn history as audit data and cannot restore local file checkpoints or resume old Sessions. Import size, string, entity, event and depth budgets are deployment settings; see the [Host configuration](packages/host/README.md#organization-recovery).

## Company workflow

The Tasks view contains drafts, reusable templates and result review. A draft has a short title, full instructions, expected artifacts and acceptance criteria. Creating, editing, discarding or applying a template only saves a draft. Confirmation requires an explicit employed assignee and creates one formal task; retries of the same committed operation return that task without assigning or delivering it again. If the runtime is unavailable or stops before delivery, the committed task remains undelivered and needs the existing explicit retry action; runtime availability alone does not start it.

Confirmed tasks deliver the persisted full brief, including any selected handoff context, through the normal DSH Session input. Later draft or template edits cannot change it. Employees can use `workspace_propose_task` from an existing admitted turn to suggest a draft, but cannot confirm it, accept a result or grant delegation authority.

Task templates retain immutable brief revisions. Company configuration templates refer to immutable role revisions and name new colleagues and optional groups in the current organization. Preview writes nothing; confirmation explicitly chooses new-events membership memory. It creates the configuration atomically without copying history, Sessions, tasks or grants, and without waking colleagues.

Artifacts are human-registered labels, summaries and optional inert path or HTTP(S) references attached to an exact result event and delivery attempt. References are unverified: the plugin does not read files, execute paths or fetch links. Human acceptance is separate from model completion and applies only to the selected result, including visibly marked late results from cancelled tasks. Requesting changes or selecting artifacts for handoff creates a new draft; neither starts execution nor transfers authority. Archived organizations remain read-only throughout this workflow.

## Forward export

v0.2.0 introduced portable format `dsh-agent-workspace` version `1`; v0.5.0 preserves that read-only exporter. Build the Host package, then export an explicit storage-domain document:

```sh
pnpm build:host
pnpm export:forward-v1 -- --input E:/exports/agent-workspace.json --output E:/exports/workspace-portable-v1.json --exported-at 2026-09-04T00:00:00.000Z
```

The command validates one legacy version-`0` local aggregate, preserves definitions, colleagues, employment history, rooms, Tasks, Memory, child results, and events, omits local DSH session bindings, refuses to overwrite its output, and never changes the source. Frozen format-1/2 producers omit workflow metadata, and format 3 omits communication metadata; use the Browser's format-4 export for the current organization backup. Older readers reject successor formats rather than silently dropping their metadata.

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

The command copies this plugin to an isolated directory below the selected scratch root, excludes local output and worktree directories, generates source overrides only in that copy, and removes it after the check. CI runs the default registry verification and this explicit source check separately.

## Release

Before publishing, run the packed release gate:

```sh
pnpm exec playwright install chromium
pnpm release:pack
pnpm smoke:packed -- --dsh <absolute-path-to-deepseek-harness-0.2.0-rc.2> --scratch-root E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-smoke
```

The Playwright command installs the Chromium runtime used by the smoke. `release:pack` runs build, typecheck, tests, packs the three npm artifacts in dependency order into `release/`, clears any earlier smoke receipt, and records their hashes together with the deterministic build-input hash. `smoke:packed` rejects stale or changed artifacts, verifies the named Harness checkout, builds its host and Browser artifacts, installs only those packed plugin artifacts into a new Web profile, launches its public `dsh --profile web` CLI source in an owned scratch workspace, and runs `tests/e2e/workspace-browser.mjs` against the assembled UI. A successful full smoke writes a receipt bound to the source hash, the Browser smoke driver and fixtures, all three tarball hashes, and the verified DSH commit. Run the full smoke twice consecutively with unchanged inputs and retain the two independent evidence directories and matching receipts described in [Browser verification](tests/e2e/README.md).

Use npm CLI `>=11.15.0` and an npm account with package publish access and 2FA. Authenticate against the official registry:

```sh
npm login --registry=https://registry.npmjs.org/
```

Before each staged upload, verify that the receipt still matches the current source, smoke inputs, tarballs and DSH point:

```sh
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { verifyReleaseSmokeReceipt } from './scripts/release-artifacts.mjs'; const c = JSON.parse(readFileSync('compatibility.json', 'utf8')); verifyReleaseSmokeReceipt(process.cwd(), '0.5.0', c.verifiedSource);"
```

If the receipt is missing, complete the full packed smoke before uploading; logging in again cannot create it. If the source or tarballs changed, rerun packing and the full smoke; changed smoke inputs also require a new full smoke. Do not remove the verification step or replace a failed run with an installation-only check. Upload only the verified tarballs through [npm staged publishing](https://docs.npmjs.com/staged-publishing/). For each package below, run its command, open **Staged Packages** on [npmjs.com](https://www.npmjs.com/), review the exact name/version and contents, and click **Approve** with 2FA. Confirm its `0.5.0` version is public before proceeding to the next package, in Host → Web → bundle order:

```sh
npm stage publish ./release/dsh-agent-group-host-0.5.0.tgz --access public --registry=https://registry.npmjs.org/
# Approve Host on npmjs.com, then stage Web.
npm stage publish ./release/dsh-agent-group-web-0.5.0.tgz --access public --registry=https://registry.npmjs.org/
# Approve Web on npmjs.com, then stage the bundle.
npm stage publish ./release/dsh-agent-group-0.5.0.tgz --access public --registry=https://registry.npmjs.org/
```

Staging alone does not make the version installable. Website approval publishes the staged bytes; do not repack a directory or substitute another tarball. The existing `release:publish` script is a direct-publication path and does not perform this staged approval workflow.

After all three packages are approved and public, verify the exact immutable registry version:

```sh
pnpm smoke:registry -- --version 0.5.0 --dsh <absolute-path-to-deepseek-harness-0.2.0-rc.2> --scratch-root E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-smoke
```

Before publishing a candidate, an installation-only smoke can check an already public version without applying newer Browser assertions:

```sh
pnpm smoke:registry -- --version 0.4.0 --installation-only --dsh <absolute-path-to-deepseek-harness-0.2.0-rc.2>
```

The `Release smoke` GitHub Actions workflow runs the packed command above and retains assembled configuration, Host logs, ARIA milestones, console diagnostics, and the final durable aggregate. The manual `Registry smoke` workflow waits with bounded retries for all three exact package manifests, then runs the same installation, startup, and Browser scenario from registry specifications only.

See the [v0.5.0 release notes](docs/releases/v0.5.0.md) for organization recovery, chat assignment and personal memory changes. The [v0.4.0 release notes](docs/releases/v0.4.0.md) record the DSH `0.2.0` compatibility migration. The [v0.3.0 release notes](docs/releases/v0.3.0.md) and [v0.2.0 release notes](docs/releases/v0.2.0.md) remain the records for older Harness lines, and the earlier [v0.1.1 release notes](docs/releases/v0.1.1.md) remain available for the stabilization release.

## Known limitations

- **Backup and rollback limits** — portable backups create new organizations and omit Sessions, extraction audit/cache domains and file bytes. Older plugin versions cannot read successor records or format-4 exports; retain a complete pre-upgrade backup for rollback.
- **Withdrawal is not erasure** — withdrawn sources and removed group acquisitions leave raw organization history, original Session files and local extraction audits stored. Optional file recovery cannot undo arbitrary shell/network effects or conflicting file changes.
- **Memory extraction limits** — on-use extraction adds auxiliary requests to the employee's provider/model. Facts and lexical ranking do not guarantee answer quality; room secrecy is not enforced.
- **Unverified artifact references** — registering a path or link does not establish that its target exists, is safe or satisfies acceptance criteria.
- **No per-agent model/tool/skill selection** — top-level agents currently inherit the deployment's model, tools, skills, and permissions.
- **No hard room secrecy** — unified personal memory can recall an event from another room; secrecy is not enforced as a domain boundary.
- **One-shot children only** — child agents are task-scoped, terminal, and not resumable colleagues.
- **Pre-1.0 compatibility** — DeepSeek Harness and this plugin are both evolving quickly. The npm peer ranges intentionally require a verified Harness release line rather than claiming compatibility with every prerelease.

## License

MIT
