import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, HumanId, RoomId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignHumanTask } from '../packages/host/src/tasks.ts'
import { WorkspaceDispatcher } from '../packages/host/src/dispatcher.ts'
import type { WorkspaceDispatcherHost, SubagentRuntimeLike } from '../packages/host/src/dispatcher.ts'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'
import { WorkspaceTurnStream } from '../packages/host/src/turn-stream.ts'
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

function buildRoleRoom(): { state: WorkspaceState; roomId: ReturnType<typeof RoomId>; productId: ReturnType<typeof AgentId>; architectId: ReturnType<typeof AgentId> } {
  let state = createInitialState(WorkspaceId('roles'))
  const productDefinition = mutateWorkspace(state, {
    type: 'definition/create', name: '产品经理', description: 'product', instructions: 'i',
  })
  state = productDefinition.state
  const architectDefinition = mutateWorkspace(state, {
    type: 'definition/create', name: '系统架构师', description: 'architecture', instructions: 'i',
  })
  state = architectDefinition.state
  const product = mutateWorkspace(state, {
    type: 'agent/create', definitionId: productDefinition.definitionId, name: '张产品',
  })
  state = product.state
  const architect = mutateWorkspace(state, {
    type: 'agent/create', definitionId: architectDefinition.definitionId, name: '老周',
  })
  state = architect.state
  const room = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: '产品研发群' })
  state = room.state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: product.agentId, memoryStart: { type: 'new-events' } }).state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: architect.agentId, memoryStart: { type: 'new-events' } }).state
  return { state, roomId: room.roomId, productId: product.agentId, architectId: architect.agentId }
}

interface RetiredTurn {
  readonly roomId: ReturnType<typeof RoomId>
  readonly agentId: ReturnType<typeof AgentId>
  readonly sessionId: string
  readonly turn: number
  readonly workspaceRevision: number
}

interface FakeHost extends WorkspaceDispatcherHost {
  delivered: AgentId[]
  replies: Map<AgentId, string>
  state: WorkspaceState
  retired: RetiredTurn[]
  retireWorkspaceTurn(input: Omit<RetiredTurn, 'workspaceRevision'>, workspaceRevision: number): void
}

function fakeHost(initial: WorkspaceState, replies: Map<AgentId, string>): FakeHost {
  const host: FakeHost = {
    state: structuredClone(initial),
    delivered: [],
    replies,
    retired: [],
    snapshot: () => structuredClone(host.state),
    execute: async (command, settledTurn) => {
      host.state = mutateWorkspace(host.state, command).state
      if (settledTurn !== undefined) host.retireWorkspaceTurn(settledTurn, host.state.revision)
      return structuredClone(host.state)
    },
    apply: async (mutation) => {
      host.state = mutation(host.state)
      return structuredClone(host.state)
    },
    deliver: async (agentId, _delivery, _recall, roomId) => {
      host.delivered.push(agentId)
      return {
        output: [{ type: 'text', text: host.replies.get(agentId) ?? '' }],
        stopReason: { kind: 'completed' },
        interrupted: false,
        ...(roomId === undefined
          ? {}
          : {
              workspaceTurn: {
                roomId,
                agentId,
                sessionId: `session-${agentId}` as never,
                turn: host.delivered.length,
              },
            }),
      }
    },
    retireWorkspaceTurn: (input, workspaceRevision) => {
      host.retired.push({ ...input, sessionId: String(input.sessionId), workspaceRevision })
    },
    ensureEmployee: async () => ({ agent: { id: 's' } as never, dispose: async () => {} }) as AgentHandle,
  }
  return host
}

const limits = { maxAgentHops: 3, maxRepliesPerRoot: 8, recallCharacterBudget: 4000 }

function trackerEvents(): {
  readonly context: Context
  readonly emit: (event: string, ...args: unknown[]) => void
} {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  return {
    context: {
      on: (event: string, listener: (...args: never[]) => unknown) => {
        const current = listeners.get(event) ?? []
        current.push(listener)
        listeners.set(event, current)
        return () => {}
      },
    } as unknown as Context,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...(args as never[]))
    },
  }
}

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

  test('retires a streamed turn only after its durable agent reply is committed', async () => {
    const { state, roomId, agentIds } = buildRoom(['alice'])
    const alice = agentIds[0]!
    const host = fakeHost(state, new Map([[alice, '**done**']]))
    const dispatcher = new WorkspaceDispatcher(host, undefined, 'spawn', limits)

    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [alice])

    const messages = host.snapshot().events.filter(event => event.type === 'room/message' && event.subjectId === roomId)
    expect(messages.at(-1)?.actor).toEqual({ type: 'agent', id: alice })
    expect(messages.at(-1)?.text).toBe('**done**')
    expect(host.retired).toEqual([expect.objectContaining({
      roomId,
      agentId: alice,
      sessionId: `session-${alice}`,
      turn: 1,
      workspaceRevision: host.snapshot().revision,
    })])
  })

  test('records one durable reply when the same terminal notification is observed twice', async () => {
    const { state, roomId, agentIds } = buildRoom(['alice'])
    const alice = agentIds[0]!
    const host = fakeHost(state, new Map())
    const events = trackerEvents()
    const stream = new WorkspaceTurnStream()
    const tracker = new WorkspaceTurnTracker({
      agentId: alice,
      sessionId: SessionId('alice-session'),
      stream,
    })
    tracker.install(events.context)
    const claimed = Promise.withResolvers<UserMessage>()
    const agent = {
      followup: (delivery: UserMessage) => claimed.resolve(delivery),
    } as unknown as Agent
    host.deliver = async (_agentId, delivery, recall, deliveredRoomId) => (
      await tracker.deliver(agent, delivery, recall, deliveredRoomId)
    )
    const dispatcher = new WorkspaceDispatcher(host, undefined, 'spawn', limits)

    const posted = dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [alice])
    const delivery = await claimed.promise
    events.emit('agent/inbox/claimed', { message: delivery, turn: 8 })
    events.emit('session/event', {}, {
      type: 'assistant/message',
      data: { turn: 8, step: 1, message: { content: [{ type: 'text', text: 'done' }] } },
    })
    const terminal = { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } }
    events.emit('session/event', {}, terminal)
    events.emit('session/event', {}, terminal)
    await posted

    const agentReplies = host.snapshot().events.filter(event => event.type === 'room/message' && event.actor?.type === 'agent')
    expect(agentReplies).toHaveLength(1)
    expect(agentReplies[0]?.text).toBe('done')
    expect(host.retired).toEqual([expect.objectContaining({
      roomId,
      agentId: alice,
      sessionId: 'alice-session',
      turn: 8,
    })])
  })

  test('retires an aborted partial turn without recording its reply or downstream mentions', async () => {
    const { state, roomId, agentIds } = buildRoom(['alice', 'bob'])
    const alice = agentIds[0]!
    const bob = agentIds[1]!
    const host = fakeHost(state, new Map())
    host.deliver = async (agentId, _delivery, _recall, deliveredRoomId) => {
      host.delivered.push(agentId)
      return {
        output: [{ type: 'text', text: `partial <@${bob}>` }],
        stopReason: { kind: 'aborted', reason: { kind: 'user' } },
        interrupted: true,
        workspaceTurn: {
          roomId: deliveredRoomId,
          agentId,
          sessionId: `session-${agentId}`,
          turn: 7,
        },
      } as never
    }
    const dispatcher = new WorkspaceDispatcher(host, undefined, 'spawn', limits)

    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [alice])

    const messages = host.snapshot().events.filter(event => event.type === 'room/message' && event.subjectId === roomId)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.actor).toEqual({ type: 'human', id: HumanId('owner') })
    expect(host.delivered).toEqual([alice])
    expect(host.retired).toEqual([expect.objectContaining({
      roomId,
      agentId: alice,
      sessionId: `session-${alice}`,
      turn: 7,
      workspaceRevision: host.snapshot().revision,
    })])
  })

  test('records nonblank output when the successful turn reaches its token ceiling', async () => {
    const { state, roomId, agentIds } = buildRoom(['alice'])
    const alice = agentIds[0]!
    const host = fakeHost(state, new Map())
    host.deliver = async (agentId, _delivery, _recall, deliveredRoomId) => {
      host.delivered.push(agentId)
      return {
        output: [{ type: 'text', text: 'usable capped reply' }],
        stopReason: { kind: 'max-tokens' },
        interrupted: false,
        workspaceTurn: {
          roomId: deliveredRoomId,
          agentId,
          sessionId: `session-${agentId}`,
          turn: 9,
        },
      } as never
    }
    const dispatcher = new WorkspaceDispatcher(host, undefined, 'spawn', limits)

    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [alice])

    const agentReplies = host.snapshot().events.filter(event => event.type === 'room/message' && event.actor?.type === 'agent')
    expect(agentReplies).toHaveLength(1)
    expect(agentReplies[0]?.text).toBe('usable capped reply')
    expect(host.retired).toHaveLength(1)
  })

  test('an agent reply mentioning another agent by canonical id schedules the next hop', async () => {
    const { state, roomId, agentIds } = buildRoom(['alice', 'bob'])
    const replies = new Map([[agentIds[0]!, `<@${agentIds[1]}> please help`]])
    const host = fakeHost(state, replies)
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', limits)
    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [agentIds[0]!])
    expect(host.delivered).toEqual([agentIds[0], agentIds[1]])
  })

  test('an agent reply mentioning another active member by display name schedules the next hop', async () => {
    const { state, roomId, agentIds } = buildRoom(['alice', 'bob'])
    const replies = new Map([[agentIds[0]!, '@bob please help']])
    const host = fakeHost(state, replies)
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', limits)
    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [agentIds[0]!])
    expect(host.delivered).toEqual([agentIds[0], agentIds[1]])
  })

  test('an agent reply mentioning a unique role name schedules that room member', async () => {
    const { state, roomId, productId, architectId } = buildRoleRoom()
    const replies = new Map([[productId, '@系统架构师 请继续做架构设计。']])
    const host = fakeHost(state, replies)
    const dispatcher = new WorkspaceDispatcher(host, { start: vi.fn() } as unknown as SubagentRuntimeLike, 'spawn', limits)
    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [productId])
    expect(host.delivered).toEqual([productId, architectId])
  })

  test('ordinary room mentions do not require the optional one-shot subagent runtime', async () => {
    const { state, roomId, agentIds } = buildRoom(['alice'])
    const host = fakeHost(state, new Map([[agentIds[0]!, 'done']]))
    const dispatcher = new WorkspaceDispatcher(host, undefined, 'spawn', limits)
    await dispatcher.postHumanMessage(roomId, HumanId('owner'), 'hello', [agentIds[0]!])
    expect(host.delivered).toEqual([agentIds[0]])
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
    const taskState = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: alice, title: 'do work' })
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

  test('runChild reports a clear capability error when the optional subagent runtime is absent', async () => {
    const { state, agentIds } = buildRoom(['alice'])
    const alice = agentIds[0]!
    const taskState = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: alice, title: 'do work' })
    const host = fakeHost(taskState.state, new Map())
    const dispatcher = new WorkspaceDispatcher(host, undefined, 'spawn', limits)
    await expect(dispatcher.runChild(alice, taskState.taskId, 'do work')).rejects.toThrow(/subagent runtime is not available/i)
  })
})
