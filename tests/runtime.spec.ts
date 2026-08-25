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

  test('an explicitly incompatible bound session is hidden and replaced instead of resumed', async () => {
    const create = vi.fn(async () => handle())
    const resume = vi.fn(async () => handle())
    const recordSessionId = vi.fn(async () => {})
    const classifySession = vi.fn(async () => 'replace' as const)
    const hideSession = vi.fn(async () => {})
    const source: EmployeeSessionSource = {
      sessionIdFor: () => SessionId('legacy'),
      recordSessionId,
      classifySession,
      hideSession,
    }
    const pool = new EmployeeAgentPool({ create, resume }, source)

    await pool.ensure(AgentId('alice'))

    expect(classifySession).toHaveBeenCalledWith(AgentId('alice'), SessionId('legacy'))
    expect(hideSession).toHaveBeenCalledWith(SessionId('legacy'))
    expect(resume).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    const createdId = create.mock.calls[0]?.[0].sessionId
    expect(createdId).toBeDefined()
    expect(createdId).not.toBe(SessionId('legacy'))
    expect(hideSession).toHaveBeenCalledWith(createdId)
    expect(recordSessionId).toHaveBeenCalledWith(AgentId('alice'), createdId)
  })

  test('a compatible bound session is hidden and resumed without rebinding', async () => {
    const create = vi.fn(async () => handle())
    const resume = vi.fn(async () => handle())
    const recordSessionId = vi.fn(async () => {})
    const classifySession = vi.fn(async () => 'resume' as const)
    const hideSession = vi.fn(async () => {})
    const source: EmployeeSessionSource = {
      sessionIdFor: () => SessionId('bound'),
      recordSessionId,
      classifySession,
      hideSession,
    }
    const pool = new EmployeeAgentPool({ create, resume }, source)

    await pool.ensure(AgentId('alice'))

    expect(hideSession).toHaveBeenCalledWith(SessionId('bound'))
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: SessionId('bound') }))
    expect(create).not.toHaveBeenCalled()
    expect(recordSessionId).not.toHaveBeenCalled()
  })

  test('a fresh internal session is hidden before its durable binding is recorded', async () => {
    const create = vi.fn(async () => handle())
    const hideSession = vi.fn(async () => {})
    const recordSessionId = vi.fn(async () => {})
    const source: EmployeeSessionSource = {
      sessionIdFor: () => undefined,
      recordSessionId,
      hideSession,
    }
    const pool = new EmployeeAgentPool({ create, resume: vi.fn() }, source)

    await pool.ensure(AgentId('alice'))

    const createdId = create.mock.calls[0]?.[0].sessionId
    expect(hideSession).toHaveBeenCalledWith(createdId)
    expect(recordSessionId).toHaveBeenCalledWith(AgentId('alice'), createdId)
    expect(hideSession.mock.invocationCallOrder[0]).toBeLessThan(recordSessionId.mock.invocationCallOrder[0]!)
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

  test('materialization options are applied to fresh and resumed employee agents', async () => {
    const create = vi.fn(async () => handle())
    const resume = vi.fn(async () => handle())
    const setup = vi.fn()
    const configure = vi.fn(async (_agentId: ReturnType<typeof AgentId>, mode: 'create' | 'resume') => ({
      agentOptions: { provider: 'test-provider', model: 'test-model' },
      ...(mode === 'create' ? { meta: { cwd: 'E:/workspace', agentPreset: 'standard' } } : {}),
      setup,
    }))

    const freshSource: EmployeeSessionSource = {
      sessionIdFor: () => undefined,
      recordSessionId: vi.fn(async () => {}),
    }
    const fresh = new EmployeeAgentPool({ create, resume }, freshSource, configure)
    await fresh.ensure(AgentId('alice'))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: { provider: 'test-provider', model: 'test-model' },
      meta: { cwd: 'E:/workspace', agentPreset: 'standard' },
      setup,
    }))

    const resumedSource: EmployeeSessionSource = {
      sessionIdFor: () => SessionId('bound'),
      recordSessionId: vi.fn(async () => {}),
    }
    const resumed = new EmployeeAgentPool({ create, resume }, resumedSource, configure)
    await resumed.ensure(AgentId('bob'))
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: SessionId('bound'),
      agentOptions: { provider: 'test-provider', model: 'test-model' },
      setup,
    }))
    expect(configure).toHaveBeenCalledWith(AgentId('alice'), 'create')
    expect(configure).toHaveBeenCalledWith(AgentId('bob'), 'resume')
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
