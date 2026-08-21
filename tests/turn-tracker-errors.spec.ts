import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'

function text(value: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
}

function fakeContext(): Context {
  return { on: vi.fn(() => () => {}) } as unknown as Context
}

describe('WorkspaceTurnTracker delivery errors', () => {
  test('a synchronous followup failure removes the pending delivery', async () => {
    const tracker = new WorkspaceTurnTracker()
    tracker.install(fakeContext())
    const delivery = text('deliver')
    const agent = {
      followup: vi.fn(() => { throw new Error('followup failed') }),
    } as unknown as Agent

    await expect(tracker.deliver(agent, delivery)).rejects.toThrow(/followup failed/)

    // A second delivery using the same identified message must fail only for
    // its own followup call, not because stale tracker state survived.
    await expect(tracker.deliver(agent, delivery)).rejects.toThrow(/followup failed/)
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })
})
