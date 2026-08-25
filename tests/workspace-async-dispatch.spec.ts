import { describe, expect, test } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentId, HumanId, RoomId, WorkspaceId } from '../packages/host/src/ids.ts'
import { WorkspaceDispatcher } from '../packages/host/src/dispatcher.ts'
import type { WorkspaceDispatcherHost } from '../packages/host/src/dispatcher.ts'
import { createWorkspaceRpcHandler } from '../packages/host/src/rpc.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import type { WorkspaceCommand, WorkspaceState } from '../packages/host/src/types.ts'

function oneAgentRoom(): {
  state: WorkspaceState
  roomId: RoomId
  agentId: AgentId
} {
  let state = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(state, {
    type: 'definition/create',
    name: 'Worker',
    description: 'worker',
    instructions: 'reply',
  })
  state = definition.state
  const agent = mutateWorkspace(state, {
    type: 'agent/create',
    definitionId: definition.definitionId,
    name: 'alice',
  })
  state = agent.state
  const room = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: 'room' })
  state = room.state
  state = mutateWorkspace(state, {
    type: 'room/join',
    roomId: room.roomId,
    agentId: agent.agentId,
    memoryStart: { type: 'new-events' },
  }).state
  return { state, roomId: room.roomId, agentId: agent.agentId }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('non-blocking browser workspace dispatch', () => {
  test('persists the human message before returning a separately awaitable agent chain', async () => {
    const built = oneAgentRoom()
    const gate = deferred()
    const host: WorkspaceDispatcherHost & { state: WorkspaceState } = {
      state: structuredClone(built.state),
      snapshot() {
        return structuredClone(this.state)
      },
      async execute(command: WorkspaceCommand) {
        this.state = mutateWorkspace(this.state, command).state
        return structuredClone(this.state)
      },
      async apply(mutation) {
        this.state = mutation(this.state)
        return structuredClone(this.state)
      },
      async deliver(_agentId: AgentId, _delivery: UserMessage, _recall?: UserMessage) {
        await gate.promise
        return { output: [{ type: 'text' as const, text: 'done' }], stopReason: 'completed' }
      },
      async ensureEmployee() {
        return { agent: { id: 'session' } as never, dispose: async () => {} } as AgentHandle
      },
    }
    const dispatcher = new WorkspaceDispatcher(
      host,
      undefined,
      'spawn',
      { maxAgentHops: 3, maxRepliesPerRoot: 8, recallCharacterBudget: 4000 },
    )

    const started = await dispatcher.startHumanMessage(
      built.roomId,
      HumanId('web-user'),
      'hello',
      [built.agentId],
    )

    expect(started.state.events.some(event => event.type === 'room/message' && event.actor?.type === 'human')).toBe(true)
    let settled = false
    void started.completion.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    gate.resolve()
    await started.completion
    expect(host.snapshot().events.some(event => event.type === 'room/message' && event.actor?.type === 'agent' && event.text === 'done')).toBe(true)
  })

  test('exposes ephemeral dispatch status without overloading the durable workspace snapshot', async () => {
    let state = createInitialState(WorkspaceId('local'))
    const handler = createWorkspaceRpcHandler({
      snapshot: () => structuredClone(state),
      execute: async (command: WorkspaceCommand) => {
        state = { ...state, revision: state.revision + 1 }
        void command
        return structuredClone(state)
      },
      postHumanMessage: async () => structuredClone(state),
      runtimeStatus: () => ({ rooms: { 'room-1': { pending: 1 } } }),
    })

    const result = await handler('runtime/status', {}, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ rooms: { 'room-1': { pending: 1 } } })
  })
})
