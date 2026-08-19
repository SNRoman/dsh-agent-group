# Agent Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable DSH bundle that provides persistent role definitions and named agent instances, unified event memory, mention-driven group/DM responses, human-authorized peer task delegation, one-shot child agents, and a Web Workspace overlay.

**Architecture:** A Host package owns one atomic `WorkspaceState` aggregate per local workspace through `ctx.storageDomain`, projects durable events into per-agent memory, and owns long-lived DSH `AgentHandle`s. A separate Browser package mounts the Host package's generated Typert Remote and renders a polling overlay reached from the shipped sidebar. A small bundle package mounts both without modifying the DSH clone.

**Tech Stack:** TypeScript strict ESM, Cordis effects, DSH 0.1.0-rc.7 public packages, Zod 4, storage-domain, Typert Remote generation, React 19, tsdown, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-agent-workspace-design.md`

## Global Constraints

- The project lives at `E:\003code\deepseek-harness-plugins\dsh-agent-workspace`; the adjacent DSH clone is read-only product source and local dependency evidence.
- All top-level agents inherit the same Host model, tools, skills, and permissions; definitions contain only role description and instructions.
- Only mentions wake agents. Unmentioned members receive memory without a model run.
- Each employed agent owns one stable, persistent DSH `SessionId`; every workspace-derived model input must be appended to that session log.
- Workspace mutations update one per-workspace aggregate record so each user-visible operation is a single durable write.
- Browser code uses `sidebar.footer.action` plus `shell.overlay`; it must not replace `root`, `conversation`, or `sidebar`.
- DSH dependencies are semver peers and local `link:` dev dependencies. Packed artifacts must not contain machine-local `link:` values.
- Every exported symbol and public method has concise contract JSDoc. Every registration uses a Cordis disposer.
- Tests follow TDD and run from the independent plugin repository; the DSH root test globs do not cover this project.

## File map

```text
dsh-agent-workspace/
├── package.json                         # private pnpm workspace scripts
├── pnpm-workspace.yaml                  # host, web, and bundle packages
├── tsconfig.json                        # shared strict compiler options
├── tsconfig.host.json                   # Typert generator host face root
├── vitest.config.ts                     # unit and integration tests
├── packages/
│   ├── host/
│   │   ├── package.json                 # @dsh-agent-workspace/host
│   │   ├── tsconfig.json
│   │   ├── tsdown.config.ts             # Host ESM + Typert artifacts
│   │   └── src/
│   │       ├── index.ts                 # plugin apply/service assembly
│   │       ├── ids.ts                   # branded id constructors
│   │       ├── types.ts                 # durable and wire contracts
│   │       ├── spec.ts                  # Zod storage-domain schema
│   │       ├── state.ts                 # pure aggregate mutations/invariants
│   │       ├── memory.ts                # event delivery and recall selection
│   │       ├── tasks.ts                 # grants, assignments, terminal state
│   │       ├── runtime.ts               # AgentHandle pool and scoped setup
│   │       ├── turn-tracker.ts           # delivery-to-turn/output correlation
│   │       ├── dispatcher.ts             # mention chain and child execution
│   │       ├── remote.ts                 # Typert Remote methods
│   │       └── invariant.ts              # runtime relationship checks
│   ├── web/
│   │   ├── package.json                 # @dsh-agent-workspace/web
│   │   ├── tsconfig.json
│   │   ├── tsconfig.client.json
│   │   ├── tsdown.config.ts             # Node stub + loader-compatible CJS
│   │   └── src/
│   │       ├── index.ts                 # Host-visible Loader entry
│   │       └── client/
│   │           ├── index.ts             # Remote and slot registration
│   │           ├── store.ts             # overlay/navigation store
│   │           ├── controller.ts         # polling and mutations
│   │           ├── workspace.tsx         # application shell
│   │           ├── sidebar.tsx           # room/agent/definition lists
│   │           ├── room.tsx              # messages/composer/mentions
│   │           ├── agents.tsx            # definitions and lifecycle forms
│   │           ├── tasks.tsx             # assignments/grants/child activity
│   │           └── styles.css             # inlined client CSS
│   └── bundle/
│       ├── package.json                 # installable dsh-agent-workspace
│       ├── cordis.patch.yml             # mounts Host and Browser entries
│       └── src/{index,invariant}.ts     # bundle identity/invariant
├── tests/
│   ├── state.spec.ts
│   ├── memory.spec.ts
│   ├── tasks.spec.ts
│   ├── dispatcher.spec.ts
│   ├── runtime.spec.ts
│   ├── remote.spec.ts
│   ├── web.spec.tsx
│   ├── restart.integration.spec.ts
│   └── bundle.integration.spec.ts
└── README.md
```

---

### Task 1: Workspace scaffold and clean-tree build faces

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.gitattributes`, `tsconfig.json`, `tsconfig.host.json`, `vitest.config.ts`
- Create: `packages/host/package.json`, `packages/host/tsconfig.json`, `packages/host/tsdown.config.ts`
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/tsconfig.client.json`, `packages/web/tsdown.config.ts`
- Create: `packages/bundle/package.json`, `packages/bundle/tsconfig.json`, `packages/bundle/tsdown.config.ts`
- Test: `tests/build-layout.spec.ts`

**Interfaces:**
- Produces: three workspace packages; ordered `build:host`, `build:web`, `build:bundle`, and aggregate `build` scripts.

- [ ] **Step 1: Write a failing manifest test**

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('workspace manifests', () => {
  test('builds Host before Browser so generated Remote types exist', async () => {
    const root = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(root.scripts.build).toBe('pnpm build:host && pnpm build:web && pnpm build:bundle')
  })
})
```

- [ ] **Step 2: Run the test and verify the missing manifest failure**

Run: `pnpm exec vitest run tests/build-layout.spec.ts`
Expected: FAIL because the root manifest and scripts do not exist.

- [ ] **Step 3: Create the pnpm workspace and package manifests**

Use `node ^22.19 || >=24`, `pnpm@11.7.0`, ESM everywhere, and semver peers `>=0.1.0-rc.7 <0.2.0` for DSH packages. Point matching dev dependencies at `link:../../../../deepseek-harness/...` from package directories. The installable bundle depends on `@dsh-agent-workspace/host` and `@dsh-agent-workspace/web` through `workspace:^`.

- [ ] **Step 4: Configure ordered Host Typert and Browser builds**

Host compilation emits declarations, then tsdown runs `typertPlugin({ mode: 'package', faces: ['host'] })`. Browser compilation runs only after Host generates `@dsh-agent-workspace/host/remote`; its client target is loader-compatible CJS wrapped by `window.__ModuleLoader__.load(...)`.

- [ ] **Step 5: Install and prove a clean-tree build**

Run: `pnpm install && pnpm test -- tests/build-layout.spec.ts && pnpm typecheck && pnpm build`
Expected: manifest test PASS; all three packages build from an empty `lib/` tree.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml .gitignore .gitattributes tsconfig*.json vitest.config.ts packages tests/build-layout.spec.ts
git commit -m "build: scaffold agent workspace packages"
```

### Task 2: Durable aggregate, identifiers, definitions, employment, and rooms

**Files:**
- Create: `packages/host/src/ids.ts`, `packages/host/src/types.ts`, `packages/host/src/spec.ts`, `packages/host/src/state.ts`
- Test: `tests/state.spec.ts`

**Interfaces:**
- Produces: `WorkspaceState`, branded ids, `agentWorkspaceSpec`, `createInitialState()`, and `mutateWorkspace(state, command)`.

- [ ] **Step 1: Write failing definition and lifecycle tests**

```ts
const state = createInitialState(WorkspaceId('local'))
const v1 = mutateWorkspace(state, { type: 'definition/create', name: 'Java engineer', description: 'Build Java services', instructions: 'Act as a Java engineer.' })
const alice = mutateWorkspace(v1.state, { type: 'agent/create', definitionId: v1.definitionId, name: 'Alice' })
const departed = mutateWorkspace(alice.state, { type: 'agent/depart', agentId: alice.agentId })
const rehired = mutateWorkspace(departed.state, { type: 'agent/employ', agentId: alice.agentId })
expect(rehired.state.agents[alice.agentId].employmentStatus).toBe('employed')
expect(rehired.state.events.map(event => event.type)).toContain('agent/employed')
```

Also test definition revision synchronization, duplicate names, departed-agent room rejection, and re-employment preserving prior event ids.

- [ ] **Step 2: Run the focused tests and verify missing exports**

Run: `pnpm test -- tests/state.spec.ts`
Expected: FAIL because state contracts are absent.

- [ ] **Step 3: Implement branded ids and the Zod aggregate schema**

Define immutable records for definitions/revisions, instances/employment periods, rooms/memberships, events/memory entries, tasks/grants, and child runs. Store the complete `WorkspaceState` in `domainTable<WorkspaceId, WorkspaceState>` so one command is one atomic `table.update()`.

- [ ] **Step 4: Implement pure commands and invariants**

Every command increments `revision` and appends events with monotonic sequence ids. Reject invalid references, mentions of departed agents, overlapping membership periods, and definition synchronization to a nonexistent revision with subject-specific errors.

- [ ] **Step 5: Run tests, typecheck, and commit**

Run: `pnpm test -- tests/state.spec.ts && pnpm typecheck`
Expected: PASS.

```bash
git add packages/host/src tests/state.spec.ts
git commit -m "feat: add durable agent workspace model"
```

### Task 3: Unified event memory and history synchronization

**Files:**
- Create: `packages/host/src/memory.ts`
- Modify: `packages/host/src/state.ts`, `packages/host/src/types.ts`
- Test: `tests/memory.spec.ts`

**Interfaces:**
- Produces: `appendRoomMessage()`, `joinRoomWithMemory()`, `recallAgentEvents()` and `MemoryReader.recall()`.

- [ ] **Step 1: Write failing memory behavior tests**

```ts
const result = appendRoomMessage(state, {
  roomId,
  actor: { type: 'human', id: HumanId('owner') },
  text: 'Release on Friday',
  mentions: [aliceId],
})
expect(memoryEventIds(result.state, aliceId)).toContain(result.eventId)
expect(memoryEventIds(result.state, bobId)).toContain(result.eventId)
expect(result.wakeAgentIds).toEqual([aliceId])
```

Test new-events-only joins, explicit historical ranges, DM events, cross-room recall, child-result acquisition, stable recency ordering, and token/character budget truncation.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm test -- tests/memory.spec.ts`
Expected: FAIL because memory projection is absent.

- [ ] **Step 3: Implement one canonical event plus memory associations**

Append each room event once and append one `AgentMemoryEntry` for every current member. History synchronization adds entries with `acquiredBy: 'history-sync'` for exactly the selected inclusive sequence range and never changes the original event.

- [ ] **Step 4: Implement deterministic first-release recall**

Return current-room recent events first, followed by case-insensitive lexical matches from the agent's unified memory, then remaining recent personal events until the configured character budget is exhausted. Return event ids and rendered provenance for the DSH recall message.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test -- tests/memory.spec.ts tests/state.spec.ts && pnpm typecheck`
Expected: PASS.

```bash
git add packages/host/src tests/memory.spec.ts
git commit -m "feat: project unified personal event memory"
```

### Task 4: Human assignments, delegation grants, and one-shot child records

**Files:**
- Create: `packages/host/src/tasks.ts`
- Modify: `packages/host/src/state.ts`, `packages/host/src/types.ts`
- Test: `tests/tasks.spec.ts`

**Interfaces:**
- Produces: `assignHumanTask()`, `grantTaskDelegation()`, `assignDelegatedTask()`, `completeTask()`, `recordChildRunStarted()`, and `recordChildRunFinished()`.

- [ ] **Step 1: Write failing authorization tests**

```ts
expect(() => assignDelegatedTask(state, {
  actorAgentId: managerId,
  assigneeAgentId: engineerId,
  rootTaskId,
  title: 'Implement API',
})).toThrow(/human delegation grant/)
```

Then grant the manager, prove the derived assignment cites the grant and root task, prove unrelated-root assignment fails, and prove completion expires the grant.

- [ ] **Step 2: Write child lifecycle tests**

Prove any employed parent can start a child without a grant, the terminal result becomes parent memory, and a terminal child run rejects continuation or a second completion.

- [ ] **Step 3: Implement task-scoped authority and child records**

Keep communication events independent of formal task records. Only human-created grants authorize peer assignments. Child runs are parent-owned and terminal; no child id appears in room membership or employee maps.

- [ ] **Step 4: Verify and commit**

Run: `pnpm test -- tests/tasks.spec.ts && pnpm typecheck`
Expected: PASS.

```bash
git add packages/host/src tests/tasks.spec.ts
git commit -m "feat: add task delegation and child lifecycle"
```

### Task 5: storage-domain service and restart recovery

**Files:**
- Create: `packages/host/src/index.ts`
- Modify: `packages/host/src/spec.ts`
- Test: `tests/restart.integration.spec.ts`

**Interfaces:**
- Produces: `AgentWorkspaceDomainService`, `ctx.agentWorkspace`, `snapshot()`, and serialized `execute(command)`.

- [ ] **Step 1: Write a failing restart integration test**

Create a temporary Cordis context with the JSON storage provider and storage-domain, execute definition/agent/room/message commands, dispose it, boot a second context against the same directory, and assert deep equality of the detached snapshot.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- tests/restart.integration.spec.ts`
Expected: FAIL because no Host service opens the domain.

- [ ] **Step 3: Implement service ownership**

Use `await ctx.storageDomain.open(agentWorkspaceSpec)`, register `domain.close()` through `ctx.effect`, create the local aggregate on first boot, and expose detached snapshots. Route every mutation through `workspaceTable.update(localWorkspaceId, current => mutateWorkspace(current, command).state)`.

- [ ] **Step 4: Prove schema mismatch and durable-first behavior**

Add tests that an incompatible domain version fails at boot and a failed durable write does not publish a new in-memory revision or wake an agent.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test -- tests/restart.integration.spec.ts tests/state.spec.ts tests/memory.spec.ts tests/tasks.spec.ts && pnpm typecheck`
Expected: PASS.

```bash
git add packages/host/src/index.ts packages/host/src/spec.ts tests/restart.integration.spec.ts
git commit -m "feat: persist agent workspace state"
```

### Task 6: Long-lived DSH employees, recall injection, and turn tracking

**Files:**
- Create: `packages/host/src/runtime.ts`, `packages/host/src/turn-tracker.ts`
- Modify: `packages/host/src/index.ts`, `packages/host/src/types.ts`
- Test: `tests/runtime.spec.ts`

**Interfaces:**
- Produces: `EmployeeAgentPool.ensure()`, `EmployeeAgentPool.dispose()`, `WorkspaceTurnTracker.deliver()`, and custom DSH message sources `agent-workspace-delivery` and `agent-workspace-recall`.

- [ ] **Step 1: Write failing runtime ownership tests**

Use fake `ctx.agents` and session events to prove concurrent `ensure()` calls create or resume once, the Host retains `AgentHandle`, departure disposes the handle, and a known materialized session never silently falls back to create when resume fails.

- [ ] **Step 2: Write failing recall and correlation tests**

Prove the scoped `agent/pre-step` listener inserts recall immediately after the matching delivery only after downstream admission; discarded messages reject; `agent/inbox/claimed` binds `MessageId` to turn; chunks and final output from other turns are ignored.

- [ ] **Step 3: Implement the pool and scoped setup**

Create new employees with stable `SessionId`, resume materialized employees, register the current definition as an agent-scoped system-prompt section, and install the recall listener. Keep a single-flight map and reject a live foreign session without an owning handle.

- [ ] **Step 4: Implement turn tracking**

Use `Promise.withResolvers`, `agent/inbox/claimed`, `agent/inbox/discarded`, `assistant/chunk`, `assistant/message`, `turn/end`, and `agent/disposed`. Treat `TurnEndReason` as merge-extensible and retain the last nonempty assistant message.

- [ ] **Step 5: Verify durable model visibility and commit**

Assert every recalled workspace event id is present in a logged `user/message` before the corresponding model request and call `ctx.sessions.flush(agent.session)` after terminal delivery.

Run: `pnpm test -- tests/runtime.spec.ts && pnpm typecheck`
Expected: PASS.

```bash
git add packages/host/src tests/runtime.spec.ts
git commit -m "feat: run persistent workspace employees"
```

### Task 7: Mention dispatcher, reply budgets, and DSH subagents

**Files:**
- Create: `packages/host/src/dispatcher.ts`
- Modify: `packages/host/src/index.ts`, `packages/host/src/types.ts`
- Test: `tests/dispatcher.spec.ts`

**Interfaces:**
- Produces: `WorkspaceDispatcher.postHumanMessage()`, `postAgentMessage()`, `runAssignedTask()`, and `runChild()`.

- [ ] **Step 1: Write failing mention-chain tests**

Prove all members gain memory, only explicitly mentioned employed agents receive `deliver()`, mentions in an agent answer schedule the next hop, and the fourth hop or ninth reply appends `conversation/stopped` without another delivery.

- [ ] **Step 2: Write failing child-provider tests**

Fake `ctx.subagents.start()` and prove the dispatcher uses one-shot `start(provider, { parent, label, prompt, signal })`, always awaits `run.dispose()` in `finally`, records terminal output in parent memory, and never creates a top-level instance or membership.

- [ ] **Step 3: Implement the serialized dispatcher**

Host mention parsing owns canonical ids; UI-supplied display text never grants authority. Serialize each root chain, commit an event before wakeup, append agent output before resolving its mentions, and isolate failures as terminal reply events.

- [ ] **Step 4: Implement task and child execution**

Route formal peer assignments through Task 4 authorization. Permit any employed active parent to start a child, optionally after an ordinary DSH ask-user interaction, and persist input/status/result events.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test -- tests/dispatcher.spec.ts tests/runtime.spec.ts tests/tasks.spec.ts && pnpm typecheck`
Expected: PASS.

```bash
git add packages/host/src tests/dispatcher.spec.ts
git commit -m "feat: dispatch mentioned agents and child work"
```

### Task 8: Typert Remote and invariant

**Files:**
- Create: `packages/host/src/remote.ts`, `packages/host/src/invariant.ts`
- Modify: `packages/host/src/index.ts`, `packages/host/package.json`, `packages/host/tsdown.config.ts`
- Test: `tests/remote.spec.ts`

**Interfaces:**
- Produces: generated `@dsh-agent-workspace/host/remote`, snapshot and mutation request/response types, and a companion runtime invariant.

- [ ] **Step 1: Write failing Remote tests**

Instantiate the service over a fake domain and assert every mutation returns the committed detached snapshot with a strictly increased revision; stale `expectedRevision` requests return a typed conflict instead of overwriting newer state.

- [ ] **Step 2: Implement the Host Remote**

Extend `TypertRemoteService`, call `super(ctx, 'agentWorkspace')`, and add `@Remote` methods for snapshot, definitions, instances, lifecycle, rooms/membership/history synchronization, messages, tasks, grants, and child requests. Keep wire ids branded and validate every durable boundary.

- [ ] **Step 3: Add invariant and generate artifacts**

Check owned relationships: every employed materialized instance has a recoverable session binding; every memory entry references an existing event and agent; every live grant references an open root task. Generate `lib/typert.host.*` and `lib/typert.remote-client.*` and export `./typert`, `./remote`, `./types`, and `./invariant`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm test -- tests/remote.spec.ts && pnpm build:host && pnpm typecheck:host`
Expected: PASS with generated Remote artifacts.

```bash
git add packages/host tests/remote.spec.ts
git commit -m "feat: expose agent workspace remote API"
```

### Task 9: Browser Workspace overlay

**Files:**
- Create: `packages/web/src/index.ts`, `packages/web/src/client/index.ts`, `store.ts`, `controller.ts`, `workspace.tsx`, `sidebar.tsx`, `room.tsx`, `agents.tsx`, `tasks.tsx`, `styles.css`
- Test: `tests/web.spec.tsx`

**Interfaces:**
- Consumes: generated `@dsh-agent-workspace/host/remote` and Host wire types.
- Produces: one sidebar footer action and one full-screen overlay with polling snapshots and mutation forms.

- [ ] **Step 1: Write failing component and registration tests**

Using jsdom and a fake Remote, prove apply self-mounts the Host contribution, registers through `ctx.slots.inject`, opens from `sidebar.footer.action`, closes from the overlay, polls only while open, and disposes the Remote contribution.

- [ ] **Step 2: Implement shared store and controller**

Keep one apply-local store handle. Poll `snapshot()` while open, stop on close/dispose, use `expectedRevision` for mutations, and refresh immediately from successful mutation responses. Render actionable typed errors without losing the last valid snapshot.

- [ ] **Step 3: Implement product interactions**

Provide role revision/synchronization, named instance lifecycle, rooms/DMs, membership history range, mention composer, task/grant controls, event memory inspection, and child status/results. Do not render model/tool/skill/participation settings.

- [ ] **Step 4: Build the loader-compatible client**

Bundle CJS into `lib/client.js`, inline CSS, externalize platform React/Cordis/UI packages, inline generated Remote dependencies, and wrap output in `window.__ModuleLoader__.load`. Declare `dsh.client.platform = 'web'` with runtime, gateway, layout, and sidebar injections.

- [ ] **Step 5: Verify and commit**

Run: `pnpm build:host && pnpm test -- tests/web.spec.tsx && pnpm build:web && pnpm typecheck:web`
Expected: PASS and `lib/client.js` contains one loader registration.

```bash
git add packages/web tests/web.spec.tsx
git commit -m "feat: add agent workspace web interface"
```

### Task 10: Bundle, assembled replay, documentation, and package audit

**Files:**
- Create: `packages/bundle/src/index.ts`, `packages/bundle/src/invariant.ts`, `packages/bundle/cordis.patch.yml`
- Create: `tests/bundle.integration.spec.ts`, `tests/agent-workspace.snapshot.spec.ts`, `tests/fixtures/agent-workspace.expected.jsonl`
- Create: `README.md`, `docs/architecture.md`
- Modify: all package manifests as required by packing evidence

**Interfaces:**
- Produces: installable `dsh-agent-workspace` bundle tarball and a runnable Web-profile composition.

- [ ] **Step 1: Write a failing bundle composition test**

Pack all workspace packages, install the bundle tarball into a temporary DSH profile, run `dsh --profile <temp> --dump-config`, and assert exactly one Host row and one Browser row with no process started by config dumping.

- [ ] **Step 2: Add the bundle patch and manifests**

Mount `@dsh-agent-workspace/host` and `@dsh-agent-workspace/web`. Include compiled Host/UI artifacts and `cordis.patch.yml`; exclude sources, local links, credentials, test data, and DSH checkout paths from tarballs.

- [ ] **Step 3: Add an assembled keyless replay**

Drive a deterministic fake LLM through definition creation, two agents in a group, one unmentioned observer, one mention response, one cross-room recalled event, a human delegation grant, and one one-shot child result. Compare room events, memory associations, DSH session inputs, and terminal task state with the committed JSONL fixture.

- [ ] **Step 4: Write consumer and architecture documentation**

Document prerequisites, local clone link setup, clean build order, installation, profile patching, UI entry, persistence semantics, model-visible inputs, failures, limitations, and all first-release exclusions. Keep package contracts in package READMEs and rationale in `docs/architecture.md`.

- [ ] **Step 5: Run release verification**

Run: `pnpm test && pnpm typecheck && pnpm build && pnpm pack:check && git diff --check`
Expected: all commands PASS; package audit finds no `link:`, absolute local path, credential, or undeclared runtime dependency in packed manifests.

- [ ] **Step 6: Commit**

```bash
git add packages tests README.md docs
git commit -m "feat: ship agent workspace bundle"
```

## Plan self-review

- Tasks 2–5 cover every durable product record and restart behavior in the specification.
- Tasks 6–7 cover persistent agent identity, model-visible recall logging, deterministic mentions, bounded agent chains, formal delegation, and one-shot children.
- Tasks 8–10 cover typed Host access, the Browser product surface, bundle installation, assembled transcript evidence, packaging, and documentation.
- The plan contains no migration compatibility layer, automatic response routing, permanent child identity, per-agent capability selection, or hard room secrecy.
