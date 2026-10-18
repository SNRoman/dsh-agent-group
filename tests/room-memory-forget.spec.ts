import { expect, test } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'
import { assignHumanTask, recordChildRunFinished, recordChildRunStarted } from '../packages/host/src/tasks.ts'
import { assertWorkspaceInvariants } from '../packages/host/src/invariant.ts'
import { createInitialCommunicationState, assertCommunicationRelationships, effectiveWorkspaceState, getCommunicationInvalidation } from '../packages/host/src/communication.ts'
import { communicationStateSchema } from '../packages/host/src/communication-schema.ts'
import { completeMessageRecall, failMessageRecall, messageRecallInputIds, prepareMessageRecall } from '../packages/host/src/message-recall.ts'
import { joinRoomWithMemory, recallAgentEvents } from '../packages/host/src/memory.ts'
import { createWorkspaceExportV4, prepareWorkspaceImportV4 } from '../packages/host/src/workspace-portable.ts'
import { MemoryProcessor } from '../packages/host/src/memory-processor.ts'
import type { MemoryAudit, MemoryProjection, MemoryTable } from '../packages/host/src/memory-projection.ts'
import type { CommunicationInputId, ContextResetId } from '../packages/host/src/communication-contract.ts'
import type { WorkspaceRecordV3 } from '../packages/host/src/workspace-record.ts'

const owner = HumanId('owner')
const operationId = 'forget-room' as ContextResetId
const now = '2026-10-17T00:00:00.000Z'

function fixture() {
  const role = mutateWorkspace(createInitialState(WorkspaceId('local')), { type: 'definition/create', name: 'Writer', description: '', instructions: 'Write' })
  const alice = mutateWorkspace(role.state, { type: 'agent/create', definitionId: role.definitionId, name: 'Alice' })
  const bob = mutateWorkspace(alice.state, { type: 'agent/create', definitionId: role.definitionId, name: 'Bob' })
  const room = mutateWorkspace(bob.state, { type: 'room/create', kind: 'group', name: 'Team' })
  const other = mutateWorkspace(room.state, { type: 'room/create', kind: 'group', name: 'Other team' })
  let state = other.state
  for (const roomId of [room.roomId, other.roomId]) for (const agentId of [alice.agentId, bob.agentId]) {
    state = mutateWorkspace(state, { type: 'room/join', roomId, agentId, memoryStart: { type: 'new-events' } }).state
  }
  const source = mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: owner }, text: 'FORGET_THIS_ROOM', mentions: [] })
  const independent = mutateWorkspace(source.state, { type: 'room/message', roomId: other.roomId, actor: { type: 'human', id: owner }, text: 'Retained other room', mentions: [] })
  const derived = mutateWorkspace(independent.state, { type: 'room/message', roomId: other.roomId, actor: { type: 'agent', id: alice.agentId }, text: 'Derived FORGET_THIS_ROOM', mentions: [] })
  const relay = mutateWorkspace(derived.state, { type: 'room/message', roomId: other.roomId, actor: { type: 'agent', id: bob.agentId }, text: 'Other colleague original', mentions: [] })
  const following = mutateWorkspace(relay.state, { type: 'room/message', roomId: other.roomId, actor: { type: 'agent', id: alice.agentId }, text: 'Summary of my earlier reply', mentions: [] })
  const task = assignHumanTask(following.state, { humanId: owner, assigneeAgentId: alice.agentId, title: 'Separately authorized work' })
  const child = recordChildRunStarted(task.state, { parentAgentId: alice.agentId, taskId: task.taskId })
  const finished = recordChildRunFinished(child.state, { childRunId: child.childRunId, status: 'completed', result: 'Separately retained task result' })
  const boundAlice = mutateWorkspace(finished.state, { type: 'runtime/session-bound', agentId: alice.agentId, sessionId: SessionId('old-alice') })
  const boundBob = mutateWorkspace(boundAlice.state, { type: 'runtime/session-bound', agentId: bob.agentId, sessionId: SessionId('old-bob') })
  const inputId = 'derived-input' as CommunicationInputId
  const followingInputId = 'following-input' as CommunicationInputId
  const record: WorkspaceRecordV3 = { recordVersion: 3, descriptor: { id: WorkspaceId('local'), label: 'Test', lifecycle: 'active' }, aggregate: boundBob.state,
    workflow: createInitialWorkflowState(), communication: { ...createInitialCommunicationState(), inputs: { [followingInputId]: {
      id: followingInputId, agentId: alice.agentId, contextGeneration: 0, target: { kind: 'event', eventId: following.eventId },
      recordedAtSequence: following.state.nextSequence - 1, directEventIds: [], recalledEventIds: [], sessionEventIds: [derived.eventId],
    }, [inputId]: {
      id: inputId, agentId: alice.agentId, contextGeneration: 0, target: { kind: 'event', eventId: derived.eventId },
      recordedAtSequence: derived.state.nextSequence - 1, directEventIds: [], recalledEventIds: [source.eventId], sessionEventIds: [],
    } } } }
  return { record, aliceId: alice.agentId, bobId: bob.agentId, roomId: room.roomId, sourceId: source.eventId, derivedId: derived.eventId, followingId: following.eventId,
    relayId: relay.eventId, independentId: independent.eventId, taskId: task.taskId,
    membershipId: Object.values(record.aggregate.memberships).find(member => member.roomId === room.roomId && member.agentId === alice.agentId)!.id }
}

test('room forgetting removes only personal room sources and tracked own replies while preserving raw history and independent work', async () => {
  const { prepareRoomMemoryForget } = await import('../packages/host/src/room-memory-forget.ts')
  const f = fixture(), before = structuredClone(f.record)
  const prepared = prepareRoomMemoryForget(f.record, f.membershipId, operationId, owner, now)
  const memories = prepared.aggregate.memoryEntries.filter(entry => entry.agentId === f.aliceId).map(entry => entry.eventId)
  expect(memories).not.toContain(f.sourceId)
  expect(memories).not.toContain(f.derivedId)
  expect(memories).not.toContain(f.followingId)
  expect(memories).toEqual(expect.arrayContaining([f.independentId, f.relayId]))
  expect(prepared.aggregate.memoryEntries.filter(entry => entry.agentId === f.bobId)).toEqual(before.aggregate.memoryEntries.filter(entry => entry.agentId === f.bobId))
  expect(prepared.aggregate.memoryEntries.filter(entry => entry.acquiredBy === 'task' || entry.acquiredBy === 'child-result')).toEqual(before.aggregate.memoryEntries.filter(entry => entry.acquiredBy === 'task' || entry.acquiredBy === 'child-result'))
  expect(prepared.aggregate.events.slice(0, -1)).toEqual(before.aggregate.events)
  expect(prepared.aggregate.tasks).toEqual(before.aggregate.tasks)
  expect(prepared.aggregate.sessionBindings).toEqual({ [f.bobId]: 'old-bob' })
  expect(prepared.communication.contexts[f.aliceId]).toEqual({ generation: 1, blockedBy: operationId })
  expect(prepared.communication.contexts[f.bobId]).toBeUndefined()
  expect(prepared.communication.resets[operationId]).toMatchObject({ kind: 'room-memory-forget', membershipId: f.membershipId,
    source: { roomId: f.roomId, eventId: prepared.aggregate.memberships[f.membershipId]!.leftEventId },
    forgottenEventIds: [f.sourceId, f.derivedId, f.followingId], affectedAgentIds: [f.aliceId], previousGenerations: { [f.aliceId]: 0 } })
  expect(getCommunicationInvalidation(prepared.aggregate, prepared.communication).eventIds.size).toBe(0)
  expect(effectiveWorkspaceState(prepared.aggregate, prepared.communication).events).toEqual(prepared.aggregate.events)
  assertWorkspaceInvariants(prepared.aggregate, prepared.descriptor.id)
  assertCommunicationRelationships(prepared.aggregate, prepared.communication, prepared.workflow)
  expect(f.record).toEqual(before)
})

test('forget retry preserves the committed leave and generation, and failed cleanup never restores the old Session', async () => {
  const { prepareRoomMemoryForget } = await import('../packages/host/src/room-memory-forget.ts')
  const f = fixture()
  const pending = prepareRoomMemoryForget(f.record, f.membershipId, operationId, owner, now)
  const failed = failMessageRecall(pending, operationId)
  expect(failed.communication.contexts[f.aliceId]?.blockedBy).toBe(operationId)
  expect(prepareRoomMemoryForget(failed, f.membershipId, operationId, owner, '2026-10-18T00:00:00.000Z')).toBe(failed)
  expect(() => prepareRoomMemoryForget(failed, f.membershipId, operationId, HumanId('another'), now)).toThrow()
  const otherMembership = Object.values(f.record.aggregate.memberships).find(member => member.agentId === f.bobId)!.id
  expect(() => prepareRoomMemoryForget(failed, otherMembership, operationId, owner, now)).toThrow()
  expect(() => completeMessageRecall(failed, operationId, {})).toThrow()
  const completed = completeMessageRecall(failed, operationId, { [f.aliceId]: SessionId('fresh-alice') })
  expect(completed.aggregate.sessionBindings).toEqual({ [f.aliceId]: 'fresh-alice', [f.bobId]: 'old-bob' })
  expect(completed.communication.contexts[f.aliceId]).toEqual({ generation: 1, sessionId: 'fresh-alice' })
  assertCommunicationRelationships(completed.aggregate, completed.communication, completed.workflow)
})

test('explicit full-history rejoin reacquires forgotten room sources under new acquisition ids', async () => {
  const { prepareRoomMemoryForget } = await import('../packages/host/src/room-memory-forget.ts')
  const f = fixture(), previousEntry = f.record.aggregate.memoryEntries.find(entry => entry.agentId === f.aliceId && entry.eventId === f.sourceId)!
  const completed = completeMessageRecall(prepareRoomMemoryForget(f.record, f.membershipId, operationId, owner, now), operationId, { [f.aliceId]: SessionId('fresh') })
  const rejoined = joinRoomWithMemory(completed.aggregate, { type: 'room/join', roomId: f.roomId, agentId: f.aliceId,
    memoryStart: { type: 'event-range', startSequence: 1, endSequence: completed.aggregate.nextSequence - 1 } }).state
  const reacquired = rejoined.memoryEntries.find(entry => entry.agentId === f.aliceId && entry.eventId === f.sourceId)!
  expect(reacquired.acquiredBy).toBe('history-sync')
  expect(reacquired.id).not.toBe(previousEntry.id)
  assertCommunicationRelationships(rejoined, completed.communication, completed.workflow)
  expect(recallAgentEvents(effectiveWorkspaceState(rejoined, completed.communication), {
    agentId: f.aliceId, query: 'FORGET_THIS_ROOM', matchingOnly: true, characterBudget: 4_000,
  }).eventIds).toContain(f.sourceId)
  const newMessage = mutateWorkspace(rejoined, { type: 'room/message', roomId: f.roomId,
    actor: { type: 'human', id: owner }, text: 'NEW_ROOM_MESSAGE', mentions: [] })
  assertCommunicationRelationships(newMessage.state, completed.communication, completed.workflow)
  expect(recallAgentEvents(effectiveWorkspaceState(newMessage.state, completed.communication), {
    agentId: f.aliceId, query: 'NEW_ROOM_MESSAGE', matchingOnly: true, characterBudget: 4_000,
  }).eventIds).toContain(newMessage.eventId)
})

test.each(['sourceId', 'derivedId'] as const)('rejects resurrection of forgotten %s acquisitions without a later history sync', async eventKey => {
  const { prepareRoomMemoryForget } = await import('../packages/host/src/room-memory-forget.ts')
  const f = fixture()
  const completed = completeMessageRecall(prepareRoomMemoryForget(f.record, f.membershipId, operationId, owner, now), operationId, { [f.aliceId]: SessionId('fresh') })
  const original = f.record.aggregate.memoryEntries.find(entry => entry.agentId === f.aliceId && entry.eventId === f[eventKey])!
  for (const acquiredBy of ['room-membership', 'history-sync'] as const) {
    const restored = { ...completed.aggregate, memoryEntries: [...completed.aggregate.memoryEntries, { ...original, acquiredBy }] }
    assertWorkspaceInvariants(restored, completed.descriptor.id)
    expect(() => assertCommunicationRelationships(restored, completed.communication, completed.workflow)).toThrow(/forgotten.*history sync/)
  }
})

function table<T>(): MemoryTable<T> {
  const entries = new Map<string, T>()
  return { get: key => entries.get(key), entries: () => entries.entries(), put: async (key, value) => { entries.set(key, value) } }
}

test('a late shared extraction stays available only to colleagues who still own its source', async () => {
  const { prepareRoomMemoryForget } = await import('../packages/host/src/room-memory-forget.ts')
  const f = fixture(), audit = table<MemoryAudit>(), projection = table<MemoryProjection>()
  let current = f.record
  const entered = Promise.withResolvers<void>(), result = Promise.withResolvers<{ text: string; stream: string }>()
  const processor = new MemoryProcessor({ snapshot: () => current.aggregate, audit, projection,
    extract: async () => { entered.resolve(); return await result.promise } })
  const event = f.record.aggregate.events.find(candidate => candidate.id === f.sourceId)!
  const processing = processor.process({ workspaceId: f.record.descriptor.id, event, start: 0, end: event.text!.length, text: event.text! }, { provider: 'selected', model: 'selected' })
  await entered.promise
  current = prepareRoomMemoryForget(current, f.membershipId, operationId, owner, now)
  result.resolve({ text: JSON.stringify({ facts: [{ kind: 'controlled', property: 'person.address', subject: 'source-actor', temporal: 'current',
    operation: 'set', value: 'FORGET_THIS_ROOM', application: { kind: 'unresolved' }, sourceQuote: 'FORGET_THIS_ROOM', assertionKind: 'human-explicit' }] }), stream: '[]' })
  await processing
  expect(processor.facts(current.aggregate, f.aliceId)).toEqual([])
  expect(processor.progress(current.aggregate, f.aliceId).some(item => item.eventId === f.sourceId)).toBe(false)
  expect(processor.facts(current.aggregate, f.bobId).map(fact => fact.value)).toEqual(['FORGET_THIS_ROOM'])
  expect([...audit.entries()].map(([, entry]) => entry.status)).toEqual(['completed'])
  expect([...projection.entries()]).toHaveLength(1)
})

test('forget metadata survives export and import without making legacy withdrawals accept a membership source', async () => {
  const { prepareRoomMemoryForget } = await import('../packages/host/src/room-memory-forget.ts')
  const f = fixture(), prepared = prepareRoomMemoryForget(f.record, f.membershipId, operationId, owner, now)
  expect(communicationStateSchema.parse(prepared.communication)).toEqual(prepared.communication)
  const exported = createWorkspaceExportV4(prepared, { exportedAt: now })
  const imported = prepareWorkspaceImportV4(exported.json, { workspaceId: WorkspaceId('imported'), limits: { maxBytes: 1_000_000, maxEntities: 10_000, maxEvents: 10_000, maxStringBytes: 100_000, maxDepth: 32 } })
  expect(imported.communication.resets[operationId]).toEqual(prepared.communication.resets[operationId])
  expect(imported.state.memoryEntries).toEqual(prepared.aggregate.memoryEntries)
  expect(() => messageRecallInputIds(prepared, operationId)).toThrow()
  expect(() => prepareMessageRecall(prepared, { operationId, roomId: f.roomId, eventId: f.sourceId, humanId: owner, requestedAt: now, restoreFiles: false })).toThrow()
})

test.each(['source', 'agents', 'generation', 'forgotten-event', 'global-invalidation', 'file-restore'] as const)('rejects corrupted forget %s metadata', async corruption => {
  const { prepareRoomMemoryForget } = await import('../packages/host/src/room-memory-forget.ts')
  const f = fixture(), prepared = prepareRoomMemoryForget(f.record, f.membershipId, operationId, owner, now)
  const reset = structuredClone(prepared.communication.resets[operationId]!)
  const changed = corruption === 'source' ? { ...reset, source: { roomId: f.roomId, eventId: f.sourceId } }
    : corruption === 'agents' ? { ...reset, affectedAgentIds: [f.aliceId, f.bobId] }
      : corruption === 'generation' ? { ...reset, previousGenerations: { [f.bobId]: 0 } }
        : corruption === 'forgotten-event' ? { ...reset, forgottenEventIds: [f.relayId] }
          : corruption === 'global-invalidation' ? { ...reset, invalidatedTaskIds: [f.taskId] }
            : { ...reset, fileRestoreRequested: true }
  const communication = { ...prepared.communication, resets: { ...prepared.communication.resets, [operationId]: changed } }
  expect(() => {
    const parsed = communicationStateSchema.parse(communication)
    assertCommunicationRelationships(prepared.aggregate, parsed, prepared.workflow)
  }).toThrow()
})
