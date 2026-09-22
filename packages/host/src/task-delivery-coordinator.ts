/** Durable task delivery orchestration and resumed-session recovery. */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AgentId, DefinitionRevisionId, TaskDeliveryAttemptId, TaskId } from './ids.ts'
import type { TaskAssignment, TaskDeliveryProgressEvent, WorkspaceState } from './types.ts'
import type { WorkspaceActivitySource } from './activity-stream.ts'
import { projectDefinitionHistory } from './definition-history.ts'
import type { WorkspaceTurnOutcome } from './turn-tracker.ts'
import {
  acceptTaskDelivery,
  failTaskDelivery,
  inspectTaskDelivery,
  recordTaskResultAfterCancel,
  startTaskDelivery,
  terminalizeTask,
} from './task-delivery.ts'

/** Lifecycle callbacks observed while one tracked delivery enters its turn. */
export interface WorkspaceDeliveryHooks {
  /** Reject a new inbox admission synchronously when its owning work was cancelled. */
  beforeAdmission?(): void
  /** Persist that the exact inbox message entered its owning turn. */
  onClaim?(definitionRevisionId?: DefinitionRevisionId): void | Promise<void>
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
  readonly cancellation: AbortController
  ownedAttemptId?: TaskDeliveryAttemptId
}

/** Delivery attempt durably started by an owning serialized mutation. */
interface PreparedTaskDelivery {
  readonly state: WorkspaceState
  readonly assignment: TaskAssignment
  readonly agentId: AgentId
  readonly definitionRevisionId: DefinitionRevisionId
  readonly taskId: TaskId
  readonly attemptId: TaskDeliveryAttemptId
  readonly message: UserMessage
}

/** Exclusive Browser retry ownership reserved before its durable attempt is created. */
export interface TaskDeliveryReservation {
  /**
   * Build the exact delivery-start candidate in the caller's serialized update.
   * @param state - Aggregate current in the caller's table update slot.
   * @returns Candidate state and delivery identity owned by this reservation.
   */
  prepare(state: WorkspaceState): PreparedTaskDelivery
  /**
   * Adopt the reservation and start runtime delivery after persistence succeeds.
   * @param prepared - Candidate returned by this reservation's prepare call.
   */
  commit(prepared: PreparedTaskDelivery): void
  /** Release the reservation after stale rejection or persistence failure. */
  rollback(): void
  /** @returns The committed reservation's delivery result. */
  result(): Promise<string>
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
   * Prevent one exact live task flight from entering or publishing more work.
   * @param taskId - Durable task whose cancellation already committed.
   */
  cancelTaskDelivery(taskId: TaskId): void {
    this.taskFlights.get(taskId)?.cancellation.abort()
  }

  /**
   * Start a retry in the caller's serialized aggregate update.
   * @param state - Aggregate current in the caller's revision-checked update slot.
   * @param taskId - Open task whose previous delivery attempt is terminal.
   * @returns The committed candidate and exact attempt to continue afterward.
   */
  private prepareTaskDelivery(state: WorkspaceState, taskId: TaskId): PreparedTaskDelivery {
    const assignment = assignmentFor(state, taskId)
    const agent = state.agents[assignment.assigneeAgentId]
    if (agent === undefined) throw new Error(`task '${taskId}' assignee does not exist`)
    const started = startTaskDelivery(state, { taskId })
    return {
      state: started.state,
      assignment,
      agentId: agent.id,
      definitionRevisionId: agent.definitionRevisionId,
      taskId,
      attemptId: started.attemptId,
      message: started.message,
    }
  }

  /**
   * Reserve one task flight before the caller creates its durable retry attempt.
   * @param taskId - Exact task whose retry flight must be owned.
   * @returns Exclusive prepare/commit/rollback control for that flight.
   */
  reserveTaskDelivery(taskId: TaskId): TaskDeliveryReservation {
    if (this.taskFlights.has(taskId)) throw new Error(`task '${taskId}' already has a live delivery`)
    const owner = {}
    const completion = Promise.withResolvers<string>()
    void completion.promise.catch(() => {})
    const flight: TaskFlight = { owner, promise: completion.promise, cancellation: new AbortController() }
    this.taskFlights.set(taskId, flight)
    let phase: 'reserved' | 'committed' | 'rolled-back' = 'reserved'
    return {
      prepare: state => {
        if (phase !== 'reserved' || flight.ownedAttemptId !== undefined) {
          throw new Error(`task '${taskId}' delivery reservation is not pending`)
        }
        const prepared = this.prepareTaskDelivery(state, taskId)
        flight.ownedAttemptId = prepared.attemptId
        return prepared
      },
      commit: prepared => {
        if (phase !== 'reserved') throw new Error(`task '${taskId}' delivery reservation is not pending`)
        if (prepared.taskId !== taskId) throw new Error(`task '${taskId}' delivery reservation received another task`)
        if (flight.ownedAttemptId !== prepared.attemptId) {
          throw new Error(`task '${taskId}' delivery reservation does not own the prepared attempt`)
        }
        phase = 'committed'
        void (async () => {
          try {
            completion.resolve(await this.runPrepared(prepared, owner, true, flight.cancellation.signal))
          } catch (error) {
            try {
              await this.convergeRejectedFlight(taskId)
              completion.reject(error)
            } catch (convergenceError) {
              completion.reject(new AggregateError([error, convergenceError], `task '${taskId}' delivery and failure convergence both failed`))
            }
          } finally {
            if (this.taskFlights.get(taskId) === flight) this.taskFlights.delete(taskId)
          }
        })()
      },
      rollback: () => {
        if (phase !== 'reserved') return
        phase = 'rolled-back'
        delete flight.ownedAttemptId
        if (this.taskFlights.get(taskId) === flight) this.taskFlights.delete(taskId)
        completion.reject(new Error(`task '${taskId}' delivery reservation was rolled back`))
      },
      result: async () => await completion.promise,
    }
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
    const cancellation = new AbortController()
    const promise = Promise.resolve().then(() => this.run(taskId, owner, cancellation.signal))
    const flight = { owner, promise, cancellation }
    this.taskFlights.set(taskId, flight)
    try {
      return await promise
    } catch (error) {
      await this.convergeRejectedFlight(taskId)
      throw error
    } finally {
      if (this.taskFlights.get(taskId) === flight) this.taskFlights.delete(taskId)
    }
  }

  private async run(taskId: TaskId, owner: object, signal: AbortSignal): Promise<string> {
    throwIfTaskDeliveryCancelled(signal, taskId)
    const before = this.host.snapshot()
    const assignment = assignmentFor(before, taskId)
    const agent = before.agents[assignment.assigneeAgentId]
    if (agent === undefined) throw new Error(`task '${taskId}' assignee does not exist`)
    await this.host.ensureEmployee(agent.id)
    throwIfTaskDeliveryCancelled(signal, taskId)
    const recovered = this.taskFlights.get(taskId)
    if (recovered !== undefined && recovered.owner !== owner) return await recovered.promise

    let prepared: PreparedTaskDelivery | undefined
    await this.host.apply(current => {
      prepared = this.prepareTaskDelivery(current, taskId)
      return prepared.state
    })
    if (prepared === undefined) throw new Error(`task '${taskId}' delivery start did not publish an attempt`)
    return await this.runPrepared(prepared, owner, false, signal)
  }

  private async runPrepared(
    prepared: PreparedTaskDelivery,
    owner: object,
    ensureEmployee: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    const { assignment, agentId, definitionRevisionId, taskId, attemptId, message } = prepared
    throwIfTaskDeliveryCancelled(signal, taskId)
    const recovered = this.taskFlights.get(taskId)
    if (recovered !== undefined && recovered.owner !== owner) return await recovered.promise
    const identity = { taskId, attemptId, messageId: message.id }

    let claimed = false
    let outcome: WorkspaceTurnOutcome
    try {
      if (ensureEmployee) await this.host.ensureEmployee(agentId)
      throwIfTaskDeliveryCancelled(signal, taskId)
      outcome = await this.host.deliver(
        agentId,
        message,
        undefined,
        { kind: 'task', taskId, attemptId },
        {
          beforeAdmission: () => throwIfTaskDeliveryCancelled(signal, taskId),
          onClaim: async definitionRevisionId => {
            throwIfTaskDeliveryCancelled(signal, taskId)
            claimed = true
            await this.host.apply(current => acceptTaskDelivery(current, {
              ...identity,
              definitionRevisionId: definitionRevisionId ?? prepared.definitionRevisionId,
            }).state)
          },
        },
      )
    } catch (error) {
      throwIfTaskDeliveryCancelled(signal, taskId)
      const inspection = inspectTaskDelivery(this.host.snapshot(), taskId)
      const accepted = inspection.attemptId === attemptId && inspection.phase === 'accepted'
      await this.failIfOpen(
        identity,
        claimed || accepted ? 'interrupted' : 'delivery-rejected',
        claimed || accepted ? 'Delivery was interrupted before a terminal result.' : 'Agent delivery could not be queued.',
      )
      throw error
    }

    throwIfTaskDeliveryCancelled(signal, taskId)
    const toolResult = completedTaskResult(this.host.snapshot(), identity)
    if (toolResult !== undefined) return toolResult
    const result = completedText(outcome)
    if (result === undefined) {
      await this.failIfOpen(identity, 'interrupted', 'Delivery was interrupted before a terminal result.')
      throw new Error(`task '${taskId}' delivery was interrupted before a terminal result`)
    }
    await this.recordCompletedResult(assignment, identity, result, outcome.definitionRevisionId ?? definitionRevisionId)
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
      if (this.taskFlights.get(assignment.taskId)?.ownedAttemptId === inspection.attemptId) continue
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
        const cancellation = new AbortController()
        const completion = this.finishRecovered(
          assignment,
          identity,
          inspection.phase === 'accepted'
            ? this.revisionForAcceptedAttempt(snapshot, assignment, identity)
            : snapshot.agents[agentId]?.definitionRevisionId,
          inspection.phase === 'accepted',
          recoverDelivery(
            agentId,
            handle,
            evidence.message,
            { kind: 'task', taskId: assignment.taskId, attemptId: inspection.attemptId },
            {
              onClaim: async definitionRevisionId => await this.acceptIfStarted(
                identity,
                definitionRevisionId ?? snapshot.agents[agentId]?.definitionRevisionId,
              ),
            },
          ),
          cancellation.signal,
        )
        this.publishRecoveredFlight(assignment.taskId, completion, cancellation)
        outcomes.push({ taskId: assignment.taskId, status: 'pending' })
        continue
      }

      if (evidence.status === 'completed') {
        const revisionId = this.revisionForAcceptedAttempt(snapshot, assignment, identity)
        if (inspection.phase === 'started') {
          await this.failIfOpen(identity, 'interrupted', 'Delivery claim revision could not be recovered.')
          outcomes.push({ taskId: assignment.taskId, status: 'interrupted' })
          continue
        }
        if (revisionId === undefined) {
          await this.failIfOpen(identity, 'interrupted', 'Delivery claim revision could not be recovered.')
          outcomes.push({ taskId: assignment.taskId, status: 'interrupted' })
          continue
        }
        await this.recordCompletedResult(assignment, identity, evidence.result, revisionId)
        outcomes.push({ taskId: assignment.taskId, status: 'completed' })
        continue
      }

      await this.failIfOpen(identity, 'interrupted', 'Delivery was interrupted before a terminal result.')
      outcomes.push({ taskId: assignment.taskId, status: 'interrupted' })
    }
    return outcomes
  }

  private publishRecoveredFlight(taskId: TaskId, promise: Promise<string>, cancellation: AbortController): void {
    const displaced = this.taskFlights.get(taskId)
    const recovered = { owner: {}, promise, cancellation }
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
    capturedRevisionId: DefinitionRevisionId | undefined,
    acceptedBeforeRecovery: boolean,
    pending: Promise<WorkspaceTurnOutcome>,
    signal: AbortSignal,
  ): Promise<string> {
    let outcome: WorkspaceTurnOutcome
    try {
      outcome = await pending
    } catch (error) {
      await this.failIfOpen(identity, 'interrupted', 'Delivery was interrupted before a terminal result.')
      throw error
    }
    throwIfTaskDeliveryCancelled(signal, identity.taskId)
    const toolResult = completedTaskResult(this.host.snapshot(), identity)
    if (toolResult !== undefined) return toolResult
    const result = completedText(outcome)
    if (result === undefined) {
      await this.failIfOpen(identity, 'interrupted', 'Delivery was interrupted before a terminal result.')
      throw new Error(`task '${identity.taskId}' delivery was interrupted before a terminal result`)
    }
    const definitionRevisionId = acceptedBeforeRecovery
      ? capturedRevisionId
      : outcome.definitionRevisionId ?? capturedRevisionId
    if (definitionRevisionId === undefined) {
      await this.failIfOpen(identity, 'interrupted', 'Delivery claim revision could not be recovered.')
      throw new Error(`task '${identity.taskId}' delivery claim revision could not be recovered`)
    }
    await this.recordCompletedResult(assignment, identity, result, definitionRevisionId)
    return completedTaskResult(this.host.snapshot(), identity) ?? result
  }

  private async acceptIfStarted(
    identity: { readonly taskId: TaskId; readonly attemptId: TaskDeliveryAttemptId; readonly messageId: MessageId },
    definitionRevisionId?: DefinitionRevisionId,
  ): Promise<void> {
    await this.host.apply(current => {
      const inspection = inspectTaskDelivery(current, identity.taskId)
      if (inspection.attemptId !== identity.attemptId || inspection.phase !== 'started') return current
      return acceptTaskDelivery(current, { ...identity, ...(definitionRevisionId === undefined ? {} : { definitionRevisionId }) }).state
    })
  }

  private revisionForAcceptedAttempt(
    state: WorkspaceState,
    assignment: TaskAssignment,
    identity: { readonly attemptId: TaskDeliveryAttemptId },
  ): DefinitionRevisionId | undefined {
    const accepted = state.events.findLast(event => (
      event.type === 'task/delivery-accepted'
      && event.taskDeliveryAttemptId === identity.attemptId
    ))
    return accepted?.definitionRevisionId ?? deriveLegacyClaimRevision(state, assignment, accepted?.sequence)
  }

  private async recordCompletedResult(
    assignment: TaskAssignment,
    identity: { readonly taskId: TaskId; readonly attemptId: TaskDeliveryAttemptId; readonly messageId: MessageId },
    result: string,
    definitionRevisionId: DefinitionRevisionId,
  ): Promise<void> {
    await this.host.apply(current => {
      const inspection = inspectTaskDelivery(current, identity.taskId)
      if (inspection.attemptId !== identity.attemptId || inspection.phase !== 'accepted') return current
      const request = {
        actorAgentId: assignment.assigneeAgentId,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        result,
        definitionRevisionId,
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

  /** Ensure a rejected background flight cannot leave its latest attempt open. */
  private async convergeRejectedFlight(taskId: TaskId): Promise<void> {
    const inspection = inspectTaskDelivery(this.host.snapshot(), taskId)
    if (inspection.attemptId === undefined || (inspection.phase !== 'started' && inspection.phase !== 'accepted')) return
    const started = latestStartedEvent(this.host.snapshot(), taskId, inspection.attemptId)
    if (started === undefined) return
    const accepted = inspection.phase === 'accepted'
    await this.failIfOpen(
      { taskId, attemptId: inspection.attemptId, messageId: started.messageId },
      accepted ? 'interrupted' : 'delivery-rejected',
      accepted ? 'Delivery was interrupted before a terminal result.' : 'Agent delivery could not be queued.',
    )
  }
}

function completedText(outcome: WorkspaceTurnOutcome): string | undefined {
  if (outcome.stopReason.kind !== 'completed' || outcome.interrupted) return undefined
  const text = textOf(outcome.output)
  return text.trim() === '' ? undefined : text
}

function deriveLegacyClaimRevision(
  state: WorkspaceState,
  assignment: TaskAssignment,
  acceptedSequence: number | undefined,
): DefinitionRevisionId | undefined {
  if (acceptedSequence === undefined) return undefined
  const agent = state.agents[assignment.assigneeAgentId]
  const createdEventId = agent?.employmentPeriods[0]?.startedEventId
  const createdSequence = createdEventId === undefined
    ? undefined
    : state.events.find(event => event.id === createdEventId)?.sequence
  if (agent === undefined || createdSequence === undefined) return undefined
  let revisionId = projectDefinitionHistory(state, agent.definitionId)
    .filter(item => item.creationEvent.status !== 'unresolved' && item.creationEvent.sequence <= createdSequence)
    .at(-1)?.id
  if (revisionId === undefined) return undefined
  for (const event of state.events) {
    if (event.sequence > acceptedSequence) break
    if (event.type === 'agent/definition-revision-assigned'
      && event.subjectId === agent.id
      && event.definitionRevisionId !== undefined) {
      revisionId = event.definitionRevisionId
    }
  }
  return revisionId
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

function throwIfTaskDeliveryCancelled(signal: AbortSignal, taskId: TaskId): void {
  if (signal.aborted) throw new Error(`task '${taskId}' delivery was cancelled`)
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
