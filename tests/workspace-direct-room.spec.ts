import { describe, expect, it } from 'vitest'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { assertWorkspaceInvariants } from '../packages/host/src/invariant.ts'
import { resolveHumanWakeTargets } from '../packages/host/src/room-policy.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'

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

describe('direct workspace rooms', () => {
  it('allows exactly one active agent membership', () => {
    const fixture = twoAgents()
    const direct = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'direct' })
    const joined = mutateWorkspace(direct.state, {
      type: 'room/join', roomId: direct.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    })
    const invalid = mutateWorkspace(joined.state, {
      type: 'room/join', roomId: direct.roomId, agentId: fixture.bobId, memoryStart: { type: 'new-events' },
    }).state
    expect(() => assertWorkspaceInvariants(invalid)).toThrow(/direct room.*active member/i)
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
    expect(() => resolveHumanWakeTargets(departed, direct.roomId, [])).toThrow(/exactly one active employed member/i)
  })

  it('does not alter the external human identity used for direct delivery', () => {
    expect(HumanId('web-user')).toBe('web-user')
  })
})
