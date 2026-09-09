/** Durable task delivery orchestration and resumed-session recovery. */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AgentId, TaskDeliveryAttemptId, TaskId } from './ids.ts'
import type { TaskAssignment, TaskDeliveryProgressEvent, WorkspaceState } from './types.ts'
import type { WorkspaceActivitySource } from './activity-stream.ts'
import type { WorkspaceTurnOutcome } from './turn-tracker.ts'
import {
  acceptTaskDelivery,
  failTaskDelivery,
  inspectTaskDelivery,
  recordTaskResultAfterCancel,
  startTaskDelivery,
  terminalizeTask,
} from './task-delivery.ts'

/** Durable callbacks observed while one tracked delivery enters its turn. */
export interface WorkspaceDeliveryHooks {
  /** Persist that the exact inbox message entered its owning turn. */
  onClaim?(): void | Promise<void>
}

/** Host operations used by the task delivery coordinator. */
export interface TaskDeliveryCoordinatorHost {
  /** Return the latest committed workspace aggregate. */
  snapshot(): WorkspaceState
  /** Commit one pure aggregate mutation through the workspace table. */
  apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState>
  /** Materialize an employee after resumed-session recovery completes. */
  ensureEmployee(agentId: AgentId): Promise<AgentHandle>
  /** Insert and track one new delivery through its terminal turn event. */
  deliver(
    agentId: AgentId,
    delivery: UserMessage,
    recall?: UserMessage,
    source?: WorkspaceActivitySource,
    hooks?: WorkspaceDeliveryHooks,
  ): Promise<WorkspaceTurnOutcome>
  /** Reconstruct tracking for one message already present in a resumed inbox. */
  recoverDelivery?(
    agentId: AgentId,
    handle: Pick<AgentHandle, 'agent'>,
    delivery: UserMessage,
    source: WorkspaceActivitySource,
    hooks?: WorkspaceDeliveryHooks,
  ): Promise<WorkspaceTurnOutcome>
}

/** Durable recovery classification for one open delivery attempt. */
export interface TaskDeliveryRecoveryOutcome {
  /** Task whose latest open delivery attempt was reconciled. */
  readonly taskId: TaskId
  /** Durable/session outcome established during recovery. */
  readonly status: 'pending' | 'completed' | 'interrupted'
}

interface TaskFlight {
  readonly owner: object
  readonly promise: Promise<string>
}

/** Coordinates one durable inbox delivery attempt per task. */
export class TaskDeliveryCoordinator {
  private readonly taskFlights = new Map<TaskId, TaskFlight>()
  private readonly recoveryFlights = new Map<AgentId, Promise<readonly TaskDeliveryRecoveryOutcome[]>>()

  constructor(private readonly host: TaskDeliveryCoordinatorHost) {}

  /**
   * Deliver one open assigned task under a per-task single-flight.
   * @param taskId - Durable task to deliver.
   * @returns The complete text from a successfully completed turn.
   */
  async deliver(taskId: TaskId): Promise<string> {
    return await this.singleFlight(taskId)
  }

  /**
   * Retry one open task without replacing its durable task identity.
   * @param taskId - Durable task whose prior attempt is terminal.
   * @returns The complete text from a successfully completed retry.
   */
  async retryTaskDelivery(taskId: TaskId): Promise<string> {
    return await this.singleFlight(taskId)
  }

  /**
   * Reconcile open attempts owned by one resumed employee before publication.
   * @param agentId - Workspace employee being resumed.
   * @param handle - Unpublished live agent whose inbox and Session log are authoritative.
   * @returns One classification for each open attempt owned by the employee.
   */
  async recoverAgent(agentId: AgentId, handle: Pick<AgentHandle, 'agent'>): Promise<readonly TaskDeliveryRecoveryOutcome[]> {
    const existing = this.recoveryFlights.get(agentId)
    if (existing !== undefined) return await existing
    const flight = this.recover(agentId, handle)
    this.recoveryFlights.set(agentId, flight)
    try {
      return await flight
    } finally {
      if (this.recoveryFlights.get(agentId) === flight) this.recoveryFlights.delete(agentId)
    }
  }

  private async singleFlight(taskId: TaskId): Promise<string> {
    const existing = this.taskFlights.get(taskId)
    if (existing !== undefined) return await existing.promise
    const owner = {}
    const promise = Promise.resolve().then(() => this.run(taskId, owner))
    const flight = { owner, promise }
    this.taskFlights.set(taskId, flight)
    try {
      return await promise
    } finally {
      if (this.taskFlights.get(taskId) === flight) this.taskFlights.delete(taskId)
    }
  }

  private async run(taskId: TaskId, owner: object): Promise<string> {
    const before = this.host.snapshot()
    const assignment = assignmentFor(before, taskId)
    const agent = before.agents[assignment.assigneeAgentId]
    if (agent === undefined) throw new Error(`task '${taskId}' assignee does not exist`)
    await this.host.ensureEmployee(agent.id)
    const recovered = this.taskFlights.get(taskId)
    if (recovered !== undefined && recovered.owner !== owner) return await recovered.promise

    let attempt: {
      readonly attemptId: TaskDeliveryAttemptId
      readonly message: UserMessage
    } | undefined
    await this.host.apply(current => {
      const started = startTaskDelivery(current, { taskId })
      attempt = { attemptId: started.attemptId, message: started.message }
      return started.state
    })
    if (attempt === undefined) throw new Error(`task '${taskId}' delivery start did not publish an attempt`)
    const startedAttempt = attempt
    const identity = { taskId, attemptId: startedAttempt.attemptId, messageId: startedAttempt.message.id }

    let claimed = false
    let outcome: WorkspaceTurnOutcome
    try {
      outcome = await this.host.deliver(
        agent.id,
        startedAttempt.message,
        undefined,
        { kind: 'task', taskId, attemptId: startedAttempt.attemptId },
        {
          onClaim: async () => {
            claimed = true
            await this.host.apply(current => acceptTaskDelivery(current, identity).state)
          },
        },
      )
    } catch (error) {
      const inspection = inspectTaskDelivery(this.host.snapshot(), taskId)
      const accepted = inspection.attemptId === startedAttempt.attemptId && inspection.phase === 'accepted'
      await this.failIfOpen(
        identity,
        claimed || accepted ? 'interrupted' : 'delivery-rejected',
        claimed || accepted ? 'Delivery was interrupted before a terminal result.' : 'Agent delivery could not be queued.',
      )
      throw error
    }

    const toolResult = completedTaskResult(this.host.snapshot(), identity)
    if (toolResult !== undefined) return toolResult
    const result = completedText(outcome)
    if (result === undefined) {
      await this.failIfOpen(identity, 'interrupted', 'Delivery was interrupted before a terminal result.')
      throw new Error(`task '${taskId}' delivery was interrupted before a terminal result`)
    }
    await this.recordCompletedResult(assignment, identity, result)
    return completedTaskResult(this.host.snapshot(), identity) ?? result
  }

  private async recover(agentId: AgentId, handle: Pick<AgentHandle, 'agent'>): Promise<readonly TaskDeliveryRecoveryOutcome[]> {
    const outcomes: TaskDeliveryRecoveryOutcome[] = []
    const snapshot = this.host.snapshot()
    const assignments = Object.values(snapshot.taskAssignments)
      .filter(assignment => assignment.assigneeAgentId === agentId)
    for (const assignment of assignments) {
      const inspection = inspectTaskDelivery(this.host.snapshot(), assignment.taskId)
      if (inspection.attemptId === undefined || (inspection.phase !== 'started' && inspection.phase !== 'accepted')) continue
      const started = latestStartedEvent(this.host.snapshot(), assignment.taskId, inspection.attemptId)
      if (started === undefined) continue
      const identity = {
        taskId: assignment.taskId,
        attemptId: inspection.attemptId,
        messageId: started.messageId,
      }
      const evidence = inspectAgentDelivery(handle, started.messageId)

      if (evidence.status === 'pending') {
        const recoverDelivery = this.host.recoverDelivery
        if (recoverDelivery === undefined) {
          await this.failIfOpen(identity, 'interrupted', 'Delivery was interrupted before a terminal result.')
          outcomes.push({ taskId: assignment.taskId, status: 'interrupted' })
          continue
        }
        const completion = this.finishRecovered(
          assignment,
          identity,
          recoverDelivery(
            agentId,
            handle,
            evidence.message,
            { kind: 'task', taskId: assignment.taskId, attemptId: inspection.attemptId },
            { onClaim: async () => await this.acceptIfStarted(identity) },
          ),
        )
        this.publishRecoveredFlight(assignment.taskId, completion)
        outcomes.push({ taskId: assignment.taskId, status: 'pending' })
        continue
      }

      if (evidence.status === 'completed') {
        await this.acceptIfStarted(identity)
        await this.recordCompletedResult(assignment, identity, evidence.result)
        outcomes.push({ taskId: assignment.taskId, status: 'completed' })
        continue
      }

      await this.failIfOpen(identity, 'interrupted', 'Delivery was interrupted before a terminal result.')
      outcomes.push({ taskId: assignment.taskId, status: 'interrupted' })
    }
    return outcomes
  }

  private publishRecoveredFlight(taskId: TaskId, promise: Promise<string>): void {
    const displaced = this.taskFlights.get(taskId)
    const recovered = { owner: {}, promise }
    this.taskFlights.set(taskId, recovered)
    void this.releaseRecoveredFlight(taskId, recovered, displaced)
  }

  private async releaseRecoveredFlight(taskId: TaskId, recovered: TaskFlight, displaced: TaskFlight | undefined): Promise<void> {
    try {
      await recovered.promise
    } catch (_error) {
      // finishRecovered already persists the failure; cleanup only waits for convergence.
    }
    if (displaced !== undefined) {
      try {
        await displaced.promise
      } catch (_error) {
        // The displaced caller observes the same recovered failure before cleanup.
      }
    }
    if (this.taskFlights.get(taskId) === recovered) this.taskFlights.delete(taskId)
  }

  private async finishRecovered(
    assignment: TaskAssignment,
    identity: { readonly taskId: TaskId; readonly attemptId: TaskDeliveryAttemptId; readonly messageId: MessageId },
    pending: Promise<WorkspaceTurnOutcome>,
  ): Promise<string> {
    let outcome: WorkspaceTurnOutcome
    try {
      outcome = await pending
    } catch (error) {
      await this.failIfOpen(identity, 'interrupted', 'Delivery was interrupted before a terminal result.')
      throw error
    }
    const toolResult = completedTaskResult(this.host.snapshot(), identity)
    if (toolResult !== undefined) return toolResult
    const result = completedText(outcome)
    if (result === undefined) {
      await this.failIfOpen(identity, 'interrupted', 'Delivery was interrupted before a terminal result.')
      throw new Error(`task '${identity.taskId}' delivery was interrupted before a terminal result`)
    }
    await this.recordCompletedResult(assignment, identity, result)
    return completedTaskResult(this.host.snapshot(), identity) ?? result
  }

  private async acceptIfStarted(
    identity: { readonly taskId: TaskId; readonly attemptId: TaskDeliveryAttemptId; readonly messageId: MessageId },
  ): Promise<void> {
    await this.host.apply(current => {
      const inspection = inspectTaskDelivery(current, identity.taskId)
      if (inspection.attemptId !== identity.attemptId || inspection.phase !== 'started') return current
      return acceptTaskDelivery(current, identity).state
    })
  }

  private async recordCompletedResult(
    assignment: TaskAssignment,
    identity: { readonly taskId: TaskId; readonly attemptId: TaskDeliveryAttemptId; readonly messageId: MessageId },
    result: string,
  ): Promise<void> {
    await this.host.apply(current => {
      const inspection = inspectTaskDelivery(current, identity.taskId)
      if (inspection.attemptId !== identity.attemptId || inspection.phase !== 'accepted') return current
      const agent = current.agents[assignment.assigneeAgentId]
      if (agent === undefined) throw new Error(`task '${identity.taskId}' assignee does not exist`)
      const request = {
        actorAgentId: agent.id,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        result,
        definitionRevisionId: agent.definitionRevisionId,
      }
      return current.tasks[identity.taskId]?.status === 'cancelled'
        ? recordTaskResultAfterCancel(current, request).state
        : terminalizeTask(current, request).state
    })
  }

  private async failIfOpen(
    identity: { readonly taskId: TaskId; readonly attemptId: TaskDeliveryAttemptId; readonly messageId: MessageId },
    failureCode: string,
    failureSummary: string,
  ): Promise<void> {
    await this.host.apply(current => {
      const inspection = inspectTaskDelivery(current, identity.taskId)
      if (inspection.attemptId !== identity.attemptId || (inspection.phase !== 'started' && inspection.phase !== 'accepted')) {
        return current
      }
      return failTaskDelivery(current, { ...identity, failureCode, failureSummary }).state
    })
  }
}

function completedText(outcome: WorkspaceTurnOutcome): string | undefined {
  if (outcome.stopReason.kind !== 'completed' || outcome.interrupted) return undefined
  const text = textOf(outcome.output)
  return text.trim() === '' ? undefined : text
}

function completedTaskResult(
  state: WorkspaceState,
  identity: { readonly taskId: TaskId; readonly attemptId: TaskDeliveryAttemptId },
): string | undefined {
  return state.events.findLast(event => (
    (event.type === 'task/result' || event.type === 'task/result-after-cancel')
    && event.taskId === identity.taskId
    && event.taskDeliveryAttemptId === identity.attemptId
  ))?.text
}

function assignmentFor(state: WorkspaceState, taskId: TaskId): TaskAssignment {
  const assignment = Object.values(state.taskAssignments).find(candidate => candidate.taskId === taskId)
  if (assignment === undefined) throw new Error(`task '${taskId}' has no assignment`)
  return assignment
}

type RecoveredDeliveryEvidence =
  | { readonly status: 'pending'; readonly message: UserMessage }
  | { readonly status: 'completed'; readonly result: string }
  | { readonly status: 'interrupted' }

function inspectAgentDelivery(handle: Pick<AgentHandle, 'agent'>, messageId: MessageId): RecoveredDeliveryEvidence {
  const pending = [...handle.agent.inbox.nextTurn, ...handle.agent.inbox.nextStep]
    .find(message => message.id === messageId)
  if (pending !== undefined) return { status: 'pending', message: pending }

  const folded = foldDeliveryEvents(handle.agent.session.events, messageId)
  if (folded.message === undefined || folded.turn === undefined || !folded.entered) return { status: 'interrupted' }
  if (folded.reason?.kind !== 'completed' || folded.interrupted || folded.output === undefined) {
    return { status: 'interrupted' }
  }
  const result = textOf(folded.output)
  return result.trim() === '' ? { status: 'interrupted' } : { status: 'completed', result }
}

interface FoldedDeliveryEvents {
  readonly message: UserMessage | undefined
  readonly turn: number | undefined
  readonly entered: boolean
  readonly output: readonly ContentBlock[] | undefined
  readonly interrupted: boolean
  readonly reason: TurnEndReason | undefined
}

function foldDeliveryEvents(events: readonly SessionEvent[], messageId: MessageId): FoldedDeliveryEvents {
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  let activeTurn: number | undefined
  let claimedTurn: number | undefined
  let message: UserMessage | undefined
  let entered = false
  let output: readonly ContentBlock[] | undefined
  let interrupted = false
  let reason: TurnEndReason | undefined

  for (const event of events) {
    if (event.type === 'turn/start') activeTurn = event.data.turn
    if (event.type === 'agent/inbox/spliced') {
      const list = inbox[event.data.target]
      const removed = list.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
      const inserted = event.data.inserted.find(candidate => candidate.id === messageId)
      if (inserted !== undefined) message = inserted
      if (removed.some(candidate => candidate.id === messageId)) claimedTurn = activeTurn
    }
    if (event.type === 'user/message' && event.data.id === messageId) {
      message = event.data
      entered = claimedTurn !== undefined && activeTurn === claimedTurn
    }
    if (event.type === 'assistant/message' && event.data.turn === claimedTurn && event.data.message.content.length > 0) {
      output = event.data.message.content
      interrupted = event.data.interrupted === true
    }
    if (event.type === 'turn/end') {
      if (event.data.turn === claimedTurn) reason = event.data.reason
      if (event.data.turn === activeTurn) activeTurn = undefined
    }
  }
  return { message, turn: claimedTurn, entered, output, interrupted, reason }
}

function latestStartedEvent(
  state: WorkspaceState,
  taskId: TaskId,
  attemptId: TaskDeliveryAttemptId,
): TaskDeliveryProgressEvent | undefined {
  for (let index = state.events.length - 1; index >= 0; index--) {
    const event = state.events[index]
    if (event?.type === 'task/delivery-started' && event.taskId === taskId && event.taskDeliveryAttemptId === attemptId) {
      return event
    }
  }
  return undefined
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}
