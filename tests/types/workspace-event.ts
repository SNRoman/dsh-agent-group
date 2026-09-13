import { MessageId } from '@deepseek-ai/dsh-llm'
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'
import {
  DefinitionRevisionId,
  DelegationGrantId,
  HumanId,
  RoomId,
  TaskDeliveryAttemptId,
  TaskId,
  WorkspaceEventId,
  WorkspaceId,
} from '../../packages/host/src/ids.ts'
import { appendTaskCancelledEvent, appendTaskDelegationRevokedEvent } from '../../packages/host/src/state.ts'
import type { WorkspaceEvent, WorkspaceEventType, WorkspaceState } from '../../packages/host/src/types.ts'

const eventId = WorkspaceEventId('event-1')

const terminal: WorkspaceEvent = {
  id: eventId,
  sequence: 1,
  type: 'child/run-finished',
  childRunStatus: 'completed',
}

// @ts-expect-error Terminal child events require their durable terminal status.
const missingTerminalStatus: WorkspaceEvent = { id: eventId, sequence: 1, type: 'child/run-finished' }

// @ts-expect-error Non-terminal child events cannot carry a terminal status.
const statusOnOtherEvent: WorkspaceEvent = { id: eventId, sequence: 1, type: 'child/run-started', childRunStatus: 'completed' }

const knownType: WorkspaceEventType = 'room/message'

const deliveryStarted: WorkspaceEvent = {
  id: eventId,
  sequence: 1,
  type: 'task/delivery-started',
  taskId: TaskId('task-1'),
  taskDeliveryAttemptId: TaskDeliveryAttemptId('delivery-1'),
  messageId: MessageId('message-1'),
}

const deliveryAccepted: WorkspaceEvent = { ...deliveryStarted, type: 'task/delivery-accepted' }
const deliveryFailed: WorkspaceEvent = {
  ...deliveryStarted,
  type: 'task/delivery-failed',
  failureCode: 'delivery-rejected',
  failureSummary: 'The task inbox rejected the delivery.',
}
const taskResult: WorkspaceEvent = {
  id: eventId,
  sequence: 1,
  type: 'task/result',
  taskId: TaskId('task-1'),
  taskDeliveryAttemptId: TaskDeliveryAttemptId('delivery-1'),
  definitionRevisionId: DefinitionRevisionId('definition-revision-1'),
  text: 'Completed.',
}
const taskResultAfterCancel: WorkspaceEvent = { ...taskResult, type: 'task/result-after-cancel' }
const taskCancelled: WorkspaceEvent = {
  id: eventId,
  sequence: 1,
  type: 'task/cancelled',
  subjectId: TaskId('task-1'),
}
const delegationRevoked: WorkspaceEvent = {
  id: eventId,
  sequence: 1,
  type: 'task/delegation-revoked',
  subjectId: DelegationGrantId('grant-1'),
}

const deliverySource: MessageSourceMap['agent-workspace-delivery'] = {
  kind: 'agent-workspace-delivery',
  workspaceId: WorkspaceId('local'),
  source: { kind: 'room', roomId: RoomId('room-1') },
  sourceEventId: WorkspaceEventId('event-1'),
  taskDeliveryAttemptId: TaskDeliveryAttemptId('delivery-1'),
}

declare const workspaceState: WorkspaceState
appendTaskCancelledEvent(workspaceState, TaskId('task-1'), HumanId('owner'), 'derived-only')
appendTaskDelegationRevokedEvent(workspaceState, DelegationGrantId('grant-1'), HumanId('owner'))

// @ts-expect-error Cancellation helpers reject grant subjects at the typed boundary.
appendTaskCancelledEvent(workspaceState, DelegationGrantId('grant-1'), HumanId('owner'), 'derived-only')

// @ts-expect-error Revocation helpers reject task subjects at the typed boundary.
appendTaskDelegationRevokedEvent(workspaceState, TaskId('task-1'), HumanId('owner'))

// @ts-expect-error Delivery events require the durable message identity.
const deliveryWithoutMessage: WorkspaceEvent = {
  id: eventId, sequence: 1, type: 'task/delivery-started', taskId: TaskId('task-1'), taskDeliveryAttemptId: TaskDeliveryAttemptId('delivery-1'),
}

// @ts-expect-error Failed deliveries require a stable failure code and summary.
const failedWithoutDetails: WorkspaceEvent = { ...deliveryStarted, type: 'task/delivery-failed' }

// @ts-expect-error Non-failure delivery events cannot carry failure fields.
const failureOnAccepted: WorkspaceEvent = { ...deliveryAccepted, failureCode: 'unexpected', failureSummary: 'unexpected' }

// @ts-expect-error Task results require the active definition revision.
const resultWithoutRevision: WorkspaceEvent = {
  id: eventId, sequence: 1, type: 'task/result', taskId: TaskId('task-1'), taskDeliveryAttemptId: TaskDeliveryAttemptId('delivery-1'), text: 'done',
}

// @ts-expect-error Task cancellation subjects are task ids.
const cancellationWithGrant: WorkspaceEvent = { ...taskCancelled, subjectId: DelegationGrantId('grant-1') }

// @ts-expect-error Delegation revocation subjects are grant ids.
const revocationWithTask: WorkspaceEvent = { ...delegationRevoked, subjectId: TaskId('task-1') }

// @ts-expect-error Durable event discriminants are closed to Host-produced facts.
const unknownType: WorkspaceEventType = 'workspace/unknown'

void [
  terminal,
  missingTerminalStatus,
  statusOnOtherEvent,
  knownType,
  deliveryStarted,
  deliveryAccepted,
  deliveryFailed,
  taskResult,
  taskResultAfterCancel,
  taskCancelled,
  delegationRevoked,
  deliverySource,
  deliveryWithoutMessage,
  failedWithoutDetails,
  failureOnAccepted,
  resultWithoutRevision,
  cancellationWithGrant,
  revocationWithTask,
  unknownType,
]
