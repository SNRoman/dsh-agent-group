# Agent Workspace Conversation Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver direct private chat, `@all` group routing, true incremental Agent turn streaming, and Markdown/reasoning/tool-process rendering in Agent Workspace without replacing DeepSeek Harness core conversation surfaces.

**Architecture:** Keep durable room history in the plugin `agent_workspace` domain and DSH employee Sessions hidden. Add a Host-only ephemeral turn stream that folds authoritative `session/event` records (`assistant/chunk`, `tool/call`, `tool/result`, `turn/end`) into JSON-safe Workspace turn projections. Because the public plugin Connection RPC seam is unary and the core Remote event allowlist is not extensible from this plugin without patching Harness, expose a cancellation-aware long-poll subscription endpoint (`stream/wait`) that resolves immediately on stream version changes; Browser immediately reissues it, giving event-driven incremental updates without interval polling or a second server.

**Tech Stack:** TypeScript, React 18, Cordis, DeepSeek Harness Agent/Session/Connection APIs, `@deepseek-ai/dsh-client-ui-primitives` MarkdownText/DisclosureRow, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-22-workspace-conversation-upgrade-design.md`

## Global Constraints

- Work only on `feat/workspace-ui`; do not merge PR #2.
- Keep plugin integration additive: only `sidebar.footer.action` and `shell.overlay` registrations.
- Do not replace DSH `sidebar`, `conversation`, or `details` slot owners.
- Do not patch `@deepseek-ai/dsh-api-remotes`, intercept `/api`, or add a second network server.
- Keep `agent_workspace` as the durable Workspace source of truth; turn-stream state is ephemeral only.
- Keep employee Sessions archived from ordinary DSH grouping surfaces.
- Do not import private `@deepseek-ai/.../src/...` UI paths.
- Reuse public `@deepseek-ai/dsh-client-ui-primitives` for Markdown and disclosure rendering.
- Group zero-mention post persists and wakes nobody; direct post auto-targets its sole member.
- Lowercase `@all` is group-only and expands to all active employed members exactly once.
- Existing bounds remain `maxAgentHops = 3`, `maxRepliesPerRoot = 8`, recall budget `4000`.

---

### Task 1: Lock group routing and direct-room invariants

**Files:**
- Modify: `packages/host/src/state.ts`
- Modify: `packages/host/src/invariant.ts`
- Modify: `packages/host/src/index.ts`
- Modify: `packages/host/src/rpc.ts`
- Modify: `tests/workspace-rpc.spec.ts`
- Create: `tests/workspace-direct-room.spec.ts`

**Interfaces:**
- Produces: `AgentWorkspaceDomainService.openDirectRoom(agentId): Promise<{ state: WorkspaceState; roomId: RoomId }>`.
- Produces: RPC endpoint `room/direct/open` with `{ agentId }` -> `{ state, roomId }`.
- Existing `room/post` remains the human-post endpoint.

- [ ] **Step 1: Write failing direct-room tests**

```ts
it('creates one direct room and reuses it for the same employed agent', async () => {
  const first = await service.openDirectRoom(agentId)
  const second = await service.openDirectRoom(agentId)
  expect(second.roomId).toBe(first.roomId)
  expect(activeMembers(second.state, first.roomId)).toEqual([agentId])
})

it('rejects a second active member in a direct room', () => {
  const direct = mutateWorkspace(state, { type: 'room/create', kind: 'direct' }).state
  // join first member, then expect joining a different active member to throw.
})
```

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `pnpm vitest run tests/workspace-direct-room.spec.ts tests/workspace-rpc.spec.ts`
Expected: FAIL because `openDirectRoom` / `room/direct/open` do not exist and direct membership is not constrained.

- [ ] **Step 3: Implement direct-room open/reuse atomically**

Use one `KvTable.update` transaction: find an existing direct room whose sole active membership is `agentId`; otherwise create a `direct` room and join the employed agent with `{ type: 'new-events' }`. Capture and return the resolved `roomId`. Reject missing/departed agents.

- [ ] **Step 4: Enforce direct membership invariant**

In `joinRoom`, before mutation:

```ts
if (room.kind === 'direct') {
  const active = Object.values(state.memberships)
    .filter(m => m.roomId === roomId && m.leftEventId === undefined)
  if (active.length > 0) throw new Error(`direct room '${roomId}' already has an active member`)
}
```

Extend invariant coverage so newly committed direct rooms cannot have more than one active membership.

- [ ] **Step 5: Add RPC contract**

Add Zod `{ agentId }` validation and return a typed direct-open result; no arbitrary mutation endpoint.

- [ ] **Step 6: Run targeted tests and commit**

Run: `pnpm vitest run tests/workspace-direct-room.spec.ts tests/workspace-rpc.spec.ts`
Expected: PASS.

Commit: `feat: add direct workspace rooms`

---

### Task 2: Add `@all` and room-aware human routing

**Files:**
- Modify: `packages/web/src/client/view-model.ts`
- Modify: `packages/web/src/client/WorkspaceUi.tsx`
- Modify: `packages/host/src/index.ts`
- Modify: `tests/workspace-view.spec.ts`
- Modify: `tests/dispatcher.spec.ts`

**Interfaces:**
- `parseRoomMentionIds(snapshot, roomId, text)` expands lowercase `@all` only for `room.kind === 'group'`.
- `postHumanMessage` derives the sole direct target server-side for direct rooms; Browser mentions are advisory only for groups.

- [ ] **Step 1: Write failing `@all` and direct-routing tests**

```ts
expect(parseRoomMentionIds(snapshot, groupId, '@all 请评审')).toEqual([aliceId, bobId])
expect(parseRoomMentionIds(snapshot, groupId, '@all @Alice 请评审')).toEqual([aliceId, bobId])
expect(parseRoomMentionIds(snapshot, directId, '@all')).toEqual([])
```

Add Host test proving `postHumanMessage(directId, human, 'hello', [])` delivers to the sole member.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run tests/workspace-view.spec.ts tests/dispatcher.spec.ts`
Expected: FAIL on `@all` expansion/direct auto-target.

- [ ] **Step 3: Implement routing**

For group rooms, preserve existing explicit mention behavior and expand `@all` to active employed members in stable membership order, deduplicating explicit hits. For direct rooms, service ignores empty Browser mention list and derives exactly the sole active employed target before dispatch; reject malformed direct rooms.

- [ ] **Step 4: Add composer `@all` affordance**

Render an `@all` chip only for group rooms; insert literal `@all`. When a group send resolves zero targets, show `未指定智能体，本消息仅发送到群聊。` as transient non-error feedback.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run tests/workspace-view.spec.ts tests/dispatcher.spec.ts`
Expected: PASS.

Commit: `feat: add all-member workspace routing`

---

### Task 3: Introduce the ephemeral Host turn stream

**Files:**
- Create: `packages/host/src/turn-stream.ts`
- Modify: `packages/host/src/turn-tracker.ts`
- Modify: `packages/host/src/dispatcher.ts`
- Modify: `packages/host/src/index.ts`
- Create: `tests/workspace-turn-stream.spec.ts`
- Modify: `tests/runtime.spec.ts`

**Interfaces:**

```ts
export interface WorkspaceTurnStreamSnapshot {
  readonly version: number
  readonly workspaceRevision: number
  readonly turns: readonly WorkspaceTurnProjection[]
}

export class WorkspaceTurnStream {
  snapshot(): WorkspaceTurnStreamSnapshot
  wait(afterVersion: number, signal: AbortSignal): Promise<WorkspaceTurnStreamSnapshot>
  setWorkspaceRevision(revision: number): void
  begin(input: { roomId: RoomId; agentId: AgentId; sessionId: SessionId; turn: number }): void
  acceptSessionEvent(input: { roomId: RoomId; agentId: AgentId; sessionId: SessionId; event: SessionEvent }): void
}
```

Projection block vocabulary:

```ts
type WorkspaceTurnBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; callId: string; name: string; arguments: string; status: 'running' | 'completed' | 'failed'; resultText?: string; error?: string }
  | { kind: 'unknown'; label: string; value: unknown }
```

- [ ] **Step 1: Write stream reducer tests**

Feed `turn/start`, `assistant/chunk` text/reasoning deltas, `tool/call`, `tool/result`, and `turn/end`; assert one stable turn projection grows in place and `version` increments. Assert no turn-stream mutation changes `WorkspaceState`.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run tests/workspace-turn-stream.spec.ts`
Expected: FAIL because the stream does not exist.

- [ ] **Step 3: Implement JSON-safe stream folding**

Use `assistant/chunk` as the authoritative token stream. Append adjacent text/reasoning deltas; create running tool rows on `tool/call`; settle matching rows on `tool/result`; reconcile terminal assistant content if a provider produced no chunks; record turn stop/error on `turn/end`.

- [ ] **Step 4: Wire tracker with room/session identity**

Extend pending delivery with `roomId`; when `agent/inbox/claimed` assigns `turn`, publish `begin`. Forward relevant scoped `session/event` records to `WorkspaceTurnStream`. Keep terminal `DeliveryOutcome` semantics unchanged.

- [ ] **Step 5: Wire workspace revision publication**

After every durable `execute`/`apply` commit, call `turnStream.setWorkspaceRevision(next.revision)` so Browser knows when it must refresh room history.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run tests/workspace-turn-stream.spec.ts tests/runtime.spec.ts tests/dispatcher.spec.ts`
Expected: PASS.

Commit: `feat: project live workspace turns`

---

### Task 4: Add cancellation-aware stream subscription RPC

**Files:**
- Modify: `packages/host/src/rpc.ts`
- Modify: `packages/web/src/client/contracts.ts`
- Modify: `packages/web/src/client/api.ts`
- Modify: `tests/workspace-rpc.spec.ts`

**Interfaces:**
- RPC `stream/snapshot` `{}` -> `WorkspaceTurnStreamSnapshot`.
- RPC `stream/wait` `{ afterVersion: nonnegative integer }` -> next `WorkspaceTurnStreamSnapshot` after a version change; resolves periodically only as a transport keepalive, not interval polling.
- Browser `WorkspaceApiClient.streamSnapshot()` and `waitForStream(afterVersion, signal)`.

- [ ] **Step 1: Write failing RPC tests**

Assert `stream/wait` remains pending at version N, resolves immediately after `WorkspaceTurnStream` publishes N+1, and abort returns the existing cancelled result.

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `pnpm vitest run tests/workspace-rpc.spec.ts`
Expected: FAIL on missing endpoints.

- [ ] **Step 3: Implement endpoints and structural Browser guards**

Do not modify core remotes or `/api`. Keep the long-poll on the plugin Connection RPC channel `/agent-workspace`.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm vitest run tests/workspace-rpc.spec.ts`
Expected: PASS.

Commit: `feat: stream workspace turns over plugin rpc`

---

### Task 5: Render incremental Markdown, reasoning, and tool process

**Files:**
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/web/src/client/contracts.ts`
- Create: `packages/web/src/client/WorkspaceTurn.tsx`
- Modify: `packages/web/src/client/WorkspaceUi.tsx`
- Modify: `packages/web/src/client/styles.ts`
- Modify: `packages/web/tsconfig.client.json` if needed
- Create: `tests/workspace-turn-view.spec.ts`
- Modify: `tests/workspace-ui-registration.spec.ts`

**Interfaces:**
- Public dependency: `@deepseek-ai/dsh-client-ui-primitives`.
- `WorkspaceTurn` accepts one `WorkspaceTurnProjection` and renders its ordered blocks.

- [ ] **Step 1: Write renderer/source-contract tests**

Assert the Web package depends on the public primitives package; source imports `MarkdownText`/`DisclosureRow`; source contains no `@deepseek-ai/.../src/` import. Add pure projection tests for tool status labels and ordered blocks.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run tests/workspace-turn-view.spec.ts tests/workspace-ui-registration.spec.ts`
Expected: FAIL because `WorkspaceTurn` does not exist and Markdown primitive is not a dependency.

- [ ] **Step 3: Implement renderer**

Use:

```tsx
<MarkdownText text={block.text} streaming={turn.status === 'running'} codeLabels={...} />
```

Render reasoning through public `DisclosureRow`. Render tool calls through a compact disclosure showing name, running/completed/failed state, safe parsed arguments/raw fallback, and result/error text. Preserve block order. Do not copy/import `AssistantMarkdown.tsx` or private DSH source.

- [ ] **Step 4: Replace 1-second polling with stream loop**

On overlay open: fetch durable snapshot + stream snapshot; then loop `waitForStream(version, signal)`. Update transient turn state immediately. When `workspaceRevision` changes, fetch durable snapshot once. Keep reconnect/backoff only after transport errors.

- [ ] **Step 5: Merge live rows with durable room messages**

Render durable room events plus active turn projections for the selected room. On settlement/durable revision convergence, suppress/remove the transient copy so the final assistant message appears exactly once.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run tests/workspace-turn-view.spec.ts tests/workspace-view.spec.ts tests/workspace-ui-registration.spec.ts`
Expected: PASS.

Commit: `feat: render streaming workspace conversations`

---

### Task 6: Add direct-chat Browser workflow

**Files:**
- Modify: `packages/web/src/client/api.ts`
- Modify: `packages/web/src/client/WorkspaceUi.tsx`
- Modify: `packages/web/src/client/view-model.ts`
- Modify: `packages/web/src/client/styles.ts`
- Modify: `tests/workspace-view.spec.ts`
- Modify: `tests/workspace-rpc.spec.ts`

**Interfaces:**
- `WorkspaceApiClient.openDirect(agentId)` -> `{ snapshot, roomId }`.
- Employed agent rows expose `私聊`; departed rows do not.

- [ ] **Step 1: Write failing view/API tests**

Verify direct open selects the returned room, switches to chat mode, hides member-add controls, and sends plain text with no inserted mention.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run tests/workspace-view.spec.ts tests/workspace-rpc.spec.ts`
Expected: FAIL on missing direct workflow.

- [ ] **Step 3: Implement direct workflow**

Add `私聊` on employed instances. Direct chat header/left navigation shows agent name + `私聊`. Direct composer has no `@all`; ordinary send passes empty mention list and Host auto-targets.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm vitest run tests/workspace-view.spec.ts tests/workspace-rpc.spec.ts`
Expected: PASS.

Commit: `feat: add workspace private chat`

---

### Task 7: Full compatibility verification

**Files:**
- Modify tests only if a legitimate uncovered regression is found.
- Update PR description only after verification is green.

- [ ] **Step 1: Run complete plugin verification**

Run:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

Expected: all commands exit 0.

- [ ] **Step 2: Verify compatibility source contracts**

Confirm no core slot replacement, no private DSH UI imports, no `/api` interception, and no direct browser Conversation-store mutation.

- [ ] **Step 3: Push and wait for strict GitHub CI**

Expected workflow stages all green: Harness frozen install, Harness `build:lib`, plugin frozen install, Build, Typecheck, Test.

- [ ] **Step 4: Update Draft PR #2 summary/verification**

Keep PR Draft and unmerged. Record the final CI run and the four delivered features: direct chat, `@all`, live streaming, Markdown/reasoning/tool process.
