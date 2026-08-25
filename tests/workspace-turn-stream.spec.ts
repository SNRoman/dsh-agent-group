import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, RoomId } from '../packages/host/src/ids.ts'
import { WorkspaceTurnStream } from '../packages/host/src/turn-stream.ts'

const roomId = RoomId('room-1')
const agentId = AgentId('agent-1')
const sessionId = SessionId('session-1')

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq, time: seq } as unknown as SessionEvent
}

describe('WorkspaceTurnStream', () => {
  it('folds authoritative assistant chunks into one growing turn', () => {
    const stream = new WorkspaceTurnStream()
    stream.begin({ roomId, agentId, sessionId, turn: 1 })
    stream.acceptSessionEvent({ roomId, agentId, sessionId, event: event('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你好' },
    }, 1) })
    stream.acceptSessionEvent({ roomId, agentId, sessionId, event: event('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '，世界' },
    }, 2) })
    stream.acceptSessionEvent({ roomId, agentId, sessionId, event: event('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: '分析中' },
    }, 3) })

    const turn = stream.snapshot().turns[0]
    expect(turn).toMatchObject({ roomId, agentId, sessionId, turn: 1, status: 'running' })
    expect(turn?.blocks).toEqual([
      { kind: 'text', index: 0, text: '你好，世界' },
      { kind: 'reasoning', index: 1, text: '分析中' },
    ])
  })

  it('projects running tool calls and settles them with their tool result', () => {
    const stream = new WorkspaceTurnStream()
    stream.begin({ roomId, agentId, sessionId, turn: 2 })
    stream.acceptSessionEvent({ roomId, agentId, sessionId, event: event('assistant/chunk', {
      turn: 2, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read_file', argumentsDelta: '{"path":' },
    }, 1) })
    stream.acceptSessionEvent({ roomId, agentId, sessionId, event: event('assistant/chunk', {
      turn: 2, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: '"a.md"}' },
    }, 2) })
    stream.acceptSessionEvent({ roomId, agentId, sessionId, event: event('tool/call', {
      turn: 2, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"a.md"}',
    }, 3) })
    stream.acceptSessionEvent({ roomId, agentId, sessionId, event: event('tool/result', {
      turn: 2,
      step: 1,
      message: {
        id: 'message-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file body' }], isError: false }],
      },
    }, 4) })

    expect(stream.snapshot().turns[0]?.blocks).toEqual([
      {
        kind: 'tool', index: 0, callId: 'call-1', name: 'read_file', arguments: '{"path":"a.md"}',
        status: 'completed', resultText: 'file body',
      },
    ])
  })

  it('settles a turn with display-safe error information', () => {
    const stream = new WorkspaceTurnStream()
    stream.begin({ roomId, agentId, sessionId, turn: 3 })
    stream.acceptSessionEvent({ roomId, agentId, sessionId, event: event('turn/end', {
      turn: 3, reason: { kind: 'error', error: { code: 'MODEL_ERROR', message: 'provider failed' } },
    }, 1) })
    expect(stream.snapshot().turns[0]).toMatchObject({
      status: 'settled', stopReason: 'error', error: 'provider failed',
    })
  })

  it('waits for a version change instead of interval polling and supports retirement', async () => {
    const stream = new WorkspaceTurnStream()
    const before = stream.snapshot()
    const pending = stream.wait(before.version, new AbortController().signal)
    stream.begin({ roomId, agentId, sessionId, turn: 4 })
    const changed = await pending
    expect(changed.version).toBeGreaterThan(before.version)
    expect(changed.turns).toHaveLength(1)

    stream.retire({ roomId, agentId, sessionId, turn: 4 }, 12)
    const retired = stream.snapshot()
    expect(retired.workspaceRevision).toBe(12)
    expect(retired.turns).toEqual([])
  })

  it('cancels a pending wait through AbortSignal', async () => {
    const stream = new WorkspaceTurnStream()
    const controller = new AbortController()
    const pending = stream.wait(stream.snapshot().version, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
