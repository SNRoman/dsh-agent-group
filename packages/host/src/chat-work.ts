/** Atomic chat assignment using the existing workflow transitions and delegation authority. */
import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import type { HumanId } from './ids.ts'
import type { WorkspaceRecordV3 } from './workspace-record.ts'
import type { ChatWorkCommand, ChatWorkReceipt } from './chat-work-contract.ts'
import { chatWorkCommandSchema } from './chat-work-schema.ts'
import { assertDirectRoomTextAllowed, assertRoomMessageAuthorized, resolveHumanWakeTargets } from './room-policy.ts'
import { mutateWorkspace } from './state.ts'
import { applyWorkflowCommand, WorkflowBusinessError } from './workflow.ts'
import { grantTaskDelegation } from './tasks.ts'

/** @param humanId Trusted author. @param command Resolved semantic chat instruction. @returns SHA-256 semantic retry identity, excluding displayed revisions. */
export function chatWorkRequestDigest(humanId: HumanId, command: ChatWorkCommand): string {
  const value = canonicalize({ humanId, command: chatWorkCommandSchema.parse(command) })
  if (value === undefined) throw new Error('invalid chat work request')
  return createHash('sha256').update(value).digest('hex')
}

/** @param record Complete raw successor record. @param command Validated explicit assignment or confirmation. @param context Trusted human and Host time. @returns Detached successor and real source receipt; no delivery occurs here. */
export function applyChatWork(record: WorkspaceRecordV3, command: ChatWorkCommand, context: { readonly humanId: HumanId; readonly occurredAt: string }): { readonly record: WorkspaceRecordV3; readonly value: ChatWorkReceipt } {
  const brief = command.type === 'communication/assign' ? command.brief : record.workflow.drafts[command.draftId]?.brief
  if (brief === undefined) throw new WorkflowBusinessError('workflow-reference-invalid', { entityKind: 'draft', entityId: command.type === 'communication/confirm' ? command.draftId : '' })
  resolveHumanWakeTargets(record.aggregate, command.roomId, [command.assigneeAgentId])
  assertRoomMessageAuthorized(record.aggregate, command.roomId, { type: 'human', id: context.humanId }, [command.assigneeAgentId])
  if (record.aggregate.rooms[command.roomId]?.kind === 'direct') assertDirectRoomTextAllowed(command.roomId, brief.instructions)
  const message = mutateWorkspace(record.aggregate, { type: 'room/message', roomId: command.roomId, actor: { type: 'human', id: context.humanId }, text: brief.instructions, mentions: [command.assigneeAgentId] })
  const source = { roomId: command.roomId, eventId: message.eventId }
  const created = command.type === 'communication/assign' ? applyWorkflowCommand({ aggregate: message.state, workflow: record.workflow }, { type: 'workflow/draft/create', brief: command.brief, suggestedAssigneeAgentId: command.assigneeAgentId }, context) : undefined
  const draftId = created?.value.draftId ?? (command.type === 'communication/confirm' ? command.draftId : undefined)
  if (draftId === undefined) throw new Error('chat assignment did not create its draft')
  const confirmed = applyWorkflowCommand({ aggregate: created?.aggregate ?? message.state, workflow: created?.workflow ?? record.workflow }, { type: 'workflow/draft/confirm', draftId, expectedDraftRevision: command.type === 'communication/confirm' ? command.expectedDraftRevision : 0, assigneeAgentId: command.assigneeAgentId }, context)
  const aggregate = command.allowDelegation ? grantTaskDelegation(confirmed.aggregate, { humanId: context.humanId, rootTaskId: confirmed.value.taskId, granteeAgentId: command.assigneeAgentId }).state : confirmed.aggregate
  return { record: { ...record, aggregate, workflow: confirmed.workflow, communication: { ...record.communication, revision: record.communication.revision + 1, messages: { ...record.communication.messages, [source.eventId]: { eventId: source.eventId, intent: 'assignment' } }, draftSources: { ...record.communication.draftSources, [draftId]: record.communication.draftSources[draftId] ?? source }, taskSources: { ...record.communication.taskSources, [confirmed.value.taskId]: source } } }, value: { ...confirmed.value, source } }
}

/** @param record Raw successor after structural parsing. @returns Nothing; throws if a persisted retry receipt differs from its recorded work or semantic digest. */
export function assertChatWorkOperations(record: WorkspaceRecordV3): void {
  for (const [id, operation] of Object.entries(record.communication.operations)) {
    const { source, draftId, taskId, taskAssignmentId } = operation.receipt
    const event = record.aggregate.events.find(event => event.id === source.eventId)
    const assignment = record.aggregate.taskAssignments[taskAssignmentId]
    const draft = record.workflow.drafts[draftId]
    if (id !== operation.id || operation.requestDigest !== chatWorkRequestDigest(operation.humanId, operation.command) || operation.aggregateRevision > record.aggregate.revision || operation.workflowRevision > record.workflow.revision || event?.actor?.type !== 'human' || event.actor.id !== operation.humanId || event.subjectId !== operation.command.roomId || source.roomId !== operation.command.roomId || assignment?.taskId !== taskId || assignment.assigneeAgentId !== operation.command.assigneeAgentId || draft?.taskId !== taskId || record.communication.taskSources[taskId]?.eventId !== source.eventId) throw new Error('invalid communication operation relationships or digest')
    if (operation.command.type === 'communication/assign' && canonicalize(draft.brief) !== canonicalize(operation.command.brief)) throw new Error('invalid communication operation brief')
    if (operation.command.type === 'communication/confirm' && operation.command.draftId !== draftId) throw new Error('invalid communication confirmation receipt')
  }
}
