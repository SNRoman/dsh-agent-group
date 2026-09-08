import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, RoomId } from '../packages/host/src/ids.ts'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'
import { WorkspaceActivityStream } from '../packages/host/src/activity-stream.ts'

function text(value: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
}

interface FakeEvents {
  on: (event: string, listener: (...args: never[]) => unknown) => () => void
  listenerFor: (event: string) => ((...args: never[]) => unknown) | undefined
}

function fakeEvents(): FakeEvents {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  return {
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    listenerFor: event => listeners.get(event),
  }
}

describe('WorkspaceTurnTracker delivery errors', () => {
  test('a synchronous followup failure removes the pending delivery and its recall', async () => {
    const events = fakeEvents()
    const tracker = new WorkspaceTurnTracker()
    tracker.install(events as unknown as Context)
    const delivery = text('deliver')
    const recall = text('stale recall must disappear')
    const agent = {
      followup: vi.fn(() => { throw new Error('followup failed') }),
    } as unknown as Agent

    await expect(tracker.deliver(agent, delivery, recall)).rejects.toThrow(/followup failed/)

    const preStep = events.listenerFor('agent/pre-step')
    if (preStep === undefined) throw new Error('expected pre-step listener')
    const decision = await preStep(
      { messages: [delivery] } as never,
      (async () => ({ kind: 'enter', messages: [delivery] })) as never,
    )
    expect(decision).toEqual({ kind: 'enter', messages: [delivery] })
  })

  test('agent disposal removes a pending correlation once before any late claim', async () => {
    const events = fakeEvents()
    const stream = new WorkspaceActivityStream()
    const tracker = new WorkspaceTurnTracker({
      agentId: AgentId('alice'),
      sessionId: SessionId('alice-session'),
      stream,
    })
    tracker.install(events as unknown as Context)
    const delivery = text('deliver')
    const agent = { followup: vi.fn() } as unknown as Agent
    const outcome = tracker.deliver(agent, delivery, undefined, { kind: 'room', roomId: RoomId('room-1') })
    const disposed = events.listenerFor('agent/disposed')
    if (disposed === undefined) throw new Error('expected agent/disposed listener')

    disposed()
    disposed()
    await expect(outcome).rejects.toThrow(/agent disposed/)

    const claimed = events.listenerFor('agent/inbox/claimed')
    if (claimed === undefined) throw new Error('expected agent/inbox/claimed listener')
    claimed({ message: delivery, turn: 1 } as never)
    expect(stream.snapshot().activities).toEqual([])
    expect(stream.snapshot().agents).toContainEqual({
      agentId: AgentId('alice'),
      status: 'failed',
      usingTool: false,
      error: { code: 'agent-disposed', summary: 'agent disposed before the delivery settled' },
    })
  })

  test('a synchronous followup failure remains display-safe until acknowledged', async () => {
    const events = fakeEvents()
    const stream = new WorkspaceActivityStream()
    const tracker = new WorkspaceTurnTracker({
      agentId: AgentId('alice'),
      sessionId: SessionId('alice-session'),
      stream,
    })
    tracker.install(events as unknown as Context)
    const delivery = text('deliver')
    const failure = Object.assign(new Error('provider unavailable'), {
      code: 'FOLLOWUP_FAILED',
      env: { API_KEY: 'secret' },
    })
    const agent = { followup: vi.fn(() => { throw failure }) } as unknown as Agent

    await expect(tracker.deliver(
      agent,
      delivery,
      undefined,
      { kind: 'room', roomId: RoomId('room-1') },
    )).rejects.toThrow(/provider unavailable/)

    const snapshot = stream.snapshot()
    expect(snapshot.activities).toEqual([])
    expect(snapshot.agents).toContainEqual({
      agentId: AgentId('alice'),
      status: 'failed',
      usingTool: false,
      error: { code: 'FOLLOWUP_FAILED', summary: 'provider unavailable' },
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret')

    stream.acknowledgeAgentFailure(AgentId('alice'))
    expect(stream.snapshot().agents).toContainEqual({
      agentId: AgentId('alice'), status: 'idle', usingTool: false,
    })
  })
})
