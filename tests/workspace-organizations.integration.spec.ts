import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { WorkspaceOperationId } from '../packages/host/src/workspace-record.ts'
import { WorkspaceDispatcher } from '../packages/host/src/dispatcher.ts'
import type { WorkspaceRuntime } from '../packages/host/src/workspace-runtime.ts'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ChildControllerRegistry } from '../packages/host/src/child-controller.ts'
import { assignHumanTask, recordChildRunStarted } from '../packages/host/src/tasks.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'
import { acceptTaskDelivery, inspectTaskDelivery, startTaskDelivery } from '../packages/host/src/task-delivery.ts'
import type { WorkspaceTurnOutcome } from '../packages/host/src/turn-tracker.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function boot(root?: string, configure?: (ctx: Context) => void) {
  const storage = root ?? await mkdtemp(join(tmpdir(), 'agent-organizations-'))
  if (root === undefined) roots.push(storage)
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root: storage }),
    await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
  ]
  configure?.(ctx)
  const host = await ctx.plugin(AgentWorkspaceDomainService)
  fibers.push(host)
  return { ctx, root: storage, service: ctx.agentWorkspace, disposeHost: () => host.dispose(), dispose: async () => { for (const fiber of fibers.toReversed()) await fiber.dispose() } }
}

describe('durable independent organizations', () => {
  test('Host disposal waits for child disposal and durable settlement before closing storage', async () => {
    let closed = false
    const host = await boot(undefined, ctx => {
      const open = ctx.storageDomain.open.bind(ctx.storageDomain)
      vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async spec => {
        const domain = await open(spec)
        const close = domain.close.bind(domain)
        vi.spyOn(domain, 'close').mockImplementation(async () => { await close(); closed = true })
        return domain
      })
    })
    const started = Promise.withResolvers<void>()
    const disposing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const providers = await host.ctx.plugin(ctx => {
      ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } } as never)
      ctx.provide('subagents', { start: async (_provider: string, request: { signal: AbortSignal }) => {
        started.resolve()
        return {
          result: new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })),
          dispose: async () => { disposing.resolve(); await release.promise },
        }
      } } as never)
    })
    let child: Promise<string> | undefined
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const { agentId } = await seedRoom(runtime)
      let taskId!: ReturnType<typeof assignHumanTask>['taskId']
      await runtime.apply(state => { const assigned = assignHumanTask(state, { humanId: HumanId('human'), assigneeAgentId: agentId, title: 'child work' }); taskId = assigned.taskId; return assigned.state })
      vi.spyOn(runtime, 'ensureEmployee').mockResolvedValue({ agent: {} } as AgentHandle)
      child = runtime.runChild(agentId, taskId, 'run child')
      void child.catch(() => {})
      await started.promise
      let finished = false
      const disposal = host.disposeHost().then(() => { finished = true })
      await disposing.promise
      expect(() => runtime.snapshot()).not.toThrow()
      expect(closed).toBe(false)
      expect(finished).toBe(false)
      expect(runtime.admission.pending).toBe(1)
      await expect(runtime.execute(runtime.snapshot().revision, { type: 'room/create', kind: 'group', name: 'late task' })).rejects.toThrow(/closed|stopping/)
      release.resolve()
      await expect(child).rejects.toThrow('stopped')
      await disposal
      expect(closed).toBe(true)
      expect(runtime.admission.pending).toBe(0)
      const stored = JSON.parse(await readFile(join(host.root, 'agent_workspace.json'), 'utf8'))
      expect(Object.values(stored.tables.workspaces.local.aggregate.childRuns)).toMatchObject([{ status: 'cancelled' }])
      expect(stored.tables.workspaces.local.aggregate.tasks[taskId].status).toBe('open')
    } finally {
      release.resolve()
      await child?.catch(() => {})
      vi.restoreAllMocks()
      await host.dispose()
      await providers.dispose()
    }
  })

  test.each(['create', 'import'] as const)('Host disposal waits for an admitted directory %s and closes its late runtime', async kind => {
    const host = await boot()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let creation: Promise<Awaited<ReturnType<typeof host.service.createOrganization>>> | undefined
    try {
      const local = host.service.forWorkspace(WorkspaceId('local'))
      const other = await host.service.createOrganization(WorkspaceOperationId('existing'), 'Existing organization')
      if (kind === 'create') {
        const create = local.directory.create.bind(local.directory)
        vi.spyOn(local.directory, 'create').mockImplementationOnce(async request => { entered.resolve(); await release.promise; return await create(request) })
        creation = host.service.createOrganization(WorkspaceOperationId('late-create'), 'Late organization')
      } else {
        const exported = await host.service.exportOrganization(local.workspaceId)
        const importOrganization = local.directory.import.bind(local.directory)
        vi.spyOn(local.directory, 'import').mockImplementationOnce(async request => { entered.resolve(); await release.promise; return await importOrganization(request) })
        creation = host.service.importOrganization(WorkspaceOperationId('late-import'), exported.json, 'Late organization')
      }
      void creation.catch(() => {})
      await entered.promise
      let finished = false
      const disposal = host.disposeHost().then(() => { finished = true })
      await expect.poll(() => host.ctx.agentWorkspace).toBeUndefined()
      expect(() => local.directory.list()).not.toThrow()
      expect(finished).toBe(false)
      await expect(host.service.createOrganization(WorkspaceOperationId('rejected-create'), 'Rejected')).rejects.toThrow(/closed|stopping/)
      await expect(host.service.forWorkspace(other.descriptor.id).execute(0, { type: 'room/create', kind: 'group', name: 'Rejected task' })).rejects.toThrow(/closed|stopping/)
      release.resolve()
      const record = await creation
      await disposal
      const late = host.service.forWorkspace(record.descriptor.id)
      await expect(late.execute(0, { type: 'room/create', kind: 'group', name: 'late task' })).rejects.toThrow(/closed|stopping/)
      const stored = JSON.parse(await readFile(join(host.root, 'agent_workspace.json'), 'utf8'))
      expect(stored.tables.workspaces[record.descriptor.id].descriptor.label).toBe('Late organization')
    } finally { release.resolve(); await creation?.catch(() => {}); vi.restoreAllMocks(); await host.dispose() }
  })

  test('dynamic agents unload revokes old identities and waits for child cleanup before reinjection', async () => {
    const host = await boot()
    const started = Promise.withResolvers<void>()
    const disposing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    host.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } as never)
    const first = await host.ctx.plugin(ctx => {
      ctx.provide('agents', {
        create: async (options: { sessionId: SessionId }) => employee(options.sessionId),
        resume: async (options: { resumeSessionId: SessionId }) => employee(options.resumeSessionId),
      } as never)
    })
    const children = await host.ctx.plugin(ctx => ctx.provide('subagents', { start: async (_provider: string, request: { signal: AbortSignal }) => {
      started.resolve()
      return {
        result: new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })),
        dispose: async () => { disposing.resolve(); await release.promise },
      }
    } } as never))
    let child: Promise<string> | undefined
    let second: Awaited<ReturnType<Context['plugin']>> | undefined
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const { agentId } = await seedRoom(runtime)
      const prior = await runtime.ensureEmployee(agentId)
      expect(runtime.agentIdFor(prior.agent)).toBe(agentId)
      let taskId!: ReturnType<typeof assignHumanTask>['taskId']
      await runtime.apply(state => { const assigned = assignHumanTask(state, { humanId: HumanId('human'), assigneeAgentId: agentId, title: 'child work' }); taskId = assigned.taskId; return assigned.state })
      child = runtime.runChild(agentId, taskId, 'child')
      void child.catch(() => {})
      await started.promise
      let retired = false
      const retirement = first.dispose().then(() => { retired = true })
      await disposing.promise
      expect(retired).toBe(false)
      expect(runtime.agentIdFor(prior.agent)).toBeUndefined()
      await expect(runtime.ensureEmployee(agentId)).rejects.toThrow(/closed|stopping/)
      release.resolve()
      await child.catch(() => {})
      await retirement
      expect(runtime.admission.pending).toBe(0)
      expect(Object.values(runtime.snapshot().childRuns)).toMatchObject([{ status: 'cancelled' }])
      second = await host.ctx.plugin(ctx => ctx.provide('agents', {
        create: async (options: { sessionId: SessionId }) => employee(options.sessionId),
        resume: async (options: { resumeSessionId: SessionId }) => employee(options.resumeSessionId),
      } as never))
      const resumed = await runtime.ensureEmployee(agentId)
      expect(resumed).not.toBe(prior)
      expect(runtime.agentIdFor(prior.agent)).toBeUndefined()
      expect(runtime.agentIdFor(resumed.agent)).toBe(agentId)
      expect(resumed.agent.id).toBe(prior.agent.id)
    } finally { release.resolve(); await child?.catch(() => {}); await host.dispose(); await first.dispose(); await second?.dispose(); await children.dispose() }
  })

  test('Host teardown reports employee cleanup failures while attempting every organization', async () => {
    const host = await boot()
    const disposed: SessionId[] = []
    host.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } as never)
    const agents = await host.ctx.plugin(ctx => ctx.provide('agents', {
      create: async (options: { sessionId: SessionId }) => employee(options.sessionId, async () => { disposed.push(options.sessionId); throw new Error('employee session flush failed') }),
      resume: async () => { throw new Error('unused') },
    } as never))
    const errors: unknown[] = []
    const errorLog = vi.spyOn(host.ctx.logger, 'error').mockImplementation(error => { errors.push(error) })
    try {
      const other = await host.service.createOrganization(WorkspaceOperationId('cleanup-other'), 'Other')
      const runtimes = [host.service.forWorkspace(WorkspaceId('local')), host.service.forWorkspace(other.descriptor.id)]
      const sessions: SessionId[] = []
      for (const runtime of runtimes) {
        const { agentId } = await seedRoom(runtime)
        sessions.push((await runtime.ensureEmployee(agentId)).agent.id)
      }
      await host.disposeHost()
      expect(disposed.toSorted()).toEqual(sessions.toSorted())
      expect(errors.some(error => containsFailure(error, 'employee session flush failed'))).toBe(true)
      const stored = JSON.parse(await readFile(join(host.root, 'agent_workspace.json'), 'utf8'))
      expect(Object.keys(stored.tables.workspaces)).toHaveLength(2)
    } finally { await host.dispose(); await agents.dispose(); errorLog.mockRestore() }
  })

  test('Host teardown retains child abort and flush failures and closes after all organizations drain', async () => {
    const disposed: number[] = []
    let cleanupCountAtClose = 0
    const host = await boot(undefined, ctx => {
      const open = ctx.storageDomain.open.bind(ctx.storageDomain)
      vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async spec => {
        const domain = await open(spec)
        const close = domain.close.bind(domain)
        vi.spyOn(domain, 'close').mockImplementation(async () => { cleanupCountAtClose = disposed.length; await close() })
        return domain
      })
    })
    const started = Promise.withResolvers<void>()
    let starts = 0
    const providers = await host.ctx.plugin(ctx => {
      ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } } as never)
      ctx.provide('subagents', { start: async (_provider: string, request: { signal: AbortSignal }) => {
        const index = starts++
        if (starts === 2) started.resolve()
        return {
          result: new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('normal stopped')), { once: true })),
          dispose: async () => { disposed.push(index); if (index === 0) throw new Error('CHILD_FLUSH_CANARY') },
        }
      } } as never)
    })
    const errors: unknown[] = []
    vi.spyOn(host.ctx.logger, 'error').mockImplementation(error => { errors.push(error) })
    const children: Promise<string>[] = []
    try {
      const other = await host.service.createOrganization(WorkspaceOperationId('child-flush-other'), 'Other')
      const runtimes = [host.service.forWorkspace(WorkspaceId('local')), host.service.forWorkspace(other.descriptor.id)]
      for (const runtime of runtimes) {
        const { agentId } = await seedRoom(runtime)
        let taskId!: ReturnType<typeof assignHumanTask>['taskId']
        await runtime.apply(state => { const assigned = assignHumanTask(state, { humanId: HumanId('human'), assigneeAgentId: agentId, title: 'child work' }); taskId = assigned.taskId; return assigned.state })
        vi.spyOn(runtime, 'ensureEmployee').mockResolvedValue({ agent: {} } as AgentHandle)
        const child = runtime.runChild(agentId, taskId, 'child')
        void child.catch(() => {})
        children.push(child)
      }
      await started.promise
      await host.disposeHost()
      const outcomes = await Promise.allSettled(children)
      const first = outcomes[0]
      expect(first?.status).toBe('rejected')
      if (first?.status === 'rejected') {
        expect(containsFailure(first.reason, 'normal stopped')).toBe(true)
        expect(containsFailure(first.reason, 'CHILD_FLUSH_CANARY')).toBe(true)
      }
      expect(disposed.toSorted()).toEqual([0, 1])
      expect(cleanupCountAtClose).toBe(2)
      expect(runtimes.map(runtime => runtime.admission.pending)).toEqual([0, 0])
      expect(errors.some(error => containsFailure(error, 'CHILD_FLUSH_CANARY'))).toBe(true)
      const stored = JSON.parse(await readFile(join(host.root, 'agent_workspace.json'), 'utf8'))
      for (const runtime of runtimes) expect(Object.values(stored.tables.workspaces[runtime.workspaceId].aggregate.childRuns)).toMatchObject([{ status: 'cancelled' }])
    } finally { await host.dispose(); await Promise.allSettled(children); await providers.dispose(); vi.restoreAllMocks() }
  })

  test('dynamic agents reinjection resumes after a drained employee flush failure without reviving old identity', async () => {
    const host = await boot()
    host.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } as never)
    const first = await host.ctx.plugin(ctx => ctx.provide('agents', {
      create: async (options: { sessionId: SessionId }) => employee(options.sessionId, async () => { throw new Error('FLUSH_FAILED_ONCE') }),
      resume: async () => { throw new Error('unused') },
    } as never))
    const errors: unknown[] = []
    vi.spyOn(host.ctx.logger, 'error').mockImplementation(error => { errors.push(error) })
    let second: Awaited<ReturnType<Context['plugin']>> | undefined
    let resumes = 0
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const { agentId } = await seedRoom(runtime)
      const old = await runtime.ensureEmployee(agentId)
      await first.dispose()
      expect(runtime.agentIdFor(old.agent)).toBeUndefined()
      expect(runtime.admission.pending).toBe(0)
      expect(errors.some(error => containsFailure(error, 'FLUSH_FAILED_ONCE'))).toBe(true)
      second = await host.ctx.plugin(ctx => ctx.provide('agents', {
        create: async () => { throw new Error('unexpected replacement') },
        resume: async (options: { resumeSessionId: SessionId }) => { resumes++; return employee(options.resumeSessionId) },
      } as never))
      const resumed = await runtime.ensureEmployee(agentId)
      expect(resumes).toBe(1)
      expect(resumed).not.toBe(old)
      expect(resumed.agent.id).toBe(old.agent.id)
      expect(runtime.agentIdFor(old.agent)).toBeUndefined()
      expect(runtime.agentIdFor(resumed.agent)).toBe(agentId)
      await runtime.execute(runtime.snapshot().revision, { type: 'room/create', kind: 'group', name: 'After failure' })
      expect(errors.some(error => containsFailure(error, 'FLUSH_FAILED_ONCE'))).toBe(true)
    } finally { await host.dispose(); await first.dispose(); await second?.dispose(); vi.restoreAllMocks() }
  })

  test.each(['resume', 'root-close', 'root-close-failure'] as const)('dynamic agents reinjection retries an unsettled child terminal write before opening admission: %s', async mode => {
    let closeStarted = false
    const host = await boot(undefined, ctx => {
      const open = ctx.storageDomain.open.bind(ctx.storageDomain)
      vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async spec => {
        const domain = await open(spec)
        const close = domain.close.bind(domain)
        vi.spyOn(domain, 'close').mockImplementation(async () => { closeStarted = true; await close() })
        return domain
      })
    })
    host.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) } as never)
    const first = await host.ctx.plugin(ctx => ctx.provide('agents', {
      create: async (options: { sessionId: SessionId }) => employee(options.sessionId),
      resume: async (options: { resumeSessionId: SessionId }) => employee(options.resumeSessionId),
    } as never))
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const children = await host.ctx.plugin(ctx => ctx.provide('subagents', { start: async (_provider: string, request: { signal: AbortSignal }) => {
      started.resolve()
      return {
        result: new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })),
        dispose: async () => {},
      }
    } } as never))
    const errors: unknown[] = []
    vi.spyOn(host.ctx.logger, 'error').mockImplementation(error => { errors.push(error) })
    let child: Promise<string> | undefined
    let second: Awaited<ReturnType<Context['plugin']>> | undefined
    let installation: Promise<Awaited<ReturnType<Context['plugin']>>> | undefined
    let resumes = 0
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const { agentId } = await seedRoom(runtime)
      const old = await runtime.ensureEmployee(agentId)
      let taskId!: ReturnType<typeof assignHumanTask>['taskId']
      await runtime.apply(state => { const assigned = assignHumanTask(state, { humanId: HumanId('human'), assigneeAgentId: agentId, title: 'child work' }); taskId = assigned.taskId; return assigned.state })
      child = runtime.runChild(agentId, taskId, 'child')
      void child.catch(() => {})
      await started.promise
      const childId = Object.values(runtime.snapshot().childRuns)[0]!.id
      let retrying = false
      let entered = false
      const update = runtime.directory.updateAggregate.bind(runtime.directory)
      vi.spyOn(runtime.directory, 'updateAggregate').mockImplementation(async (id, mutation) => {
        const state = runtime.directory.snapshot(id)
        const candidate = mutation(state)
        if (state.childRuns[childId]?.status === 'running' && candidate.childRuns[childId]?.status !== 'running') {
          if (!retrying) throw new Error('CHILD_TERMINAL_WRITE_FAILED')
          entered = true
          await release.promise
          if (mode === 'root-close-failure') throw new Error('RETRY_WRITE_CANARY')
        }
        return await update(id, mutation)
      })
      await first.dispose()
      await child.catch(() => {})
      expect(runtime.snapshot().childRuns[childId]?.status).toBe('running')
      expect(runtime.admission.pending).toBe(0)
      expect(errors.some(error => containsFailure(error, 'CHILD_TERMINAL_WRITE_FAILED'))).toBe(true)
      retrying = true
      installation = Promise.resolve(host.ctx.plugin(ctx => ctx.provide('agents', {
        create: async () => { throw new Error('unexpected replacement') },
        resume: async (options: { resumeSessionId: SessionId }) => { resumes++; return employee(options.resumeSessionId) },
      } as never)))
      await expect.poll(() => entered).toBe(true)
      expect(runtime.snapshot().childRuns[childId]?.status).toBe('running')
      await expect(runtime.ensureEmployee(agentId)).rejects.toThrow(/closed/)
      if (mode === 'resume') {
        release.resolve()
        second = await installation
        await expect.poll(() => runtime.snapshot().childRuns[childId]?.status).toBe('cancelled')
        const resumed = await runtime.ensureEmployee(agentId)
        expect(runtime.agentIdFor(old.agent)).toBeUndefined()
        expect(runtime.agentIdFor(resumed.agent)).toBe(agentId)
        expect(resumes).toBe(1)
      } else {
        let finished = false
        const disposal = host.disposeHost().then(() => { finished = true })
        await expect.poll(() => host.ctx.agentWorkspace).toBeUndefined()
        expect(() => runtime.snapshot()).not.toThrow()
        expect(closeStarted).toBe(false)
        expect(finished).toBe(false)
        await expect(runtime.ensureEmployee(agentId)).rejects.toThrow(/closed/)
        release.resolve()
        await disposal
        second = await installation
        expect(closeStarted).toBe(true)
        expect(runtime.admission.pending).toBe(0)
        expect(resumes).toBe(0)
        expect(runtime.agentIdFor(old.agent)).toBeUndefined()
        const stored = JSON.parse(await readFile(join(host.root, 'agent_workspace.json'), 'utf8'))
        expect(stored.tables.workspaces.local.aggregate.childRuns[childId].status).toBe(mode === 'root-close' ? 'cancelled' : 'running')
        if (mode === 'root-close-failure') expect(errors.some(error => containsFailure(error, 'RETRY_WRITE_CANARY'))).toBe(true)
        expect(errors.some(error => containsFailure(error, "domain 'agent_workspace' is closed"))).toBe(false)
      }
      expect(errors.some(error => containsFailure(error, 'CHILD_TERMINAL_WRITE_FAILED'))).toBe(true)
    } finally {
      release.resolve()
      second ??= await installation
      await host.dispose()
      await child?.catch(() => {})
      await first.dispose()
      await second?.dispose()
      await children.dispose()
      vi.restoreAllMocks()
    }
  })

  test('Host teardown stops every child when one terminal write fails', async () => {
    const host = await boot()
    const started = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<void>()
    const results: ReturnType<typeof Promise.withResolvers<never>>[] = []
    const aborted: number[] = []
    const providers = await host.ctx.plugin(ctx => {
      ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } } as never)
      ctx.provide('subagents', { start: async (_provider: string, request: { signal: AbortSignal }) => {
        const result = Promise.withResolvers<never>()
        const index = results.length
        results.push(result)
        request.signal.addEventListener('abort', () => { aborted.push(index); result.reject(new Error('stopped')) }, { once: true })
        if (results.length === 2) started.resolve()
        return { result: result.promise, dispose: async () => {} }
      } } as never)
    })
    const errors: unknown[] = []
    const errorLog = vi.spyOn(host.ctx.logger, 'error').mockImplementation(error => { errors.push(error) })
    let children: Promise<string>[] = []
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const { agentId } = await seedRoom(runtime)
      let taskId!: ReturnType<typeof assignHumanTask>['taskId']
      await runtime.apply(state => { const assigned = assignHumanTask(state, { humanId: HumanId('human'), assigneeAgentId: agentId, title: 'child work' }); taskId = assigned.taskId; return assigned.state })
      vi.spyOn(runtime, 'ensureEmployee').mockResolvedValue({ agent: {} } as AgentHandle)
      children = [runtime.runChild(agentId, taskId, 'first'), runtime.runChild(agentId, taskId, 'second')]
      for (const child of children) void child.catch(() => {})
      await started.promise
      const firstId = Object.values(runtime.snapshot().childRuns)[0]!.id
      const update = runtime.directory.updateAggregate.bind(runtime.directory)
      vi.spyOn(runtime.directory, 'updateAggregate').mockImplementation(async (id, mutation) => update(id, state => {
        const next = mutation(state)
        if (state.childRuns[firstId]?.status === 'running' && next.childRuns[firstId]?.status !== 'running') {
          failed.resolve()
          throw new Error('child terminal persistence failed')
        }
        return next
      }))
      const disposal = host.disposeHost()
      await failed.promise
      expect(aborted.toSorted()).toEqual([0, 1])
      await disposal
      expect(runtime.admission.pending).toBe(0)
      expect(errors.some(error => containsFailure(error, 'child terminal persistence failed'))).toBe(true)
      const stored = JSON.parse(await readFile(join(host.root, 'agent_workspace.json'), 'utf8'))
      expect(Object.values(stored.tables.workspaces.local.aggregate.childRuns)).toMatchObject([{ status: 'running' }, { status: 'cancelled' }])
    } finally {
      for (const result of results) result.reject(new Error('test cleanup'))
      await Promise.allSettled(children)
      vi.restoreAllMocks()
      await host.dispose()
      await providers.dispose()
      errorLog.mockRestore()
    }
  })

  test('creates idempotently and routes equal internal IDs to independent fixed runtimes', async () => {
    const host = await boot()
    try {
      const a = await host.service.createOrganization(WorkspaceOperationId('create-a'), '甲公司')
      const b = await host.service.createOrganization(WorkspaceOperationId('create-b'), '乙公司')
      expect(await host.service.createOrganization(WorkspaceOperationId('create-a'), '甲公司')).toEqual(a)
      await expect(host.service.createOrganization(WorkspaceOperationId('create-a'), '别的公司')).rejects.toThrow()
      const first = host.service.forWorkspace(a.descriptor.id)
      const second = host.service.forWorkspace(b.descriptor.id)
      await first.execute(0, { type: 'definition/create', name: '甲工程师', description: '', instructions: '' })
      await second.execute(0, { type: 'definition/create', name: '乙工程师', description: '', instructions: '' })
      expect(Object.keys(first.snapshot().definitions)).toEqual(Object.keys(second.snapshot().definitions))
      expect(Object.values(first.snapshot().definitions)[0]?.name).toBe('甲工程师')
      expect(Object.values(second.snapshot().definitions)[0]?.name).toBe('乙工程师')
      expect(host.service.forWorkspace(a.descriptor.id)).toBe(first)
      expect(() => host.service.forWorkspace(WorkspaceId('missing'))).toThrow()
      expect(first.activitySnapshot()).not.toBe(second.activitySnapshot())
    } finally { await host.dispose() }
  })

  test('stores descriptors and aggregates together and preserves the directory across restart', async () => {
    const first = await boot()
    const created = await first.service.createOrganization(WorkspaceOperationId('restart-create'), '持久组织')
    await first.service.renameOrganization(created.descriptor.id, '新名字')
    await first.dispose()
    const stored = JSON.parse(await readFile(join(first.root, 'agent_workspace.json'), 'utf8'))
    expect(stored.unit.version).toBe(0)
    expect(stored.tables.workspaces[created.descriptor.id]).toMatchObject({ recordVersion: 1, descriptor: { label: '新名字' }, aggregate: { workspaceId: created.descriptor.id } })
    const restarted = await boot(first.root)
    try { expect(restarted.service.listOrganizations().find(entry => entry.descriptor.id === created.descriptor.id)?.descriptor.label).toBe('新名字') }
    finally { await restarted.dispose() }
  })

  test('archives read-only and reopens without rewriting aggregate history', async () => {
    const host = await boot()
    try {
      const local = host.service.forWorkspace(WorkspaceId('local'))
      await local.execute(0, { type: 'definition/create', name: '岗位', description: '', instructions: '' })
      const before = local.snapshot()
      await host.service.archiveOrganization(WorkspaceId('local'), 'wait')
      await expect(local.execute(before.revision, { type: 'room/create', kind: 'group', name: '非法' })).rejects.toThrow()
      expect(local.snapshot()).toEqual(before)
      await host.service.reopenOrganization(WorkspaceId('local'))
      await local.execute(before.revision, { type: 'room/create', kind: 'group', name: '继续工作' })
      expect(Object.values(local.snapshot().rooms)[0]?.name).toBe('继续工作')
    } finally { await host.dispose() }
  })

  test('previews without writing and confirms a detached new organization only once', async () => {
    const host = await boot()
    try {
      const local = host.service.forWorkspace(WorkspaceId('local'))
      await local.execute(0, { type: 'definition/create', name: '设计师', description: '', instructions: '敏感指令' })
      const before = local.snapshot()
      const exported = await host.service.exportOrganization(WorkspaceId('local'))
      const directory = host.service.listOrganizations()
      const preview = host.service.previewImport(exported.json)
      expect(host.service.listOrganizations()).toEqual(directory)
      const restored = await host.service.importOrganization(preview.operationId, exported.json, '恢复的公司')
      expect(restored.descriptor.id).not.toBe('local')
      expect(restored.aggregate.definitions).toEqual(before.definitions)
      expect(restored.aggregate.sessionBindings).toEqual({})
      expect(await host.service.importOrganization(preview.operationId, exported.json, '恢复的公司')).toEqual(restored)
      expect(host.service.listOrganizations()).toHaveLength(2)
      expect(local.snapshot()).toEqual(before)
    } finally { await host.dispose() }
  })

  test('rejects malformed imports without modifying any record', async () => {
    const host = await boot()
    try {
      const before = host.service.listOrganizations()
      expect(() => host.service.previewImport('{')).toThrow()
      await expect(host.service.importOrganization(WorkspaceOperationId('bad'), '{}', '坏文件')).rejects.toThrow()
      expect(host.service.listOrganizations()).toEqual(before)
    } finally { await host.dispose() }
  })

  test('keeps a human room chain reserved through acknowledgement until its full completion', async () => {
    const host = await boot()
    const completion = Promise.withResolvers<void>()
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const { roomId, agentId } = await seedRoom(runtime)
      Reflect.set(runtime, 'dispatcher', { continueCommittedHumanMessage: () => completion.promise })
      await runtime.postHumanMessage(runtime.snapshot().revision, roomId, HumanId('human'), '明确工作', [agentId])
      expect(runtime.admission.pending).toBe(1)
      await expect(host.service.exportOrganization(runtime.workspaceId)).rejects.toThrow(/busy/i)
      const persisted = Promise.withResolvers<void>()
      const setLifecycle = runtime.directory.setLifecycle.bind(runtime.directory)
      vi.spyOn(runtime.directory, 'setLifecycle').mockImplementation(async (...args) => { const value = await setLifecycle(...args); persisted.resolve(); return value })
      let finished = false
      const archived = host.service.archiveOrganization(runtime.workspaceId, 'wait').then(value => { finished = true; return value })
      await persisted.promise
      expect(finished).toBe(false)
      await expect(runtime.execute(runtime.snapshot().revision, { type: 'room/create', kind: 'group', name: '不能新入场' })).rejects.toThrow(/closed/i)
      await expect(host.service.reopenOrganization(runtime.workspaceId)).rejects.toThrow(/busy/i)
      completion.resolve()
      expect((await archived).descriptor.lifecycle).toBe('archived')
      expect(runtime.admission.pending).toBe(0)
    } finally { completion.resolve(); vi.restoreAllMocks(); await host.dispose() }
  })

  test('reserves before the first durable await and honours cancellation while a create is queued', async () => {
    const host = await boot()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const update = runtime.directory.updateAggregate.bind(runtime.directory)
      vi.spyOn(runtime.directory, 'updateAggregate').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return await update(...args) })
      const mutation = runtime.execute(0, { type: 'room/create', kind: 'group', name: '已接收' })
      await entered.promise
      expect(runtime.admission.pending).toBe(1)
      await expect(host.service.exportOrganization(runtime.workspaceId)).rejects.toThrow(/busy/i)
      // A pre-aborted create must not enter the durable directory queue.
      const abort = new AbortController(); abort.abort()
      await expect(host.service.createOrganization(WorkspaceOperationId('cancelled-create'), '取消', abort.signal)).rejects.toThrow()
      release.resolve(); await mutation
      expect(host.service.listOrganizations()).toHaveLength(1)
    } finally { release.resolve(); vi.restoreAllMocks(); await host.dispose() }
  })

  test('an archive write failure restores admission without stopping work or changing history', async () => {
    const host = await boot()
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const before = runtime.snapshot()
      const stop = vi.spyOn(runtime, 'stopAdmittedWork')
      vi.spyOn(runtime.directory, 'setLifecycle').mockRejectedValueOnce(new Error('write failed'))
      await expect(host.service.archiveOrganization(runtime.workspaceId, 'stop')).rejects.toThrow('write failed')
      expect(stop).not.toHaveBeenCalled()
      expect(runtime.snapshot()).toEqual(before)
      expect(host.service.listOrganizations()[0]?.descriptor.lifecycle).toBe('active')
      await runtime.execute(before.revision, { type: 'room/create', kind: 'group', name: '仍可工作' })
    } finally { vi.restoreAllMocks(); await host.dispose() }
  })

  test('archive rejects failed recovered-task terminal persistence and keeps the committed archived record', async () => {
    const host = await boot()
    const tracked = Promise.withResolvers<WorkspaceTurnOutcome>()
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const { agentId } = await seedRoom(runtime)
      const assigned = assignHumanTask(runtime.snapshot(), { humanId: HumanId('human'), assigneeAgentId: agentId, title: 'recovered work' })
      const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
      const accepted = acceptTaskDelivery(started.state, { taskId: assigned.taskId, attemptId: started.attemptId, messageId: started.message.id })
      await runtime.apply(() => accepted.state)
      let terminalWriteFailures = 0
      const coordinator = new TaskDeliveryCoordinator({
        snapshot: () => runtime.snapshot(),
        apply: mutation => runtime.apply(current => {
          const next = mutation(current)
          if (next.events.at(-1)?.type === 'task/delivery-failed') {
            terminalWriteFailures++
            throw new Error('terminal persistence unavailable')
          }
          return next
        }),
        ensureEmployee: async () => { throw new Error('unused') },
        deliver: async () => { throw new Error('unused') },
        recoverDelivery: async () => await tracked.promise,
      })
      const resumed = { agent: {
        id: SessionId('recovered'), inbox: { nextTurn: [started.message], nextStep: [] }, session: { snapshotEvents: () => [] },
      } } as Pick<AgentHandle, 'agent'>
      await coordinator.recoverAgent(agentId, resumed)
      Reflect.set(runtime, 'taskDelivery', coordinator)
      const stop = runtime.stopAdmittedWork.bind(runtime)
      vi.spyOn(runtime, 'stopAdmittedWork').mockImplementation(async () => {
        await stop()
        tracked.resolve({ output: [], stopReason: { kind: 'aborted' }, interrupted: true })
      })
      await expect(host.service.archiveOrganization(runtime.workspaceId, 'stop')).rejects.toThrow(/unfinished task delivery/)
      expect(terminalWriteFailures).toBe(1)
      expect(runtime.directory.record(runtime.workspaceId).descriptor.lifecycle).toBe('archived')
      expect(inspectTaskDelivery(runtime.snapshot(), assigned.taskId).phase).toBe('accepted')
      await expect(runtime.execute(runtime.snapshot().revision, { type: 'room/create', kind: 'group', name: 'still closed' })).rejects.toThrow(/closed/)
    } finally {
      tracked.resolve({ output: [], stopReason: { kind: 'aborted' }, interrupted: true })
      vi.restoreAllMocks()
      await host.dispose()
    }
  })

  test.each(['started task', 'running child'] as const)('archive rejects durable %s work after process-local draining', async kind => {
    const host = await boot()
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const { agentId } = await seedRoom(runtime)
      const assigned = assignHumanTask(runtime.snapshot(), { humanId: HumanId('human'), assigneeAgentId: agentId, title: 'unfinished work' })
      const unfinished = kind === 'started task'
        ? startTaskDelivery(assigned.state, { taskId: assigned.taskId }).state
        : recordChildRunStarted(assigned.state, { parentAgentId: agentId, taskId: assigned.taskId }).state
      await runtime.apply(() => unfinished)
      await expect(host.service.archiveOrganization(runtime.workspaceId, 'wait')).rejects.toThrow(kind === 'started task' ? /unfinished task delivery/ : /unfinished child work/)
      expect(runtime.directory.record(runtime.workspaceId).descriptor.lifecycle).toBe('archived')
      expect(runtime.snapshot()).toEqual(unfinished)
      expect(runtime.admission.pending).toBe(0)
    } finally { await host.dispose() }
  })

  test('an export capture excludes concurrent metadata mutations and releases its barrier', async () => {
    const host = await boot()
    try {
      const exported = host.service.exportOrganization(WorkspaceId('local'))
      await expect(host.service.renameOrganization(WorkspaceId('local'), '不能穿透导出')).rejects.toThrow(/busy/i)
      expect((await exported).document).toMatchObject({ workspace: { descriptor: { label: 'Local organization' } } })
      await host.service.renameOrganization(WorkspaceId('local'), '捕获后可改名')
    } finally { await host.dispose() }
  })

  test('stop-mode archive waits for child handle disposal and leaves another organization usable', async () => {
    const host = await boot()
    const started = Promise.withResolvers<void>()
    const disposing = Promise.withResolvers<void>()
    const disposed = Promise.withResolvers<void>()
    try {
      const runtime = host.service.forWorkspace(WorkspaceId('local'))
      const { agentId } = await seedRoom(runtime)
      let taskId!: ReturnType<typeof assignHumanTask>['taskId']
      await runtime.apply(state => { const assigned = assignHumanTask(state, { humanId: HumanId('human'), assigneeAgentId: agentId, title: 'child work' }); taskId = assigned.taskId; return assigned.state })
      const controllers = Reflect.get(runtime, 'childControllers') as ChildControllerRegistry
      const dispatcher = new WorkspaceDispatcher({
        snapshot: () => runtime.snapshot(), apply: mutation => runtime.apply(mutation),
        execute: async () => { throw new Error('unused') }, deliver: async () => { throw new Error('unused') },
        ensureEmployee: async () => ({ agent: {} } as AgentHandle),
      }, { start: async (_provider, request) => {
        started.resolve()
        const result = new Promise<never>((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }) })
        return { result, dispose: async () => { disposing.resolve(); await disposed.promise } }
      } }, 'spawn', { maxAgentHops: 3, maxRepliesPerRoot: 8, recallCharacterBudget: 4000 }, undefined, controllers)
      Reflect.set(runtime, 'dispatcher', dispatcher)
      const child = runtime.runChild(agentId, taskId, 'run child')
      void child.catch(() => {})
      await started.promise
      let archived = false
      const archive = host.service.archiveOrganization(runtime.workspaceId, 'stop').then(record => { archived = true; return record })
      await disposing.promise
      expect(archived).toBe(false)
      expect(runtime.admission.pending).toBe(1)
      const other = await host.service.createOrganization(WorkspaceOperationId('other'), '另一组织')
      await host.service.forWorkspace(other.descriptor.id).execute(0, { type: 'room/create', kind: 'group', name: '不受影响' })
      disposed.resolve()
      await expect(child).rejects.toThrow()
      expect((await archive).descriptor.lifecycle).toBe('archived')
      expect(Object.values(runtime.snapshot().childRuns)[0]?.status).toBe('cancelled')
      expect(runtime.snapshot().tasks[taskId]?.status).toBe('open')
    } finally { disposed.resolve(); await host.dispose() }
  })
})

async function seedRoom(runtime: WorkspaceRuntime) {
  await runtime.execute(runtime.snapshot().revision, { type: 'definition/create', name: 'Worker', description: '', instructions: '' })
  const definitionId = Object.values(runtime.snapshot().definitions)[0]!.id
  await runtime.execute(runtime.snapshot().revision, { type: 'agent/create', definitionId, name: 'Alice' })
  const agentId = Object.values(runtime.snapshot().agents)[0]!.id
  await runtime.execute(runtime.snapshot().revision, { type: 'room/create', kind: 'group', name: '工作群' })
  const roomId = Object.values(runtime.snapshot().rooms)[0]!.id
  await runtime.execute(runtime.snapshot().revision, { type: 'room/join', roomId, agentId, memoryStart: { type: 'new-events' } })
  return { roomId, agentId }
}

function employee(sessionId: SessionId, dispose: () => Promise<void> = async () => {}): AgentHandle {
  return { agent: { id: sessionId, whenIdle: async () => {} } as Agent, dispose }
}

function containsFailure(error: unknown, message: string): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes(message)
    || error instanceof AggregateError && error.errors.some(item => containsFailure(item, message))
    || containsFailure(error.cause, message)
}
