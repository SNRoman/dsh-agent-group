import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AgentId, DefinitionRevisionId, HumanId, RoomId, TaskDeliveryAttemptId, TaskId, WorkspaceId } from '../packages/host/src/ids.ts'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import type { EmployeeSessionSource } from '../packages/host/src/runtime.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { acceptTaskDelivery, startTaskDelivery } from '../packages/host/src/task-delivery.ts'
import { assignHumanTask } from '../packages/host/src/tasks.ts'
import { WorkspaceTurnTracker } from '../packages/host/src/turn-tracker.ts'
import { WorkspaceActivityStream } from '../packages/host/src/activity-stream.ts'

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

  test('publishes an agent handle identity only while the employee is resident', async () => {
    const created = handle()
    const admission = Promise.withResolvers<AgentHandle>()
    const pool = new EmployeeAgentPool(
      { create: vi.fn(async () => await admission.promise), resume: vi.fn() },
      { sessionIdFor: () => undefined, recordSessionId: vi.fn(async () => {}) },
    )

    const ensuring = pool.ensure(AgentId('alice'))
    expect(pool.agentIdFor(created.agent)).toBeUndefined()
    admission.resolve(created)
    await ensuring
    expect(pool.agentIdFor(created.agent)).toBe(AgentId('alice'))

    await pool.dispose(AgentId('alice'))
    expect(pool.agentIdFor(created.agent)).toBeUndefined()
  })

  test('disposeAll invalidates every published agent handle identity', async () => {
    const alice = handle()
    const bob = handle()
    const created = [alice, bob]
    const pool = new EmployeeAgentPool(
      { create: vi.fn(async () => created.shift()!), resume: vi.fn() },
      { sessionIdFor: () => undefined, recordSessionId: vi.fn(async () => {}) },
    )

    await pool.ensure(AgentId('alice'))
    await pool.ensure(AgentId('bob'))
    expect(pool.agentIdFor(alice.agent)).toBe(AgentId('alice'))
    expect(pool.agentIdFor(bob.agent)).toBe(AgentId('bob'))

    await pool.disposeAll()
    expect(pool.agentIdFor(alice.agent)).toBeUndefined()
    expect(pool.agentIdFor(bob.agent)).toBeUndefined()
  })

  test('departure invalidates queued delivery before it can rematerialize the employee', async () => {
    const activeStarted = Promise.withResolvers<void>()
    const releaseActive = Promise.withResolvers<void>()
    const recordSessionId = vi.fn(async () => {})
    const dispose = vi.fn(async () => {})
    const create = vi.fn(async () => handle(dispose))
    const queuedDelivery = vi.fn(async () => 'stale')
    const pool = new EmployeeAgentPool(
      { create, resume: vi.fn() },
      { sessionIdFor: () => undefined, recordSessionId },
    )
    await pool.ensure(AgentId('alice'))
    const active = pool.runDelivery(AgentId('alice'), async () => {
      activeStarted.resolve()
      await releaseActive.promise
      return 'active'
    })
    await activeStarted.promise
    const queued = pool.runDelivery(AgentId('alice'), queuedDelivery)

    await pool.dispose(AgentId('alice'))
    releaseActive.resolve()
    await expect(active).resolves.toBe('active')
    await expect(queued).rejects.toThrow(/invalidated by disposal/)
    expect(queuedDelivery).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    expect(recordSessionId).toHaveBeenCalledTimes(1)
    expect(pool.handleFor(AgentId('alice'))).toBeUndefined()
  })

  test('whole-pool teardown invalidates queued refresh and drains its operation lane', async () => {
    const activeStarted = Promise.withResolvers<void>()
    const releaseActive = Promise.withResolvers<void>()
    const install = vi.fn(() => vi.fn())
    const stable = handle()
    const pool = new EmployeeAgentPool(
      { create: vi.fn(async () => stable), resume: vi.fn() },
      { sessionIdFor: () => undefined, recordSessionId: vi.fn(async () => {}) },
      async () => ({ roleRevisionId: DefinitionRevisionId('revision-1') }),
      undefined,
      install,
    )
    await pool.ensure(AgentId('alice'))
    const active = pool.runDelivery(AgentId('alice'), async () => {
      activeStarted.resolve()
      await releaseActive.promise
    })
    await activeStarted.promise
    const refresh = pool.refreshRole(AgentId('alice'), DefinitionRevisionId('revision-2'))
    const teardown = pool.disposeAll()
    releaseActive.resolve()

    await expect(active).resolves.toBeUndefined()
    await expect(refresh).rejects.toThrow(/invalidated by disposal/)
    await expect(teardown).resolves.toBeUndefined()
    expect(install).not.toHaveBeenCalled()
    expect(pool.roleRevisionFor(AgentId('alice'))).toBeUndefined()
    expect(pool.handleFor(AgentId('alice'))).toBeUndefined()
  })

  test('disposal during refresh maintenance prevents a stale role write', async () => {
    const maintenanceStarted = Promise.withResolvers<void>()
    const releaseMaintenance = Promise.withResolvers<void>()
    const agentCtx = {} as Context
    const install = vi.fn(() => vi.fn())
    const agent = {
      id: SessionId('stable-session'), ctx: agentCtx,
      whenIdle: vi.fn(async () => {}),
      runMaintenance: vi.fn(async <T>(task: (signal: AbortSignal) => Promise<T>) => {
        maintenanceStarted.resolve()
        await releaseMaintenance.promise
        return await task(new AbortController().signal)
      }),
    } as unknown as Agent
    const stable = { agent, dispose: vi.fn(async () => {}) }
    const pool = new EmployeeAgentPool(
      {
        create: vi.fn(async options => {
          await options.setup?.(agentCtx)
          return stable
        }),
        resume: vi.fn(),
      },
      { sessionIdFor: () => undefined, recordSessionId: vi.fn(async () => {}) },
      async () => ({ roleRevisionId: DefinitionRevisionId('revision-1') }),
      undefined,
      install,
    )
    await pool.ensure(AgentId('alice'))
    const refresh = pool.refreshRole(AgentId('alice'), DefinitionRevisionId('revision-2'))
    await maintenanceStarted.promise

    await pool.dispose(AgentId('alice'))
    releaseMaintenance.resolve()

    await expect(refresh).rejects.toThrow(/invalidated by disposal/)
    expect(install).toHaveBeenCalledTimes(1)
    expect(pool.roleRevisionFor(AgentId('alice'))).toBeUndefined()
    expect(pool.handleFor(AgentId('alice'))).toBeUndefined()
  })

  test('refresh after departure cannot rematerialize the employee', async () => {
    const create = vi.fn(async () => handle())
    const pool = new EmployeeAgentPool(
      { create, resume: vi.fn() },
      { sessionIdFor: () => undefined, recordSessionId: vi.fn(async () => {}) },
      async () => ({ roleRevisionId: DefinitionRevisionId('revision-1') }),
      undefined,
      vi.fn(() => vi.fn()),
    )
    await pool.ensure(AgentId('alice'))
    await pool.dispose(AgentId('alice'))

    await expect(pool.refreshRole(AgentId('alice'), DefinitionRevisionId('revision-2'))).rejects.toThrow(/not resident/)
    expect(create).toHaveBeenCalledTimes(1)
    expect(pool.handleFor(AgentId('alice'))).toBeUndefined()
  })

  test('disposal during fresh admission prevents a session-binding write', async () => {
    const admission = Promise.withResolvers<AgentHandle>()
    const created = handle()
    const recordSessionId = vi.fn(async () => {})
    const pool = new EmployeeAgentPool(
      { create: vi.fn(async () => await admission.promise), resume: vi.fn() },
      { sessionIdFor: () => undefined, recordSessionId },
    )
    const ensuring = pool.ensure(AgentId('alice'))
    const disposing = pool.dispose(AgentId('alice'))
    admission.resolve(created)

    await expect(ensuring).rejects.toThrow(/invalidated by disposal/)
    await expect(disposing).resolves.toBeUndefined()
    expect(recordSessionId).not.toHaveBeenCalled()
    expect(created.dispose).toHaveBeenCalledTimes(1)
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

  test('refreshes one resident role across an exact idle barrier and queues later deliveries', async () => {
    const idle = Promise.withResolvers<void>()
    const firstDelivery = Promise.withResolvers<void>()
    const firstStarted = Promise.withResolvers<void>()
    const calls: string[] = []
    let activeRevision: DefinitionRevisionId | undefined
    const disposers = new Map<string, ReturnType<typeof vi.fn>>()
    const agentCtx = {} as Context
    const agent = {
      id: SessionId('stable-session'),
      ctx: agentCtx,
      session: { header: { id: SessionId('stable-session') } },
      whenIdle: vi.fn(async () => await idle.promise),
      runMaintenance: vi.fn(async <T>(task: (signal: AbortSignal) => Promise<T>) => await task(new AbortController().signal)),
    } as unknown as Agent
    const stableHandle = { agent, dispose: vi.fn(async () => {}) }
    const pool = new EmployeeAgentPool(
      {
        create: vi.fn(async options => {
          await options.setup?.(agentCtx)
          return stableHandle
        }),
        resume: vi.fn(),
      },
      { sessionIdFor: () => undefined, recordSessionId: vi.fn(async () => {}) },
      async () => ({ roleRevisionId: DefinitionRevisionId('revision-1') }),
      undefined,
      (_agentId, revisionId, context) => {
        expect(context).toBe(agentCtx)
        if (activeRevision !== undefined) throw new Error('duplicate role section')
        activeRevision = revisionId
        calls.push(`install:${revisionId}`)
        const dispose = vi.fn(() => {
          activeRevision = undefined
          calls.push(`dispose:${revisionId}`)
        })
        disposers.set(revisionId, dispose)
        return dispose
      },
    )
    const handleBefore = await pool.ensure(AgentId('alice'))
    const sessionBefore = handleBefore.agent.id
    const active = pool.runDelivery(AgentId('alice'), async handle => {
      expect(handle).toBe(handleBefore)
      firstStarted.resolve()
      await firstDelivery.promise
      return 'old-turn'
    })
    await firstStarted.promise

    const refreshing = pool.refreshRole(AgentId('alice'), DefinitionRevisionId('revision-2'))
    let laterStarted = false
    const later = pool.runDelivery(AgentId('alice'), async handle => {
      laterStarted = true
      expect(handle).toBe(handleBefore)
      return 'new-turn'
    })
    await Promise.resolve()
    expect(calls).toEqual(['install:revision-1'])
    expect(laterStarted).toBe(false)

    firstDelivery.resolve()
    await active
    await vi.waitFor(() => expect(agent.whenIdle).toHaveBeenCalledTimes(1))
    expect(calls).toEqual(['install:revision-1'])
    expect(laterStarted).toBe(false)

    idle.resolve()
    await refreshing
    expect(await later).toBe('new-turn')
    expect(pool.handleFor(AgentId('alice'))).toBe(handleBefore)
    expect(pool.handleFor(AgentId('alice'))?.agent.id).toBe(sessionBefore)
    expect(calls).toEqual(['install:revision-1', 'dispose:revision-1', 'install:revision-2'])
    expect(disposers.get('revision-1')).toHaveBeenCalledTimes(1)
    expect(agent.runMaintenance).toHaveBeenCalledTimes(1)
  })

  test('retires the resident and releases its gate when replacement registration fails', async () => {
    const calls: string[] = []
    const agentCtx = {} as Context
    const agent = {
      id: SessionId('stable-session'), ctx: agentCtx,
      whenIdle: vi.fn(async () => {}),
      runMaintenance: vi.fn(async <T>(task: (signal: AbortSignal) => Promise<T>) => await task(new AbortController().signal)),
    } as unknown as Agent
    let activeRevision: DefinitionRevisionId | undefined
    const oldDispose = vi.fn(() => {
      activeRevision = undefined
      calls.push('dispose:old')
    })
    const pool = new EmployeeAgentPool(
      {
        create: vi.fn(async options => {
          await options.setup?.(agentCtx)
          return { agent, dispose: vi.fn(async () => {}) }
        }),
        resume: vi.fn(),
      },
      { sessionIdFor: () => undefined, recordSessionId: vi.fn(async () => {}) },
      async () => ({ roleRevisionId: DefinitionRevisionId('revision-1') }),
      undefined,
      (_agentId, revisionId) => {
        if (activeRevision !== undefined) throw new Error('duplicate role section')
        calls.push(`install:${revisionId}`)
        if (revisionId === DefinitionRevisionId('revision-2')) throw new Error('replacement failed')
        activeRevision = revisionId
        return revisionId === DefinitionRevisionId('revision-1') ? oldDispose : vi.fn()
      },
    )
    await pool.ensure(AgentId('alice'))
    await expect(pool.refreshRole(AgentId('alice'), DefinitionRevisionId('revision-2'))).rejects.toThrow('replacement failed')
    expect(oldDispose).toHaveBeenCalledTimes(1)
    expect(pool.roleRevisionFor(AgentId('alice'))).toBeUndefined()
    expect(pool.handleFor(AgentId('alice'))).toBeUndefined()
    expect(calls).toEqual([
      'install:revision-1', 'dispose:old', 'install:revision-2', 'install:revision-1',
    ])
  })

  test('retires the resident and releases its gate when prior role teardown fails', async () => {
    const agentCtx = {} as Context
    const agent = {
      id: SessionId('stable-session'), ctx: agentCtx,
      whenIdle: vi.fn(async () => {}),
      runMaintenance: vi.fn(async <T>(task: (signal: AbortSignal) => Promise<T>) => await task(new AbortController().signal)),
    } as unknown as Agent
    const install = vi.fn((_agentId: AgentId, revisionId: DefinitionRevisionId) => {
      if (revisionId === DefinitionRevisionId('revision-1')) return () => { throw new Error('teardown failed') }
      return vi.fn()
    })
    const pool = new EmployeeAgentPool(
      {
        create: vi.fn(async options => {
          await options.setup?.(agentCtx)
          return { agent, dispose: vi.fn(async () => {}) }
        }),
        resume: vi.fn(),
      },
      { sessionIdFor: () => undefined, recordSessionId: vi.fn(async () => {}) },
      async () => ({ roleRevisionId: DefinitionRevisionId('revision-1') }),
      undefined,
      install,
    )

    await pool.ensure(AgentId('alice'))
    await expect(pool.refreshRole(AgentId('alice'), DefinitionRevisionId('revision-2'))).rejects.toThrow('teardown failed')
    expect(pool.roleRevisionFor(AgentId('alice'))).toBeUndefined()
    expect(pool.handleFor(AgentId('alice'))).toBeUndefined()
    expect(install).toHaveBeenCalledTimes(1)
  })
})

describe('AgentWorkspaceDomainService task-tool lifecycle', () => {
  test('registers all task tools and removes them with the Host fiber', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-workspace-task-tools-'))
    const registered: string[] = []
    const disposed: string[] = []
    const tools = {
      register(definition: { readonly name: string }) {
        registered.push(definition.name)
        return () => { disposed.push(definition.name) }
      },
    }
    const ctx = new Context()
    const fibers = []
    try {
      fibers.push(await ctx.plugin(Storage))
      fibers.push(await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }))
      fibers.push(await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }))
      fibers.push(await ctx.plugin((toolCtx) => toolCtx.provide('tools', tools)))
      const host = await ctx.plugin(AgentWorkspaceDomainService)
      fibers.push(host)

      expect(registered).toEqual([
        'workspace_delegate_task',
        'workspace_run_child',
        'workspace_complete_task',
      ])
      await host.dispose()
      fibers.pop()
      expect(disposed).toEqual([
        'workspace_complete_task',
        'workspace_run_child',
        'workspace_delegate_task',
      ])
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('exposes the employee completion tool through the loaded DSH registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-workspace-real-tools-'))
    const employee = { id: SessionId('employee-tool-session') } as Agent
    const agents = {
      create: vi.fn(async () => ({ agent: employee, dispose: vi.fn(async () => {}) })),
      resume: vi.fn(),
    }
    const systemPrompt = {
      tools: vi.fn(() => () => {}),
      section: vi.fn(() => () => {}),
    }
    const ctx = new Context()
    const fibers = []
    try {
      fibers.push(await ctx.plugin(Storage))
      fibers.push(await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }))
      fibers.push(await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }))
      fibers.push(await ctx.plugin(promptCtx => promptCtx.provide('systemPrompt', systemPrompt)))
      fibers.push(await ctx.plugin(modelCtx => modelCtx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: 'scripted', model: 'scripted-model' }),
      })))
      fibers.push(await ctx.plugin(ToolRuntime))
      fibers.push(await ctx.plugin(agentCtx => agentCtx.provide('agents', agents)))
      const host = await ctx.plugin(AgentWorkspaceDomainService)
      fibers.push(host)
      const service = ctx.agentWorkspace

      await service.execute({ type: 'definition/create', name: 'Engineer', description: 'Build', instructions: 'Ship' })
      const definitionId = Object.values(service.snapshot().definitions)[0]?.id
      if (definitionId === undefined) throw new Error('expected definition')
      await service.execute({ type: 'agent/create', definitionId, name: 'Alice' })
      const employeeId = Object.values(service.snapshot().agents)[0]?.id
      if (employeeId === undefined) throw new Error('expected employee')
      await service.ensureEmployee(employeeId)

      const assigned = assignHumanTask(service.snapshot(), {
        humanId: HumanId('owner'), assigneeAgentId: employeeId, title: 'Complete through the real tool runtime',
      })
      const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
      const accepted = acceptTaskDelivery(started.state, {
        taskId: assigned.taskId, attemptId: started.attemptId, messageId: started.message.id,
      })
      await service.apply(() => accepted.state)

      const schemas = ctx.tools.schemas(employee)
      const execution = await ctx.tools.execute({
        callId: CallId('employee-complete-call'),
        name: 'workspace_complete_task',
        arguments: { taskId: assigned.taskId, result: 'REAL_TOOL_RESULT' },
        agent: employee,
        signal: new AbortController().signal,
      })
      const modelVisible = {
        schemas: schemas.map(schema => ({ name: schema.name, parameters: schema.parameters })),
        execution,
      }
      const expected = JSON.parse(await readFile(
        new URL('./fixtures/task-tools/employee-completion.json', import.meta.url),
        'utf8',
      ))
      expect(modelVisible).toEqual(expected)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('WorkspaceTurnTracker', () => {
  test('publishes task delivery while queued and binds its claim without changing activity identity', async () => {
    const events = fakeEvents()
    const stream = new WorkspaceActivityStream()
    const tracker = new WorkspaceTurnTracker({
      agentId: AgentId('alice'),
      sessionId: SessionId('alice-session'),
      stream,
    })
    tracker.install(events as unknown as Context)
    const agent = { followup: vi.fn() } as unknown as Agent
    const delivery = text('deliver task')
    const outcome = tracker.deliver(agent, delivery, undefined, {
      kind: 'task',
      taskId: TaskId('task-1'),
      attemptId: TaskDeliveryAttemptId('attempt-1'),
    })

    const queued = stream.snapshot().activities[0]
    expect(queued).toMatchObject({
      agentId: AgentId('alice'),
      messageId: delivery.id,
      source: { kind: 'task', taskId: TaskId('task-1'), attemptId: TaskDeliveryAttemptId('attempt-1') },
      status: 'queued',
    })
    events.emit('agent/inbox/claimed', { message: delivery, turn: 8 })
    expect(stream.snapshot().activities[0]).toMatchObject({
      activityId: queued?.activityId,
      messageId: delivery.id,
      status: 'responding',
      claimed: { sessionId: SessionId('alice-session'), turn: 8 },
    })

    events.emit('session/event', {}, {
      type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } },
    })
    await expect(outcome).resolves.toMatchObject({ stopReason: { kind: 'completed' } })
  })

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
    await expect(outcome).resolves.toEqual({
      output: [{ type: 'text', text: '8 months' }],
      stopReason: { kind: 'completed' },
      interrupted: false,
    })
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
    await expect(outcome).resolves.toEqual({
      output: [{ type: 'text', text: 'mine' }],
      stopReason: { kind: 'completed' },
      interrupted: false,
    })
  })

  test('reports the authoritative aborted reason and interrupted assistant output', async () => {
    const events = fakeEvents()
    const tracker = new WorkspaceTurnTracker()
    tracker.install(events as unknown as Context)
    const agent = { followup: vi.fn() } as unknown as Agent
    const delivery = text('deliver')
    const outcome = tracker.deliver(agent, delivery)

    events.emit('agent/inbox/claimed', { message: delivery, turn: 4 })
    events.emit('session/event', {}, {
      type: 'assistant/message',
      data: {
        turn: 4,
        step: 1,
        message: { content: [{ type: 'text', text: 'partial reply' }] },
        interrupted: true,
      },
    })
    events.emit('session/event', {}, {
      type: 'turn/end',
      data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })

    await expect(outcome).resolves.toEqual({
      output: [{ type: 'text', text: 'partial reply' }],
      stopReason: { kind: 'aborted', reason: { kind: 'user' } },
      interrupted: true,
    })
  })

  test('settles one claimed delivery only once when its terminal event is repeated', async () => {
    const events = fakeEvents()
    const stream = new WorkspaceActivityStream()
    const tracker = new WorkspaceTurnTracker({
      agentId: AgentId('alice'),
      sessionId: SessionId('alice-session'),
      stream,
    })
    tracker.install(events as unknown as Context)
    const agent = { followup: vi.fn() } as unknown as Agent
    const delivery = text('deliver')
    const outcome = tracker.deliver(agent, delivery, undefined, { kind: 'room', roomId: RoomId('room-1') })

    events.emit('agent/inbox/claimed', { message: delivery, turn: 5 })
    events.emit('session/event', {}, {
      type: 'assistant/message',
      data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: 'done' }] } },
    })
    events.emit('session/event', {}, {
      type: 'turn/end',
      data: { turn: 5, reason: { kind: 'completed' } },
    })
    const terminalVersion = stream.snapshot().version
    events.emit('session/event', {}, {
      type: 'turn/end',
      data: { turn: 5, reason: { kind: 'error', error: { code: 'LATE', message: 'duplicate' } } },
    })

    await expect(outcome).resolves.toMatchObject({
      stopReason: { kind: 'completed' },
      interrupted: false,
    })
    expect(stream.snapshot().version).toBe(terminalVersion)
    expect(stream.snapshot().activities).toHaveLength(1)
  })

  test('long-poll cancellation leaves the tracked agent outcome untouched', async () => {
    const events = fakeEvents()
    const stream = new WorkspaceActivityStream()
    const tracker = new WorkspaceTurnTracker({
      agentId: AgentId('alice'),
      sessionId: SessionId('alice-session'),
      stream,
    })
    tracker.install(events as unknown as Context)
    const agent = { followup: vi.fn() } as unknown as Agent
    const delivery = text('deliver')
    const outcome = tracker.deliver(agent, delivery, undefined, { kind: 'room', roomId: RoomId('room-1') })
    events.emit('agent/inbox/claimed', { message: delivery, turn: 6 })

    let outcomeSettled = false
    void outcome.then(() => { outcomeSettled = true })
    const beforeWait = stream.snapshot()
    const controller = new AbortController()
    const wait = stream.wait(beforeWait.version, controller.signal)
    controller.abort()

    await expect(wait).rejects.toMatchObject({ name: 'AbortError' })
    expect(outcomeSettled).toBe(false)
    expect(stream.snapshot()).toEqual(beforeWait)

    events.emit('session/event', {}, {
      type: 'turn/end',
      data: { turn: 6, reason: { kind: 'completed' } },
    })
    await expect(outcome).resolves.toMatchObject({ stopReason: { kind: 'completed' } })
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

describe('AgentWorkspaceDomainService delivery failures', () => {
  test('returns a committed revision and retires its resident after role refresh fails', async () => {
    const created = mutateWorkspace(createInitialState(WorkspaceId('local')), {
      type: 'definition/create', name: 'Engineer', description: 'v1', instructions: 'one',
    })
    const hired = mutateWorkspace(created.state, {
      type: 'agent/create', definitionId: created.definitionId, name: 'Alice',
    })
    let state = hired.state
    const stable = handle()
    const refreshRole = vi.fn(async () => { throw new Error('refresh failed') })
    const dispose = vi.fn(async () => {})
    const service = new AgentWorkspaceDomainService(new Context())
    const internals = service as unknown as {
      table: {
        get(id: WorkspaceId): typeof state | undefined
        update(id: WorkspaceId, mutation: (current: typeof state) => typeof state): Promise<typeof state>
      }
      pool: { handleFor(agentId: AgentId): AgentHandle | undefined; refreshRole: typeof refreshRole; dispose: typeof dispose }
    }
    internals.table = {
      get: () => state,
      update: async (_id, mutation) => {
        state = mutation(state)
        return state
      },
    }
    internals.pool = { handleFor: () => stable, refreshRole, dispose }
    const beforeRevision = state.revision
    const beforeEvents = state.events.length

    const committed = await service.execute({
      type: 'definition/revise', definitionId: created.definitionId,
      description: 'v2', instructions: 'two', synchronizeAgentIds: [hired.agentId],
    })

    expect(committed.revision).toBe(beforeRevision + 1)
    expect(committed.events).toHaveLength(beforeEvents + 2)
    expect(refreshRole).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledWith(hired.agentId)
    expect(service.activitySnapshot().agents).toContainEqual({
      agentId: hired.agentId,
      status: 'failed',
      usingTool: false,
      error: { code: 'agent-role-refresh-failed', summary: 'Agent role could not be refreshed.' },
    })
  })

  test('materialization failure remains display-safe until acknowledged', async () => {
    const service = new AgentWorkspaceDomainService(new Context())
    const secretCanary = 'API_KEY=FAKE_REVIEW_CANARY'
    const agentId = AgentId('alice')
    vi.spyOn(service, 'ensureEmployee').mockRejectedValue(new Error(secretCanary))

    await expect(service.deliver(agentId, text('deliver'))).rejects.toThrow(secretCanary)

    const failed = service.activitySnapshot()
    expect(failed.agents).toContainEqual({
      agentId,
      status: 'failed',
      usingTool: false,
      error: { code: 'agent-materialization-failed', summary: 'Agent could not be started.' },
    })
    expect(JSON.stringify(failed)).not.toContain(secretCanary)
    service.acknowledgeAgentFailure(agentId)
    expect(service.activitySnapshot().agents).toContainEqual({ agentId, status: 'idle', usingTool: false })
  })

  test('session flush failure remains display-safe until acknowledged', async () => {
    const service = new AgentWorkspaceDomainService(new Context())
    const secretCanary = 'API_KEY=FAKE_REVIEW_CANARY'
    const agentId = AgentId('alice')
    const session = {} as Agent['session']
    const agent = { id: SessionId('alice-session'), session } as Agent
    vi.spyOn(service, 'ensureEmployee').mockResolvedValue({ agent, dispose: vi.fn(async () => {}) })
    const tracker = new WorkspaceTurnTracker()
    vi.spyOn(tracker, 'deliver').mockResolvedValue({
      output: [], stopReason: { kind: 'completed' }, interrupted: false,
    })
    const flush = vi.fn(async () => { throw new Error(secretCanary) })
    const internals = service as unknown as {
      ctx: { get(name: string): unknown }
      trackers: Map<AgentId, WorkspaceTurnTracker>
    }
    internals.ctx = { get: name => name === 'sessions' ? { flush } : undefined }
    internals.trackers.set(agentId, tracker)

    await expect(service.deliver(agentId, text('deliver'))).rejects.toThrow(secretCanary)

    const failed = service.activitySnapshot()
    expect(failed.agents).toContainEqual({
      agentId,
      status: 'failed',
      usingTool: false,
      error: { code: 'agent-session-flush-failed', summary: 'Agent session could not be saved.' },
    })
    expect(JSON.stringify(failed)).not.toContain(secretCanary)
    service.acknowledgeAgentFailure(agentId)
    expect(service.activitySnapshot().agents).toContainEqual({ agentId, status: 'idle', usingTool: false })
  })

  test('flush failure preserves a more specific tracker failure', async () => {
    const service = new AgentWorkspaceDomainService(new Context())
    const agentId = AgentId('alice')
    const session = {} as Agent['session']
    const agent = { id: SessionId('alice-session'), session } as Agent
    vi.spyOn(service, 'ensureEmployee').mockResolvedValue({ agent, dispose: vi.fn(async () => {}) })
    const tracker = new WorkspaceTurnTracker()
    vi.spyOn(tracker, 'deliver').mockResolvedValue({
      output: [], stopReason: { kind: 'error', error: { code: 'provider' } }, interrupted: false,
    })
    const internals = service as unknown as {
      activityStream: { recordAgentFailure(agentId: AgentId, error: { code: string; summary: string }): void }
      ctx: { get(name: string): unknown }
      trackers: Map<AgentId, WorkspaceTurnTracker>
    }
    internals.activityStream.recordAgentFailure(agentId, {
      code: 'agent-turn-failed', summary: 'Agent turn failed.',
    })
    internals.ctx = {
      get: name => name === 'sessions'
        ? { flush: async () => { throw new Error('secondary flush failure') } }
        : undefined,
    }
    internals.trackers.set(agentId, tracker)

    await expect(service.deliver(agentId, text('deliver'))).rejects.toThrow(/secondary flush failure/)

    expect(service.activitySnapshot().agents).toContainEqual({
      agentId,
      status: 'failed',
      usingTool: false,
      error: { code: 'agent-turn-failed', summary: 'Agent turn failed.' },
    })
  })
})
