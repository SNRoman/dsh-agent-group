import { describe, expect, test } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { HumanId, TaskDeliveryAttemptId, WorkspaceId } from '../packages/host/src/ids.ts'
import {
  acceptTaskDelivery,
  failTaskDelivery,
  inspectTaskDelivery,
  recordTaskResultAfterCancel,
  startTaskDelivery,
  terminalizeTask,
} from '../packages/host/src/task-delivery.ts'
import { cancelTask, assignHumanTask } from '../packages/host/src/tasks.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'

function assignedTask() {
  const initial = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(initial, {
    type: 'definition/create', name: 'Engineer', description: 'd', instructions: 'i',
  })
  const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Ada' })
  const assigned = assignHumanTask(agent.state, {
    humanId: HumanId('owner'), assigneeAgentId: agent.agentId, title: 'Ship the delivery state machine',
  })
  return { state: assigned.state, taskId: assigned.taskId, agentId: agent.agentId, definitionRevisionId: definition.definitionRevisionId }
}

function acceptedTask() {
  const task = assignedTask()
  const started = startTaskDelivery(task.state, { taskId: task.taskId })
  const accepted = acceptTaskDelivery(started.state, {
    taskId: task.taskId, attemptId: started.attemptId, messageId: started.message.id,
  })
  return { ...task, ...accepted, attemptId: started.attemptId, messageId: started.message.id }
}

describe('durable task delivery attempts', () => {
  test('starts one frozen deterministic task message and folds its started phase', () => {
    const task = assignedTask()
    const started = startTaskDelivery(task.state, { taskId: task.taskId })

    expect(started.message).toMatchObject({
      id: MessageId(`agent-workspace-task:${task.state.workspaceId}:${started.attemptId}`),
      source: {
        kind: 'agent-workspace-delivery',
        workspaceId: task.state.workspaceId,
        source: { kind: 'task', taskId: task.taskId },
        taskDeliveryAttemptId: started.attemptId,
      },
    })
    expect(Object.isFrozen(started.message)).toBe(true)
    expect(inspectTaskDelivery(started.state, task.taskId)).toEqual({ attemptId: started.attemptId, phase: 'started' })
  })

  test('accepts only the matching started delivery and persists failure terminals before or after acceptance', () => {
    const task = assignedTask()
    const started = startTaskDelivery(task.state, { taskId: task.taskId })
    const identity = { taskId: task.taskId, attemptId: started.attemptId, messageId: started.message.id }

    expect(() => acceptTaskDelivery(started.state, { ...identity, messageId: MessageId('agent-workspace-task:wrong') })).toThrow(/message/i)
    expect(() => acceptTaskDelivery(started.state, { ...identity, attemptId: TaskDeliveryAttemptId('wrong-attempt') })).toThrow(/attempt/i)
    const other = assignHumanTask(started.state, {
      humanId: HumanId('owner'), assigneeAgentId: task.agentId, title: 'A different task',
    })
    expect(() => acceptTaskDelivery(other.state, { ...identity, taskId: other.taskId })).toThrow(/task/i)
    const accepted = acceptTaskDelivery(started.state, identity)
    expect(inspectTaskDelivery(accepted.state, task.taskId)).toEqual({ attemptId: started.attemptId, phase: 'accepted' })
    const failedAfterAccept = failTaskDelivery(accepted.state, { ...identity, failureCode: 'delivery-rejected', failureSummary: 'Inbox rejected the message.' })
    expect(inspectTaskDelivery(failedAfterAccept.state, task.taskId)).toEqual({ attemptId: started.attemptId, phase: 'settled' })
    expect(failedAfterAccept.state.events.at(-1)).toMatchObject({
      type: 'task/delivery-failed', taskId: identity.taskId,
      taskDeliveryAttemptId: identity.attemptId, messageId: identity.messageId,
    })

    const failedBeforeAccept = failTaskDelivery(started.state, { ...identity, failureCode: 'delivery-rejected', failureSummary: 'Inbox rejected the message.' })
    expect(inspectTaskDelivery(failedBeforeAccept.state, task.taskId)).toEqual({ attemptId: started.attemptId, phase: 'retryable' })
    expect(failedBeforeAccept.state.events.at(-1)).not.toHaveProperty('text')
  })

  test('allows a new attempt only after the prior attempt is terminal', () => {
    const task = assignedTask()
    const first = startTaskDelivery(task.state, { taskId: task.taskId })

    expect(() => startTaskDelivery(first.state, { taskId: task.taskId })).toThrow(/open delivery/i)
    const failed = failTaskDelivery(first.state, {
      taskId: task.taskId, attemptId: first.attemptId, messageId: first.message.id,
      failureCode: 'delivery-rejected', failureSummary: 'Inbox rejected the message.',
    })
    const retry = startTaskDelivery(failed.state, { taskId: task.taskId })

    expect(retry.attemptId).not.toBe(first.attemptId)
    expect(inspectTaskDelivery(retry.state, task.taskId)).toEqual({ attemptId: retry.attemptId, phase: 'started' })
  })

  test('terminalizes an accepted delivery atomically with one result, completion, and assignee memory entry', () => {
    const accepted = acceptedTask()
    const terminalized = terminalizeTask(accepted.state, {
      actorAgentId: accepted.agentId,
      taskId: accepted.taskId,
      attemptId: accepted.attemptId,
      result: 'The task is complete.',
      definitionRevisionId: accepted.definitionRevisionId,
    })
    const result = terminalized.state.events.at(-2)
    const completion = terminalized.state.events.at(-1)

    expect(result).toMatchObject({ type: 'task/result', taskId: accepted.taskId, taskDeliveryAttemptId: accepted.attemptId, text: 'The task is complete.' })
    expect(completion).toMatchObject({ type: 'task/completed', subjectId: accepted.taskId })
    expect(terminalized.state.tasks[accepted.taskId]?.status).toBe('completed')
    expect(terminalized.state.memoryEntries.filter(entry => entry.agentId === accepted.agentId && entry.eventId === result?.id && entry.acquiredBy === 'task')).toHaveLength(1)
    expect(() => terminalizeTask(terminalized.state, {
      actorAgentId: accepted.agentId, taskId: accepted.taskId, attemptId: accepted.attemptId,
      result: 'A duplicate result.', definitionRevisionId: accepted.definitionRevisionId,
    })).toThrow(/terminal|completed/i)
  })

  test('records one full accepted result after cancellation without reopening the task or accepting partial output', () => {
    const accepted = acceptedTask()
    const cancelled = cancelTask(accepted.state, { humanId: HumanId('owner'), taskId: accepted.taskId })
    const recorded = recordTaskResultAfterCancel(cancelled.state, {
      actorAgentId: accepted.agentId,
      taskId: accepted.taskId,
      attemptId: accepted.attemptId,
      result: 'The already accepted turn completed.',
      definitionRevisionId: accepted.definitionRevisionId,
    })

    expect(recorded.state.tasks[accepted.taskId]?.status).toBe('cancelled')
    expect(recorded.state.events.at(-1)).toMatchObject({ type: 'task/result-after-cancel', text: 'The already accepted turn completed.' })
    expect(recorded.state.events.filter(event => event.type === 'task/result-after-cancel')).toHaveLength(1)
    expect(() => recordTaskResultAfterCancel(recorded.state, {
      actorAgentId: accepted.agentId, taskId: accepted.taskId, attemptId: accepted.attemptId,
      result: 'A duplicate raced result.', definitionRevisionId: accepted.definitionRevisionId,
    })).toThrow(/not accepted/i)

    const interruptedTask = assignedTask()
    const started = startTaskDelivery(interruptedTask.state, { taskId: interruptedTask.taskId })
    expect(() => failTaskDelivery(started.state, {
      taskId: interruptedTask.taskId,
      attemptId: started.attemptId,
      messageId: started.message.id,
      failureCode: 'interrupted',
      failureSummary: 'A partial assistant response must not become a task result.',
    })).not.toThrow()
    expect(started.state.events.some(event => event.type === 'task/result' || event.type === 'task/result-after-cancel')).toBe(false)
  })
})
