# Agent Workspace Architecture

The Host package owns a durable single-record workspace aggregate, a long-lived DSH employee runtime, and a serialized mention dispatcher. The domain model is pure and independent of DSH; the adapter files (`runtime.ts`, `turn-tracker.ts`, `dispatcher.ts`) bridge it to DSH services.

## Domain model

One `WorkspaceState` record holds every durable fact, stored once in a storage-domain table keyed `local`:

- `definitions` and `definitionRevisions` — reusable roles and their immutable revisions.
- `agents` — named instances with `employmentStatus` and `employmentPeriods`.
- `rooms` and `memberships` — group or direct-message rooms with memory-start rules.
- `events` — append-only sequence-ordered facts; `memoryEntries` associate an agent with events it experienced.
- `tasks`, `taskAssignments`, `delegationGrants`, `childRuns` — formal work and human-authorized peer delegation.
- `sessionBindings` — the durable DSH session id bound to each materialized agent.

`state.ts` applies pure invariant-preserving commands; `memory.ts`, `tasks.ts`, and `invariant.ts` build on those primitives. The aggregate is validated at the durable boundary by the Zod schema in `spec.ts` and checked by `assertWorkspaceInvariants`.

## Persistence

`AgentWorkspaceDomainService` (`index.ts`) opens the `agent_workspace` domain through `ctx.storageDomain`, materializes the local aggregate on first boot, and routes every mutation through one atomic `table.update`. Reads return detached snapshots; writes serialize on the domain chain, reach durability before memory, and emit `domain/changed`. The bundle mounts the storage hub, the JSON backend, and the domain form ahead of the Host.

## Employee runtime

`EmployeeAgentPool` (`runtime.ts`) admits one DSH `AgentHandle` per employed agent with single-flight `ensure()`: a materialized session resumes, a fresh one creates and durably records its `sessionBindings` row. A resume failure never falls back to create. `WorkspaceTurnTracker` (`turn-tracker.ts`) correlates a delivery with its turn: `agent/inbox/claimed` binds the message id to a turn, `session/event` captures `assistant/message` and settles on `turn/end`, and the `agent/pre-step` waterfall inserts the recall message immediately after its delivery. Every recalled event id is logged as a `user/message` before the model request; delivery flushes the session.

## Dispatch

`WorkspaceDispatcher` (`dispatcher.ts`) records a room message (projecting memory to every member), then walks a bounded mention queue: mentioned employed agents are woken one at a time, their replies are recorded and their `<@agentId>` mentions enqueue the next hop. The shared hop and reply budgets stop runaway chains. `runChild` runs a one-shot child through `ctx.subagents` and records its terminal result into the parent's memory.

## Extension seams

- The domain is pure and independent of DSH; only `runtime.ts`, `turn-tracker.ts`, and `dispatcher.ts` import DSH packages.
- `agents` and `subagents` are optional services resolved with `ctx.get`, so persistence works without an agent runtime.
- The dispatcher takes structural `SubagentRuntimeLike` and `WorkspaceDispatcherHost` interfaces, so its chain and child logic are testable with fakes.
