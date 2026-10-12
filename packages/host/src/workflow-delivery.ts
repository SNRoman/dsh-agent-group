/** Persisted workflow instructions for new and explicitly retried task attempts. */
import type { TaskId } from './ids.ts'
import type { WorkspaceRecordV2 } from './workspace-record.ts'
import { renderWorkflowTaskInstructions } from './workflow.ts'

/** @param record Current committed organization. @param taskId Task to deliver. @returns Full frozen brief instructions, or undefined for legacy title-only tasks. */
export function workflowTaskInstructions(record: Pick<WorkspaceRecordV2, 'workflow'>, taskId: TaskId): string | undefined {
  return Object.hasOwn(record.workflow.taskBriefs, taskId)
    ? renderWorkflowTaskInstructions(record.workflow.taskBriefs[taskId]!)
    : undefined
}
