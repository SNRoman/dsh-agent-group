/** Durable task-delivery attempts and serialized task-result terminalization. */

import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { WorkspaceBusinessError } from './errors.ts'
import { TaskDeliveryAttemptId } from './ids.ts'
import type { AgentId, DefinitionRevisionId, TaskDeliveryAttemptId as AttemptId, TaskId } from './ids.ts'
import {
  appendMemoryEntries,
  appendTaskDeliveryEvent,
  appendTaskResultEvent,
  appendWorkspaceEvent,
  beginWorkspaceMutation,
  mintWorkspaceId,
} from './state.ts'
import type { TaskResultEvent, WorkspaceState, WorkspaceTask } from './types.ts'

/** The durable state of the latest task delivery attempt. */
export interface TaskDeliveryInspection {
  readonly attemptId?: AttemptId | undefined
  readonly phase: 'retryable' | 'started' | 'accepted' | 'settled'
}

/** Fields required to create a durable task delivery attempt. */
export interface StartTaskDeliveryRequest { readonly taskId: TaskId }

/** The stored attempt identity and frozen task message ready for inbox delivery. */
export interface StartTaskDeliveryResult {
  readonly state: WorkspaceState
  readonly attemptId: AttemptId
  readonly message: UserMessage
}

/** Durable identity shared by task-delivery transitions. */
export interface TaskDeliveryIdentity {
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly messageId: MessageId
}

/** Failure facts that make an inbox delivery retryable or settled. */
export interface FailTaskDeliveryRequest extends TaskDeliveryIdentity {
  readonly failureCode: string
  readonly failureSummary: string
}

/** Fields required to terminalize one accepted task delivery. */
export interface TerminalizeTaskRequest {
  readonly actorAgentId: AgentId
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly result: string
  readonly definitionRevisionId: DefinitionRevisionId
}

/** Fields required to save an accepted result after human cancellation won the task state race. */
export type RecordTaskResultAfterCancelRequest = TerminalizeTaskRequest

/** Fold canonical delivery facts for the latest attempt on one task. */
export function inspectTaskDelivery(state: WorkspaceState, taskId: TaskId): TaskDeliveryInspection {
  let inspection: TaskDeliveryInspection = { phase: 'retryable' }
  for (const event of state.events) {
    if (!('taskId' in event) || event.taskId !== taskId) continue
    switch (event.type) {
      case 'task/delivery-started':
        inspection = { attemptId: event.taskDeliveryAttemptId, phase: 'started' }
        break
      case 'task/delivery-accepted':
        if (inspection.attemptId === event.taskDeliveryAttemptId) inspection = { attemptId: event.taskDeliveryAttemptId, phase: 'accepted' }
        break
      case 'task/delivery-failed':
        if (inspection.attemptId === event.taskDeliveryAttemptId) {
          inspection = { attemptId: event.taskDeliveryAttemptId, phase: inspection.phase === 'started' ? 'retryable' : 'settled' }
        }
        break
      case 'task/result':
      case 'task/result-after-cancel':
        if (inspection.attemptId === event.taskDeliveryAttemptId) inspection = { attemptId: event.taskDeliveryAttemptId, phase: 'settled' }
        break
      default:
        break
    }
  }
  return inspection
}

/** Start a single retryable delivery and create its fixed inbox message. */
export function startTaskDelivery(state: WorkspaceState, request: StartTaskDeliveryRequest): StartTaskDeliveryResult {
  const task = requireOpenTask(state, request.taskId)
  const inspection = inspectTaskDelivery(state, task.id)
  if (inspection.phase === 'started' || inspection.phase === 'accepted') {
    throw new Error(`task '${task.id}' already has an open delivery attempt '${inspection.attemptId}'`)
  }
  let changed = beginWorkspaceMutation(state)
  let attemptId: AttemptId
  ;[changed, attemptId] = mintWorkspaceId(changed, 'task-delivery-attempt', TaskDeliveryAttemptId)
  const messageId = taskDeliveryMessageId(changed, attemptId)
  const message = taskMessage(changed, task, attemptId, messageId)
  ;[changed] = appendTaskDeliveryEvent(changed, {
    type: 'task/delivery-started',
    taskId: task.id,
    taskDeliveryAttemptId: attemptId,
    messageId,
  })
  return { state: changed, attemptId, message }
}

/** Persist that the inbox accepted one started task-delivery message. */
export function acceptTaskDelivery(state: WorkspaceState, identity: TaskDeliveryIdentity): { readonly state: WorkspaceState } {
  requireDeliveryPhase(state, identity, 'started')
  let changed = beginWorkspaceMutation(state)
  ;[changed] = appendTaskDeliveryEvent(changed, {
    type: 'task/delivery-accepted',
    taskId: identity.taskId,
    taskDeliveryAttemptId: identity.attemptId,
    messageId: identity.messageId,
  })
  return { state: changed }
}

/** Persist one delivery failure without recording any partial assistant output. */
export function failTaskDelivery(state: WorkspaceState, request: FailTaskDeliveryRequest): { readonly state: WorkspaceState } {
  requireText('delivery failure code', request.failureCode)
  requireText('delivery failure summary', request.failureSummary)
  const inspection = requireDeliveryIdentity(state, request)
  if (inspection.phase !== 'started' && inspection.phase !== 'accepted') {
    throw new Error(`task delivery attempt '${request.attemptId}' is already terminal`)
  }
  let changed = beginWorkspaceMutation(state)
  ;[changed] = appendTaskDeliveryEvent(changed, {
    type: 'task/delivery-failed',
    taskId: request.taskId,
    taskDeliveryAttemptId: request.attemptId,
    messageId: request.messageId,
    failureCode: request.failureCode,
    failureSummary: request.failureSummary,
  })
  return { state: changed }
}

/** Append an accepted result, complete its task, and acquire that result in assignee memory together. */
export function terminalizeTask(state: WorkspaceState, request: TerminalizeTaskRequest): { readonly state: WorkspaceState } {
  const task = requireAssignedOpenTask(state, request.actorAgentId, request.taskId)
  requireText('task result', request.result)
  requireDeliveryPhase(state, { ...request, messageId: taskDeliveryMessageId(state, request.attemptId) }, 'accepted')
  requireAssignedRevision(state, task.id, request.definitionRevisionId)
  let changed = beginWorkspaceMutation(state)
  let result: TaskResultEvent
  ;[changed, result] = appendTaskResultEvent(changed, {
    type: 'task/result', taskId: task.id, taskDeliveryAttemptId: request.attemptId,
    definitionRevisionId: request.definitionRevisionId, text: request.result,
  })
  ;[changed] = appendWorkspaceEvent(changed, 'task/completed', task.id, {
    actor: { type: 'agent', id: request.actorAgentId }, text: task.title,
  })
  const delegationGrants = expireRootGrants(changed, task)
  changed = {
    ...changed,
    tasks: { ...changed.tasks, [task.id]: { ...task, status: 'completed' } },
    delegationGrants,
  }
  changed = appendMemoryEntries(changed, [{ agentId: request.actorAgentId, eventId: result.id, acquiredBy: 'task' }])
  return { state: changed }
}

/** Append the one full result that raced a cancellation without changing cancelled task state. */
export function recordTaskResultAfterCancel(state: WorkspaceState, request: RecordTaskResultAfterCancelRequest): { readonly state: WorkspaceState } {
  const task = requireTask(state, request.taskId)
  if (task.status !== 'cancelled') throw new Error(`task '${task.id}' is not cancelled`)
  requireAssignedAgent(state, task.id, request.actorAgentId)
  requireText('task result', request.result)
  requireDeliveryPhase(state, { ...request, messageId: taskDeliveryMessageId(state, request.attemptId) }, 'accepted')
  requireAssignedRevision(state, task.id, request.definitionRevisionId)
  let changed = beginWorkspaceMutation(state)
  let result: TaskResultEvent
  ;[changed, result] = appendTaskResultEvent(changed, {
    type: 'task/result-after-cancel', taskId: task.id, taskDeliveryAttemptId: request.attemptId,
    definitionRevisionId: request.definitionRevisionId, text: request.result,
  })
  changed = appendMemoryEntries(changed, [{ agentId: request.actorAgentId, eventId: result.id, acquiredBy: 'task' }])
  return { state: changed }
}

function taskDeliveryMessageId(state: WorkspaceState, attemptId: AttemptId): MessageId {
  return MessageId(`agent-workspace-task:${state.workspaceId}:${attemptId}`)
}

function taskMessage(state: WorkspaceState, task: WorkspaceTask, attemptId: AttemptId, messageId: MessageId): UserMessage {
  const assignment = Object.values(state.taskAssignments).find(candidate => candidate.taskId === task.id)
  const sourceEvent = assignment === undefined ? undefined : state.events.find(event => (
    (event.type === 'task/assigned' || event.type === 'task/delegated') && event.subjectId === assignment.id
  ))
  if (sourceEvent === undefined) throw new Error(`task '${task.id}' has no assignment event`)
  return freezeMessage({
    id: messageId,
    role: 'user',
    content: [{ type: 'text', text: task.title }],
    source: {
      kind: 'agent-workspace-delivery', workspaceId: state.workspaceId,
      source: { kind: 'task', taskId: task.id }, sourceEventId: sourceEvent.id,
      taskDeliveryAttemptId: attemptId,
    },
  })
}

function requireDeliveryPhase(state: WorkspaceState, identity: TaskDeliveryIdentity, phase: 'started' | 'accepted'): void {
  const inspection = requireDeliveryIdentity(state, identity)
  if (inspection.phase !== phase) throw new Error(`task delivery attempt '${identity.attemptId}' is not ${phase}`)
}

function requireDeliveryIdentity(state: WorkspaceState, identity: TaskDeliveryIdentity): TaskDeliveryInspection {
  const task = state.tasks[identity.taskId]
  if (task === undefined) throw new Error(`task '${identity.taskId}' does not exist`)
  const inspection = inspectTaskDelivery(state, task.id)
  if (inspection.attemptId !== identity.attemptId) throw new Error(`task delivery attempt '${identity.attemptId}' does not match task '${task.id}'`)
  if (identity.messageId !== taskDeliveryMessageId(state, identity.attemptId)) {
    throw new Error(`task delivery message '${identity.messageId}' does not match attempt '${identity.attemptId}'`)
  }
  return inspection
}

function requireOpenTask(state: WorkspaceState, taskId: TaskId): WorkspaceTask {
  const task = requireTask(state, taskId)
  if (task.status !== 'open') {
    throw new WorkspaceBusinessError('task-not-open', { taskId, status: task.status }, `task '${taskId}' is ${task.status}`)
  }
  return task
}

function requireTask(state: WorkspaceState, taskId: TaskId): WorkspaceTask {
  const task = state.tasks[taskId]
  if (task === undefined) throw new Error(`task '${taskId}' does not exist`)
  return task
}

function requireAssignedOpenTask(state: WorkspaceState, agentId: AgentId, taskId: TaskId): WorkspaceTask {
  const task = requireOpenTask(state, taskId)
  const agent = state.agents[agentId]
  if (agent === undefined) throw new WorkspaceBusinessError('agent-missing', { agentId }, `agent '${agentId}' does not exist`)
  if (agent.employmentStatus !== 'employed') {
    throw new WorkspaceBusinessError('agent-departed', { agentId }, `agent '${agentId}' is departed and cannot handle tasks`)
  }
  requireAssignedAgent(state, task.id, agentId)
  return task
}

function requireAssignedAgent(state: WorkspaceState, taskId: TaskId, agentId: AgentId): void {
  if (!Object.values(state.taskAssignments).some(assignment => assignment.taskId === taskId && assignment.assigneeAgentId === agentId)) {
    throw new WorkspaceBusinessError('task-not-assigned', { taskId, agentId }, `agent '${agentId}' is not assigned task '${taskId}'`)
  }
}

function requireAssignedRevision(state: WorkspaceState, taskId: TaskId, definitionRevisionId: DefinitionRevisionId): void {
  const assignment = Object.values(state.taskAssignments).find(candidate => candidate.taskId === taskId)
  const assignee = assignment === undefined ? undefined : state.agents[assignment.assigneeAgentId]
  const revision = state.definitionRevisions[definitionRevisionId]
  if (assignee === undefined || revision === undefined || revision.definitionId !== assignee.definitionId) {
    throw new Error(`definition revision '${definitionRevisionId}' does not belong to task '${taskId}' assignee`)
  }
}

function expireRootGrants(state: WorkspaceState, task: WorkspaceTask): WorkspaceState['delegationGrants'] {
  const delegationGrants = { ...state.delegationGrants }
  if (task.id === task.rootTaskId) {
    for (const grant of Object.values(delegationGrants)) {
      if (grant.rootTaskId === task.id && grant.status === 'active') delegationGrants[grant.id] = { ...grant, status: 'expired' }
    }
  }
  return delegationGrants
}

function requireText(subject: string, value: string): void {
  if (value.trim() === '') throw new Error(`${subject} must not be blank`)
}
