import { describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { MessageId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceActivityController } from '../packages/host/src/activity-controller.ts'
import { WorkspaceActivityStream } from '../packages/host/src/activity-stream.ts'
import type { WorkspaceActivityIdentity } from '../packages/host/src/activity-stream.ts'
import { AgentId, HumanId, RoomId, WorkspaceActivityId, WorkspaceId } from '../packages/host/src/ids.ts'
import AgentWorkspaceDomainService, { LOCAL_WORKSPACE_ID } from '../packages/host/src/index.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import {
  assignDelegatedTask,
  assignHumanTask,
  grantTaskDelegation,
  recordChildRunStarted,
} from '../packages/host/src/tasks.ts'
import { acceptTaskDelivery, startTaskDelivery } from '../packages/host/src/task-delivery.ts'
import type { ChildControllerRegistry } from '../packages/host/src/child-controller.ts'
import type { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'

function activeFixture(): {
  readonly controller: WorkspaceActivityController
  readonly stream: WorkspaceActivityStream
  readonly identity: WorkspaceActivityIdentity
  readonly cancel: ReturnType<typeof vi.fn>
  readonly queued: ReturnType<typeof createUserMessage>
  readonly pending: () => readonly ReturnType<typeof createUserMessage>[]
} {
  const agentId = AgentId('alice')
  const messageId = MessageId('delivery-1')
  const sessionId = SessionId('session-1')
  const stream = new WorkspaceActivityStream()
  const activityId = stream.queue({
    agentId,
    messageId,
    source: { kind: 'room', roomId: RoomId('room-1') },
  })
  const identity = { activityId, agentId, messageId, sessionId, turn: 4 }
  stream.claim(identity)

  const queued = createUserMessage({
    id: MessageId('unrelated'),
    content: [{ type: 'text', text: 'unrelated queued work' }],
    source: { kind: 'test' },
  })
  const inbox = [queued]
  const cancel = vi.fn((_cause, options?: { keepInbox?: boolean }) => {
    if (options?.keepInbox !== true) inbox.splice(0)
  })
  const agent = {
    id: sessionId,
    session: { header: { id: sessionId } },
    inbox: {
      get nextTurn() { return inbox },
      get nextStep() { return [] },
    },
    cancel,
  } as unknown as Agent
  const handle = { agent, dispose: async () => {} } satisfies AgentHandle
  const controller = new WorkspaceActivityController(stream, {
    handleFor: candidate => candidate === agentId ? handle : undefined,
  })
  return { controller, stream, identity, cancel, queued, pending: () => inbox }
}

describe('WorkspaceActivityController', () => {
  test.each([
    ['activityId', WorkspaceActivityId('another-activity')],
    ['agentId', AgentId('bob')],
    ['messageId', MessageId('another-message')],
    ['sessionId', SessionId('another-session')],
    ['turn', 5],
  ] as const)('does not stop when %s does not match', (field, value) => {
    const { controller, identity, cancel } = activeFixture()

    expect(controller.stopActivity({ ...identity, [field]: value })).toEqual({ status: 'not-active' })
    expect(cancel).not.toHaveBeenCalled()
  })

  test('stops the exact turn once and preserves unrelated queued inbox work', () => {
    const { controller, identity, cancel, queued, pending } = activeFixture()

    expect(controller.stopActivity(identity)).toEqual({ status: 'stopping' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(controller.stopActivity(identity)).toEqual({ status: 'already-stopping' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(pending()).toEqual([queued])
  })

  test('does not let an earlier turn identity stop a later turn that reused the session', () => {
    const { controller, stream, identity, cancel } = activeFixture()
    stream.acceptSessionEvent({
      ...identity,
      event: { type: 'turn/end', data: { turn: identity.turn, reason: { kind: 'completed' } } },
    })
    const laterMessageId = MessageId('delivery-2')
    const laterActivityId = stream.queue({
      agentId: identity.agentId,
      messageId: laterMessageId,
      source: { kind: 'room', roomId: RoomId('room-1') },
    })
    stream.claim({
      activityId: laterActivityId,
      agentId: identity.agentId,
      messageId: laterMessageId,
      sessionId: identity.sessionId,
      turn: identity.turn + 1,
    })

    expect(controller.stopActivity(identity)).toEqual({ status: 'not-active' })
    expect(cancel).not.toHaveBeenCalled()
  })

  test('returns not-active after the exact activity settles', () => {
    const { controller, stream, identity, cancel } = activeFixture()
    stream.acceptSessionEvent({
      ...identity,
      event: { type: 'turn/end', data: { turn: identity.turn, reason: { kind: 'completed' } } },
    })

    expect(controller.stopActivity(identity)).toEqual({ status: 'not-active' })
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('AgentWorkspaceDomainService exact cancellation', () => {
  test('cleans only the queued, active, and child work returned by root task cancellation', async () => {
    let state = createInitialState(WorkspaceId(LOCAL_WORKSPACE_ID))
    const definition = mutateWorkspace(state, {
      type: 'definition/create', name: 'Worker', description: 'd', instructions: 'i',
    })
    state = definition.state
    const alice = mutateWorkspace(state, {
      type: 'agent/create', definitionId: definition.definitionId, name: 'Alice',
    })
    state = alice.state
    const bob = mutateWorkspace(state, {
      type: 'agent/create', definitionId: definition.definitionId, name: 'Bob',
    })
    const root = assignHumanTask(bob.state, {
      humanId: HumanId('owner'), assigneeAgentId: alice.agentId, title: 'root work',
    })
    const granted = grantTaskDelegation(root.state, {
      humanId: HumanId('owner'), granteeAgentId: alice.agentId, rootTaskId: root.taskId,
    })
    const derived = assignDelegatedTask(granted.state, {
      actorAgentId: alice.agentId,
      assigneeAgentId: bob.agentId,
      rootTaskId: root.taskId,
      title: 'derived work',
    })
    const unrelated = assignHumanTask(derived.state, {
      humanId: HumanId('owner'), assigneeAgentId: alice.agentId, title: 'unrelated work',
    })
    const rootDelivery = startTaskDelivery(unrelated.state, { taskId: root.taskId })
    const acceptedRoot = acceptTaskDelivery(rootDelivery.state, {
      taskId: root.taskId,
      attemptId: rootDelivery.attemptId,
      messageId: rootDelivery.message.id,
    })
    const derivedDelivery = startTaskDelivery(acceptedRoot.state, { taskId: derived.taskId })
    const unrelatedDelivery = startTaskDelivery(derivedDelivery.state, { taskId: unrelated.taskId })
    const rootChild = recordChildRunStarted(unrelatedDelivery.state, {
      parentAgentId: alice.agentId, taskId: root.taskId,
    })
    const unrelatedChild = recordChildRunStarted(rootChild.state, {
      parentAgentId: alice.agentId, taskId: unrelated.taskId,
    })
    state = unrelatedChild.state

    const service = new AgentWorkspaceDomainService(new Context())
    const table = {
      get: (id: typeof LOCAL_WORKSPACE_ID) => id === LOCAL_WORKSPACE_ID ? state : undefined,
      update: async (_id: typeof LOCAL_WORKSPACE_ID, mutation: (current: WorkspaceState) => WorkspaceState) => {
        state = mutation(state)
        return state
      },
    }
    const aliceInbox = [unrelatedDelivery.message]
    const bobInbox = [derivedDelivery.message]
    const removed: string[] = []
    const makeHandle = (sessionId: string, inbox: typeof aliceInbox, cancel = vi.fn()): AgentHandle => ({
      agent: {
        id: SessionId(sessionId),
        session: { header: { id: SessionId(sessionId) } },
        inbox: {
          get nextTurn() { return inbox },
          get nextStep() { return [] },
          remove: (messageId: string) => {
            expect(service.snapshot().tasks[root.taskId]?.status).toBe('cancelled')
            const index = inbox.findIndex(message => message.id === messageId)
            if (index < 0) return false
            removed.push(messageId)
            inbox.splice(index, 1)
            return true
          },
        },
        cancel,
      } as unknown as Agent,
      dispose: async () => {},
    })
    const aliceCancel = vi.fn()
    const handles = new Map([
      [alice.agentId, makeHandle('alice-session', aliceInbox, aliceCancel)],
      [bob.agentId, makeHandle('bob-session', bobInbox)],
    ])
    const internals = service as unknown as {
      table: typeof table
      pool: Pick<EmployeeAgentPool, 'handleFor'>
      activityStream: WorkspaceActivityStream
      childControllers: ChildControllerRegistry
    }
    internals.table = table
    internals.pool = { handleFor: agentId => handles.get(agentId) }
    const activityId = internals.activityStream.queue({
      agentId: alice.agentId,
      messageId: rootDelivery.message.id,
      source: { kind: 'task', taskId: root.taskId, attemptId: rootDelivery.attemptId },
    })
    const activity = {
      activityId,
      agentId: alice.agentId,
      messageId: rootDelivery.message.id,
      sessionId: SessionId('alice-session'),
      turn: 3,
    }
    internals.activityStream.claim(activity)
    const rootAbort = vi.fn()
    const unrelatedAbort = vi.fn()
    internals.childControllers.register({
      childRunId: rootChild.childRunId, parentAgentId: alice.agentId, taskId: root.taskId, abort: rootAbort,
    })
    internals.childControllers.register({
      childRunId: unrelatedChild.childRunId, parentAgentId: alice.agentId, taskId: unrelated.taskId, abort: unrelatedAbort,
    })

    await service.cancelTask(HumanId('owner'), root.taskId)

    expect(service.snapshot().tasks[root.taskId]?.status).toBe('cancelled')
    expect(service.snapshot().tasks[derived.taskId]?.status).toBe('cancelled')
    expect(service.snapshot().tasks[unrelated.taskId]?.status).toBe('open')
    expect(removed).toEqual([derivedDelivery.message.id])
    expect(aliceInbox).toEqual([unrelatedDelivery.message])
    expect(bobInbox).toEqual([])
    expect(aliceCancel).toHaveBeenCalledOnce()
    expect(aliceCancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(rootAbort).toHaveBeenCalledOnce()
    expect(unrelatedAbort).not.toHaveBeenCalled()
    expect(service.snapshot().childRuns[rootChild.childRunId]).toMatchObject({ status: 'cancelled' })
    expect(service.snapshot().childRuns[unrelatedChild.childRunId]).toMatchObject({ status: 'running' })
    expect(service.snapshot().events.some(event => event.type === 'task/result' || event.type === 'task/result-after-cancel')).toBe(false)
    expect(service.snapshot().events.some(event => event.type === 'room/message')).toBe(false)

    await expect(service.stopChildRun(unrelatedChild.childRunId)).resolves.toEqual({ status: 'stopping' })
    expect(unrelatedAbort).toHaveBeenCalledOnce()
  })
})
