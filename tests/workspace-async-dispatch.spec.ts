import { describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, HumanId, RoomId, WorkspaceId } from '../packages/host/src/ids.ts'
import { WorkspaceDispatcher } from '../packages/host/src/dispatcher.ts'
import type { WorkspaceDispatcherHost } from '../packages/host/src/dispatcher.ts'
import { createWorkspaceRpcHandler } from '../packages/host/src/rpc.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import type { WorkspaceCommand, WorkspaceState } from '../packages/host/src/types.ts'
import { assignHumanTask } from '../packages/host/src/tasks.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'
import type { TaskDeliveryCoordinatorHost } from '../packages/host/src/task-delivery-coordinator.ts'

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
        return {
          output: [{ type: 'text' as const, text: 'done' }],
          stopReason: { kind: 'completed' as const },
          interrupted: false,
        }
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

  test('a resumed employee finishes recovery before accepting a new task delivery', async () => {
    const built = oneAgentRoom()
    const assigned = assignHumanTask(built.state, {
      humanId: HumanId('owner'),
      assigneeAgentId: built.agentId,
      title: 'after restart',
    })
    let state = assigned.state
    const recoveryEntered = deferred()
    const releaseRecovery = deferred()
    const delivered = deferred()
    const handle = { agent: { id: SessionId('persisted-session') } as never, dispose: async () => {} } as AgentHandle
    let resumePublished = false
    const pool = new EmployeeAgentPool(
      {
        create: async () => handle,
        resume: async options => {
          await options.setup?.({ agent: handle.agent } as Context)
          resumePublished = true
          return handle
        },
      },
      {
        sessionIdFor: () => SessionId('persisted-session'),
        recordSessionId: async () => {},
      },
      undefined,
      async () => {
        recoveryEntered.resolve()
        expect(resumePublished).toBe(false)
        await releaseRecovery.promise
      },
    )
    const host: TaskDeliveryCoordinatorHost = {
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      ensureEmployee: async agentId => await pool.ensure(agentId),
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        delivered.resolve()
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'done' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    }
    const coordinator = new TaskDeliveryCoordinator(host)

    const pending = coordinator.deliver(assigned.taskId)
    await recoveryEntered.promise
    expect(state.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(0)
    let woke = false
    void delivered.promise.then(() => { woke = true })
    await Promise.resolve()
    expect(woke).toBe(false)

    releaseRecovery.resolve()
    await expect(pending).resolves.toBe('done')
    expect(state.events.filter(event => event.type === 'task/result')).toHaveLength(1)
  })
})
