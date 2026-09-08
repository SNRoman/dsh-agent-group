import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, RoomId, TaskDeliveryAttemptId, TaskId } from '../packages/host/src/ids.ts'
import { WorkspaceActivityStream } from '../packages/host/src/activity-stream.ts'
import type { WorkspaceActivityIdentity, WorkspaceActivitySource } from '../packages/host/src/activity-stream.ts'

const roomId = RoomId('room-1')
const taskId = TaskId('task-1')
const attemptId = TaskDeliveryAttemptId('attempt-1')
const agentId = AgentId('agent-1')
const sessionId = SessionId('session-1')

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq, time: seq } as unknown as SessionEvent
}

function claimed(
  stream: WorkspaceActivityStream,
  messageId: MessageId,
  turn: number,
  source: WorkspaceActivitySource = { kind: 'room', roomId },
): WorkspaceActivityIdentity {
  const activityId = stream.queue({ agentId, messageId, source })
  const identity = { activityId, agentId, messageId, sessionId, turn }
  stream.claim(identity)
  return identity
}

describe('WorkspaceActivityStream', () => {
  it('keeps a stable queued identity and binds the claimed session turn', () => {
    const stream = new WorkspaceActivityStream()
    const messageId = MessageId('message-1')
    const activityId = stream.queue({ agentId, messageId, source: { kind: 'room', roomId } })

    expect(stream.snapshot().activities).toEqual([{
      activityId,
      agentId,
      source: { kind: 'room', roomId },
      messageId,
      startOrder: 1,
      status: 'queued',
      blocks: [],
    }])

    stream.claim({ activityId, agentId, messageId, sessionId, turn: 7 })
    expect(stream.snapshot().activities[0]).toMatchObject({
      activityId,
      status: 'responding',
      claimed: { sessionId, turn: 7 },
    })
  })

  it('projects room and task deliveries through the same monotonic stream', () => {
    const stream = new WorkspaceActivityStream()
    const roomActivityId = stream.queue({
      agentId,
      messageId: MessageId('room-message'),
      source: { kind: 'room', roomId },
    })
    const taskActivityId = stream.queue({
      agentId: AgentId('agent-2'),
      messageId: MessageId('task-message'),
      source: { kind: 'task', taskId, attemptId },
    })

    expect(stream.snapshot().activities).toMatchObject([
      { activityId: roomActivityId, source: { kind: 'room', roomId }, startOrder: 1 },
      { activityId: taskActivityId, source: { kind: 'task', taskId, attemptId }, startOrder: 2 },
    ])
  })

  it('rejects a claim whose agent or message differs from the queued activity', () => {
    const stream = new WorkspaceActivityStream()
    const messageId = MessageId('message-claim')
    const activityId = stream.queue({ agentId, messageId, source: { kind: 'room', roomId } })

    expect(() => stream.claim({ activityId, agentId: AgentId('other'), messageId, sessionId, turn: 1 })).toThrow(/agent/i)
    expect(() => stream.claim({
      activityId,
      agentId,
      messageId: MessageId('other-message'),
      sessionId,
      turn: 1,
    })).toThrow(/message/i)
    expect(stream.snapshot().activities[0]).toMatchObject({ status: 'queued' })
  })

  it('folds responding content, running tools, stopping and settlement', () => {
    const stream = new WorkspaceActivityStream()
    const identity = claimed(stream, MessageId('message-lifecycle'), 3)

    stream.acceptSessionEvent({ ...identity, event: event('assistant/chunk', {
      turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: '你好' },
    }, 1) })
    stream.acceptSessionEvent({ ...identity, event: event('tool/call', {
      turn: 3, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"a.md"}',
    }, 2) })
    expect(stream.snapshot().agents).toContainEqual({ agentId, status: 'active', usingTool: true })

    stream.markStopping(identity)
    expect(stream.snapshot().activities[0]).toMatchObject({ status: 'stopping' })

    stream.acceptSessionEvent({ ...identity, event: event('tool/result', {
      turn: 3,
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file body' }] }],
      },
    }, 3) })
    stream.acceptSessionEvent({ ...identity, event: event('turn/end', {
      turn: 3, reason: { kind: 'completed' },
    }, 4) })

    expect(stream.snapshot().activities[0]).toMatchObject({
      status: 'settled',
      terminalReason: 'completed',
      blocks: [
        { kind: 'text', index: 0, text: '你好' },
        { kind: 'tool', index: 1, callId: 'call-1', status: 'completed', resultText: 'file body' },
      ],
    })
    expect(stream.snapshot().agents).toContainEqual({ agentId, status: 'idle', usingTool: false })
  })

  it('keeps process failures until acknowledgement without exposing unsafe error fields', () => {
    const stream = new WorkspaceActivityStream()
    const identity = claimed(stream, MessageId('message-failed'), 4)
    stream.acceptSessionEvent({ ...identity, event: event('turn/end', {
      turn: 4,
      reason: {
        kind: 'error',
        error: { code: 'MODEL_ERROR', message: 'provider failed', env: { API_KEY: 'secret' }, host: { handle: true } },
      },
    }, 1) })
    stream.retire(identity)

    const failed = stream.snapshot()
    expect(failed.activities).toEqual([])
    expect(failed.agents).toContainEqual({
      agentId,
      status: 'failed',
      usingTool: false,
      error: { code: 'MODEL_ERROR', summary: 'provider failed' },
    })
    expect(JSON.stringify(failed)).not.toContain('secret')
    expect(JSON.stringify(failed)).not.toContain('handle')

    stream.acknowledgeAgentFailure(agentId)
    expect(stream.snapshot().agents).toContainEqual({ agentId, status: 'idle', usingTool: false })
  })

  it('replaces task-delivery failures from each durable workspace projection', () => {
    const stream = new WorkspaceActivityStream()
    stream.setWorkspaceProjection(9, [agentId], [{
      agentId,
      error: { code: 'task-delivery-failed', summary: 'inbox rejected the task' },
    }])
    expect(stream.snapshot()).toMatchObject({
      workspaceRevision: 9,
      agents: [{
        agentId,
        status: 'failed',
        usingTool: false,
        error: { code: 'task-delivery-failed', summary: 'inbox rejected the task' },
      }],
    })

    stream.setWorkspaceProjection(10, [agentId], [])
    expect(stream.snapshot()).toMatchObject({
      workspaceRevision: 10,
      agents: [{ agentId, status: 'idle', usingTool: false }],
    })
  })

  it('retires settled activities within the configured bound', () => {
    const stream = new WorkspaceActivityStream({ settledLimit: 2 })
    for (let turn = 1; turn <= 3; turn++) {
      const identity = claimed(stream, MessageId(`message-${turn}`), turn)
      stream.acceptSessionEvent({ ...identity, event: event('turn/end', {
        turn, reason: { kind: 'completed' },
      }, turn) })
    }

    expect(stream.snapshot().activities.map(activity => activity.messageId)).toEqual([
      MessageId('message-2'),
      MessageId('message-3'),
    ])
  })

  it('waits for a version change and cancels only the pending observer', async () => {
    const stream = new WorkspaceActivityStream()
    const before = stream.snapshot()
    const waiting = stream.wait(before.version, new AbortController().signal)
    stream.queue({ agentId, messageId: MessageId('message-wait'), source: { kind: 'room', roomId } })
    const changed = await waiting
    expect(changed.version).toBeGreaterThan(before.version)

    const controller = new AbortController()
    const pending = stream.wait(changed.version, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(stream.snapshot()).toEqual(changed)
  })
})
