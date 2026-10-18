/** Durable withdrawal preparation; preserved audit data is never used to seed replacement sessions. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentId, HumanId, RoomId, WorkspaceEventId } from './ids.ts'
import type { CommunicationInputId, CommunicationState, ContextResetId, ContextResetOperation, MessageRecallOperation } from './communication-contract.ts'
import type { WorkspaceRecordV3 } from './workspace-record.ts'
import { getCommunicationInvalidation } from './communication.ts'
import { mutateWorkspace } from './state.ts'

/** Explicit author-owned withdrawal, with file restoration opt-in kept for retries. */
export interface MessageRecallRequest {
  readonly operationId: ContextResetId
  readonly roomId: RoomId
  readonly eventId: WorkspaceEventId
  readonly humanId: HumanId
  readonly requestedAt: string
  readonly restoreFiles: boolean
}
/** Named UI subjects are resolved from these durable identifiers, never from source text. */
export interface MessageRecallPreview {
  readonly affectedAgentIds: readonly AgentId[]
  readonly invalidatedEventIds: readonly WorkspaceEventId[]
  readonly invalidatedTaskIds: readonly import('./ids.ts').TaskId[]
  readonly fileCheckpointIds: readonly import('./communication-contract.ts').FileCheckpointId[]
  readonly conservative: true
  readonly files?: readonly import('./file-checkpoints.ts').FileCheckpointPreview[]
}

/** @param record Detached raw record. @param request Author and persisted source. @returns Exact conservative impact without durable writes. */
export function previewMessageRecall(record: WorkspaceRecordV3, request: MessageRecallRequest): MessageRecallPreview {
  const prepared = prepareMessageRecall(record, request)
  const operation = prepared.communication.resets[request.operationId]!
  const invalid = getCommunicationInvalidation(prepared.aggregate, prepared.communication)
  const inputs = messageRecallInputIds(prepared, request.operationId)
  return { affectedAgentIds: operation.affectedAgentIds, invalidatedEventIds: [...invalid.eventIds], invalidatedTaskIds: [...invalid.taskIds],
    fileCheckpointIds: Object.values(record.communication.fileCheckpoints).filter(checkpoint => inputs.has(checkpoint.inputId)).map(checkpoint => checkpoint.id), conservative: true }
}

/** @param record Raw record including all withdrawals. @param id Selected operation. @returns Inputs first invalidated by this operation; later recalls never widen its file consent. */
export function messageRecallInputIds(record: WorkspaceRecordV3, id: ContextResetId): ReadonlySet<CommunicationInputId> {
  const reset = requireMessageRecall(record, id)
  const previous = Object.values(record.communication.resets).filter((candidate): candidate is MessageRecallOperation => candidate.kind === undefined && candidate.id !== id && candidate.affectedAgentIds.some(agentId => (candidate.previousGenerations[agentId] ?? 0) < (reset.previousGenerations[agentId] ?? 0)))
  const metadata = (resets: readonly ContextResetOperation[]): CommunicationState => {
    const selected = new Set(resets.map(item => item.id))
    return { ...record.communication, resets: Object.fromEntries(resets.map(item => [item.id, item])), messages: Object.fromEntries(Object.entries(record.communication.messages).map(([eventId, message]) => {
      const { withdrawnBy, ...base } = message
      return [eventId, withdrawnBy !== undefined && selected.has(withdrawnBy) ? message : base]
    })) }
  }
  const before = getCommunicationInvalidation(record.aggregate, metadata(previous)).inputIds
  const after = getCommunicationInvalidation(record.aggregate, metadata([...previous, reset])).inputIds
  return new Set([...after].filter(inputId => {
    const input = record.communication.inputs[inputId]!
    return !before.has(inputId) && input.recordedAtSequence <= reset.throughSequence && input.contextGeneration <= (reset.previousGenerations[input.agentId] ?? -1)
  }))
}

/** @param record Raw audit record. @param request Human-owned source and stable operation identity. @returns Withdrawal and admission fencing in one replacement; retries do not advance generations. */
export function prepareMessageRecall(record: WorkspaceRecordV3, request: MessageRecallRequest): WorkspaceRecordV3 {
  if (record.descriptor.lifecycle !== 'active') throw new Error('Message withdrawal requires an active organization.')
  const event = record.aggregate.events.find(item => item.id === request.eventId)
  if (event?.type !== 'room/message' || event.subjectId !== request.roomId || event.actor?.type !== 'human' || event.actor.id !== request.humanId) throw new Error('Only the author can withdraw this chat message.')
  const existing = record.communication.resets[request.operationId]
  if (existing !== undefined) {
    if (existing.kind !== undefined || existing.source.eventId !== request.eventId || existing.source.roomId !== request.roomId || existing.requestedByHumanId !== request.humanId || existing.fileRestoreRequested !== request.restoreFiles) throw new Error('Message withdrawal retry differs from its original request.')
    return record
  }
  if (record.communication.messages[event.id]?.withdrawnBy !== undefined || Object.values(record.communication.resets).some(reset => reset.status !== 'completed')) throw new Error('An unfinished message withdrawal must be retried first.')
  const affectedAgentIds = Object.values(record.aggregate.agents).map(agent => agent.id)
  const contexts = { ...record.communication.contexts }
  const previousGenerations: Record<AgentId, number> = {}
  for (const agentId of affectedAgentIds) {
    const generation = contexts[agentId]?.generation ?? 0
    previousGenerations[agentId] = generation
    contexts[agentId] = { generation: generation + 1, blockedBy: request.operationId }
  }
  const source = { roomId: request.roomId, eventId: request.eventId }
  const operation: ContextResetOperation = {
    id: request.operationId, source, requestedByHumanId: request.humanId, requestedAt: request.requestedAt, fileRestoreRequested: request.restoreFiles,
    status: 'pending', fromSequence: event.sequence, throughSequence: record.aggregate.nextSequence - 1,
    affectedAgentIds, previousGenerations, invalidatedEventIds: [], invalidatedTaskIds: [],
    // Legacy workflow records lack model dependency attribution. They cannot be reused as an alternate route into a fresh session.
    invalidatedDraftIds: Object.values(record.workflow.drafts).map(draft => draft.id),
    invalidatedTemplateRevisionIds: Object.values(record.workflow.taskTemplateRevisions).map(template => template.id),
    invalidatedArtifactIds: Object.values(record.workflow.artifacts).map(artifact => artifact.id),
  }
  const prepared: WorkspaceRecordV3 = { ...record,
    aggregate: { ...record.aggregate, revision: record.aggregate.revision + 1, sessionBindings: {} },
    communication: { ...record.communication, revision: record.communication.revision + 1, contexts,
      messages: { ...record.communication.messages, [event.id]: { ...record.communication.messages[event.id], eventId: event.id, intent: record.communication.messages[event.id]?.intent ?? 'message', withdrawnBy: request.operationId } },
      resets: { ...record.communication.resets, [request.operationId]: operation } },
  }
  const invalid = getCommunicationInvalidation(prepared.aggregate, prepared.communication)
  return { ...prepared, communication: { ...prepared.communication, resets: { ...prepared.communication.resets, [request.operationId]: { ...operation, invalidatedEventIds: [...invalid.eventIds], invalidatedTaskIds: [...invalid.taskIds] } } } }
}

/** @param record Pending or failed context reset. @param id Stable operation. @returns Failed reset retaining blocked contexts; diagnostics exclude message content. */
export function failMessageRecall(record: WorkspaceRecordV3, id: ContextResetId): WorkspaceRecordV3 {
  const operation = requireReset(record, id)
  if (operation.status === 'completed') return record
  return { ...record, communication: { ...record.communication, revision: record.communication.revision + 1, resets: { ...record.communication.resets, [id]: { ...operation, status: 'failed', error: 'context-reset-cleanup-failed' } } } }
}

/** @param record Pending reset after old work has drained. @param id Operation. @param sessions Unseeded replacement sessions for every affected employed colleague. @returns Atomic completed reset and fresh local bindings; departed colleagues remain unbound. */
export function completeMessageRecall(record: WorkspaceRecordV3, id: ContextResetId, sessions: Readonly<Record<AgentId, SessionId>>): WorkspaceRecordV3 {
  const operation = requireReset(record, id)
  if (operation.status === 'completed') return record
  let aggregate = record.aggregate
  const contexts = { ...record.communication.contexts }
  for (const agentId of operation.affectedAgentIds) {
    const context = contexts[agentId]!
    if (context.blockedBy !== id) throw new Error('Reset admission ownership changed.')
    if (aggregate.agents[agentId]?.employmentStatus === 'employed') {
      const sessionId = sessions[agentId]
      if (sessionId === undefined) throw new Error('Reset has not created every replacement session.')
      aggregate = mutateWorkspace(aggregate, { type: 'runtime/session-bound', agentId, sessionId }).state
      contexts[agentId] = { generation: context.generation, sessionId }
    } else contexts[agentId] = { generation: context.generation }
  }
  const { error: _error, ...base } = operation
  return { ...record, aggregate, communication: { ...record.communication, revision: record.communication.revision + 1, contexts, resets: { ...record.communication.resets, [id]: { ...base, status: 'completed' } } } }
}
function requireReset(record: WorkspaceRecordV3, id: ContextResetId): ContextResetOperation {
  const operation = record.communication.resets[id]
  if (operation === undefined) throw new Error('Message withdrawal operation does not exist.')
  return operation
}
function requireMessageRecall(record: WorkspaceRecordV3, id: ContextResetId): MessageRecallOperation {
  const reset = requireReset(record, id)
  if (reset.kind !== undefined) throw new Error('File restoration requires a message withdrawal operation.')
  return reset
}
