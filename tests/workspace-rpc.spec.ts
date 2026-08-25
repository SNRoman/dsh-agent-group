import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, HumanId, RoomId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState } from '../packages/host/src/state.ts'
import { createWorkspaceRpcHandler } from '../packages/host/src/rpc.ts'
import { WorkspaceTurnStream } from '../packages/host/src/turn-stream.ts'
import type { WorkspaceCommand, WorkspaceState } from '../packages/host/src/types.ts'

function serviceFixture() {
  let state = createInitialState(WorkspaceId('local'))
  const commands: WorkspaceCommand[] = []
  const posts: Array<{ roomId: string; humanId: string; text: string; mentions: readonly string[] }> = []
  const directOpens: string[] = []
  const stream = new WorkspaceTurnStream()
  return {
    commands,
    posts,
    directOpens,
    stream,
    service: {
      snapshot: (): WorkspaceState => structuredClone(state),
      runtimeStatus: () => ({ rooms: {} }),
      turnStreamSnapshot: () => stream.snapshot(),
      waitForTurnStream: (afterVersion: number, signal: AbortSignal) => stream.wait(afterVersion, signal),
      execute: async (command: WorkspaceCommand): Promise<WorkspaceState> => {
        commands.push(command)
        state = { ...state, revision: state.revision + 1 }
        return structuredClone(state)
      },
      openDirectRoom: async (agentId: AgentId): Promise<{ state: WorkspaceState; roomId: RoomId }> => {
        directOpens.push(agentId)
        state = { ...state, revision: state.revision + 1 }
        return { state: structuredClone(state), roomId: RoomId('room-direct') }
      },
      postHumanMessage: async (roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[]): Promise<WorkspaceState> => {
        posts.push({ roomId, humanId, text, mentions })
        state = { ...state, revision: state.revision + 1 }
        return structuredClone(state)
      },
    },
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

  it('returns the current versioned live turn projection', async () => {
    const fixture = serviceFixture()
    fixture.stream.begin({
      roomId: RoomId('room-1'),
      agentId: AgentId('agent-1'),
      sessionId: SessionId('session-1'),
      turn: 3,
    })
    const handler = createWorkspaceRpcHandler(fixture.service)
    const result = await handler('stream/snapshot', {}, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(expect.objectContaining({
      version: 1,
      turns: [expect.objectContaining({ roomId: 'room-1', agentId: 'agent-1', turn: 3, status: 'running' })],
    }))
  })

  it('long-polls until the live turn projection advances', async () => {
    const fixture = serviceFixture()
    const handler = createWorkspaceRpcHandler(fixture.service)
    const controller = new AbortController()
    const waiting = handler('stream/wait', { afterVersion: 0 }, controller.signal)
    fixture.stream.begin({
      roomId: RoomId('room-2'),
      agentId: AgentId('agent-2'),
      sessionId: SessionId('session-2'),
      turn: 8,
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
    expect(result.error.code).toBe('cancelled')
  })

  it('maps definition creation to the existing durable command boundary', async () => {
    const { service, commands } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('definition/create', {
      name: 'Java 工程师',
      description: '负责服务端开发',
      instructions: '优先保证正确性与可维护性',
    }, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(commands).toEqual([{
      type: 'definition/create',
      name: 'Java 工程师',
      description: '负责服务端开发',
      instructions: '优先保证正确性与可维护性',
    }])
  })

  it('opens or reuses a direct room through the explicit service boundary', async () => {
    const { service, directOpens, commands } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('room/direct/open', { agentId: 'agent-9' }, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(directOpens).toEqual(['agent-9'])
    expect(commands).toEqual([])
    expect(result.value).toEqual(expect.objectContaining({ roomId: 'room-direct' }))
  })

  it('posts room messages through the dispatcher-facing human message method', async () => {
    const { service, posts, commands } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('room/post', {
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

  it('rejects malformed input before reaching the workspace service', async () => {
    const { service, commands, posts } = serviceFixture()
    const handler = createWorkspaceRpcHandler(service)
    const result = await handler('room/join', { roomId: '', agentId: 'agent-1' }, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('bad-request')
    expect(commands).toEqual([])
    expect(posts).toEqual([])
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
