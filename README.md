# dsh-agent-group

A persistent multi-agent workspace for DeepSeek Harness. It models a small organization: reusable role definitions, named agent instances with employment lifecycles, rooms and direct messages, unified per-agent event memory, mention-driven replies, human-authorized task delegation, and one-shot child agents.

## What it does

- **Definitions and instances.** An `AgentDefinition` is a reusable role (`Java engineer`, `finance analyst`). An `AgentInstance` is a named colleague created from one role, with `employed`/`departed` lifecycle periods and a durable DSH session binding. Multiple instances share one definition while keeping independent memories, memberships, and tasks. Definitions are versioned; saving a revision can synchronize existing instances without touching their memories.
- **Rooms and memory.** A room is a group or a direct message. Every current member records every new room event as personal memory even when it does not speak. Joining a room with a historical range adds exactly that range. Recall selects the current room first, then lexical matches, then recent personal events within a character budget.
- **Mentions.** Mentions are the only automatic wake mechanism. A mentioned employed agent must run and reply; unmentioned members record the event without running. Agent-to-agent chains stop at three hops or eight replies per root with a `conversation/stopped` event.
- **Tasks and delegation.** Ordinary mentions are communication. A top-level agent may assign a formal task to another only while holding a human-created, task-scoped `DelegationGrant`; completing the root task expires the grant.
- **Child agents.** Any employed agent can run a one-shot child through the DSH subagent seam. The child's terminal result enters the parent's memory; it never becomes a colleague or room member.

## Packages

| Package | Role |
|---|---|
| `@dsh-agent-group/host` | Domain model, persistence, employee runtime, dispatcher, invariant |
| `@dsh-agent-group/web` | Browser overlay (scaffold; not yet implemented) |
| `dsh-agent-group` | Installable profile bundle mounting the Host and storage stack |

## Installation

The bundle mounts the Host domain service and its Browser overlay. Add it to a profile that already provides the DSH core and the storage stack — the shipped `web` and `headless` templates do both, so list this bundle after them:

```yaml
# profile bundles
bundles:
  - '@deepseek-ai/dsh-base'
  - '@deepseek-ai/dsh-web-app'   # or '@deepseek-ai/dsh-headless'
  - dsh-agent-group
```

The bundle must not re-declare the `storage` / `storage-json` / `storage-domain` rows: those belong to the profile's mode bundle, and duplicating them would override the profile's persistence root. The Host service is reachable as `ctx.agentWorkspace`.

## Service API

| Member | Meaning |
|---|---|
| `snapshot()` | Detached copy of the committed local aggregate. |
| `execute(command)` | Apply one durable domain command and return the committed aggregate. |
| `postHumanMessage(roomId, humanId, text, mentions)` | Record a human room message and wake its mentioned agents. |
| `runChild(parentAgentId, taskId, prompt)` | Run a one-shot child and record its terminal result. |
| `ensureEmployee(agentId)` | Admit the live DSH handle for one employed agent. |
| `deliver(agentId, delivery, recall?)` | Deliver a message to an agent and resolve with its reply. |

The runtime (`agents`/`subagents`) is optional: without those services, the domain and persistence work and the runtime methods throw a clear error.

## Development

The repository links its DSH dependencies to a local `deepseek-harness` clone under `../../deepseek-harness`. Build order is Host → Web → bundle, then test and typecheck:

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Known Limitations and Deferred Work

- **Single local workspace** — the domain table holds one aggregate keyed `local`; multi-workspace discovery is not implemented.
- **No Typert Remote yet** — exposing `snapshot`/`execute` through Typert requires the Host package to extend `TypertRemoteService`, but the Typert generator's `loadRegistrations` only registers packages whose root is inside the workspace `packages/` directory (`analyzer.ts` `isWithin(packageRoot, packages/)`). The plugin links `@deepseek-ai/dsh-typert-protocol` from an adjacent DSH clone, so its `Remote` symbol is never recognized and the `@Remote` decorators are skipped. Enabling the Remote needs either vendoring the DSH packages into this repository's `packages/` or developing inside the DSH workspace.
- **Web overlay is a scaffold** — the Browser package registers nothing; the UI is not implemented.
- **No per-agent model/tool/skill selection** — every top-level agent shares the deployment's model, tools, skills, and permissions.
- **No hard room secrecy** — an agent's unified memory can recall a direct-message event while replying in a group; secrecy is the model's own judgment, not an enforced boundary.
- **One-shot children only** — child agents are task-scoped, terminal, and not resumable.
- **No assembled keyless replay** — the dispatcher and runtime are covered by fake-based unit tests; an assembled real-loop transcript is not yet recorded.
