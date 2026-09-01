# dsh-agent-group

A persistent multi-agent workspace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It adds a browser workspace where reusable agent roles become named colleagues that can join rooms, remember room events, reply to mentions, collaborate through bounded agent-to-agent chains, receive human-authorized tasks, and run one-shot child agents.

## Features

- **Agent definitions and instances** — define reusable roles, create multiple named instances, and keep each instance's employment lifecycle, memory, memberships, tasks, and durable DSH session independent.
- **Group rooms and direct chat** — create group rooms, open a stable direct room for an employed agent, and retain durable room history in the plugin-owned `agent_workspace` domain.
- **Mention routing** — `@agent` wakes only the selected employed room members; lowercase `@all` expands to all active employed members of a group. Agent-to-agent chains remain bounded by the workspace dispatcher.
- **Live turns** — stream assistant text, reasoning, and tool activity into the Workspace UI while a DSH employee turn is in flight, then converge to the durable room event.
- **DSH-native rendering** — final and streaming text use DeepSeek Harness Markdown primitives; reasoning and tool calls use disclosure rows instead of a second conversation renderer.
- **Tasks and delegation** — ordinary mentions are communication. Formal peer delegation requires a human-created, task-scoped `DelegationGrant`.
- **Child agents** — an employed agent can run a one-shot DSH child agent and retain the terminal result in personal memory without turning the child into a workspace colleague.
- **Additive integration** — the Browser package registers only `sidebar.footer.action` and `shell.overlay`; it does not replace the core `sidebar`, `conversation`, or `details` surfaces and does not intercept `/api`.

## Requirements

- DeepSeek Harness on the `0.1.1` release line, starting at `0.1.1-rc.2`.
- Node.js `^22.19.0` or `>=24.0.0`.
- `pnpm` available on `PATH`. The official `dsh plugin` command delegates profile package management to pnpm.

The current package manifests intentionally stop before the `0.1.2` prerelease line. Upgrade the plugin only after that Harness line has been verified.

## Install

Install the profile bundle through the official DeepSeek Harness plugin command:

```sh
dsh plugin --profile web add dsh-agent-group
```

Then start the normal Harness web profile:

```sh
dsh web
```

The bundle declares `dsh.bundle.patch`; Harness adds it to the profile layer stack automatically. You do not need to clone this repository, patch DeepSeek Harness, or manually edit the profile bundle list.

For a domain/runtime-only deployment, the same bundle can be added to a profile that already provides the DSH core and storage stack, such as `headless`. The Browser half is a no-op on the Node side and activates only on the web client platform.

### Update

```sh
dsh plugin --profile web update dsh-agent-group
```

### Remove

```sh
dsh plugin --profile web remove dsh-agent-group
```

## Packages

| Package | Role |
|---|---|
| `@dsh-agent-group/host` | Durable workspace domain, persistence boundary, employee runtime, dispatcher, turn stream, tasks, memory, and invariants. |
| `@dsh-agent-group/web` | Additive Browser workspace UI and Connection RPC client. |
| `dsh-agent-group` | Installable DeepSeek Harness profile bundle that mounts Host and Browser packages. |

Users should normally install only `dsh-agent-group`; the two scoped packages are published dependencies of the bundle.

## Runtime integration

The Host service is exposed as `ctx.agentWorkspace`. It stores one local aggregate in the existing DSH storage-domain stack and dynamically attaches to optional Harness services such as `agents`, `subagents`, and `connection` when they are present.

The Browser transport uses the existing Harness Connection RPC service on the plugin-local Agent Workspace channel. There is no second HTTP/WebSocket server, no core API interception, and no replacement of the standard Harness conversation store.

## Development

This repository is a pnpm workspace. For source development it links DeepSeek Harness packages from a sibling checkout at `../../deepseek-harness` so CI and local development can exercise the current Harness source tree.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

The strict CI checks out and builds DeepSeek Harness before building the plugin.

## Release

Before publishing, run the packed release gate:

```sh
pnpm release:pack
```

It runs build, typecheck, tests, and packs the three npm artifacts in dependency order into `release/`.

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

The `Release smoke` GitHub Actions workflow goes further than the development build: it runs `pnpm pack`, stages the packed Host/Web artifacts into the packed bundle, creates a clean DSH home, installs the bundle through `dsh plugin --profile web add`, and verifies the composed config with `--dump-config`.

## Known limitations

- **Single local workspace** — the durable domain currently uses one aggregate keyed `local`; multi-workspace discovery is not implemented.
- **No per-agent model/tool/skill selection** — top-level agents currently inherit the deployment's model, tools, skills, and permissions.
- **No hard room secrecy** — unified personal memory can recall an event from another room; secrecy is not enforced as a domain boundary.
- **One-shot children only** — child agents are task-scoped, terminal, and not resumable colleagues.
- **Pre-1.0 compatibility** — DeepSeek Harness and this plugin are both evolving quickly. The npm peer ranges intentionally require a verified Harness release line rather than claiming compatibility with every prerelease.

## License

MIT
