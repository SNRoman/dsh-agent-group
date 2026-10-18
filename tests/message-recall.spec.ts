import { expect, test } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace, appendMemoryEntries } from '../packages/host/src/state.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'
import { createInitialCommunicationState, assertCommunicationRelationships, effectiveWorkspaceState } from '../packages/host/src/communication.ts'
import type { ContextResetId, CommunicationInputId } from '../packages/host/src/communication-contract.ts'
import { prepareMessageRecall, completeMessageRecall, failMessageRecall, previewMessageRecall, messageRecallInputIds } from '../packages/host/src/message-recall.ts'
import { joinRoomWithMemory, recallAgentEvents } from '../packages/host/src/memory.ts'

function fixture() {
  const role = mutateWorkspace(createInitialState(WorkspaceId('local')), { type: 'definition/create', name: 'Writer', description: '', instructions: 'Write' })
  const agent = mutateWorkspace(role.state, { type: 'agent/create', definitionId: role.definitionId, name: 'Alice' })
  const room = mutateWorkspace(agent.state, { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: agent.agentId, memoryStart: { type: 'new-events' } })
  const source = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'WITHDRAWN_MARKER', mentions: [agent.agentId] })
  const reply = mutateWorkspace(source.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: agent.agentId }, text: 'Derived WITHDRAWN_MARKER', mentions: [] })
  const bound = mutateWorkspace(reply.state, { type: 'runtime/session-bound', agentId: agent.agentId, sessionId: SessionId('old') })
  return { agentId: agent.agentId, roomId: room.roomId, eventId: source.eventId, replyId: reply.eventId,
    record: { recordVersion: 3 as const, descriptor: { id: WorkspaceId('local'), label: 'Test', lifecycle: 'active' as const }, aggregate: appendMemoryEntries(bound.state, [source.eventId, reply.eventId].map(eventId => ({ agentId: agent.agentId, eventId, acquiredBy: 'room-membership' as const }))), workflow: createInitialWorkflowState(), communication: createInitialCommunicationState() } }
}
const id = 'recall' as ContextResetId
const requestedAt = '2026-10-13T00:00:00.000Z'

test('each file recovery is limited to newly invalidated inputs of that recall, including later retries', () => {
  const f = fixture(), firstInput = 'first-input' as CommunicationInputId, secondInput = 'second-input' as CommunicationInputId
  f.record.communication = { ...f.record.communication, inputs: { [firstInput]: { id: firstInput, target: { kind: 'room-input', eventId: f.eventId }, agentId: f.agentId, contextGeneration: 0, recordedAtSequence: f.record.aggregate.nextSequence - 1, directEventIds: [f.eventId], recalledEventIds: [], sessionEventIds: [] } } }
  const first = completeMessageRecall(prepareMessageRecall(f.record, { operationId: id, roomId: f.roomId, eventId: f.eventId, humanId: HumanId('owner'), requestedAt, restoreFiles: false }), id, { [f.agentId]: SessionId('fresh') })
  const message = mutateWorkspace(first.aggregate, { type: 'room/message', roomId: f.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Independent new work', mentions: [] })
  const secondId = 'second-recall' as ContextResetId
  const second = prepareMessageRecall({ ...first, aggregate: message.state, communication: { ...first.communication, inputs: { ...first.communication.inputs, [secondInput]: { id: secondInput, target: { kind: 'room-input', eventId: message.eventId }, agentId: f.agentId, contextGeneration: 1, recordedAtSequence: message.state.nextSequence - 1, directEventIds: [message.eventId], recalledEventIds: [], sessionEventIds: [] } } } }, { operationId: secondId, roomId: f.roomId, eventId: message.eventId, humanId: HumanId('owner'), requestedAt, restoreFiles: true })
  expect([...messageRecallInputIds(second, secondId)]).toEqual([secondInput])
  expect([...messageRecallInputIds(second, id)]).toEqual([firstInput])
})
test('preview names conservative affected colleagues and excludes the source and its reply from effective memory', () => {
  const f = fixture()
  const request = { operationId: id, roomId: f.roomId, eventId: f.eventId, humanId: HumanId('owner'), requestedAt, restoreFiles: false }
  const preview = previewMessageRecall(f.record, request)
  expect(preview.affectedAgentIds).toEqual([f.agentId])
  expect(preview.invalidatedEventIds).toEqual(expect.arrayContaining([f.eventId, f.replyId]))
  const next = prepareMessageRecall(f.record, request)
  expect(next.aggregate.sessionBindings).toEqual({})
  expect(next.communication.contexts[f.agentId]).toEqual({ generation: 1, blockedBy: id })
  expect(effectiveWorkspaceState(next.aggregate, next.communication).events.some(event => event.text?.includes('WITHDRAWN_MARKER'))).toBe(false)
  expect(f.record.aggregate.sessionBindings[f.agentId]).toBe('old')
  assertCommunicationRelationships(next.aggregate, next.communication, next.workflow)
})
test('a full-history rejoin cannot restore withdrawn messages to effective personal memory', () => {
  const f = fixture()
  const colleague = mutateWorkspace(f.record.aggregate, {
    type: 'agent/create', definitionId: f.record.aggregate.agents[f.agentId]!.definitionId, name: 'Bob',
  })
  const joined = joinRoomWithMemory(colleague.state, {
    type: 'room/join', roomId: f.roomId, agentId: colleague.agentId, memoryStart: { type: 'new-events' },
  })
  const membership = Object.values(joined.state.memberships).find(item => item.agentId === colleague.agentId)!
  const prepared = prepareMessageRecall({ ...f.record, aggregate: joined.state }, {
    operationId: id, roomId: f.roomId, eventId: f.eventId, humanId: HumanId('owner'), requestedAt, restoreFiles: false,
  })
  const completed = completeMessageRecall(prepared, id, {
    [f.agentId]: SessionId('fresh-alice'), [colleague.agentId]: SessionId('fresh-bob'),
  })
  const left = mutateWorkspace(completed.aggregate, { type: 'room/leave', membershipId: membership.id })
  const independent = mutateWorkspace(left.state, {
    type: 'room/message', roomId: f.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Independent planning after withdrawal', mentions: [],
  })
  const rejoined = joinRoomWithMemory(independent.state, {
    type: 'room/join', roomId: f.roomId, agentId: colleague.agentId,
    memoryStart: { type: 'event-range', startSequence: 1, endSequence: independent.state.events.at(-1)!.sequence },
  })
  const rawMemories = rejoined.state.memoryEntries.filter(entry => entry.agentId === colleague.agentId)
  expect(rawMemories.map(entry => entry.eventId)).toEqual(expect.arrayContaining([f.eventId, f.replyId, independent.eventId]))
  expect(rawMemories.every(entry => entry.acquiredBy === 'history-sync')).toBe(true)

  const effective = effectiveWorkspaceState(rejoined.state, completed.communication)
  const createdEventId = f.record.aggregate.events.find(event => event.type === 'room/created' && event.subjectId === f.roomId)!.id
  expect(effective.memoryEntries.filter(entry => entry.agentId === colleague.agentId).map(entry => entry.eventId)).toEqual([
    createdEventId, independent.eventId,
  ])
  expect(recallAgentEvents(effective, {
    agentId: colleague.agentId, query: 'WITHDRAWN_MARKER', matchingOnly: true, characterBudget: 2_000,
  }).eventIds).toEqual([])
  expect(recallAgentEvents(effective, {
    agentId: colleague.agentId, query: 'Independent', matchingOnly: true, characterBudget: 2_000,
  }).eventIds).toEqual([independent.eventId])
  assertCommunicationRelationships(rejoined.state, completed.communication, completed.workflow)
})

test('a retry preserves the original finite window and generation and cannot change source or file consent', () => {
  const f = fixture(), request = { operationId: id, roomId: f.roomId, eventId: f.eventId, humanId: HumanId('owner'), requestedAt, restoreFiles: false }
  const pending = prepareMessageRecall(f.record, request)
  const later = mutateWorkspace(pending.aggregate, { type: 'room/message', roomId: f.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'Independent', mentions: [] })
  const retried = prepareMessageRecall({ ...pending, aggregate: later.state }, request)
  expect(retried.communication.resets[id]).toEqual(pending.communication.resets[id])
  expect(retried.communication.contexts[f.agentId]?.generation).toBe(1)
  expect(() => prepareMessageRecall(pending, { ...request, restoreFiles: true })).toThrow()
})
test('only the author can withdraw; failures keep admission blocked; completion binds new sessions and never old sessions', () => {
  const f = fixture(), request = { operationId: id, roomId: f.roomId, eventId: f.eventId, humanId: HumanId('owner'), requestedAt, restoreFiles: false }
  expect(() => prepareMessageRecall(f.record, { ...request, humanId: HumanId('stranger') })).toThrow()
  const pending = prepareMessageRecall(f.record, request)
  const failed = failMessageRecall(pending, id)
  expect(failed.communication.resets[id]?.status).toBe('failed')
  expect(failed.communication.contexts[f.agentId]?.blockedBy).toBe(id)
  expect(() => completeMessageRecall(failed, id, {})).toThrow()
  const completed = completeMessageRecall(failed, id, { [f.agentId]: SessionId('fresh') })
  expect(completed.communication.resets[id]?.status).toBe('completed')
  expect(completed.aggregate.sessionBindings[f.agentId]).toBe('fresh')
  expect(completed.communication.contexts[f.agentId]).toEqual({ generation: 1, sessionId: 'fresh' })
  assertCommunicationRelationships(completed.aggregate, completed.communication, completed.workflow)
})
