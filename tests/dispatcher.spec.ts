import { describe, expect, test, vi } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentId, HumanId, RoomId, TaskId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignHumanTask } from '../packages/host/src/tasks.ts'
import { WorkspaceDispatcher } from '../packages/host/src/dispatcher.ts'
import type { WorkspaceDispatcherHost, SubagentRuntimeLike } from '../packages/host/src/dispatcher.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'

function buildRoom(agentNames: string[]): { state: WorkspaceState; roomId: ReturnType<typeof RoomId>; agentIds: ReturnType<typeof AgentId>[] } {
  let state = createInitialState(WorkspaceId('local'))
  const def = mutateWorkspace(state, { type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i' })
  state = def.state
  const agentIds: ReturnType<typeof AgentId>[] = []
  for (const name of agentNames) {
    const created = mutateWorkspace(state, { type: 'agent/create', definitionId: def.definitionId, name })
    state = created.state
    agentIds.push(created.agentId)
  }
  const room = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: 'room' })
  state = room.state
  for (const agentId of agentIds) {
    state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId, memoryStart: { type: 'new-events' } }).state
  }
  return { state, roomId: room.roomId, agentIds }
}

interface FakeHost extends WorkspaceDispatcherHost {
  delivered: AgentId[]
  replies: Map<AgentId, string>
  state: WorkspaceState
}

function fakeHost(initial: WorkspaceState, replies: Map<AgentId, string>): FakeHost {
  const host: FakeHost = {
    state: structuredClone(initial),
    delivered: [],
    replies,
    snapshot: () => structuredClone(host.state),
    execute: async (command) => {
      host.state = mutateWorkspace(host.state, command).state
      return structuredClone(host.state)
    },
    apply: async (mutation) => {
      host.state = mutation(host.state)
      return structuredClone(host.state)
    },
    deliver: async (agentId, _delivery, _recall) => {
      host.delivered.push(agentId)
      return { output: [{ type: 'text', text: host.replies.get(agentId) ?? '' }], stopReason: 'completed' }
    },
    ensureEmployee: async () => ({ agent: { id: 's' } as never, dispose: async () => {} }) as AgentHandle,
  }
  return host
}

const limits = { maxAgentHops: 3, maxRepliesPerRoot: 8, recallCharacterBudget: 4000 }

describe('WorkspaceDispatcher', () => {
  test('records memory for every member but wakes only mentioned agents', async () => {
    const { state, roomId, agentIds } = buildRoom(['alice', 'bob', 'carol'])
    const host = fakeHost(state, new Map())
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', limits)
    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [agentIds[0]!])
    expect(host.delivered).toEqual([agentIds[0]])
    const snap = host.snapshot()
    const messageEvent = snap.events.find(event => event.type === 'room/message')
    expect(messageEvent).toBeDefined()
    for (const agentId of agentIds) {
      expect(snap.memoryEntries.some(entry => entry.agentId === agentId && entry.eventId === messageEvent!.id)).toBe(true)
    }
  })

  test('an agent reply mentioning another agent schedules the next hop', async () => {
    const { state, roomId, agentIds } = buildRoom(['alice', 'bob'])
    const replies = new Map([[agentIds[0]!, `<@${agentIds[1]}> please help`]])
    const host = fakeHost(state, replies)
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', limits)
    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [agentIds[0]!])
    expect(host.delivered).toEqual([agentIds[0], agentIds[1]])
  })

  test('stops the chain with a conversation/stopped event at the hop budget', async () => {
    const { state, roomId, agentIds } = buildRoom(['a', 'b', 'c', 'd'])
    const replies = new Map([
      [agentIds[0]!, `<@${agentIds[1]}>`],
      [agentIds[1]!, `<@${agentIds[2]}>`],
      [agentIds[2]!, `<@${agentIds[3]}>`],
      [agentIds[3]!, `<@${agentIds[0]}>`],
    ])
    const host = fakeHost(state, replies)
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', { ...limits, maxAgentHops: 3 })
    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [agentIds[0]!])
    expect(host.snapshot().events.some(event => event.type === 'conversation/stopped')).toBe(true)
    // depth 1 = a, depth 2 = b, depth 3 = c; the fourth hop (d) is never delivered.
    expect(host.delivered).toEqual([agentIds[0], agentIds[1], agentIds[2]])
  })

  test('runChild records the terminal result into parent memory and never creates an instance', async () => {
    const { state, agentIds } = buildRoom(['alice'])
    const alice = agentIds[0]!
    let taskState = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: alice, title: 'do work' })
    const host = fakeHost(taskState.state, new Map())
    const dispose = vi.fn(async () => {})
    const subagents = {
      start: vi.fn(async () => ({
        result: Promise.resolve({ output: [{ type: 'text', text: 'child result' }], stopReason: 'completed' }),
        dispose,
      })),
    }
    const dispatcher = new WorkspaceDispatcher(host, subagents as unknown as SubagentRuntimeLike, 'spawn', limits)
    const output = await dispatcher.runChild(alice, taskState.taskId, 'do work')
    expect(output).toBe('child result')
    expect(dispose).toHaveBeenCalledTimes(1)
    const snap = host.snapshot()
    expect(snap.childRuns[Object.keys(snap.childRuns)[0]!]!.status).toBe('completed')
    expect(snap.memoryEntries.some(entry => entry.agentId === alice && entry.acquiredBy === 'child-result')).toBe(true)
    // The child is a task-scoped worker, not a top-level colleague or room member.
    expect(Object.keys(snap.agents).length).toBe(1)
    expect(Object.keys(snap.memberships).length).toBe(1)
  })
})
