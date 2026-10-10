# Agent Workspace Architecture

The development Host package owns a durable directory of independent organization records, scoped DSH employee runtimes, and bounded mention dispatch. The domain model is pure and independent of DSH; the adapter files (`runtime.ts`, `turn-tracker.ts`, `dispatcher.ts`) bridge it to DSH services. Published `0.4.0` remains the single-local-organization product.

## Domain model

Each organization stores one `WorkspaceState` aggregate inside its record in the `workspaces` table. Released single-organization data uses the `local` key; new organizations have independent identities:

- `definitions` and `definitionRevisions` — reusable roles and their immutable revisions.
- `agents` — named instances with `employmentStatus` and `employmentPeriods`.
- `rooms` and `memberships` — group or direct-message rooms with memory-start rules. Active membership is also the communication admission boundary for agent authors and mentions.
- `events` — append-only sequence-ordered facts; `memoryEntries` associate an agent with events it experienced.
- `tasks`, `taskAssignments`, `delegationGrants`, `childRuns` — formal work and human-authorized peer delegation.
- `sessionBindings` — the durable DSH session id bound to each materialized agent.

`state.ts` applies pure aggregate commands; `memory.ts`, `tasks.ts`, and the small policy helpers build on those primitives. The durable service validates the complete aggregate with the Zod schema in `workspace-state-schema.ts` and calls `assertWorkspaceInvariants` at every write boundary so cross-record references fail before commit. `spec.ts` attaches that schema to the storage-domain declaration, while the public forward-export leaf can load the validator without importing the Cordis-backed Host entry point.

Definitions own an ordered list of immutable revisions. Saving a definition revision can leave every colleague pinned, move all eligible colleagues, or move an explicit subset. Events and task results retain the definition revision used when the work began, so later synchronization does not rewrite history.

## Persistence

`AgentWorkspaceDomainService` (`index.ts`) opens the `agent_workspace` domain through `ctx.storageDomain`. `WorkspaceDirectory` creates `local` only for an empty table and serializes record writes through atomic `table.update`. Reads return detached snapshots; writes reach durability before the detached result is returned and emit `domain/changed`. A `room/join` command is projected through `joinRoomWithMemory` so its requested historical range is acquired atomically with the membership mutation.

Every group join supplies one explicit memory-start value. `new-events` starts observation after the join; `event-range` adds the selected inclusive historical interval during the same durable mutation. Subsequent room events are projected to every active member, including members who remain silent. Mention routing controls execution, not memory acquisition.

The installable bundle intentionally mounts only the Host service and Browser overlay. The enclosing DSH profile (`dsh-web-app` or `dsh-headless`) owns the storage hub, backend, domain form, and persistence root; the plugin must not redeclare those rows.

## Employee runtime

The development Host owns a `WorkspaceDirectory` derived from its authoritative table. It reads released local aggregates and version-1 organization records, validates the complete directory before wrapping legacy data, and preserves the descriptor during every aggregate update. Each organization has a fixed `WorkspaceRuntime` with its own employee pool, dispatcher, task coordinator, activity stream and child controllers. Browser operations name their organization explicitly; task and memory tools resolve it from the trusted live Agent object, never from a Browser selection or model-supplied organization id.

`WorkspaceAdmission` reserves work before its first asynchronous step and retains admitted continuations through durable results, Session flushing, hiding and child disposal. Archive closes admission before changing lifecycle; a failed lifecycle write restores admission without stopping work. Stop cancels exact owned work, while wait lets admitted work finish. Both wait for runtime cleanup and reject a completion claim if the final record still contains an unfinished task delivery or child run. Reopening an idle archived organization does not materialize employees or start work.

Root teardown has one shared shutdown flight. It prevents new directory operations, starts runtime stops before waiting for admitted metadata requests, drains late-created runtimes and all admitted work, and closes the storage domain last. Dynamic agents removal retains coordinators and trackers until settlement and revokes the old employee generation before reinjection. Employee cleanup failures remain observable through the shutdown flight and Cordis teardown logging; Cordis itself does not reject `fiber.dispose()` for effect errors.

`EmployeeAgentPool` (`runtime.ts`) admits one DSH `AgentHandle` per employed agent with single-flight `ensure()`: a materialized session resumes, a fresh one creates and durably records its `sessionBindings` row. A resume failure never falls back to create. Employee disposal invalidates an admission already in flight before waiting for it, preventing an asynchronous create/resume from publishing a stale handle after departure. `AgentWorkspaceDomainService` checks employment before materialization and disposes the live handle after a durable `agent/depart` command.

`WorkspaceTurnTracker` (`turn-tracker.ts`) correlates a delivery with its turn: `agent/inbox/claimed` binds the message id to a turn, `session/event` captures `assistant/message` and settles on `turn/end`, and the `agent/pre-step` waterfall inserts the recall message immediately after its delivery. A synchronous `followup()` admission failure removes its pending correlation and recall before rejecting. Delivery flushes the session after the turn settles.

## Dispatch

`WorkspaceDispatcher` (`dispatcher.ts`) validates room communication admission before recording or waking anything, records a room message (projecting memory to every active member), then walks a bounded mention queue. Mentioned employed room members are woken one at a time inside that root dispatch; their replies are validated, recorded, and their `<@agentId>` mentions enqueue the next hop. Separate root dispatches may overlap, while durable aggregate mutations serialize at the storage-domain boundary. The shared hop and reply budgets stop runaway chains.

Formal task execution validates employment, task openness, and assignment before the assignee is woken. `runChild` records the committed child-run id inside the durable mutation, passes an optional caller cancellation signal to `ctx.subagents`, always disposes a published run, and terminalizes accepted child work as `completed`, `failed`, or `cancelled`. A child that started while its parent was employed can still reach a durable terminal state if that parent departs while the child is running.

`TaskDeliveryCoordinator` serializes delivery per task, persists the delivery source before inbox admission, recovers pending attempts after restart, and records exactly one terminal result or retryable failure. Human grants authorize peer-derived tasks inside one root task tree. Cancellation commits before runtime cleanup: root cancellation cascades across open descendants, while derived cancellation remains scoped to the selected task.

Unified Memory is a projection of durable events and first-acquisition provenance. Room membership, selected history, task results, and child results all contribute to the same per-colleague memory without copying message bodies into a second store. Queries use snapshot revisions and stable cursors so pages cannot silently mix revisions.

`WorkspaceActivityStream` and `WorkspaceActivityController` own the ephemeral Runtime projection. Activity snapshots replace prior snapshots after reconnect; they do not append to the durable aggregate. Exact stop carries activity, agent, session, message, task, and attempt identity through the controller, while durable task cancellation remains a separate operation.

## Forward compatibility

`forward-export.ts` freezes the producer for `dsh-agent-workspace` format version 1. It validates and clones the local aggregate, omits `workspaceId` and `sessionBindings`, computes SHA-256 over the RFC 8785 canonical envelope without `digest`, and returns the completed canonical document. The command-line adapter reads one version-0 storage document and opens the destination exclusively. v0.2 has no importer, RPC method, or Browser control for portability.

Development portability adds format version 2 without changing the frozen version-1 producer. Export captures one idle organization record and excludes local sessions and creation operation metadata. Import accepts versions 1 and 2, applies explicit input budgets and strict Unicode, digest and relationship checks, then rebuilds task message identities for a new organization. Preview is read-only. Human confirmation revalidates the source and creates one new record under a durable retry operation id; it never replaces the source or starts restored employees. The released `0.4.0` packages do not contain these development controls.

Workspace policy failures use stable business-error codes with JSON-safe identifiers and counters. The RPC layer distinguishes those failures from malformed requests, caller cancellation, and unexpected internal errors. The Browser maps known codes through its typed Simplified Chinese and English dictionaries instead of parsing Host prose.

## Release validation

Default development resolves the declared DSH packages from the registry. Source compatibility is an explicit isolated check against the exact point in `compatibility.json`; it does not mutate either checkout. The packed release gate hashes deterministic build inputs and all three tarballs, assembles a clean DSH Web profile, calls the installed Host forward exporter against the legacy v0.1 fixture, exercises the four-view Browser workflow, then verifies removal, restart, preservation of core files, and recovery of a pre-existing core conversation. Its receipt also hashes the Browser driver, legacy aggregate, and fixtures. Publishing consumes those verified tarball paths and never repacks them.

## Extension seams

- The aggregate model remains independent of DSH; runtime adapters import the DSH services they bridge.
- `agents` and `subagents` are optional services resolved with `ctx.get`, so persistence works without an agent runtime.
- The dispatcher takes structural `SubagentRuntimeLike` and `WorkspaceDispatcherHost` interfaces, so its chain and child logic are testable with fakes.
