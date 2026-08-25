import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'

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
})
