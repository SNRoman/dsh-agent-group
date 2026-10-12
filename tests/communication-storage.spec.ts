import { expect, test } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { WorkspaceId, HumanId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'
import { createInitialCommunicationState } from '../packages/host/src/communication.ts'
import type { CommunicationInputId, ContextResetId, FileBlobId, FileCheckpointId } from '../packages/host/src/communication-contract.ts'
import * as records from '../packages/host/src/workspace-record.ts'
import * as portable from '../packages/host/src/workspace-portable.ts'

const exportedAt = '2026-10-13T00:00:00.000Z'
const limits = { maxBytes: 1_000_000, maxEntities: 10_000, maxEvents: 10_000, maxStringBytes: 100_000, maxDepth: 32 }
const options = { workspaceId: WorkspaceId('target'), limits }

function source() {
  const definition = mutateWorkspace(createInitialState(WorkspaceId('local')), { type: 'definition/create', name: 'Engineer', description: 'd', instructions: 'i' })
  const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
  const room = mutateWorkspace(agent.state, { type: 'room/create', kind: 'group', name: 'Team' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: agent.agentId, memoryStart: { type: 'new-events' } })
  const message = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'WITHDRAWN', mentions: [] })
  const aggregate = mutateWorkspace(message.state, { type: 'runtime/session-bound', agentId: agent.agentId, sessionId: SessionId('private-session') }).state
  return { recordVersion: 3 as const, descriptor: { id: aggregate.workspaceId, label: '组织', lifecycle: 'active' as const }, aggregate, workflow: createInitialWorkflowState(), communication: createInitialCommunicationState(), agentId: agent.agentId, roomId: room.roomId, eventId: message.eventId }
}

test('successor record reader preserves communication while predecessor readers reject the successor', () => {
  const { agentId: _agentId, roomId: _roomId, eventId: _eventId, ...record } = source()
  expect(records.workspaceRecordV3Schema.parse(record)).toEqual(record)
  expect(records.workspaceRecordV2Schema.safeParse(record).success).toBe(false)
  expect(records.storedWorkspaceSchema.parse(record)).toEqual(record)
})

test.each(['pending', 'failed'] as const)('portable successor keeps %s withdrawal and removes local session proofs', status => {
  const { agentId, roomId, eventId, ...initial } = source()
  const resetId = 'reset-1' as ContextResetId
  const resetFields = { id: resetId, source: { roomId, eventId }, requestedByHumanId: HumanId('owner'), fromSequence: initial.aggregate.events.find(event => event.id === eventId)!.sequence, throughSequence: initial.aggregate.nextSequence - 1, affectedAgentIds: [agentId], previousGenerations: { [agentId]: 0 }, invalidatedEventIds: [], invalidatedTaskIds: [], invalidatedDraftIds: [], invalidatedTemplateRevisionIds: [], invalidatedArtifactIds: [], requestedAt: exportedAt, fileRestoreRequested: false }
  const reset = status === 'failed' ? { ...resetFields, status: 'failed' as const, error: 'rebuild failed' } : { ...resetFields, status: 'pending' as const }
  const record = { ...initial, communication: { ...initial.communication, revision: 1, messages: { [eventId]: { eventId, intent: 'message' as const, withdrawnBy: resetId } }, contexts: { [agentId]: { generation: 1, blockedBy: resetId } }, resets: { [resetId]: reset } } }
  const exported = portable.createWorkspaceExportV4(record, { exportedAt })
  const imported = portable.prepareWorkspaceImportV4(exported.json, options)
  expect(exported.document.formatVersion).toBe(4)
  expect(exported.document.compatibleImportRange).toContain('unreleased')
  expect(exported.json).not.toContain('private-session')
  expect(imported.state.sessionBindings).toEqual({})
  expect(imported.communication.resets[resetId]?.status).toBe(status)
  expect(imported.communication.contexts[agentId]).toEqual({ generation: 1, blockedBy: resetId })
  expect(imported.communication.messages[eventId]?.withdrawnBy).toBe(resetId)
  expect(imported.state.events).toEqual(initial.aggregate.events)
  expect(() => portable.prepareWorkspaceImport(exported.json, options)).toThrow()
})

test('portable successor strips current local session proof and checks communication entity budgets', () => {
  const { agentId, roomId: _roomId, eventId: _eventId, ...initial } = source()
  const record = { ...initial, communication: { ...initial.communication, contexts: { [agentId]: { generation: 0, sessionId: SessionId('private-session') } } } }
  const exported = portable.createWorkspaceExportV4(record, { exportedAt })
  expect(exported.json).not.toContain('private-session')
  expect(portable.prepareWorkspaceImportV4(exported.json, options).communication.contexts[agentId]).toEqual({ generation: 0 })
  const aggregateEntities = initial.aggregate.memoryEntries.length + ['definitions', 'definitionRevisions', 'agents', 'rooms', 'memberships', 'tasks', 'taskAssignments', 'delegationGrants', 'childRuns'].reduce((count, field) => count + Object.keys(initial.aggregate[field as 'agents']).length, 0)
  expect(() => portable.prepareWorkspaceImportV4(exported.json, { ...options, limits: { ...limits, maxEntities: aggregateEntities } })).toThrow(/maxEntities/)
})

function signed(document: Record<string, unknown>): string {
  const { digest: _digest, ...envelope } = document
  return JSON.stringify({ ...envelope, digest: { algorithm: 'sha-256', canonicalization: 'RFC8785', hex: createHash('sha256').update(canonicalize(envelope)!).digest('hex') } })
}

test.each(['missing-event', 'missing-agent', 'session-proof', 'prototype'])('rejects re-signed communication corruption %s without source content in errors', kind => {
  const { agentId, roomId: _roomId, eventId, ...record } = source()
  const document = JSON.parse(portable.createWorkspaceExportV4(record, { exportedAt }).json)
  const communication = document.workspace.communication
  if (kind === 'missing-event') communication.messages['private-secret'] = { eventId: 'private-secret', intent: 'message' }
  if (kind === 'missing-agent') communication.contexts['private-secret'] = { generation: 0 }
  if (kind === 'session-proof') communication.contexts[agentId] = { generation: 0, sessionId: 'private-secret' }
  if (kind === 'prototype') Object.defineProperty(communication.messages, '__proto__', { value: { eventId, intent: 'message' }, enumerable: true })
  const json = signed(document)
  expect(() => portable.prepareWorkspaceImportV4(json, options)).toThrow()
  try { portable.prepareWorkspaceImportV4(json, options) } catch (error) { expect(String(error)).not.toContain('private-secret') }
})

test('portable checkpoints preserve audit metadata but cannot claim bytes can be restored', () => {
  const { agentId, roomId: _roomId, eventId, ...record } = source()
  const inputId = 'input-1' as CommunicationInputId
  const checkpointId = 'checkpoint-1' as FileCheckpointId
  const exported = portable.createWorkspaceExportV4({ ...record, communication: { ...record.communication, nextCheckpointOrder: 2,
    inputs: { [inputId]: { id: inputId, agentId, contextGeneration: 0, target: { kind: 'event', eventId }, recordedAtSequence: record.aggregate.nextSequence - 1, directEventIds: [eventId], recalledEventIds: [], sessionEventIds: [] } },
    fileCheckpoints: { [checkpointId]: { id: checkpointId, order: 1, inputId, agentId, contextGeneration: 0, callId: ToolCallId('call-1'), path: 'report.txt', before: { existed: false }, after: { existed: true, blobId: 'E:/private-journal/content-1' as FileBlobId, sha256: 'a'.repeat(64), size: 12 }, restore: { status: 'pending' } } },
  } }, { exportedAt })
  const imported = portable.prepareWorkspaceImportV4(exported.json, options)
  expect(imported.communication.fileCheckpoints[checkpointId]).toMatchObject({ order: 1, path: 'report.txt', before: { existed: false }, restore: { status: 'unavailable' } })
  expect(exported.document.workspace.communication.fileCheckpoints[checkpointId]?.restore.status).toBe('unavailable')
  expect(exported.json).not.toContain('E:/private-journal')
})

test('successor reader upgrades predecessor imports with empty communication and unchanged raw state', () => {
  const { agentId: _agentId, roomId: _roomId, eventId: _eventId, communication: _communication, recordVersion: _version, ...fields } = source()
  const json = portable.createWorkspaceExportV3({ ...fields, recordVersion: 2 }, { exportedAt }).json
  expect(portable.prepareWorkspaceImportV4(json, options)).toEqual({ ...portable.prepareWorkspaceImport(json, options), communication: createInitialCommunicationState() })
})
