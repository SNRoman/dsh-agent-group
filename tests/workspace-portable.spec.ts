import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { describe, expect, test } from 'vitest'
import { createWorkspaceExportV2, createWorkspaceExportV4, prepareWorkspaceImport, prepareWorkspaceImportV4 } from '../packages/host/src/workspace-portable.ts'
import { createForwardWorkspaceExportV1 } from '../packages/host/src/forward-export.ts'
import { prepareWorkspaceImportV1 } from '../packages/host/src/workspace-import.ts'
import { workspaceStateSchema } from '../packages/host/src/workspace-state-schema.ts'
import { WorkspaceId } from '../packages/host/src/ids.ts'
import { WorkspaceOperationId } from '../packages/host/src/workspace-record.ts'
import type { WorkspaceRecordV1, WorkspaceRecordV3 } from '../packages/host/src/workspace-record.ts'
import { assertWorkspaceInvariants } from '../packages/host/src/invariant.ts'
import { assignHumanTask, recordChildRunStarted } from '../packages/host/src/tasks.ts'
import { startTaskDelivery, acceptTaskDelivery, terminalizeTask } from '../packages/host/src/task-delivery.ts'
import { HumanId } from '../packages/host/src/ids.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { createInitialCommunicationState } from '../packages/host/src/communication.ts'
import { communicationStateSchema } from '../packages/host/src/communication-schema.ts'

const exportedAt = '2026-10-10T00:00:00.000Z'
const workspaceId = WorkspaceId('org-target')
const limits = { maxBytes: 1_000_000, maxEntities: 10_000, maxEvents: 10_000, maxStringBytes: 100_000, maxDepth: 32 }

async function source(): Promise<WorkspaceRecordV1> {
  const stored = JSON.parse(await readFile(new URL('./fixtures/v0.2.0/agent-workspace.json', import.meta.url), 'utf8'))
  const aggregate = workspaceStateSchema.parse(stored.tables.workspaces.local)
  return { recordVersion: 1, descriptor: { id: aggregate.workspaceId, label: '组织 😀', lifecycle: 'archived', creation: { kind: 'created', createdAt: exportedAt, operationId: WorkspaceOperationId('private-operation'), requestDigest: 'a'.repeat(64) } }, aggregate }
}

function signed(document: Record<string, unknown>): string {
  const { digest: _digest, ...envelope } = document
  return JSON.stringify({ ...envelope, digest: { algorithm: 'sha-256', canonicalization: 'RFC8785', hex: createHash('sha256').update(canonicalize(envelope)!).digest('hex') } })
}

function attributedTaskSource(): WorkspaceRecordV3 {
  const role = mutateWorkspace(createInitialState(WorkspaceId('org-source')), { type: 'definition/create', name: 'Writer', description: '', instructions: 'Write' })
  const employee = mutateWorkspace(role.state, { type: 'agent/create', name: 'Writer', definitionId: role.definitionId })
  const assigned = assignHumanTask(employee.state, { humanId: HumanId('owner'), assigneeAgentId: employee.agentId, title: 'Report' })
  const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
  const accepted = acceptTaskDelivery(started.state, { taskId: assigned.taskId, attemptId: started.attemptId, messageId: started.message.id })
  const completed = terminalizeTask(accepted.state, { actorAgentId: employee.agentId, taskId: assigned.taskId, attemptId: started.attemptId, definitionRevisionId: employee.state.agents[employee.agentId]!.definitionRevisionId, result: 'Done' })
  const room = mutateWorkspace(completed.state, { type: 'room/create', kind: 'group', name: 'Review' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: employee.agentId, memoryStart: { type: 'new-events' } })
  const message = mutateWorkspace(joined.state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: started.message.id, mentions: [] })
  const input = { agentId: employee.agentId, contextGeneration: 0, recordedAtSequence: message.state.nextSequence - 1, directEventIds: [], recalledEventIds: [], sessionEventIds: [] }
  return {
    recordVersion: 3, descriptor: { id: message.state.workspaceId, label: 'Task inputs', lifecycle: 'active' }, aggregate: message.state, workflow: createInitialWorkflowState(),
    communication: communicationStateSchema.parse({ ...createInitialCommunicationState(), inputs: {
      task: { ...input, id: 'task', target: { kind: 'task', taskId: assigned.taskId }, deliveryMessageId: started.message.id, taskDeliveryAttemptId: started.attemptId },
      legacy: { ...input, id: 'legacy', target: { kind: 'task', taskId: assigned.taskId } },
      room: { ...input, id: 'room', target: { kind: 'room-input', eventId: message.eventId }, directEventIds: [message.eventId], deliveryMessageId: 'agent-workspace-task:org-source:literal-room-input' },
    } }),
  }
}

describe('portable workspace version four task input attribution', () => {
  test('rebases only attributed task delivery ids across repeated export and import', () => {
    const original = attributedTaskSource()
    const before = structuredClone(original)
    const exported = createWorkspaceExportV4(original, { exportedAt })
    const imported = prepareWorkspaceImportV4(exported.json, { workspaceId, limits })
    const taskInput = original.communication.inputs.task!
    expect(imported.communication).toEqual({ ...original.communication, inputs: { ...original.communication.inputs, task: { ...taskInput, deliveryMessageId: `agent-workspace-task:org-target:${taskInput.taskDeliveryAttemptId}` } } })
    expect(imported.state.events).toEqual(original.aggregate.events.map(event => 'messageId' in event ? { ...event, messageId: `agent-workspace-task:org-target:${event.taskDeliveryAttemptId}` } : event))
    const second = createWorkspaceExportV4({ recordVersion: 3, descriptor: imported.descriptor, aggregate: imported.state, workflow: imported.workflow, communication: imported.communication }, { exportedAt })
    const copied = prepareWorkspaceImportV4(second.json, { workspaceId: WorkspaceId('org-copy'), limits })
    expect(copied.communication.inputs.task!.deliveryMessageId).toBe(`agent-workspace-task:org-copy:${taskInput.taskDeliveryAttemptId}`)
    expect(copied.communication.inputs.room).toEqual(original.communication.inputs.room)
    expect(copied.communication.inputs.legacy).toEqual(original.communication.inputs.legacy)
    expect(original).toEqual(before)
  })

  test.each(['delivery-id', 'attempt-id', 'task-id', 'counter', 'future', 'unknown'])('rejects re-signed invalid source %s before rebasing', kind => {
    const exported = createWorkspaceExportV4(attributedTaskSource(), { exportedAt })
    const document = structuredClone(exported.document)
    const input = document.workspace.communication.inputs.task!
    switch (kind) {
      case 'delivery-id': Reflect.set(input, 'deliveryMessageId', `agent-workspace-task:org-target:${input.taskDeliveryAttemptId}`); break
      case 'attempt-id': Reflect.set(input, 'taskDeliveryAttemptId', 'task-delivery-attempt-missing'); break
      case 'task-id': Reflect.set(input.target, 'taskId', 'task-missing'); break
      case 'counter': Reflect.set(document.workspace.aggregate, 'nextSequence', 1); break
      case 'future': Reflect.set(document, 'formatVersion', 5); break
      case 'unknown': Reflect.set(input, 'private', 'not-an-input-field'); break
    }
    expect(() => prepareWorkspaceImportV4(signed({ ...document }), { workspaceId, limits })).toThrow()
  })

  test('rejects an unsigned change to task input attribution', () => {
    const exported = createWorkspaceExportV4(attributedTaskSource(), { exportedAt })
    const document = structuredClone(exported.document)
    Reflect.set(document.workspace.communication.inputs.task!, 'deliveryMessageId', 'changed')
    expect(() => prepareWorkspaceImportV4(JSON.stringify(document), { workspaceId, limits })).toThrow(/digest/i)
  })
})

describe('portable workspace version two', () => {
  test.each(['toString', 'constructor', 'hasOwnProperty'])('rejects re-signed inherited memory agent referent %s without imported content in errors', async agentId => {
    const document = JSON.parse(createWorkspaceExportV2(await source(), { exportedAt }).json)
    document.workspace.aggregate.memoryEntries[0].agentId = agentId
    document.workspace.descriptor.label = 'private-secret'
    const json = signed(document)
    expect(() => prepareWorkspaceImport(json, { workspaceId, limits })).toThrow(/relationships/i)
    try { prepareWorkspaceImport(json, { workspaceId, limits }) } catch (error) { expect(String(error)).not.toContain('private-secret') }
  })

  test('exports only portable metadata and round trips copies with their internal ids and text intact', async () => {
    const original = await source(); const before = structuredClone(original)
    const exported = createWorkspaceExportV2(original, { exportedAt })
    expect(exported.document.formatVersion).toBe(2)
    expect(exported.document.workspace.descriptor).toEqual({ id: 'local', label: '组织 😀', lifecycle: 'archived' })
    expect(exported.json).not.toContain('private-operation')
    expect(exported.document.workspace.aggregate).not.toHaveProperty('sessionBindings')
    expect(exported.document.workspace.aggregate).not.toHaveProperty('workspaceId')
    const imported = prepareWorkspaceImport(exported.json, { workspaceId, limits })
    expect(imported.sourceWorkspaceId).toBe('local'); expect(imported.descriptor.id).toBe(workspaceId)
    assertWorkspaceInvariants(imported.state, workspaceId)
    expect(imported.state.events).toEqual(original.aggregate.events.map(event => 'messageId' in event ? { ...event, messageId: `agent-workspace-task:${workspaceId}:${event.taskDeliveryAttemptId}` } : event))
    const second = createWorkspaceExportV2({ recordVersion: 1, descriptor: imported.descriptor, aggregate: imported.state }, { exportedAt })
    const copy = prepareWorkspaceImport(second.json, { workspaceId: WorkspaceId('org-copy'), limits })
    expect(copy.sourceWorkspaceId).toBe(workspaceId); expect(copy.state.definitions).toEqual(imported.state.definitions)
    expect(original).toEqual(before)
  })

  test('imports frozen v1 exactly as the original reader does', async () => {
    const json = createForwardWorkspaceExportV1((await source()).aggregate, { exportedAt }).json
    expect(prepareWorkspaceImport(json, { workspaceId, limits })).toEqual({ ...prepareWorkspaceImportV1(json, { workspaceId, limits }), workflow: createInitialWorkflowState() })
  })

  test('preserves the frozen v1 reader treatment of nonempty whitespace labels', async () => {
    const document = JSON.parse(createForwardWorkspaceExportV1((await source()).aggregate, { exportedAt }).json)
    document.workspace.descriptor.label = ' '
    const json = signed(document)
    expect(prepareWorkspaceImport(json, { workspaceId, limits })).toEqual({ ...prepareWorkspaceImportV1(json, { workspaceId, limits }), workflow: createInitialWorkflowState() })
  })

  test('checks the raw envelope digest before accepting reordered or changed values', async () => {
    const document = createWorkspaceExportV2(await source(), { exportedAt }).document
    expect(prepareWorkspaceImport(JSON.stringify(Object.fromEntries(Object.entries(document).reverse()), null, 2), { workspaceId, limits }).state.workspaceId).toBe(workspaceId)
    expect(() => prepareWorkspaceImport(JSON.stringify({ ...document, pluginVersion: 'private-secret' }), { workspaceId, limits })).toThrow(/digest/i)
  })

  test.each(['metadata', 'source-id', 'relationships', 'counter', 'message-id', 'proto', 'surrogate', 'unknown'])('rejects re-signed corrupt %s without source content in errors', async kind => {
    const document = JSON.parse(createWorkspaceExportV2(await source(), { exportedAt }).json)
    switch (kind) {
      case 'metadata': document.workspace.descriptor.creation = { operationId: 'private-secret' }; break
      case 'source-id': document.workspace.descriptor.id = 'private-secret:bad'; break
      case 'relationships': Object.values<Record<string, unknown>>(document.workspace.aggregate.definitionRevisions)[0]!.definitionId = 'private-secret'; break
      case 'counter': document.workspace.aggregate.nextId = 1; break
      case 'message-id': document.workspace.aggregate.events.find((event: Record<string, unknown>) => 'messageId' in event).messageId = 'private-secret'; break
      case 'proto': Object.defineProperty(document.workspace.aggregate.definitions, '__proto__', { value: {}, enumerable: true }); break
      case 'surrogate': document.workspace.descriptor.label = '\ud800'; break
      case 'unknown': document.private = 'private-secret'; break
    }
    const json = signed(document)
    expect(() => prepareWorkspaceImport(json, { workspaceId, limits })).toThrow()
    try { prepareWorkspaceImport(json, { workspaceId, limits }) } catch (error) { expect(String(error)).not.toContain('private-secret') }
  })

  test('applies every import budget and duplicate-key detection to v2', async () => {
    const json = createWorkspaceExportV2(await source(), { exportedAt }).json
    for (const field of Object.keys(limits) as (keyof typeof limits)[]) {
      expect(() => prepareWorkspaceImport(json, { workspaceId, limits: { ...limits, [field]: 1 } })).toThrow()
      expect(() => prepareWorkspaceImport(json, { workspaceId, limits: { ...limits, [field]: 0 } })).toThrow(/limit/i)
    }
    expect(() => prepareWorkspaceImport(json.replace('"formatVersion":2', '"formatVersion":1,"format\\u0056ersion":2'), { workspaceId, limits })).toThrow(/duplicate/i)
    expect(() => prepareWorkspaceImport('{"private-secret":', { workspaceId, limits })).toThrow(/JSON/i)
    expect(() => prepareWorkspaceImport(json, { workspaceId: WorkspaceId('local'), limits })).toThrow(/new/i)
  })

  test('rejects unfinished delivery attempts and child runs', async () => {
    const original = await source()
    const agent = Object.values(original.aggregate.agents).find(candidate => candidate.employmentStatus === 'employed')!
    const assigned = assignHumanTask(original.aggregate, { humanId: HumanId('owner'), assigneeAgentId: agent.id, title: 'unfinished' })
    const started = startTaskDelivery(assigned.state, { taskId: assigned.taskId })
    const child = recordChildRunStarted(assigned.state, { parentAgentId: agent.id, taskId: assigned.taskId })
    for (const aggregate of [started.state, child.state]) {
      const json = createWorkspaceExportV2({ ...original, aggregate }, { exportedAt }).json
      expect(() => prepareWorkspaceImport(json, { workspaceId, limits })).toThrow(/unfinished/i)
    }
  })

  test.each(['instructions', 'event text', 'object key'])('rejects lone Unicode surrogates in exported %s without replacing source text', async field => {
    const original = await source()
    if (field === 'instructions') {
      Object.values(original.aggregate.definitionRevisions)[0]!.instructions = 'private-secret \ud800'
    } else if (field === 'event text') {
      original.aggregate.events[0]!.text = 'private-secret \udfff'
    } else {
      Object.defineProperty(original.aggregate.sessionBindings, 'private-secret \ud800', { value: 'session', enumerable: true })
    }
    const before = structuredClone(original)
    expect(() => createWorkspaceExportV2(original, { exportedAt })).toThrow(/unicode/i)
    expect(original).toEqual(before)
    try { createWorkspaceExportV2(original, { exportedAt }) } catch (error) { expect(String(error)).not.toContain('private-secret') }
  })
})
