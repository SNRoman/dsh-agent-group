import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceBusinessError } from '../packages/host/src/errors.ts'
import { AgentId, HumanId, RoomId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState } from '../packages/host/src/state.ts'
import { createWorkspaceRpcHandler } from '../packages/host/src/rpc.ts'
import { WorkspaceActivityStream } from '../packages/host/src/activity-stream.ts'
import type { WorkspaceCommand, WorkspaceState } from '../packages/host/src/types.ts'

function serviceFixture() {
  let state = createInitialState(WorkspaceId('local'))
  const commands: WorkspaceCommand[] = []
  const posts: Array<{ roomId: string; humanId: string; text: string; mentions: readonly string[] }> = []
  const directOpens: string[] = []
  const revisions: number[] = []
  const operations: Array<{ readonly name: string; readonly arguments: readonly unknown[] }> = []
  const stream = new WorkspaceActivityStream()
  return {
    commands,
    posts,
    directOpens,
    revisions,
    operations,
    stream,
    service: {
      snapshot: (): WorkspaceState => structuredClone(state),
      runtimeStatus: () => ({ rooms: {} }),
      activitySnapshot: () => stream.snapshot(),
      waitForActivity: (afterVersion: number, signal: AbortSignal) => stream.wait(afterVersion, signal),
      execute: async (expectedRevision: number, command: WorkspaceCommand) => {
        revisions.push(expectedRevision)
        commands.push(command)
        state = { ...state, revision: state.revision + 1 }
        return { revision: state.revision, value: structuredClone(state) }
      },
      openDirectRoom: async (expectedRevision: number, agentId: AgentId) => {
        revisions.push(expectedRevision)
        directOpens.push(agentId)
        state = { ...state, revision: state.revision + 1 }
        return { revision: state.revision, value: { state: structuredClone(state), roomId: RoomId('room-direct') } }
      },
      postHumanMessage: async (expectedRevision: number, roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[]) => {
        revisions.push(expectedRevision)
        posts.push({ roomId, humanId, text, mentions })
        state = { ...state, revision: state.revision + 1 }
        return { revision: state.revision, value: structuredClone(state) }
      },
      assignTask: async (...args: readonly unknown[]) => recordOperation('assignTask', args),
      grantTaskDelegation: async (...args: readonly unknown[]) => recordOperation('grantTaskDelegation', args),
      revokeTaskDelegation: async (...args: readonly unknown[]) => recordOperation('revokeTaskDelegation', args),
      cancelTask: async (...args: readonly unknown[]) => recordOperation('cancelTask', args),
      retryTaskDelivery: async (...args: readonly unknown[]) => recordOperation('retryTaskDelivery', args),
      queryMemory: (...args: readonly unknown[]) => recordRead('queryMemory', args),
      definitionHistory: (...args: readonly unknown[]) => recordRead('definitionHistory', args),
      stopActivity: async (...args: readonly unknown[]) => recordOperation('stopActivity', args),
      stopChildRun: async (...args: readonly unknown[]) => recordOperation('stopChildRun', args),
      acknowledgeAgentFailure: async (...args: readonly unknown[]) => recordOperation('acknowledgeAgentFailure', args),
    },
  }

  function recordOperation(name: string, args: readonly unknown[]) {
    operations.push({ name, arguments: args })
    const expectedRevision = args[0] as number
    revisions.push(expectedRevision)
    state = { ...state, revision: state.revision + 1 }
    return { revision: state.revision, value: { status: 'stopping' as const } }
  }

  function recordRead(name: string, args: readonly unknown[]) {
    operations.push({ name, arguments: args })
    return name === 'definitionHistory' ? [] : { snapshotRevision: state.revision, items: [] }
  }
}

describe('workspace rpc handler', () => {
  it('returns a detached workspace snapshot without mutating it', async () => {
    const { service } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('snapshot', {}, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as WorkspaceState).workspaceId).toBe('local')
  })

  it('returns ephemeral runtime status through its own endpoint', async () => {
    const fixture = serviceFixture()
    fixture.service.runtimeStatus = () => ({ rooms: { 'room-1': { pending: 2 } } })
    const handler = createWorkspaceRpcHandler(fixture.service)
    const result = await handler('runtime/status', {}, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ rooms: { 'room-1': { pending: 2 } } })
  })

  it('returns the current versioned activity projection', async () => {
    const fixture = serviceFixture()
    const messageId = MessageId('message-1')
    const activityId = fixture.stream.queue({
      agentId: AgentId('agent-1'),
      messageId,
      source: { kind: 'room', roomId: RoomId('room-1') },
    })
    fixture.stream.claim({
      activityId,
      agentId: AgentId('agent-1'),
      messageId,
      sessionId: SessionId('session-1'),
      turn: 3,
    })
    const handler = createWorkspaceRpcHandler(fixture.service)
    const result = await handler('stream/snapshot', {}, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(expect.objectContaining({
      version: 2,
      activities: [expect.objectContaining({
        source: { kind: 'room', roomId: 'room-1' }, agentId: 'agent-1', claimed: { sessionId: 'session-1', turn: 3 }, status: 'responding',
      })],
    }))
  })

  it('long-polls until the activity projection advances', async () => {
    const fixture = serviceFixture()
    const handler = createWorkspaceRpcHandler(fixture.service)
    const controller = new AbortController()
    const waiting = handler('stream/wait', { afterVersion: 0 }, controller.signal)
    fixture.stream.queue({
      agentId: AgentId('agent-2'),
      messageId: MessageId('message-2'),
      source: { kind: 'room', roomId: RoomId('room-2') },
    })
    const result = await waiting
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(expect.objectContaining({ version: 1 }))
  })

  it('cancels a pending stream wait without converting it into an internal failure', async () => {
    const fixture = serviceFixture()
    const handler = createWorkspaceRpcHandler(fixture.service)
    const controller = new AbortController()
    const waiting = handler('stream/wait', { afterVersion: 0 }, controller.signal)
    controller.abort()
    const result = await waiting
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('cancelled')
    expect(result.error.code).toBe('cancelled')
  })

  it('does not forward a pre-cancelled mutation to durable or runtime services', async () => {
    const fixture = serviceFixture()
    const controller = new AbortController()
    controller.abort()

    const result = await createWorkspaceRpcHandler(fixture.service)(
      'task/assign',
      { expectedRevision: 0, assigneeAgentId: 'agent-1', title: 'never runs' },
      controller.signal,
    )

    expect(result.ok).toBe(false)
    expect(fixture.commands).toEqual([])
    expect(fixture.operations).toEqual([])
  })

  it('maps definition creation to the existing durable command boundary', async () => {
    const fixture = serviceFixture()
    const handler = createWorkspaceRpcHandler(fixture.service)
    const result = await handler('definition/create', {
      expectedRevision: 0,
      name: 'Java 工程师',
      description: '负责服务端开发',
      instructions: '优先保证正确性与可维护性',
    }, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(expect.objectContaining({ revision: 1 }))
    expect(fixture.revisions).toEqual([0])
    expect(fixture.commands).toEqual([{
      type: 'definition/create',
      name: 'Java 工程师',
      description: '负责服务端开发',
      instructions: '优先保证正确性与可维护性',
    }])
  })

  it.each([
    ['definition/revise', {
      expectedRevision: 11,
      definitionId: 'definition-1',
      description: 'v2',
      instructions: 'new',
      synchronizeAgentIds: ['agent-1'],
    }, {
      type: 'definition/revise',
      definitionId: 'definition-1',
      description: 'v2',
      instructions: 'new',
      synchronizeAgentIds: ['agent-1'],
    }],
    ['definition/synchronize', {
      expectedRevision: 12,
      definitionId: 'definition-1',
      definitionRevisionId: 'definition-revision-2',
      agentIds: ['agent-1'],
    }, {
      type: 'definition/synchronize',
      definitionId: 'definition-1',
      definitionRevisionId: 'definition-revision-2',
      agentIds: ['agent-1'],
    }],
    ['agent/create', { expectedRevision: 13, definitionId: 'definition-1', name: 'Alice' }, {
      type: 'agent/create', definitionId: 'definition-1', name: 'Alice',
    }],
    ['agent/depart', { expectedRevision: 14, agentId: 'agent-1' }, { type: 'agent/depart', agentId: 'agent-1' }],
    ['agent/employ', { expectedRevision: 15, agentId: 'agent-1' }, { type: 'agent/employ', agentId: 'agent-1' }],
    ['room/create', { expectedRevision: 16, kind: 'group', name: 'Engineering' }, {
      type: 'room/create', kind: 'group', name: 'Engineering',
    }],
    ['room/join', {
      expectedRevision: 17,
      roomId: 'room-1',
      agentId: 'agent-1',
      memoryStart: { type: 'new-events' },
    }, {
      type: 'room/join',
      roomId: 'room-1',
      agentId: 'agent-1',
      memoryStart: { type: 'new-events' },
    }],
    ['room/leave', { expectedRevision: 18, membershipId: 'membership-1' }, {
      type: 'room/leave', membershipId: 'membership-1',
    }],
  ] as const)('forwards expectedRevision and branded fields for %s', async (endpoint, payload, expectedCommand) => {
    const fixture = serviceFixture()
    const result = await createWorkspaceRpcHandler(fixture.service)(endpoint, payload, new AbortController().signal)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(expect.objectContaining({ revision: 1 }))
    expect(fixture.revisions).toEqual([payload.expectedRevision])
    expect(fixture.commands).toEqual([expectedCommand])
  })

  it('opens or reuses a direct room through the explicit service boundary', async () => {
    const { service, directOpens, commands, revisions } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('room/direct/open', { expectedRevision: 0, agentId: 'agent-9' }, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(directOpens).toEqual(['agent-9'])
    expect(commands).toEqual([])
    expect(revisions).toEqual([0])
    expect(result.value).toEqual({ revision: 1, value: expect.objectContaining({ roomId: 'room-direct' }) })
  })

  it('posts room messages through the dispatcher-facing human message method', async () => {
    const { service, posts, commands } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('room/post', {
      expectedRevision: 0,
      roomId: 'room-7',
      text: '请 <@agent-9> 看一下这个方案',
      mentions: ['agent-9'],
    }, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(commands).toEqual([])
    expect(posts).toEqual([{
      roomId: 'room-7',
      humanId: 'web-user',
      text: '请 <@agent-9> 看一下这个方案',
      mentions: ['agent-9'],
    }])
  })

  it('maps only typed policy failures to stable business errors', async () => {
    const { service } = serviceFixture()
    service.postHumanMessage = async () => {
      throw new WorkspaceBusinessError('reserved-direct-routing', { roomId: 'room-direct', token: '@all' })
    }
    const result = await createWorkspaceRpcHandler(service)('room/post', {
      expectedRevision: 0,
      roomId: 'room-direct',
      text: '@all hello',
      mentions: [],
    }, new AbortController().signal)

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'business',
        code: 'reserved-direct-routing',
        message: 'reserved-direct-routing',
        details: { roomId: 'room-direct', token: '@all' },
      },
    })
  })

  it('rejects malformed input before reaching the workspace service', async () => {
    const { service, commands, posts } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('room/join', { expectedRevision: 0, roomId: '', agentId: 'agent-1' }, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('bad-request')
    expect(result.error.code).toBe('bad-request')
    expect(commands).toEqual([])
    expect(posts).toEqual([])
  })

  it('rejects a room join that omits the human-selected memory start', async () => {
    const { service, commands } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('room/join', {
      expectedRevision: 0,
      roomId: 'room-1',
      agentId: 'agent-1',
    }, new AbortController().signal)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('bad-request')
    expect(result.error.code).toBe('bad-request')
    expect(result.error.details).toEqual({
      issues: expect.arrayContaining([expect.objectContaining({ path: ['memoryStart'] })]),
    })
    expect(commands).toEqual([])
  })

  it.each([
    ['task/assign', { expectedRevision: 3, assigneeAgentId: 'agent-1', title: 'Ship it' }, 'assignTask', [3, 'web-user', 'agent-1', 'Ship it']],
    ['task/grant', { expectedRevision: 4, granteeAgentId: 'agent-2', rootTaskId: 'task-1' }, 'grantTaskDelegation', [4, 'web-user', 'agent-2', 'task-1']],
    ['task/revoke', { expectedRevision: 5, delegationGrantId: 'grant-1' }, 'revokeTaskDelegation', [5, 'web-user', 'grant-1']],
    ['task/cancel', { expectedRevision: 6, taskId: 'task-1' }, 'cancelTask', [6, 'web-user', 'task-1']],
    ['task/retry-delivery', { expectedRevision: 7, taskId: 'task-1' }, 'retryTaskDelivery', [7, 'task-1']],
    ['runtime/activity/stop', {
      expectedRevision: 8,
      activityId: 'activity-1',
      agentId: 'agent-1',
      messageId: 'message-1',
      sessionId: 'session-1',
      turn: 2,
    }, 'stopActivity', [8, {
      activityId: 'activity-1',
      agentId: 'agent-1',
      messageId: 'message-1',
      sessionId: 'session-1',
      turn: 2,
    }]],
    ['runtime/child/stop', { expectedRevision: 9, childRunId: 'child-run-1' }, 'stopChildRun', [9, 'child-run-1']],
    ['runtime/failure/acknowledge', { expectedRevision: 10, agentId: 'agent-1' }, 'acknowledgeAgentFailure', [10, 'agent-1']],
  ] as const)('maps %s through its named revisioned Host operation', async (endpoint, payload, name, expectedArguments) => {
    const fixture = serviceFixture()
    const result = await createWorkspaceRpcHandler(fixture.service)(endpoint, payload, new AbortController().signal)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(expect.objectContaining({ revision: 1 }))
    expect(fixture.operations).toHaveLength(1)
    expect(fixture.operations[0]?.name).toBe(name)
    expect(fixture.operations[0]?.arguments.slice(0, -1)).toEqual(expectedArguments)
    expect(fixture.operations[0]?.arguments.at(-1)).toBeInstanceOf(AbortSignal)
  })

  it.each([
    ['definition/create', { expectedRevision: 0, name: 'Role', description: '', instructions: '', actorAgentId: 'agent-1' }],
    ['task/assign', { expectedRevision: 0, assigneeAgentId: 'agent-1', title: 'Ship', humanId: 'attacker' }],
    ['room/post', { expectedRevision: 0, roomId: 'room-1', text: 'hello', mentions: [], actor: { type: 'agent', id: 'agent-1' } }],
    ['runtime/child/stop', { expectedRevision: 0, childRunId: 'child-1', extra: true }],
  ] as const)('strictly rejects extra actor or control fields for %s', async (endpoint, payload) => {
    const fixture = serviceFixture()
    const result = await createWorkspaceRpcHandler(fixture.service)(endpoint, payload, new AbortController().signal)

    expect(result.ok).toBe(false)
    expect(fixture.commands).toEqual([])
    expect(fixture.operations).toEqual([])
  })

  it.each([
    ['definition/create', { name: 'Role', description: '', instructions: '' }],
    ['definition/revise', { definitionId: 'definition-1', description: '', instructions: '' }],
    ['definition/synchronize', { definitionId: 'definition-1', definitionRevisionId: 'revision-1', agentIds: ['agent-1'] }],
    ['agent/create', { definitionId: 'definition-1', name: 'Alice' }],
    ['agent/depart', { agentId: 'agent-1' }],
    ['agent/employ', { agentId: 'agent-1' }],
    ['room/create', { kind: 'group' }],
    ['room/direct/open', { agentId: 'agent-1' }],
    ['room/join', { roomId: 'room-1', agentId: 'agent-1', memoryStart: { type: 'new-events' } }],
    ['room/leave', { membershipId: 'membership-1' }],
    ['room/post', { roomId: 'room-1', text: 'hello', mentions: [] }],
    ['task/assign', { assigneeAgentId: 'agent-1', title: 'Ship' }],
    ['task/grant', { granteeAgentId: 'agent-1', rootTaskId: 'task-1' }],
    ['task/revoke', { delegationGrantId: 'grant-1' }],
    ['task/cancel', { taskId: 'task-1' }],
    ['task/retry-delivery', { taskId: 'task-1' }],
    ['runtime/activity/stop', {
      activityId: 'activity-1', agentId: 'agent-1', messageId: 'message-1', sessionId: 'session-1', turn: 1,
    }],
    ['runtime/child/stop', { childRunId: 'child-1' }],
    ['runtime/failure/acknowledge', { agentId: 'agent-1' }],
  ] as const)('requires a numeric expectedRevision before invoking %s', async (endpoint, fields) => {
    const fixture = serviceFixture()
    const result = await createWorkspaceRpcHandler(fixture.service)(
      endpoint,
      { expectedRevision: '0', ...fields },
      new AbortController().signal,
    )

    expect(result.ok).toBe(false)
    expect(fixture.commands).toEqual([])
    expect(fixture.posts).toEqual([])
    expect(fixture.directOpens).toEqual([])
    expect(fixture.operations).toEqual([])
  })

  it('maps memory filters and definition history through detached read operations', async () => {
    const fixture = serviceFixture()
    const handler = createWorkspaceRpcHandler(fixture.service)
    const memory = await handler('memory/query', {
      agentId: 'agent-1',
      snapshotRevision: 0,
      sourceKind: 'task',
      sourceId: 'task-1',
      provenance: 'task',
      eventTypes: ['task/assigned'],
      minimumSequence: 1,
      maximumSequence: 7,
      text: 'ship',
      limit: 20,
      cursor: 'opaque',
    }, new AbortController().signal)
    const history = await handler('definition/history', { definitionId: 'definition-1' }, new AbortController().signal)

    expect(memory.ok).toBe(true)
    expect(history.ok).toBe(true)
    expect(fixture.operations).toEqual([
      { name: 'queryMemory', arguments: [{
        agentId: 'agent-1', snapshotRevision: 0, sourceKind: 'task', sourceId: 'task-1', provenance: 'task',
        eventTypes: ['task/assigned'], minimumSequence: 1, maximumSequence: 7, text: 'ship', limit: 20, cursor: 'opaque',
      }] },
      { name: 'definitionHistory', arguments: ['definition-1'] },
    ])
  })

  it('exposes the activity snapshot and cancellation-aware wait under the runtime names', async () => {
    const fixture = serviceFixture()
    const handler = createWorkspaceRpcHandler(fixture.service)
    const snapshot = await handler('runtime/activity/snapshot', {}, new AbortController().signal)
    const waiting = handler('runtime/activity/wait', { afterVersion: 0 }, new AbortController().signal)
    fixture.stream.queue({
      agentId: AgentId('agent-1'),
      messageId: MessageId('message-1'),
      source: { kind: 'room', roomId: RoomId('room-1') },
    })

    expect(snapshot.ok).toBe(true)
    expect((await waiting).ok).toBe(true)
  })

  it('returns stale-revision details verbatim and never invokes a runtime operation', async () => {
    const fixture = serviceFixture()
    fixture.service.cancelTask = async () => {
      throw new WorkspaceBusinessError('stale-revision', { expectedRevision: 2, actualRevision: 3 })
    }
    const result = await createWorkspaceRpcHandler(fixture.service)(
      'task/cancel',
      { expectedRevision: 2, taskId: 'task-1' },
      new AbortController().signal,
    )

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'business',
        code: 'stale-revision',
        message: 'stale-revision',
        details: { expectedRevision: 2, actualRevision: 3 },
      },
    })
    expect(fixture.operations).toEqual([])
  })

  it('maps unexpected exceptions to a display-safe internal error', async () => {
    const { service } = serviceFixture()
    service.execute = async () => {
      throw new Error('sensitive backend failure')
    }
    const result = await createWorkspaceRpcHandler(service)('agent/create', {
      expectedRevision: 0,
      definitionId: 'definition-1',
      name: 'Alice',
    }, new AbortController().signal)

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'internal',
        code: 'internal',
        message: 'agent workspace request failed',
        details: {},
      },
    })
  })

  it('does not expose an arbitrary mutation endpoint', async () => {
    const { service, commands } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('apply', { anything: true }, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('bad-request')
    expect(commands).toEqual([])
  })
})
