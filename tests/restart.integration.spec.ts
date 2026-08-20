import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import { agentWorkspaceSpec } from '../packages/host/src/spec.ts'
import { AgentId, HumanId } from '../packages/host/src/ids.ts'

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
    await first.dispose()

    const second = await boot(root)
    expect(second.service.snapshot()).toEqual(after)
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
})
