import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import { WorkspaceBusinessError } from '../packages/host/src/errors.ts'
import { AgentId, DefinitionRevisionId, HumanId, RoomId, WorkspaceId } from '../packages/host/src/ids.ts'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import { assertWorkspaceInvariants } from '../packages/host/src/invariant.ts'
import { assertDirectRoomTextAllowed, resolveHumanWakeTargets } from '../packages/host/src/room-policy.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assertAssignedTaskRunnable } from '../packages/host/src/task-policy.ts'
import { assignDelegatedTask, assignHumanTask } from '../packages/host/src/tasks.ts'

function twoAgents() {
  let state = createInitialState(WorkspaceId('direct-test'))
  const definition = mutateWorkspace(state, {
    type: 'definition/create', name: 'Worker', description: '', instructions: '',
  })
  state = definition.state
  const alice = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
  state = alice.state
  const bob = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Bob' })
  return { state: bob.state, aliceId: alice.agentId, bobId: bob.agentId }
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function boot(): Promise<{ service: AgentWorkspaceDomainService; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-group-direct-'))
  roots.push(root)
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }),
    await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }),
    await ctx.plugin(AgentWorkspaceDomainService),
  ]
  return {
    service: ctx.agentWorkspace,
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    },
  }
}

describe('direct workspace rooms', () => {
  it('reuses the same direct room when an employed agent is opened twice', async () => {
    const booted = await boot()
    try {
      await booted.service.execute({ type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      let snapshot = booted.service.snapshot()
      const definition = Object.values(snapshot.definitions)[0]!
      await booted.service.execute({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
      snapshot = booted.service.snapshot()
      const alice = Object.values(snapshot.agents)[0]!

      const created = await booted.service.openDirectRoom(alice.id)
      const reopened = await booted.service.openDirectRoom(alice.id)

      expect(reopened.roomId).toBe(created.roomId)
      expect(reopened.state).toEqual(created.state)
      expect(Object.values(reopened.state.rooms).filter(room => room.kind === 'direct')).toHaveLength(1)
    } finally {
      await booted.dispose()
    }
  })

  it('allows exactly one active agent membership', () => {
    const fixture = twoAgents()
    const direct = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'direct' })
    const joined = mutateWorkspace(direct.state, {
      type: 'room/join', roomId: direct.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    })
    const invalid = mutateWorkspace(joined.state, {
      type: 'room/join', roomId: direct.roomId, agentId: fixture.bobId, memoryStart: { type: 'new-events' },
    }).state
    expect(() => assertWorkspaceInvariants(invalid, WorkspaceId('direct-test'))).toThrow(/direct room.*active member/i)
  })

  it('auto-targets the sole active employed member for a direct human post', () => {
    const fixture = twoAgents()
    const direct = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'direct' })
    const joined = mutateWorkspace(direct.state, {
      type: 'room/join', roomId: direct.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    }).state
    expect(resolveHumanWakeTargets(joined, direct.roomId, [])).toEqual([fixture.aliceId])
  })

  it('keeps group human routing explicit and validates the supplied targets', () => {
    const fixture = twoAgents()
    const group = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'group', name: 'group' })
    let state = mutateWorkspace(group.state, {
      type: 'room/join', roomId: group.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    }).state
    state = mutateWorkspace(state, {
      type: 'room/join', roomId: group.roomId, agentId: fixture.bobId, memoryStart: { type: 'new-events' },
    }).state
    expect(resolveHumanWakeTargets(state, group.roomId, [])).toEqual([])
    expect(resolveHumanWakeTargets(state, group.roomId, [fixture.bobId])).toEqual([fixture.bobId])
  })

  it('rejects a direct post when the sole target is no longer employed', () => {
    const fixture = twoAgents()
    const direct = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'direct' })
    const joined = mutateWorkspace(direct.state, {
      type: 'room/join', roomId: direct.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    }).state
    const departed = mutateWorkspace(joined, { type: 'agent/depart', agentId: fixture.aliceId }).state
    expect(() => resolveHumanWakeTargets(departed, direct.roomId, [])).toThrowError(expect.objectContaining({
      code: 'agent-departed',
      details: { agentId: fixture.aliceId },
    }))
  })

  it('does not alter the external human identity used for direct delivery', () => {
    expect(HumanId('web-user')).toBe('web-user')
  })

  it('rejects only a complete lowercase @all token in direct-room text', () => {
    for (const text of ['@all', '请 @all 处理', '请（@all）处理', '@all🙂']) {
      expect(() => assertDirectRoomTextAllowed(RoomId('room-direct'), text)).toThrowError(
        new WorkspaceBusinessError('reserved-direct-routing', { roomId: 'room-direct', token: '@all' }),
      )
    }
    for (const text of ['@alloy', '@All', '请@all处理', '@allé', '@all\u0301', '\u203f@all']) {
      expect(() => assertDirectRoomTextAllowed(RoomId('room-direct'), text)).not.toThrow()
    }
  })

  it('rejects direct @all before durable state or delivery status changes', async () => {
    const booted = await boot()
    try {
      await booted.service.execute({ type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      let snapshot = booted.service.snapshot()
      const definition = Object.values(snapshot.definitions)[0]!
      await booted.service.execute({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
      snapshot = booted.service.snapshot()
      const alice = Object.values(snapshot.agents)[0]!
      const direct = await booted.service.openDirectRoom(alice.id)
      const before = booted.service.snapshot()
      const runtimeBefore = booted.service.runtimeStatus()

      await expect(booted.service.postHumanMessage(direct.roomId, HumanId('web-user'), '@all hello', []))
        .rejects.toMatchObject({
          code: 'reserved-direct-routing',
          details: { roomId: direct.roomId, token: '@all' },
        })

      expect(booted.service.snapshot()).toEqual(before)
      expect(booted.service.runtimeStatus()).toEqual(runtimeBefore)
    } finally {
      await booted.dispose()
    }
  })

  it('returns stable agent codes when opening a missing or departed direct target', async () => {
    const booted = await boot()
    try {
      await expect(booted.service.openDirectRoom(AgentId('agent-missing')))
        .rejects.toMatchObject({ code: 'agent-missing', details: { agentId: 'agent-missing' } })
      await booted.service.execute({ type: 'definition/create', name: 'Worker', description: '', instructions: '' })
      let snapshot = booted.service.snapshot()
      const definition = Object.values(snapshot.definitions)[0]!
      await booted.service.execute({ type: 'agent/create', definitionId: definition.id, name: 'Alice' })
      snapshot = booted.service.snapshot()
      const alice = Object.values(snapshot.agents)[0]!
      await booted.service.execute({ type: 'agent/depart', agentId: alice.id })
      await expect(booted.service.openDirectRoom(alice.id))
        .rejects.toMatchObject({ code: 'agent-departed', details: { agentId: alice.id } })
    } finally {
      await booted.dispose()
    }
  })

  it('identifies missing and departed mention targets by stable agent ids', () => {
    const fixture = twoAgents()
    const group = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'group', name: 'group' })
    expect(() => resolveHumanWakeTargets(group.state, group.roomId, ['agent-missing' as typeof fixture.aliceId]))
      .toThrowError(expect.objectContaining({ code: 'agent-missing', details: { agentId: 'agent-missing' } }))

    const departed = mutateWorkspace(group.state, { type: 'agent/depart', agentId: fixture.aliceId }).state
    expect(() => resolveHumanWakeTargets(departed, group.roomId, [fixture.aliceId]))
      .toThrowError(expect.objectContaining({ code: 'agent-departed', details: { agentId: fixture.aliceId } }))
  })

  it('identifies duplicate membership by stable room and agent ids', () => {
    const fixture = twoAgents()
    const group = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'group', name: 'group' })
    const joined = mutateWorkspace(group.state, {
      type: 'room/join', roomId: group.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    }).state
    expect(() => mutateWorkspace(joined, {
      type: 'room/join', roomId: group.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    })).toThrowError(expect.objectContaining({
      code: 'duplicate-membership',
      details: { roomId: group.roomId, agentId: fixture.aliceId },
    }))
  })

  it('identifies stale definition revisions by stable definition and revision ids', () => {
    const fixture = twoAgents()
    const definitionId = fixture.state.agents[fixture.aliceId]!.definitionId
    expect(() => mutateWorkspace(fixture.state, {
      type: 'definition/synchronize',
      definitionId,
      definitionRevisionId: DefinitionRevisionId('definition-revision-missing'),
      agentIds: [fixture.aliceId],
    })).toThrowError(expect.objectContaining({
      code: 'stale-revision',
      details: { definitionId, revisionId: 'definition-revision-missing' },
    }))
  })

  it('distinguishes missing delegation grants from task assignment failures', () => {
    const fixture = twoAgents()
    const assigned = assignHumanTask(fixture.state, {
      humanId: HumanId('owner'), assigneeAgentId: fixture.aliceId, title: 'root task',
    })
    expect(() => assignDelegatedTask(assigned.state, {
      actorAgentId: fixture.bobId,
      assigneeAgentId: fixture.aliceId,
      rootTaskId: assigned.taskId,
      title: 'unauthorized child',
    })).toThrowError(expect.objectContaining({
      code: 'delegation-grant-missing',
      details: { lookup: 'root-agent', rootTaskId: assigned.taskId, agentId: fixture.bobId },
    }))
    expect(() => assertAssignedTaskRunnable(assigned.state, fixture.bobId, assigned.taskId))
      .toThrowError(expect.objectContaining({
        code: 'task-not-assigned',
        details: { taskId: assigned.taskId, agentId: fixture.bobId },
      }))
  })
})
