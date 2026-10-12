/** Exact result/attempt projections for review and inert artifact display. */
import type { WorkspaceSnapshot } from './contracts.ts'
import type { TaskArtifact, TaskResultReference, TaskReview, WorkflowState } from './workflow-contracts.ts'
export interface WorkflowResultProjection { readonly result: TaskResultReference; readonly type: 'task/result' | 'task/result-after-cancel'; readonly title: string; readonly text: string; readonly artifacts: readonly TaskArtifact[]; readonly reviews: readonly TaskReview[]; readonly cancellation?: { readonly scope: 'root-cascade' | 'derived-only' | 'unknown'; readonly eventId: string } | undefined }
/** @param snapshot Current aggregate. @param workflow Workflow from the same organization. @returns Every durable result, with only its exact metadata. */
export function projectWorkflowResults(snapshot: WorkspaceSnapshot, workflow: WorkflowState): readonly WorkflowResultProjection[] {
  return snapshot.events.flatMap(event => {
    if (event.type !== 'task/result' && event.type !== 'task/result-after-cancel') return []
    const reference = { taskId: event.taskId, eventId: event.id, attemptId: event.taskDeliveryAttemptId }
    const matches = (other: TaskResultReference): boolean => other.taskId === reference.taskId && other.eventId === reference.eventId && other.attemptId === reference.attemptId
    const cancellation = event.type === 'task/result-after-cancel' ? snapshot.events.findLast(e => e.type === 'task/cancelled' && e.subjectId === event.taskId && e.sequence < event.sequence) : undefined
    return [{ result: reference, type: event.type, title: Object.hasOwn(snapshot.tasks, event.taskId) ? snapshot.tasks[event.taskId]?.title ?? event.taskId : event.taskId, text: event.text,
      artifacts: Object.values(workflow.artifacts).filter(a => matches(a.result)), reviews: Object.values(workflow.reviews).filter(r => matches(r.result)),
      ...(cancellation?.type === 'task/cancelled' ? { cancellation: { scope: cancellation.cancellationScope ?? 'unknown', eventId: cancellation.id } } : {}),
    }]
  })
}
