import { expect, it } from 'vitest'
import { roomMessageMentionSpans, linkRoomMessageMentions, canonicalRoomMessageText, parseRoomMentionIds } from '../packages/web/src/client/view-model.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { WorkspaceId } from '../packages/host/src/ids.ts'
import type { WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'

const snapshot: WorkspaceSnapshot = {
  workspaceId: 'local', revision: 0, nextId: 1, nextSequence: 1, definitions: {}, definitionRevisions: {}, rooms: {}, memberships: {}, events: [], memoryEntries: [], tasks: {}, taskAssignments: {}, delegationGrants: {}, childRuns: {}, sessionBindings: {},
  agents: { alice: { id: 'alice', name: '小林', definitionId: 'role', definitionRevisionId: 'revision', employmentStatus: 'employed', employmentPeriods: [] } },
}

it('highlights only admitted mentions outside code, links and email addresses', () => {
  const text = '请 @小林 查看。邮箱 name@小林.com；`@小林`\n```txt\n<@alice>\n```\n[原链接 @小林](https://example.com)\n<@alice>'
  const spans = roomMessageMentionSpans(snapshot, text, ['alice'])
  expect(spans.map(span => text.slice(span.start, span.end))).toEqual(['@小林', '<@alice>'])
  expect(spans.map(span => span.agentId)).toEqual(['alice', 'alice'])
  const markdown = linkRoomMessageMentions(snapshot, text, ['alice'])
  expect(markdown).toContain('[@小林](#dsh-agent-group-person/alice)')
  expect(markdown).toContain('`@小林`')
  expect(markdown).toContain('```txt\n<@alice>\n```')
  expect(markdown).toContain('[原链接 @小林](https://example.com)')
})

it('keeps persisted mention identity after renaming and does not activate unknown ids', () => {
  expect(linkRoomMessageMentions(snapshot, '<@alice> <@missing>', ['alice', 'missing'])).toBe('[@小林](#dsh-agent-group-person/alice) <@missing>')
  expect(roomMessageMentionSpans(snapshot, '@小林', [])).toEqual([])
})

it('stores recognized names using stable ids without rewriting code or email', () => {
  expect(canonicalRoomMessageText(snapshot, '@小林 查看；`@小林` name@小林.com', ['alice'])).toBe('<@alice> 查看；`@小林` name@小林.com')
})

it('does not wake a colleague for code, existing links or an email address', () => {
  const role = mutateWorkspace(createInitialState(WorkspaceId('mentions')), { type: 'definition/create', name: '工程师', description: '', instructions: '' })
  const colleague = mutateWorkspace(role.state, { type: 'agent/create', definitionId: role.definitionId, name: '小林' })
  const room = mutateWorkspace(colleague.state, { type: 'room/create', kind: 'group', name: '群聊' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: colleague.agentId, memoryStart: { type: 'new-events' } }).state
  expect(parseRoomMentionIds(joined, room.roomId, '`@小林` name@小林.com [@小林](https://example.com)\n```txt\n@all\n```')).toEqual([])
  expect(parseRoomMentionIds(joined, room.roomId, '请@小林 看一下')).toEqual([colleague.agentId])
})
