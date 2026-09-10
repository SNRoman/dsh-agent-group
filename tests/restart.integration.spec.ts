import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import { queryAgentMemory } from '../packages/host/src/memory-query.ts'
import { agentWorkspaceSpec } from '../packages/host/src/spec.ts'
import { AgentId, HumanId, TaskId } from '../packages/host/src/ids.ts'
import type { TaskId as WorkspaceTaskId } from '../packages/host/src/ids.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { assignHumanTask, recordChildRunStarted } from '../packages/host/src/tasks.ts'
import { TaskDeliveryCoordinator } from '../packages/host/src/task-delivery-coordinator.ts'
import type { TaskDeliveryCoordinatorHost } from '../packages/host/src/task-delivery-coordinator.ts'

interface Booted {
  ctx: Context
  service: AgentWorkspaceDomainService
  dispose: () => Promise<void>
}

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Boot the real storage hub, JSON backend, domain form, and workspace service over one root. */
async function boot(root: string): Promise<Booted> {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }),
    await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
    await ctx.plugin(AgentWorkspaceDomainService),
  ]
  return {
    ctx,
    service: ctx.agentWorkspace,
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    },
  }
}

describe('agent workspace persistence', () => {
  test('opens, mutates, and restarts an authentic v0.1.0 workspace', async () => {
    const root = await freshRoot()
    const fixture = new URL('./fixtures/v0.1.0/agent-workspace.json', import.meta.url)
    const stored = JSON.parse(await readFile(fixture, 'utf8')) as {
      tables: { workspaces: { local: unknown } }
    }
    await copyFile(fixture, join(root, 'agent_workspace.json'))

    const first = await boot(root)
    expect(first.service.snapshot()).toEqual(stored.tables.workspaces.local)
    await first.service.execute({ type: 'room/create', kind: 'group', name: 'release follow-up' })
    const afterMutation = first.service.snapshot()
    expect(afterMutation.revision).toBe(6)
    await first.dispose()

    const second = await boot(root)
    expect(second.service.snapshot()).toEqual(afterMutation)
    await second.dispose()
  })

  test('restores the committed aggregate after teardown and reboot', async () => {
    const root = await freshRoot()
    const first = await boot(root)
    await first.service.execute({
      type: 'definition/create',
      name: 'Java engineer',
      description: 'Build Java services',
      instructions: 'Act as a Java engineer.',
    })
    let snapshot = first.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await first.service.execute({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    snapshot = first.service.snapshot()
    const agent = Object.values(snapshot.agents)[0]!
    await first.service.execute({ type: 'room/create', kind: 'group', name: 'engineering' })
    snapshot = first.service.snapshot()
    const room = Object.values(snapshot.rooms)[0]!
    await first.service.execute({ type: 'room/join', roomId: room.id, agentId: agent.id, memoryStart: { type: 'new-events' } })
    await first.service.execute({
      type: 'room/message',
      roomId: room.id,
      actor: { type: 'human', id: HumanId('owner') },
      text: 'Release on Friday',
      mentions: [agent.id],
    })
    const after = first.service.snapshot()
    expect(after.revision).toBe(5)
    const beforeRestartMemory = queryAgentMemory(after, { agentId: agent.id, snapshotRevision: after.revision, limit: 10 })
    expect(beforeRestartMemory.items).toHaveLength(1)
    await first.service.execute({ type: 'agent/depart', agentId: agent.id })
    const departed = first.service.snapshot()
    await first.dispose()

    const second = await boot(root)
    expect(second.service.snapshot()).toEqual(departed)
    expect(queryAgentMemory(second.service.snapshot(), {
      agentId: agent.id, snapshotRevision: departed.revision, limit: 10,
    }).items).toEqual(beforeRestartMemory.items)
    await second.dispose()
  })

  test('rejects a stored domain version mismatch at open', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'agent_workspace.json'),
      JSON.stringify({ unit: { name: 'agent_workspace', version: 1 }, global: null, tables: { workspaces: {} } }),
      'utf8',
    )
    const ctx = new Context()
    const fibers = [
      await ctx.plugin(Storage),
      await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }),
      await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
    ]
    await expect(ctx.storageDomain.open(agentWorkspaceSpec)).rejects.toMatchObject({ code: 'version-mismatch' })
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })

  test('a rejected command leaves the committed aggregate unchanged', async () => {
    const root = await freshRoot()
    const booted = await boot(root)
    const before = booted.service.snapshot()
    await expect(booted.service.execute({ type: 'agent/depart', agentId: AgentId('missing') })).rejects.toThrow(/does not exist/)
    const after = booted.service.snapshot()
    expect(after.revision).toBe(before.revision)
    expect(after.events).toEqual(before.events)
    await booted.dispose()
  })

  test('restarts after a failed wake and retries the same durable task', async () => {
    const root = await freshRoot()
    const first = await boot(root)
    await first.service.execute({ type: 'definition/create', name: 'Worker', description: 'work', instructions: 'reply' })
    let snapshot = first.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await first.service.execute({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    snapshot = first.service.snapshot()
    const agent = Object.values(snapshot.agents)[0]!
    let taskId: WorkspaceTaskId | undefined
    await first.service.apply(current => {
      const assigned = assignHumanTask(current, {
        humanId: HumanId('owner'),
        assigneeAgentId: agent.id,
        title: 'persist me',
      })
      taskId = assigned.taskId
      return assigned.state
    })
    if (taskId === undefined) throw new Error('task assignment did not publish an id')
    const fakeHandle = { agent: { id: 'session' } as never, dispose: async () => {} } as AgentHandle
    const failedHost: TaskDeliveryCoordinatorHost = {
      snapshot: () => first.service.snapshot(),
      apply: async mutation => await first.service.apply(mutation),
      ensureEmployee: async () => fakeHandle,
      deliver: async () => { throw new Error('wake failed') },
    }
    await expect(new TaskDeliveryCoordinator(failedHost).deliver(taskId)).rejects.toThrow('wake failed')
    const beforeRestart = first.service.snapshot()
    await first.dispose()

    const second = await boot(root)
    expect(second.service.snapshot()).toEqual(beforeRestart)
    const resumedHost: TaskDeliveryCoordinatorHost = {
      snapshot: () => second.service.snapshot(),
      apply: async mutation => await second.service.apply(mutation),
      ensureEmployee: async () => fakeHandle,
      deliver: async (_agentId, _message, _recall, _source, hooks) => {
        await hooks?.onClaim?.()
        return { output: [{ type: 'text', text: 'finished after restart' }], stopReason: { kind: 'completed' }, interrupted: false }
      },
    }
    await expect(new TaskDeliveryCoordinator(resumedHost).retryTaskDelivery(taskId)).resolves.toBe('finished after restart')
    const afterRetry = second.service.snapshot()
    expect(Object.keys(afterRetry.tasks)).toEqual([taskId])
    expect(afterRetry.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(2)
    expect(afterRetry.events.filter(event => event.type === 'task/result')).toHaveLength(1)
    await second.dispose()
  })

  test('the Host exposes durable task retry through its service boundary', async () => {
    const root = await freshRoot()
    const booted = await boot(root)

    await expect(booted.service.retryTaskDelivery(TaskId('missing'))).rejects.toThrow(/coordinator is not available/)

    await booted.dispose()
  })

  test('repairs a durable running child before the restarted Host accepts work', async () => {
    const root = await freshRoot()
    const first = await boot(root)
    await first.service.execute({ type: 'definition/create', name: 'Worker', description: 'work', instructions: 'reply' })
    let snapshot = first.service.snapshot()
    const definition = Object.values(snapshot.definitions)[0]!
    await first.service.execute({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
    snapshot = first.service.snapshot()
    const agent = Object.values(snapshot.agents)[0]!
    let childRunId: ReturnType<typeof recordChildRunStarted>['childRunId'] | undefined
    await first.service.apply(current => {
      const assigned = assignHumanTask(current, {
        humanId: HumanId('owner'), assigneeAgentId: agent.id, title: 'orphan me',
      })
      const started = recordChildRunStarted(assigned.state, {
        parentAgentId: agent.id, taskId: assigned.taskId,
      })
      childRunId = started.childRunId
      return started.state
    })
    if (childRunId === undefined) throw new Error('child run start did not publish an id')
    expect(first.service.snapshot().childRuns[childRunId]?.status).toBe('running')
    await first.dispose()

    const second = await boot(root)
    expect(second.service.snapshot().childRuns[childRunId]).toMatchObject({
      status: 'cancelled',
      result: 'Host restarted before the child run settled.',
    })
    expect(second.service.snapshot().events.filter(event => (
      event.type === 'child/run-finished' && event.subjectId === childRunId
    ))).toHaveLength(1)
    await second.dispose()
  })
})
