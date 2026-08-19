# Agent Workspace Design

## Purpose

`dsh-agent-workspace` adds a persistent multi-agent workspace to DeepSeek Harness. A workspace models a small organization whose agent instances represent specific colleagues: each has a name, an employment lifecycle, a shared role definition, and a unified personal memory of the events it experienced.

The first release uses the same model access, tools, skills, and system permissions for every top-level agent. Role definitions describe identity and work focus; they do not grant privileges or configure participation behavior.

## Product model

An `AgentDefinition` is a reusable role such as Java engineer or finance analyst. An `AgentInstance` is a named colleague created from one role. Multiple instances may share a definition while retaining independent identities, memories, room memberships, tasks, and employment histories.

Definitions are versioned. Saving a new definition revision asks the human whether existing instances should adopt it. Adopting a revision changes the instance's current role instructions without changing its name, memories, memberships, or employment history. Revision assignments remain recorded as workspace events.

An instance is either `employed` or `departed`. Departure removes the instance from its rooms, prevents new mentions and events, and preserves its identity and memories. Re-employment restores the same instance; rooms are joined again explicitly, and departure-period events are not added unless the human selects history synchronization.

## Rooms, mentions, and participation

A room is a group or a direct message. Joining a room requires the human to select the memory start: new events only, or an explicit historical event range. Every current member receives every new room event as personal memory even when it does not speak.

Mentions are the only automatic wake mechanism in the first release:

- A mentioned employed agent must run and post a response.
- An unmentioned agent records the event but does not run or speak.
- An agent may mention another employed agent; the mentioned agent must respond.
- An agent never automatically claims work merely because it observed a message.

The system limits an agent-to-agent chain per root event. The first release allows at most three mention hops and eight agent replies. Exceeding either limit records a stopped-chain event and creates no further runs.

## Unified personal memory

The workspace stores each fact once as a `WorkspaceEvent`. `AgentMemoryEntry` records that an agent acquired an event through live room membership, human-selected history synchronization, a task, or a child-agent result. This association, rather than a copied transcript, defines personal memory.

An agent has one memory across groups, direct messages, tasks, employment periods, and child-agent results. When it is awakened, context assembly includes the current room's recent events and relevant events selected from the agent's entire personal memory. The first release does not enforce room-level secrecy inside one agent's memory; the same colleague may recall a direct-message event while responding in a group.

Memory acquisition does not run the model. Context selection happens only when a mention or assigned task awakens an agent. Every selected event becomes a durable, provenance-bearing input in that agent's DSH session before the model request.

## Tasks and delegation

Ordinary mentions are communication and do not create formal tasks. Humans may assign tasks directly to any employed agent.

A top-level agent may assign formal tasks to another top-level agent only while holding a human-created `DelegationGrant` for the root task. The grant is task-scoped and expires when the root task reaches a terminal state. Each derived assignment cites the grant and root task. Agents without a matching grant may discuss work but cannot create a top-level assignment.

All top-level agents can create child agents while handling their own work. The parent decides whether to create one directly or ask the human first. Child creation does not require a delegation grant because a child is an internal execution resource rather than another workspace colleague.

## Child agents

A child agent is a task-scoped worker owned by one parent. It receives the task and the context selected by the parent, executes once through the configured DSH subagent provider, and returns its result to the parent. It never joins rooms, receives mentions, assigns top-level tasks, or appears in the employee directory.

Completion ends the child run permanently. The creation request, selected input, terminal status, and result remain workspace events in the parent's memory. The child has no independently resumable identity or long-term memory.

## Durable records

The local workspace database stores at least:

- workspaces;
- agent definitions and immutable revisions;
- agent instances, revision assignments, and employment periods;
- rooms and membership periods;
- workspace events and agent memory entries;
- root tasks, task assignments, and delegation grants;
- child-agent runs;
- DSH session bindings.

Workspace events are append-only facts. Corrections, definition changes, employment changes, membership changes, task transitions, and stopped mention chains append new events rather than rewriting historical events. Product UI projections may hide superseded values while the audit history remains queryable.

## DSH integration

Each top-level instance owns one persistent DSH runtime session so the same colleague remains one model identity across rooms and tasks. Workspace events remain the source of observed experience; the DSH session records only admitted model inputs, turns, tool calls, child-agent interactions, and outputs.

The adapter uses only public DSH package exports. It registers through Cordis effects, disposes every contribution, uses DSH session persistence for runtime logs, uses the existing subagent capability for child work, and projects streaming agent output into workspace events. All DSH-specific types and calls stay behind the adapter; the domain model does not import DSH packages.

Context injection obeys DSH's model-visible logging rule: an event cannot enter a model request unless the same DSH session can reconstruct that input from its durable log. Cancellation ends the active turn without deleting already recorded workspace events or external side effects.

## User interface

The first release provides one workspace view with:

- a sidebar for rooms, direct messages, role definitions, employed agents, and departed agents;
- room history with human and agent messages, mentions, reply relationships, streaming state, task state, and child-agent activity;
- forms to create and revise definitions, create named instances, employ or depart instances, create rooms, and manage membership;
- a membership dialog that selects new events only or an explicit historical range;
- explicit controls for human task assignment and task-scoped delegation;
- an agent detail view for current definition revision, employment history, memberships, tasks, and personal-memory events.

The UI does not expose model, tool, skill, or participation-policy controls in the first release.

## Required behavior

The implementation is complete only when automated tests and an assembled runnable example prove these outcomes:

1. One definition creates multiple named instances with independent memories and employment histories.
2. A definition revision can update only future instances or synchronize existing instances without altering their memories.
3. Joining a room with new-events-only excludes earlier events; selecting a historical range adds exactly that range.
4. Every current member remembers a room message, but only mentioned agents run and reply.
5. Agent mentions trigger required replies and stop at the shared depth or reply budget.
6. An agent retrieves relevant memories across rooms, direct messages, tasks, and prior child results.
7. Departed agents cannot be mentioned and receive no new events; re-employed instances retain prior memories but do not gain departure-period events automatically.
8. An agent without a matching human delegation grant cannot assign a formal task to another top-level agent.
9. A granted agent can create traceable derived assignments only under the granted root task.
10. Any employed agent can run a one-shot child directly or after asking the human; the terminal child result becomes parent memory and the child cannot be resumed.
11. Restarting DSH restores workspace state, instance-to-session bindings, room history, personal memory, tasks, and employment history.
12. Every workspace-derived model input is present in the corresponding durable DSH session log.

## Excluded from the first release

The first release excludes multiple human users, enterprise authorization, SaaS tenancy, per-agent model/tool/skill selection, configurable participation policies, automatic response routing, autonomous top-level task claiming, permanent child agents, agent marketplaces, workflow builders, voice, billing, and hard secrecy between one agent's personal-memory sources.
