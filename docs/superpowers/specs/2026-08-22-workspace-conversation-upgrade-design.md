# Agent Workspace Conversation Upgrade Design

## Status

Approved in chat on 2026-08-22 for implementation on `feat/workspace-ui`, including `@all` group routing.

## Goal

Upgrade Agent Workspace chat from a final-text room projection into a first-class collaborative conversation experience while preserving the plugin's additive, uninstallable integration model.

The upgrade adds:

- direct one-to-one chat with an employed workspace agent;
- real-time turn streaming instead of one-second final-result polling;
- Markdown, reasoning, and tool-call/tool-result presentation aligned with DeepSeek Harness (DSH) Web conversation behavior;
- explicit group-message routing semantics where only mentioned agents are awakened;
- a reserved `@all` group routing token that expands to all active employed members exactly once;
- continued agent-to-agent mention collaboration with bounded hops/replies;
- isolation from the ordinary DSH sidebar/conversation data model and no replacement of core UI slots.

## Non-goals

This change does not:

- replace DSH `conversation`, `sidebar`, or `details` slot owners;
- expose Agent Workspace internal employee Sessions in ordinary DSH workspace grouping surfaces;
- make an unmentioned group message broadcast to every member;
- make `@all` valid in direct rooms;
- add arbitrary room-level permissions or hard secrecy;
- add a second React runtime or copy DSH source components into the plugin;
- redesign Agent Definition management beyond the chat-entry affordances required for direct messaging.

## Product Semantics

### Group rooms

A group room may contain multiple employed workspace agents.

Human messages use explicit routing:

- `hello` -> persist the room message, wake no agent;
- `@Alice hello` -> persist the room message, wake Alice only;
- `@Alice @Bob review this` -> persist once, wake Alice and Bob;
- `@all review this` -> persist once, expand `@all` to every active employed member and wake each exactly once;
- `@all @Alice review this` -> Alice still wakes only once because the expanded wake set is deduplicated;
- an agent reply that mentions another active member schedules that member as the next bounded collaboration hop.

`@all` is a reserved lowercase group routing token. The user-visible text remains exactly as typed, including `@all`, while the durable room event stores the expanded resolved `mentions` agent-id set. This keeps authorization/replay deterministic without rewriting user prose.

An unmentioned group message is therefore a durable room message, not a broadcast command. The browser gives a lightweight informational hint after such a send so the user understands that no agent was invoked. The send is never blocked merely because there is no mention.

Unmentioned group messages remain eligible room history for later recall according to the existing membership-memory and recall-budget rules.

### Direct rooms

A direct room represents exactly one human-to-agent conversation target.

Rules:

- exactly one active agent membership is allowed in a direct room;
- the target agent must be employed;
- a human message does not require an `@` mention and automatically routes to the direct-room target;
- `@all` is not offered and is rejected as a special routing token in direct rooms;
- the user cannot add a second member through the Browser or Host command boundary;
- an agent in a direct room may still mention another agent only by posting into a group/shared room; direct-room output itself does not silently widen the room into a group.

The Browser exposes a `私聊` action from an employed agent instance. Opening it resolves or creates the stable direct room for that agent and selects it immediately.

Repeated `私聊` actions for the same agent reuse the existing active direct room rather than creating duplicates.

## Conversation Rendering Model

### Problem with the current model

Current Agent Workspace chat persists canonical room messages but turns terminal agent output into plain text. The Host discards non-text `ContentBlock` data via `textOf()`, and the Browser renders the final message with a plain `<div>`. This loses:

- streaming text deltas;
- reasoning presentation;
- tool-call heads and tool results;
- retry/error/turn status;
- the richer Markdown rendering already available in DSH Web.

### Principle

Do not recreate a parallel chat renderer that only resembles DSH. Reuse stable public DSH client primitives/contracts where possible, and preserve enough structured turn information at the plugin boundary for the Workspace view to render the same categories of information.

The plugin remains the owner of Workspace room identity and collaboration routing. DSH remains the owner of each employee Agent Session and its native turn/tool execution.

## Workspace Turn Stream

### Host-side stream state

Add an ephemeral `WorkspaceTurnStream` service/component owned by the Agent Workspace Host runtime.

It observes the scoped DSH employee Session/Agent events already used by `WorkspaceTurnTracker`, projects only browser-safe structured records, and publishes them through the plugin-owned `/agent-workspace` transport.

The stream does not become part of the durable `WorkspaceState` aggregate. Durable room history remains canonical room events. Streaming records are transient turn presentation state.

Each active turn projection contains at least:

- `roomId`;
- `agentId`;
- DSH `sessionId`;
- turn number / stable turn key;
- ordered presentation blocks;
- running/settled status;
- stop reason when settled;
- display-safe error information when failed.

Presentation blocks preserve semantic kinds needed by the Workspace UI, including:

- assistant text/Markdown;
- reasoning summary/body data supported by the public client runtime contract;
- tool-call identity/name/arguments sufficient to join with DSH tool presentation data;
- tool result/status information exposed by stable public DSH client/runtime contracts;
- unknown blocks as an opaque fallback rather than silent deletion.

Internal secrets, credentials, raw authority objects, and arbitrary Host objects must never cross this boundary.

### Delivery lifecycle

For a human message that wakes an agent:

1. Persist the human room event.
2. Return acknowledgement quickly to the Browser.
3. Start/continue the agent turn in the background.
4. As DSH emits turn/session changes, publish Workspace turn-stream updates immediately.
5. Browser updates the corresponding agent row in place.
6. On turn settlement, persist the agent's final textual room message and its parsed room mentions using the existing bounded dispatcher semantics.
7. Retire transient stream state after the Browser has a settled durable representation, keeping only short-lived runtime metadata as needed for reconnect convergence.

The existing `WorkspaceTurnTracker` keeps its terminal correlation responsibility. Streaming observation is additive and must not weaken its delivery-to-turn correctness.

## Transport

### Preferred transport

Use the existing plugin-owned Connection channel `/agent-workspace`; do not intercept DSH `/api` and do not patch core remotes.

The Browser needs a push-capable subscription/event mechanism on that channel when supported by the public Connection API. If the current Connection public contract does not expose server-to-client push for plugin channels, implement the narrowest compatible DSH-supported subscription seam rather than inventing a second network server.

A degraded polling fallback may exist only for reconnect/recovery; it is not the primary streaming path.

### Reconnect

On Workspace overlay open or transport reconnect:

- fetch durable `WorkspaceSnapshot`;
- fetch current ephemeral turn-stream snapshot for active turns;
- merge by room/agent/turn identity;
- continue live subscription;
- never duplicate a settled agent room message that is already durable.

## Markdown and Reasoning

Workspace assistant prose must render through DSH's public Markdown primitive rather than raw text.

Requirements:

- headings, lists, tables, links, inline code, fenced code, and copy affordances follow DSH behavior;
- streaming Markdown receives `streaming=true` while the block is growing;
- reasoning uses a public DSH reasoning/assistant presentation contract when exported and stable;
- if a DSH internal component is not publicly exported, depend on the public primitive/slot contract below it rather than importing private source paths.

Do not vendor/copy `AssistantMarkdown.tsx` into this repository.

## Tool Presentation

Tool execution must no longer disappear at `textOf()`.

The Workspace stream preserves tool-call identity and correlates it with DSH runtime/session projection data. The Browser delegates visual presentation to the same public DSH tool presentation registry/slot contract used by the Web conversation when that contract is available.

If a concrete DSH tool renderer is not legally/publicly importable from its package exports, the plugin uses the public conversation/tool slot registry as the integration boundary. It must not import `src/` internals merely to achieve visual parity.

Unknown/unregistered tool types get a compact generic disclosure with tool name, state, safe arguments, and safe result summary.

The design target is behavioral parity with the main conversation for:

- running/completed/failed tool state;
- expandable tool rows;
- file/tool-specific renderers when registered by DSH;
- display-safe errors.

## Browser Layout

The existing additive overlay remains the shell.

### Left navigation

The chat navigation distinguishes:

- direct conversations, labeled with the agent name and a `私聊` indicator;
- group conversations, labeled with the group name and member count.

Agent management exposes a `私聊` action on each employed instance. The action opens/reuses the direct room and switches to chat mode.

### Message flow

For an active agent turn, one message row grows in place:

- agent identity/avatar remains stable;
- Markdown text streams incrementally;
- reasoning/tool rows appear at their actual turn positions;
- running state is visible without disabling the composer;
- the composer stays usable while one or more background turns run.

Group replies from multiple concurrently mentioned agents each own their independent streaming row.

### Mention affordances

In group rooms the composer exposes member mention chips plus an `@all` chip. Clicking `@all` inserts the literal `@all` token into the draft. Manually typing lowercase `@all` has the same routing semantics.

The Browser resolves group mentions before submit:

- explicit member mentions resolve to active employed member ids;
- `@all` expands to all active employed member ids;
- the resulting id list is deduplicated in stable room-member order;
- the text is not rewritten to individual names or canonical ids.

Direct rooms do not show an `@all` chip and do not require mention chips for ordinary delivery.

### No-mention hint

After a successful group send with zero resolved mentions, show non-error informational feedback such as:

`未指定智能体，本消息仅发送到群聊。`

This hint does not persist as a room message and does not become model context.

## Domain and Invariants

Strengthen room invariants:

- direct room: at most one active agent membership;
- group room: zero or more active agent memberships;
- direct room human post: dispatcher derives exactly the direct target as the wake set;
- group room human post: dispatcher uses only explicitly resolved mentions, including expanded `@all`, as the wake set;
- `@all` expansion includes only active employed group members and deduplicates with explicit mentions;
- every wake target must be an active employed room member;
- a departed agent cannot be a newly routed target;
- duplicate direct-room creation for the same active agent is resolved to the existing room at the service/RPC boundary.

No schema migration should be necessary if current `Room.kind='direct'` is already durable. If current persisted states can violate the new direct-room invariant, boot must tolerate legacy data long enough to report/repair explicitly; it must not silently delete memberships.

## Agent-to-Agent Collaboration

Existing bounds remain authoritative:

- `maxAgentHops = 3`;
- `maxRepliesPerRoot = 8`;
- recall character budget remains `4000` unless separately changed.

Streaming and `@all` do not change collaboration scheduling. `@all` only expands the root wake set. An agent's next mentions are parsed from its settled textual output before scheduling subsequent wakes.

For a root message that mentions multiple agents, including `@all`, those root wakes may execute independently if the existing runtime permits it, but each reply must still be committed with deterministic room sequencing at the durable domain boundary. The global `maxRepliesPerRoot` budget still caps the entire collaboration chain, including root replies triggered by `@all`.

## Compatibility and Isolation

Hard constraints:

- continue registering only additive Workspace surfaces;
- do not replace core `sidebar`, `conversation`, or `details` owners;
- do not read/write DSH browser Conversation stores as the Workspace room source of truth;
- continue using plugin-owned `agent_workspace` storage domain for durable Workspace state;
- continue archiving plugin-owned employee Sessions from ordinary DSH grouping surfaces;
- continue sharing React and DSH runtime dependencies;
- namespace plugin-owned CSS under `dsh-agent-group-*`;
- uninstalling the plugin must restore the original DSH UI behavior without migration of core data.

Reusing exported DSH Markdown/tool primitives is dependency reuse, not ownership of the main Conversation store.

## Error Handling

- message persistence failure: reject the send and keep the draft;
- direct-room target missing/departed: fail before durable post;
- `@all` in a group with no active employed members resolves to zero wakes and behaves like a no-recipient group post;
- background agent turn failure: keep the human room message, settle the transient turn with display-safe failure, and show a room-level/turn-level error;
- stream disconnect: mark live display stale, reconnect, fetch snapshot, and converge without duplicate durable messages;
- unsupported tool renderer: generic safe fallback instead of dropping the tool event;
- ordinary compatible employee Session resume failure remains a real error and must not silently mint a replacement;
- only the already-defined legacy-session compatibility classification may intentionally rotate an internal employee Session.

## Testing Strategy

### Host/domain

Add tests for:

- group message with zero mentions persists and performs zero deliveries;
- group message with one/multiple mentions wakes only those targets;
- group `@all` expands to every active employed member exactly once;
- group `@all` plus explicit mentions deduplicates targets;
- departed/inactive members are excluded from `@all`;
- direct room creation/reuse and one-target invariant;
- direct human post auto-targets the sole agent without mention text;
- departed/missing direct target rejection;
- agent-to-agent mention bounds remain unchanged;
- transient turn stream receives text/reasoning/tool lifecycle events without mutating durable WorkspaceState;
- settled turn writes exactly one final durable agent room message;
- reconnect snapshot can converge against an already-settled durable message without duplication.

### Browser

Add tests for:

- direct-chat action creates/reuses/selects a direct room;
- direct composer sends without inserting an `@` token;
- group zero-mention send shows informational hint and does not show agent-running state caused by that message;
- group composer shows `@all`, inserts the literal token, and expands it to all active employed members on submit;
- streaming assistant text updates one row in place;
- Markdown renders headings/lists/code through DSH primitive;
- tool rows render running/completed/failed states through the public integration boundary;
- multiple agents can stream independently in one group;
- composer remains enabled while agent turns run;
- disconnect/reconnect converges without duplicate rows.

### Compatibility

Retain/extend source-contract tests proving:

- only additive slot registrations are used;
- core DSH Conversation/Session browser stores are not mutated;
- no private `@deepseek-ai/.../src/...` imports are introduced for Markdown/tool parity;
- plugin bundle remains uninstallable/additive;
- strict Harness build, plugin build, typecheck, and all tests stay green.

## Acceptance Criteria

The feature is complete when all of the following hold in a real DSH Web profile:

1. Clicking `私聊` on an employed agent opens/reuses a one-to-one conversation.
2. Sending `hello` in that direct room wakes the target without an `@` token.
3. Sending `hello` in a group persists the message, wakes nobody, and shows a non-error no-recipient hint.
4. Sending `@Alice hello` in a group wakes Alice only.
5. Sending `@all hello` in a group wakes every active employed member exactly once.
6. Sending `@all @Alice hello` does not wake Alice twice.
7. Assistant Markdown visibly streams before turn completion.
8. Reasoning/tool activity appears during the turn rather than only after settlement.
9. Tool calls/results are not discarded by Host text extraction.
10. Agent-to-agent `@` collaboration remains bounded and visible as separate participant turns.
11. The composer remains usable while background turns run.
12. Employee Sessions remain hidden from ordinary DSH workspace grouping surfaces.
13. Existing DSH main conversation behavior remains unchanged.
14. Strict CI passes Harness install/build, plugin frozen install/build, typecheck, and tests.
