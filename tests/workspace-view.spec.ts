import { describe, expect, it } from 'vitest'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import {
  activeRoomMembers,
  appendDisplayMention,
  parseMentionIds,
  parseRoomMentionIds,
  roomMessageEvents,
} from '../packages/web/src/client/view-model.ts'

function workspaceFixture() {
  let state = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(state, {
    type: 'definition/create',
    name: '工程师',
    description: '',
    instructions: '',
  })
  state = definition.state
  const alice = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
  state = alice.state
  const bob = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Bob' })
  state = bob.state
  const room = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: '研发群' })
  state = room.state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: alice.agentId, memoryStart: { type: 'new-events' } }).state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: bob.agentId, memoryStart: { type: 'new-events' } }).state
  state = mutateWorkspace(state, {
    type: 'room/message',
    roomId: room.roomId,
    actor: { type: 'human', id: HumanId('web-user') },
    text: `Alice 请看一下 <@${bob.agentId}>`,
    mentions: [bob.agentId],
  }).state
  return { state, aliceId: alice.agentId, bobId: bob.agentId, roomId: room.roomId }
}

function roleAliasFixture() {
  let state = createInitialState(WorkspaceId('roles'))
  const productDefinition = mutateWorkspace(state, {
    type: 'definition/create', name: '产品经理', description: '', instructions: '',
  })
  state = productDefinition.state
  const architectDefinition = mutateWorkspace(state, {
    type: 'definition/create', name: '系统架构师', description: '', instructions: '',
  })
  state = architectDefinition.state
  const product = mutateWorkspace(state, {
    type: 'agent/create', definitionId: productDefinition.definitionId, name: '张产品',
  })
  state = product.state
  const architect = mutateWorkspace(state, {
    type: 'agent/create', definitionId: architectDefinition.definitionId, name: '老周',
  })
  state = architect.state
  const room = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: '产品研发群' })
  state = room.state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: product.agentId, memoryStart: { type: 'new-events' } }).state
  state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId: architect.agentId, memoryStart: { type: 'new-events' } }).state
  return { state, roomId: room.roomId, productId: product.agentId, architectId: architect.agentId }
}

describe('workspace UI view model', () => {
  it('projects only active memberships for the selected room', () => {
    const fixture = workspaceFixture()
    expect(activeRoomMembers(fixture.state, fixture.roomId).map(agent => agent.name)).toEqual(['Alice', 'Bob'])
    const membership = Object.values(fixture.state.memberships).find(entry => entry.roomId === fixture.roomId && entry.agentId === fixture.bobId)
    expect(membership).toBeDefined()
    const left = mutateWorkspace(fixture.state, { type: 'room/leave', membershipId: membership!.id }).state
    expect(activeRoomMembers(left, fixture.roomId).map(agent => agent.name)).toEqual(['Alice'])
  })

  it('projects only room message events for the selected room', () => {
    const fixture = workspaceFixture()
    const messages = roomMessageEvents(fixture.state, fixture.roomId)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toContain('Alice 请看一下')
    expect(messages[0]?.actor).toEqual({ type: 'human', id: 'web-user' })
  })

  it('extracts canonical agent mentions in order without duplicates', () => {
    expect(parseMentionIds('先问 <@agent-2>，再问 <@agent-4>，最后还是 <@agent-2>')).toEqual(['agent-2', 'agent-4'])
  })

  it('resolves visible @member names to active room agent ids', () => {
    const fixture = workspaceFixture()
    expect(parseRoomMentionIds(fixture.state, fixture.roomId, '先请 @Alice 看一下，再让 @Bob 复核。')).toEqual([
      fixture.aliceId,
      fixture.bobId,
    ])
    expect(parseRoomMentionIds(
      fixture.state,
      fixture.roomId,
      `兼容旧标记 <@${fixture.bobId}>，同时 @Alice，重复 @Alice 不应重复触发。`,
    )).toEqual([fixture.bobId, fixture.aliceId])
  })

  it('resolves group @all to every active employed member in room order', () => {
    const fixture = workspaceFixture()
    expect(parseRoomMentionIds(fixture.state, fixture.roomId, '@all 请大家一起评审。')).toEqual([
      fixture.aliceId,
      fixture.bobId,
    ])
    expect(parseRoomMentionIds(fixture.state, fixture.roomId, '@all @Alice 请大家一起评审。')).toEqual([
      fixture.aliceId,
      fixture.bobId,
    ])
  })

  it('excludes departed members from group @all and never expands @all in a direct room', () => {
    const fixture = workspaceFixture()
    const departed = mutateWorkspace(fixture.state, { type: 'agent/depart', agentId: fixture.bobId }).state
    expect(parseRoomMentionIds(departed, fixture.roomId, '@all')).toEqual([fixture.aliceId])

    const direct = mutateWorkspace(fixture.state, { type: 'room/create', kind: 'direct' })
    const joined = mutateWorkspace(direct.state, {
      type: 'room/join', roomId: direct.roomId, agentId: fixture.aliceId, memoryStart: { type: 'new-events' },
    }).state
    expect(parseRoomMentionIds(joined, direct.roomId, '@all')).toEqual([])
  })

  it('resolves a unique role name while refusing an ambiguous role alias', () => {
    const roles = roleAliasFixture()
    expect(parseRoomMentionIds(roles.state, roles.roomId, '@产品经理 先分析，@系统架构师 再设计。')).toEqual([
      roles.productId,
      roles.architectId,
    ])

    const shared = workspaceFixture()
    expect(parseRoomMentionIds(shared.state, shared.roomId, '@工程师 请处理')).toEqual([])
  })

  it('appends a human-readable mention token instead of exposing an internal agent id', () => {
    expect(appendDisplayMention('', '张产品')).toBe('@张产品 ')
    expect(appendDisplayMention('请处理', '张产品')).toBe('请处理 @张产品 ')
    expect(appendDisplayMention('@张产品 ', '张产品')).toBe('@张产品 ')
    expect(appendDisplayMention('', '张产品')).not.toContain('<@')
  })
})
