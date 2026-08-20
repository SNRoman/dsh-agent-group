import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { AgentId } from '../packages/host/src/ids.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import type { EmployeeSessionSource } from '../packages/host/src/runtime.ts'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'

function handle(dispose = vi.fn(async () => {})): AgentHandle {
  return { agent: { id: SessionId('agent') } as Agent, dispose }
}

function text(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

interface FakeEvents {
  on: (event: string, listener: (...args: never[]) => unknown) => () => void
  emit: (event: string, ...args: unknown[]) => void
  listenersFor: (event: string) => Array<(...args: never[]) => unknown>
}

function fakeEvents(): FakeEvents {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  return {
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener as (...args: never[]) => unknown)
      listeners.set(event, list)
      return () => {}
    },
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...(args as never[]))
    },
    listenersFor: (event) => listeners.get(event) ?? [],
  }
}

describe('EmployeeAgentPool', () => {
  test('concurrent ensure calls create one handle and retain it', async () => {
    const create = vi.fn(async () => handle())
    const resume = vi.fn(async () => handle())
    const source: EmployeeSessionSource = {
      sessionIdFor: () => undefined,
      recordSessionId: vi.fn(async () => {}),
    }
    const pool = new EmployeeAgentPool({ create, resume }, source)
    const [a, b] = await Promise.all([pool.ensure(AgentId('alice')), pool.ensure(AgentId('alice'))])
    expect(create).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
    expect(a).toBe(b)
    expect(pool.handleFor(AgentId('alice'))).toBe(a)
  })

  test('dispose releases the retained handle', async () => {
    const dispose = vi.fn(async () => {})
    const create = vi.fn(async () => handle(dispose))
    const pool = new EmployeeAgentPool({ create, resume: vi.fn() }, { sessionIdFor: () => undefined, recordSessionId: vi.fn(async () => {}) })
    await pool.ensure(AgentId('alice'))
    await pool.dispose(AgentId('alice'))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(pool.handleFor(AgentId('alice'))).toBeUndefined()
  })

  test('a materialized session never falls back to create when resume fails', async () => {
    const create = vi.fn(async () => handle())
    const resume = vi.fn(async () => { throw new Error('resume failed') })
    const source: EmployeeSessionSource = {
      sessionIdFor: () => SessionId('bound'),
      recordSessionId: vi.fn(async () => {}),
    }
    const pool = new EmployeeAgentPool({ create, resume }, source)
    await expect(pool.ensure(AgentId('alice'))).rejects.toThrow(/resume failed/)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })

  test('a fresh agent creates, records its binding, and rolls back on record failure', async () => {
    const dispose = vi.fn(async () => {})
    const create = vi.fn(async () => handle(dispose))
    const recordSessionId = vi.fn(async () => { throw new Error('record failed') })
    const pool = new EmployeeAgentPool({ create, resume: vi.fn() }, { sessionIdFor: () => undefined, recordSessionId })
    await expect(pool.ensure(AgentId('alice'))).rejects.toThrow(/record failed/)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(pool.handleFor(AgentId('alice'))).toBeUndefined()
  })
})

describe('WorkspaceTurnTracker', () => {
  test('correlates a delivery with its turn and captures the reply', async () => {
    const events = fakeEvents()
    const tracker = new WorkspaceTurnTracker()
    tracker.install(events as unknown as Context)
    const followup = vi.fn()
    const agent = { followup } as unknown as Agent
    const delivery = text('what is the runway')
    const outcome = tracker.deliver(agent, delivery)
    expect(followup).toHaveBeenCalledWith(delivery)

    events.emit('agent/inbox/claimed', { message: delivery, turn: 3 })
    events.emit('session/event', {}, { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '8 months' }] } } })
    events.emit('session/event', {}, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    await expect(outcome).resolves.toEqual({ output: [{ type: 'text', text: '8 months' }], stopReason: 'completed' })
  })

  test('ignores assistant output from other turns', async () => {
    const events = fakeEvents()
    const tracker = new WorkspaceTurnTracker()
    tracker.install(events as unknown as Context)
    const agent = { followup: vi.fn() } as unknown as Agent
    const delivery = text('deliver')
    const outcome = tracker.deliver(agent, delivery)
    events.emit('agent/inbox/claimed', { message: delivery, turn: 2 })
    events.emit('session/event', {}, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'unrelated' }] } } })
    events.emit('session/event', {}, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'mine' }] } } })
    events.emit('session/event', {}, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await expect(outcome).resolves.toEqual({ output: [{ type: 'text', text: 'mine' }], stopReason: 'completed' })
  })

  test('rejects a delivery that is discarded before its turn is claimed', async () => {
    const events = fakeEvents()
    const tracker = new WorkspaceTurnTracker()
    tracker.install(events as unknown as Context)
    const agent = { followup: vi.fn() } as unknown as Agent
    const delivery = text('deliver')
    const outcome = tracker.deliver(agent, delivery)
    events.emit('agent/inbox/discarded', { message: delivery })
    await expect(outcome).rejects.toThrow(/discarded/)
  })

  test('the pre-step listener inserts recall immediately after the delivery', async () => {
    const events = fakeEvents()
    const tracker = new WorkspaceTurnTracker()
    tracker.install(events as unknown as Context)
    const agent = { followup: vi.fn() } as unknown as Agent
    const delivery = text('deliver')
    const recall = text('remember this')
    void tracker.deliver(agent, delivery, recall)

    const preStep = events.listenersFor('agent/pre-step')[0]!
    const decision = await preStep(
      { messages: [delivery] },
      async () => ({ kind: 'enter', messages: [delivery] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [delivery, recall] })
  })
})
