import { expect, test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AgentId, HumanId, RoomId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import { appendMemoryEntries, createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignHumanTask, grantTaskDelegation, recordChildRunFinished, recordChildRunStarted } from '../packages/host/src/tasks.ts'
import type { CommunicationInputId, CommunicationState, ContextResetId, FileBlobId, FileCheckpointId } from '../packages/host/src/communication-contract.ts'
import type { TaskArtifactId, TaskDraftId, TaskTemplateRevisionId } from '../packages/host/src/workflow-contract.ts'

import * as communication from '../packages/host/src/communication.ts'
import * as schemas from '../packages/host/src/communication-schema.ts'
const owner = HumanId('owner')
const resetId = 'reset-1' as ContextResetId
const inputId = 'input-1' as CommunicationInputId
const checkpointId = 'checkpoint-1' as FileCheckpointId
const draftId = 'draft-1' as TaskDraftId
const templateRevisionId = 'template-revision-1' as TaskTemplateRevisionId
const artifactId = 'artifact-1' as TaskArtifactId
const blobId = 'blob-1' as FileBlobId

function emptyCommunication(): CommunicationState {
  return { revision: 0, nextCheckpointOrder: 1, messages: {}, taskSources: {}, draftSources: {}, inputs: {}, contexts: {}, resets: {}, fileCheckpoints: {} }
}

function fixture() {
  const definition = mutateWorkspace(createInitialState(WorkspaceId('local')), { type: 'definition/create', name: 'Engineer', description: 'd', instructions: 'i' })
  const alice = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
  const bob = mutateWorkspace(alice.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Bob' })
  const room = mutateWorkspace(bob.state, { type: 'room/create', kind: 'group', name: 'Team' })
  const joinAlice = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: alice.agentId, memoryStart: { type: 'new-events' } })
  const joinBob = mutateWorkspace(joinAlice.state, { type: 'room/join', roomId: room.roomId, agentId: bob.agentId, memoryStart: { type: 'new-events' } })
  const seed = mutateWorkspace(joinBob.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: owner }, text: 'Allowed earlier memory', mentions: [] })
  const source = mutateWorkspace(seed.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: owner }, text: 'WITHDRAWN_UNIQUE_MARKER', mentions: [alice.agentId] })
  const reply = mutateWorkspace(source.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: alice.agentId }, text: 'Derived WITHDRAWN_UNIQUE_MARKER', mentions: [] })
  const independent = mutateWorkspace(reply.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: owner }, text: 'Independent later instruction', mentions: [] })
  const tainted = assignHumanTask(independent.state, { humanId: owner, assigneeAgentId: alice.agentId, title: 'Tainted work' })
  const safe = assignHumanTask(tainted.state, { humanId: owner, assigneeAgentId: alice.agentId, title: 'Independent work' })
  const historical = assignHumanTask(safe.state, { humanId: owner, assigneeAgentId: bob.agentId, title: 'Unknown old input' })
  const granted = grantTaskDelegation(historical.state, { humanId: owner, granteeAgentId: alice.agentId, rootTaskId: tainted.taskId })
  const child = recordChildRunStarted(granted.state, { parentAgentId: alice.agentId, taskId: tainted.taskId })
  const finished = recordChildRunFinished(child.state, { childRunId: child.childRunId, status: 'completed', result: 'Child WITHDRAWN_UNIQUE_MARKER' })
  const relay = mutateWorkspace(finished.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: bob.agentId }, text: 'Relayed derived result', mentions: [] })
  const boundAlice = mutateWorkspace(relay.state, { type: 'runtime/session-bound', agentId: alice.agentId, sessionId: 'old-alice' as SessionId })
  const boundBob = mutateWorkspace(boundAlice.state, { type: 'runtime/session-bound', agentId: bob.agentId, sessionId: 'old-bob' as SessionId })
  const raw = appendMemoryEntries(boundBob.state, [seed.eventId, source.eventId, reply.eventId, independent.eventId, relay.eventId].map(eventId => ({ agentId: alice.agentId, eventId, acquiredBy: 'room-membership' })))
  const fromSequence = raw.events.find(event => event.id === source.eventId)!.sequence
  const metadata: CommunicationState = {
    ...emptyCommunication(), revision: 1,
    messages: {
      [source.eventId]: { eventId: source.eventId, intent: 'message', withdrawnBy: resetId },
      [reply.eventId]: { eventId: reply.eventId, intent: 'message', contextGeneration: 0 },
    },
    taskSources: {
      [tainted.taskId]: { roomId: room.roomId, eventId: source.eventId },
      [safe.taskId]: { roomId: room.roomId, eventId: independent.eventId },
    },
    contexts: {
      [alice.agentId]: { generation: 1, blockedBy: resetId },
      [bob.agentId]: { generation: 1, blockedBy: resetId },
    },
    resets: {
      [resetId]: {
        id: resetId, source: { roomId: room.roomId, eventId: source.eventId }, requestedByHumanId: owner,
        status: 'pending', fromSequence, throughSequence: raw.nextSequence - 1,
        affectedAgentIds: [alice.agentId, bob.agentId], previousGenerations: { [alice.agentId]: 0, [bob.agentId]: 0 },
        invalidatedEventIds: [], invalidatedTaskIds: [], invalidatedDraftIds: [], invalidatedTemplateRevisionIds: [], invalidatedArtifactIds: [],
        requestedAt: '2026-10-13T00:00:00.000Z', fileRestoreRequested: false,
      },
    },
  }
  return { raw, metadata, aliceId: alice.agentId, bobId: bob.agentId, roomId: room.roomId, seedId: seed.eventId, sourceId: source.eventId, replyId: reply.eventId, relayId: relay.eventId, independentId: independent.eventId, taintedTaskId: tainted.taskId, safeTaskId: safe.taskId, historicalTaskId: historical.taskId, childId: child.childRunId }
}

test('upgrades historical records with no invented sources or reset operations', () => {
  expect(communication.createInitialCommunicationState()).toEqual({ revision: 0, nextCheckpointOrder: 1, messages: {}, taskSources: {}, draftSources: {}, inputs: {}, contexts: {}, resets: {}, fileCheckpoints: {} })
  const f = fixture()
  expect(communication.effectiveWorkspaceState(f.raw, emptyCommunication())).toEqual(f.raw)
})

test('excludes withdrawn content and old generated inputs while retaining raw audit and independent human messages', () => {
  const f = fixture()
  const before = structuredClone(f.raw)
  const effective = communication.effectiveWorkspaceState(f.raw, f.metadata)
  expect(effective.events.map(event => event.id)).toEqual(expect.arrayContaining([f.seedId, f.independentId]))
  for (const eventId of [f.sourceId, f.replyId, f.relayId]) expect(effective.events.map(event => event.id)).not.toContain(eventId)
  expect(effective.events.some(event => event.text?.includes('WITHDRAWN_UNIQUE_MARKER'))).toBe(false)
  expect(effective.memoryEntries.some(entry => entry.eventId === f.sourceId || entry.eventId === f.replyId)).toBe(false)
  expect(effective.tasks).toEqual({ [f.safeTaskId]: f.raw.tasks[f.safeTaskId] })
  expect(Object.values(effective.taskAssignments ?? {}).map(assignment => assignment.taskId)).toEqual([f.safeTaskId])
  expect(effective.delegationGrants).toEqual({})
  expect(effective.childRuns).toEqual({})
  expect(effective.sessionBindings).toEqual({})
  expect(effective.agents).toEqual(f.raw.agents)
  expect(effective.memberships).toEqual(f.raw.memberships)
  expect(f.raw).toEqual(before)
})

test('bounds conservative invalidation and retains new generation output and the human re-sent information', () => {
  const f = fixture()
  const resent = mutateWorkspace(f.raw, { type: 'room/message', roomId: f.roomId, actor: { type: 'human', id: owner }, text: 'WITHDRAWN_UNIQUE_MARKER', mentions: [] })
  const newReply = mutateWorkspace(resent.state, { type: 'room/message', roomId: f.roomId, actor: { type: 'agent', id: f.aliceId }, text: 'New independent reply', mentions: [] })
  const bound = mutateWorkspace(newReply.state, { type: 'runtime/session-bound', agentId: f.aliceId, sessionId: 'new-alice' as SessionId })
  const reset = f.metadata.resets[resetId]!
  const metadata: CommunicationState = {
    ...f.metadata,
    messages: { ...f.metadata.messages, [newReply.eventId]: { eventId: newReply.eventId, intent: 'message', contextGeneration: 1 } },
    contexts: { [f.aliceId]: { generation: 1, sessionId: 'new-alice' as SessionId }, [f.bobId]: { generation: 1 } },
    resets: { [resetId]: { ...reset, status: 'completed' } },
  }
  const effective = communication.effectiveWorkspaceState(bound.state, metadata)
  expect(effective.events.map(event => event.id)).toEqual(expect.arrayContaining([resent.eventId, newReply.eventId]))
  expect(effective.events.some(event => event.id === f.sourceId)).toBe(false)
  expect(effective.sessionBindings).toEqual({ [f.aliceId]: 'new-alice' })
})

test('propagates recorded direct, recalled and cumulative session dependencies beyond the conservative window', () => {
  const f = fixture()
  const forwarded = mutateWorkspace(f.raw, { type: 'room/message', roomId: f.roomId, actor: { type: 'agent', id: f.aliceId }, text: 'Late dependent reply', mentions: [] })
  const metadata: CommunicationState = {
    ...f.metadata,
    inputs: {
      [inputId]: { id: inputId, target: { kind: 'event', eventId: forwarded.eventId }, agentId: f.aliceId, contextGeneration: 0, recordedAtSequence: forwarded.state.nextSequence - 1, directEventIds: [f.sourceId], recalledEventIds: [], sessionEventIds: [] },
      'input-2': { id: 'input-2' as CommunicationInputId, target: { kind: 'draft', draftId }, agentId: f.aliceId, contextGeneration: 0, recordedAtSequence: forwarded.state.nextSequence - 1, directEventIds: [], recalledEventIds: [forwarded.eventId], sessionEventIds: [] },
      'input-3': { id: 'input-3' as CommunicationInputId, target: { kind: 'template', templateRevisionId }, agentId: f.bobId, contextGeneration: 0, recordedAtSequence: forwarded.state.nextSequence - 1, directEventIds: [], recalledEventIds: [], sessionEventIds: [f.sourceId] },
    },
  }
  const invalid = communication.getCommunicationInvalidation(forwarded.state, metadata)
  expect(invalid.eventIds.has(forwarded.eventId)).toBe(true)
  expect(invalid.draftIds.has(draftId)).toBe(true)
  expect(invalid.templateRevisionIds.has(templateRevisionId)).toBe(true)
})

test('rejects explicitly fenced old generations even when output arrives after the fixed cutoff', () => {
  const f = fixture()
  const late = mutateWorkspace(f.raw, { type: 'room/message', roomId: f.roomId, actor: { type: 'agent', id: f.aliceId }, text: 'Late old session copy', mentions: [] })
  const metadata: CommunicationState = { ...f.metadata, messages: { ...f.metadata.messages, [late.eventId]: { eventId: late.eventId, intent: 'message', contextGeneration: 0 } } }
  expect(communication.effectiveWorkspaceState(late.state, metadata).events.some(event => event.id === late.eventId)).toBe(false)
})

test('uses recorded input generation to retain new result events without room message metadata', () => {
  const f = fixture()
  const reply = mutateWorkspace(f.raw, { type: 'room/message', roomId: f.roomId, actor: { type: 'agent', id: f.aliceId }, text: 'Explicitly new input output', mentions: [] })
  const metadata: CommunicationState = {
    ...f.metadata,
    contexts: { [f.aliceId]: { generation: 1 }, [f.bobId]: { generation: 1 } },
    resets: { [resetId]: { ...f.metadata.resets[resetId]!, status: 'completed', throughSequence: reply.state.nextSequence - 1 } },
    inputs: { [inputId]: { id: inputId, target: { kind: 'event', eventId: reply.eventId }, agentId: f.aliceId, contextGeneration: 1, recordedAtSequence: reply.state.nextSequence - 1, directEventIds: [f.independentId], recalledEventIds: [], sessionEventIds: [] } },
  }
  expect(communication.getCommunicationInvalidation(reply.state, metadata).eventIds.has(reply.eventId)).toBe(false)
})

test('retains unknown historical output after a conservative reset cutoff', () => {
  const f = fixture()
  const reply = mutateWorkspace(f.raw, { type: 'room/message', roomId: f.roomId, actor: { type: 'agent', id: f.aliceId }, text: 'Post-cutoff output', mentions: [] })
  expect(communication.getCommunicationInvalidation(reply.state, f.metadata).eventIds.has(reply.eventId)).toBe(false)
})

test('isolates old receiving inputs without withdrawing an independently written human message', () => {
  const f = fixture()
  const metadata: CommunicationState = {
    ...f.metadata,
    inputs: { [inputId]: { id: inputId, target: { kind: 'event', eventId: f.independentId }, agentId: f.aliceId, contextGeneration: 0, recordedAtSequence: f.raw.nextSequence - 1, directEventIds: [f.independentId], recalledEventIds: [], sessionEventIds: [f.sourceId] } },
  }
  const invalid = communication.getCommunicationInvalidation(f.raw, metadata)
  expect(invalid.inputIds.has(inputId)).toBe(true)
  expect(invalid.eventIds.has(f.independentId)).toBe(false)
  expect(invalid.taskIds.has(f.safeTaskId)).toBe(false)
})

test('retains explicit legacy workflow isolation without inventing an input dependency graph', () => {
  const f = fixture()
  const metadata: CommunicationState = { ...f.metadata, resets: { [resetId]: { ...f.metadata.resets[resetId]!, invalidatedDraftIds: [draftId], invalidatedTemplateRevisionIds: [templateRevisionId], invalidatedArtifactIds: [artifactId] } } }
  const invalid = communication.getCommunicationInvalidation(f.raw, metadata)
  expect(invalid.draftIds.has(draftId)).toBe(true)
  expect(invalid.templateRevisionIds.has(templateRevisionId)).toBe(true)
  expect(invalid.artifactIds.has(artifactId)).toBe(true)
})

test.each(['pending', 'failed'] as const)('blocks old bindings while a reset is %s', status => {
  const f = fixture()
  const metadata: CommunicationState = { ...f.metadata, resets: { [resetId]: { ...f.metadata.resets[resetId]!, status, ...(status === 'failed' ? { error: 'dispose failed' } : {}) } } }
  expect(communication.effectiveWorkspaceState(f.raw, metadata).sessionBindings).toEqual({})
})

test('round-trips pending resets and complete raw byte checkpoint metadata', () => {
  const f = fixture()
  const metadata: CommunicationState = {
    ...f.metadata, nextCheckpointOrder: 2,
    inputs: { [inputId]: { id: inputId, target: { kind: 'event', eventId: f.replyId }, agentId: f.aliceId, contextGeneration: 0, recordedAtSequence: f.raw.events.find(event => event.id === f.replyId)!.sequence, directEventIds: [f.sourceId], recalledEventIds: [], sessionEventIds: [] } },
    fileCheckpoints: { [checkpointId]: { id: checkpointId, order: 1, inputId, agentId: f.aliceId, contextGeneration: 0, callId: ToolCallId('tool-call-1'), path: 'src/中文.txt', before: { existed: true, blobId, sha256: 'a'.repeat(64), size: 4 }, after: { existed: false }, restore: { status: 'pending' } } },
  }
  expect(schemas.communicationStateSchema.safeParse(JSON.parse(JSON.stringify(metadata))).data).toEqual(metadata)
  expect(() => communication.assertCommunicationRelationships(f.raw, metadata)).not.toThrow()
})

test.each([
  ['root', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, unknown: true })],
  ['message', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, messages: { [f.sourceId]: { ...f.metadata.messages[f.sourceId]!, unknown: true } } })],
  ['source', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, taskSources: { [f.taintedTaskId]: { roomId: f.roomId, eventId: f.sourceId, unknown: true } } })],
  ['context', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, contexts: { [f.aliceId]: { generation: 1, unknown: true } } })],
  ['reset', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, resets: { [resetId]: { ...f.metadata.resets[resetId]!, unknown: true } } })],
  ['input target', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, inputs: { [inputId]: { id: inputId, target: { kind: 'event', eventId: f.replyId, unknown: true }, agentId: f.aliceId, contextGeneration: 0, recordedAtSequence: 10, directEventIds: [], recalledEventIds: [], sessionEventIds: [] } } })],
])('rejects unknown persisted fields on the %s object', (_name, corrupt) => {
  expect(schemas.communicationStateSchema.safeParse(corrupt(fixture())).success).toBe(false)
})

test.each([
  ['non-message source', (f: ReturnType<typeof fixture>) => ({ ...emptyCommunication(), taskSources: { [f.taintedTaskId]: { roomId: f.roomId, eventId: f.raw.events[0]!.id } } })],
  ['wrong source room', (f: ReturnType<typeof fixture>) => ({ ...emptyCommunication(), taskSources: { [f.taintedTaskId]: { roomId: RoomId('missing'), eventId: f.sourceId } } })],
  ['missing task', (f: ReturnType<typeof fixture>) => ({ ...emptyCommunication(), taskSources: { missing: { roomId: f.roomId, eventId: f.sourceId } } })],
  ['inherited task', (f: ReturnType<typeof fixture>) => ({ ...emptyCommunication(), taskSources: { constructor: { roomId: f.roomId, eventId: f.sourceId } } })],
  ['wrong reset author', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, resets: { [resetId]: { ...f.metadata.resets[resetId]!, requestedByHumanId: HumanId('other') } } })],
  ['unbounded reset', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, resets: { [resetId]: { ...f.metadata.resets[resetId]!, throughSequence: f.raw.nextSequence } } })],
  ['partial conservative reset', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, resets: { [resetId]: { ...f.metadata.resets[resetId]!, affectedAgentIds: [f.aliceId] } } })],
  ['dangling withdrawal', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, resets: {} })],
  ['completed blocked context', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, resets: { [resetId]: { ...f.metadata.resets[resetId]!, status: 'completed' as const } } })],
  ['future context generation', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, messages: { [f.replyId]: { eventId: f.replyId, intent: 'message' as const, contextGeneration: 2 } } })],
  ['skipped first generation', (f: ReturnType<typeof fixture>) => ({ ...f.metadata, contexts: { [f.aliceId]: { generation: 3, blockedBy: resetId }, [f.bobId]: { generation: 3, blockedBy: resetId } }, resets: { [resetId]: { ...f.metadata.resets[resetId]!, previousGenerations: { [f.aliceId]: 2, [f.bobId]: 2 } } } })],
])('rejects the persisted %s relationship', (_name, corrupt) => {
  const f = fixture()
  expect(() => communication.assertCommunicationRelationships(f.raw, corrupt(f))).toThrow()
})

test('validates repeated reset generations and preserves a later blocked operation', () => {
  const f = fixture()
  const secondId = 'reset-2' as ContextResetId
  const metadata: CommunicationState = {
    ...f.metadata,
    messages: { ...f.metadata.messages, [f.independentId]: { eventId: f.independentId, intent: 'message', withdrawnBy: secondId } },
    contexts: { [f.aliceId]: { generation: 2, blockedBy: secondId }, [f.bobId]: { generation: 2, blockedBy: secondId } },
    resets: {
      [resetId]: { ...f.metadata.resets[resetId]!, status: 'completed' },
      [secondId]: { ...f.metadata.resets[resetId]!, id: secondId, source: { roomId: f.roomId, eventId: f.independentId }, fromSequence: f.raw.events.find(event => event.id === f.independentId)!.sequence, previousGenerations: { [f.aliceId]: 1, [f.bobId]: 1 } },
    },
  }
  expect(() => communication.assertCommunicationRelationships(f.raw, metadata)).not.toThrow()
  expect(() => communication.assertCommunicationRelationships(f.raw, { ...metadata, resets: { ...metadata.resets, [secondId]: { ...metadata.resets[secondId]!, previousGenerations: { [f.aliceId]: 0, [f.bobId]: 0 } } } })).toThrow()
})

test('accepts a real draft source and rejects a missing workflow reference', () => {
  const f = fixture()
  const metadata: CommunicationState = { ...emptyCommunication(), draftSources: { [draftId]: { roomId: f.roomId, eventId: f.sourceId } } }
  const workflow = { drafts: { [draftId]: { id: draftId } }, taskTemplateRevisions: {}, artifacts: {} }
  expect(() => communication.assertCommunicationRelationships(f.raw, metadata, workflow)).not.toThrow()
  expect(() => communication.assertCommunicationRelationships(f.raw, metadata, { ...workflow, drafts: {} })).toThrow()
})

test('rejects dependency references that do not exist or were recorded before their sources', () => {
  const f = fixture()
  const input = { id: inputId, target: { kind: 'event' as const, eventId: f.replyId }, agentId: f.aliceId, contextGeneration: 0, recordedAtSequence: f.raw.nextSequence - 1, directEventIds: [WorkspaceEventId('missing')], recalledEventIds: [], sessionEventIds: [] }
  expect(() => communication.assertCommunicationRelationships(f.raw, { ...emptyCommunication(), inputs: { [inputId]: input } })).toThrow()
  expect(() => communication.assertCommunicationRelationships(f.raw, { ...emptyCommunication(), inputs: { [inputId]: { ...input, directEventIds: [f.sourceId], recordedAtSequence: 1 } } })).toThrow()
})

test('rejects generated input metadata for another author or a contradictory generation', () => {
  const f = fixture()
  const input = { id: inputId, target: { kind: 'event' as const, eventId: f.replyId }, agentId: f.aliceId, contextGeneration: 0, recordedAtSequence: f.raw.nextSequence - 1, directEventIds: [f.sourceId], recalledEventIds: [], sessionEventIds: [] }
  expect(() => communication.assertCommunicationRelationships(f.raw, { ...f.metadata, inputs: { [inputId]: { ...input, agentId: f.bobId } } })).toThrow()
  expect(() => communication.assertCommunicationRelationships(f.raw, { ...f.metadata, inputs: { [inputId]: { ...input, contextGeneration: 1 } } })).toThrow()
})

test('requires globally unique checkpoint order below its next durable counter', () => {
  const f = fixture()
  const input = { id: inputId, target: { kind: 'event' as const, eventId: f.replyId }, agentId: f.aliceId, contextGeneration: 0, recordedAtSequence: f.raw.nextSequence - 1, directEventIds: [f.sourceId], recalledEventIds: [], sessionEventIds: [] }
  const one = { id: checkpointId, order: 1, inputId, agentId: f.aliceId, contextGeneration: 0, callId: ToolCallId('call-1'), path: 'file.txt', before: { existed: false as const }, after: { existed: false as const }, restore: { status: 'pending' as const } }
  const secondId = 'checkpoint-2' as FileCheckpointId
  const metadata: CommunicationState = { ...f.metadata, nextCheckpointOrder: 3, inputs: { [inputId]: input }, fileCheckpoints: { [checkpointId]: one, [secondId]: { ...one, id: secondId, order: 2, callId: ToolCallId('call-2') } } }
  expect(() => communication.assertCommunicationRelationships(f.raw, metadata)).not.toThrow()
  expect(() => communication.assertCommunicationRelationships(f.raw, { ...metadata, nextCheckpointOrder: 2 })).toThrow()
  expect(() => communication.assertCommunicationRelationships(f.raw, { ...metadata, fileCheckpoints: { ...metadata.fileCheckpoints, [secondId]: { ...one, id: secondId } } })).toThrow()
})

test.each([-1, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe checkpoint order %s', order => {
  const checkpoint = { id: checkpointId, order, inputId, agentId: AgentId('agent-1'), contextGeneration: 0, callId: ToolCallId('call-1'), path: 'file.txt', before: { existed: false }, after: { existed: false }, restore: { status: 'pending' } }
  expect(schemas.communicationStateSchema.safeParse({ ...emptyCommunication(), fileCheckpoints: { [checkpointId]: checkpoint } }).success).toBe(false)
})

test.each(['../outside.txt', 'C:/outside.txt', '/absolute.txt', 'src\\file.txt', 'src/../file.txt'])('rejects unconfined checkpoint path %s', path => {
  const checkpoint = { id: checkpointId, order: 1, inputId, agentId: AgentId('agent-1'), contextGeneration: 0, callId: 'call-1', path, before: { existed: false }, after: { existed: false }, restore: { status: 'pending' } }
  expect(schemas.communicationStateSchema.safeParse({ ...emptyCommunication(), fileCheckpoints: { [checkpointId]: checkpoint } }).success).toBe(false)
})

test('rejects incomplete byte snapshots and unknown checkpoint fields', () => {
  const checkpoint = { id: checkpointId, order: 1, inputId, agentId: AgentId('agent-1'), contextGeneration: 0, callId: 'call-1', path: 'file.txt', before: { existed: true, blobId, sha256: 'a'.repeat(64) }, after: { existed: false }, restore: { status: 'pending' } }
  expect(schemas.communicationStateSchema.safeParse({ ...emptyCommunication(), fileCheckpoints: { [checkpointId]: checkpoint } }).success).toBe(false)
  expect(schemas.communicationStateSchema.safeParse({ ...emptyCommunication(), fileCheckpoints: { [checkpointId]: { ...checkpoint, before: { existed: false, unknown: true } } } }).success).toBe(false)
})
