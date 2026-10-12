import { expect, it } from 'vitest'
import { projectWorkflowResults } from '../packages/web/src/client/workflow-view-model.ts'
import { emptyWorkflow } from './fixtures/workflow-browser.ts'
it('selects every exact attempt and keeps acceptance on the old result', () => {
  const workflow = { ...emptyWorkflow(), reviews: { review: { id: 'review', result: { taskId: 'task', eventId: 'old', attemptId: 'a1' }, decision: 'accepted' as const, comment: '' } } }
  const results = projectWorkflowResults({ workspaceId: 'workspace', tasks: { task: { id: 'task', rootTaskId: 'task', title: 'Work', status: 'cancelled' } }, events: [
    { id: 'old', sequence: 1, type: 'task/result', taskId: 'task', taskDeliveryAttemptId: 'a1', text: 'Old' },
    { id: 'cancel', sequence: 2, type: 'task/cancelled', subjectId: 'task', cancellationScope: 'root-cascade' },
    { id: 'late', sequence: 3, type: 'task/result-after-cancel', taskId: 'task', taskDeliveryAttemptId: 'a2', text: 'Late' },
  ] } as never, workflow)
  expect(results.map(r => [r.result.eventId, r.result.attemptId, r.reviews.map(x => x.decision), r.cancellation?.scope])).toEqual([['old', 'a1', ['accepted'], undefined], ['late', 'a2', [], 'root-cascade']])
})
