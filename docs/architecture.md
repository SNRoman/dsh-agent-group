# Agent Workspace Architecture

The Host package owns a durable single-record workspace aggregate, a long-lived DSH employee runtime, and bounded mention dispatch. The domain model is pure and independent of DSH; the adapter files (`runtime.ts`, `turn-tracker.ts`, `dispatcher.ts`) bridge it to DSH services.

## Domain model

One `WorkspaceState` record holds every durable fact, stored once in a storage-domain table keyed `local`:

- `definitions` and `definitionRevisions` — reusable roles and their immutable revisions.
- `agents` — named instances with `employmentStatus` and `employmentPeriods`.
- `rooms` and `memberships` — group or direct-message rooms with memory-start rules. Active membership is also the communication admission boundary for agent authors and mentions.
- `events` — append-only sequence-ordered facts; `memoryEntries` associate an agent with events it experienced.
- `tasks`, `taskAssignments`, `delegationGrants`, `childRuns` — formal work and human-authorized peer delegation.
- `sessionBindings` — the durable DSH session id bound to each materialized agent.

`state.ts` applies pure aggregate commands; `memory.ts`, `tasks.ts`, and the small policy helpers build on those primitives. The durable service validates the complete aggregate with the Zod schema in `spec.ts` and calls `assertWorkspaceInvariants` at every write boundary so cross-record references fail before commit.

## Persistence

`AgentWorkspaceDomainService` (`index.ts`) opens the `agent_workspace` domain through `ctx.storageDomain`, materializes the local aggregate on first boot, and routes every mutation through one atomic `table.update`. Reads return detached snapshots; writes serialize on the domain chain, reach durability before the detached result is returned, and emit `domain/changed`. A `room/join` command is projected through `joinRoomWithMemory` so its requested historical range is acquired atomically with the membership mutation.

The installable bundle intentionally mounts only the Host service and Browser overlay. The enclosing DSH profile (`dsh-web-app` or `dsh-headless`) owns the storage hub, backend, domain form, and persistence root; the plugin must not redeclare those rows.

## Employee runtime

`EmployeeAgentPool` (`runtime.ts`) admits one DSH `AgentHandle` per employed agent with single-flight `ensure()`: a materialized session resumes, a fresh one creates and durably records its `sessionBindings` row. A resume failure never falls back to create. Employee disposal invalidates an admission already in flight before waiting for it, preventing an asynchronous create/resume from publishing a stale handle after departure. `AgentWorkspaceDomainService` checks employment before materialization and disposes the live handle after a durable `agent/depart` command.

`WorkspaceTurnTracker` (`turn-tracker.ts`) correlates a delivery with its turn: `agent/inbox/claimed` binds the message id to a turn, `session/event` captures `assistant/message` and settles on `turn/end`, and the `agent/pre-step` waterfall inserts the recall message immediately after its delivery. A synchronous `followup()` admission failure removes its pending correlation and recall before rejecting. Delivery flushes the session after the turn settles.

## Dispatch

`WorkspaceDispatcher` (`dispatcher.ts`) validates room communication admission before recording or waking anything, records a room message (projecting memory to every active member), then walks a bounded mention queue. Mentioned employed room members are woken one at a time inside that root dispatch; their replies are validated, recorded, and their `<@agentId>` mentions enqueue the next hop. Separate root dispatches may overlap, while durable aggregate mutations serialize at the storage-domain boundary. The shared hop and reply budgets stop runaway chains.

Formal task execution validates employment, task openness, and assignment before the assignee is woken. `runChild` records the committed child-run id inside the durable mutation, passes an optional caller cancellation signal to `ctx.subagents`, always disposes a published run, and terminalizes accepted child work as `completed`, `failed`, or `cancelled`. A child that started while its parent was employed can still reach a durable terminal state if that parent departs while the child is running.

## Extension seams

- The aggregate model remains independent of DSH; runtime adapters import the DSH services they bridge.
- `agents` and `subagents` are optional services resolved with `ctx.get`, so persistence works without an agent runtime.
- The dispatcher takes structural `SubagentRuntimeLike` and `WorkspaceDispatcherHost` interfaces, so its chain and child logic are testable with fakes.
