/** One fixed organization's employee runtime and complete-operation lifecycle. */

import { Context } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceBusinessError } from './errors.ts'
import { AgentDefinitionId, AgentId, HumanId, RoomId, TaskId, WorkspaceId } from './ids.ts'
import type { DefinitionRevisionId } from './ids.ts'
import type { ChildRunId } from './ids.ts'
import { WorkspaceDispatcher } from './dispatcher.ts'
import type { SubagentRuntimeLike, WorkspaceDispatcherHost } from './dispatcher.ts'
import { assertWorkspaceInvariants } from './invariant.ts'
import { joinRoomWithMemory } from './memory.ts'
import { createDeliveryMemory } from './delivery-memory.ts'
import { queryAgentMemory } from './memory-query.ts'
import type { MemoryPage, MemoryQuery } from './memory-query.ts'
import { assertDirectRoomTextAllowed, assertRoomMessageAuthorized, resolveHumanWakeTargets } from './room-policy.ts'
import type { WorkspaceDirectRoomResult, WorkspaceMutationResult, WorkspaceRoomRuntimeStatus, WorkspaceRuntimeStatus } from './rpc.ts'
import { EmployeeAgentPool } from './runtime.ts'
import type { AgentLifecycle, EmployeeBoundSessionDisposition, EmployeeMaterializationOptions } from './runtime.ts'
import { workspaceStateSchema } from './spec.ts'
import { mutateWorkspace } from './state.ts'
import { WorkspaceDirectory } from './workspace-directory.ts'
import { WorkspaceAdmission } from './workspace-admission.ts'
import type { ResolvedConfig } from './index.ts'
import { WorkspaceActivityStream } from './activity-stream.ts'
import type { WorkspaceActivityDurableFailure, WorkspaceActivityIdentity, WorkspaceActivitySnapshot, WorkspaceActivitySource } from './activity-stream.ts'
import { WorkspaceActivityController } from './activity-controller.ts'
import type { WorkspaceStopResult } from './activity-controller.ts'
import { WorkspaceTurnTracker } from './turn-tracker.ts'
import type { WorkspaceTurnOutcome } from './turn-tracker.ts'
import { finishChildRun, repairOrphanedChildRuns } from './child-runs.ts'
import { ChildControllerRegistry } from './child-controller.ts'
import type { PreparedChildStop } from './child-controller.ts'
import {
  assignHumanTask,
  cancelTask as cancelWorkspaceTask,
  grantTaskDelegation as grantWorkspaceTaskDelegation,
  revokeTaskDelegation as revokeWorkspaceTaskDelegation,
} from './tasks.ts'
import type { AssignHumanTaskResult, CancelTaskResult, GrantTaskDelegationResult } from './tasks.ts'
import { inspectTaskDelivery } from './task-delivery.ts'
import { TaskDeliveryCoordinator } from './task-delivery-coordinator.ts'
import type { TaskDeliveryReservation, WorkspaceDeliveryHooks } from './task-delivery-coordinator.ts'
import type { TaskDeliveryProgressEvent, WorkspaceCommand, WorkspaceState } from './types.ts'
import type { DelegationGrantId } from './ids.ts'
import { projectDefinitionHistory } from './definition-history.ts'
import type { DefinitionHistoryItem } from './definition-history.ts'
import { WEB_WORKSPACE_HUMAN_ID } from './rpc.ts'
import type { CompanyTemplatePreview, CompanyTemplateRevisionId, WorkflowCommand, WorkflowEndpoint, WorkflowExpectedRevisions, WorkflowMutationResult, WorkflowMutationValueMap, WorkflowOperationId, WorkflowProposalRequest, WorkflowProposalResult, WorkflowSnapshot } from './workflow-contract.ts'
import { previewCompanyTemplate, proposeWorkflowDraft, WorkflowBusinessError } from './workflow.ts'
import { workflowTaskInstructions } from './workflow-delivery.ts'

/** Default-model seam used by the Web composition. */
interface WorkspaceDefaultModel {
  currentSelection(): ModelSelection
}

/** Optional per-agent preset roster used by the Web composition. */
interface WorkspaceAgentPresets {
  resolve(id?: string): Promise<{ readonly id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** Agent-scoped system prompt seam. */
interface WorkspaceSystemPrompt {
  section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void
}

/** Minimal persistence view needed to validate a bound employee session. */
interface WorkspaceSessionPersistence {
  stat(sessionId: SessionId): Promise<{ readonly header: { readonly cwd?: string } } | undefined>
}

/** Minimal DSH workspace-registry view used to hide plugin-owned sessions. */
interface DshWorkspaceRegistry {
  archiveSession(sessionId: SessionId): Promise<void>
  unarchiveSession(sessionId: SessionId): Promise<void>
}

/** Mutable internal counterpart of the public readonly runtime status. */
interface MutableRoomRuntimeStatus {
  pending: number
  error?: string
}

interface OperationScope {
  pending: number
  active: boolean
  readonly release: () => void
}

/**
 * Serialized, durable access to one local Workspace aggregate, plus the
 * employee runtime that gives each employed top-level agent one stable DSH
 * session. Reads return detached copies of committed state; {@link execute}
 * applies one command atomically and leaves the committed aggregate unchanged
 * when the command is invalid or the backend write fails.
 */
export class WorkspaceRuntime {
  /** Tracks every operation through durable settlement and resource cleanup. */
  readonly admission = new WorkspaceAdmission()
  private stopping = false
  private closing = false
  private retirement: Promise<void> | undefined
  private preparation: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private retirementDrained = false
  private readonly childCleanupFailures: unknown[] = []
  private readonly operations = new AsyncLocalStorage<OperationScope>()
  private pool: EmployeeAgentPool | undefined
  private dispatcher: WorkspaceDispatcher | undefined
  private taskDelivery: TaskDeliveryCoordinator | undefined
  private readonly trackers = new Map<AgentId, WorkspaceTurnTracker>()
  private readonly roomRuntime = new Map<RoomId, MutableRoomRuntimeStatus>()
  private readonly activityStream = new WorkspaceActivityStream()
  private readonly activityController = new WorkspaceActivityController(this.activityStream, {
    handleFor: agentId => this.pool?.controlHandleFor(agentId),
  })
  private readonly childControllers = new ChildControllerRegistry(async request => {
    await this.apply(current => finishChildRun(current, request).state)
  })

  /** @param ctx Organization-owned Cordis scope. @param config Validated deployment settings. @param directory Durable record owner. @param workspaceId Fixed identity; never reads client selection. */
  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig, readonly directory: WorkspaceDirectory, readonly workspaceId: WorkspaceId) {
    if (directory.record(workspaceId).descriptor.lifecycle === 'archived') this.admission.close()
  }

  /** @returns Resolution after startup repair and runtime registrations. */
  async initialize(): Promise<void> {
    const stored = this.snapshot()
    const repaired = repairOrphanedChildRuns(stored)
    if (repaired !== stored) await this.directory.updateAggregate(this.workspaceId, () => repaired)
    this.syncActivityProjection(repaired)
    if (this.closing) return

    // Agent availability is dynamic: loader siblings mount concurrently, so a
    // one-time ctx.get('agents') sample can race startup and permanently leave
    // the workspace unable to wake anyone. The injected fiber follows the
    // service generation and tears down every retained employee when it leaves.
    this.ctx.inject(['agents'], runtimeCtx => {
      const preparation = this.prepareRuntime(runtimeCtx)
      this.preparation = preparation
      return preparation
    })
  }

  private async prepareRuntime(runtimeCtx: Context): Promise<void> {
    const previousRetirement = this.retirement
    try { await previousRetirement }
    catch (error) {
      // The old effect reports its failure; only fully drained generations can retry durable child cleanup.
      if (!this.retirementDrained) throw error
    }
    if (this.closing) return
    await this.childControllers.stopAll()
    if (this.closing) return
    const agents = runtimeCtx.get('agents') as AgentLifecycle | undefined
    if (agents === undefined) return
    this.childControllers.openGeneration()
    this.retirement = undefined
    this.retirementDrained = false
    this.childCleanupFailures.length = 0
    this.stopping = false
    const taskDelivery = new TaskDeliveryCoordinator({
      snapshot: () => this.snapshot(),
      taskInstructions: taskId => workflowTaskInstructions(this.directory.record(this.workspaceId), taskId),
      apply: async mutation => await this.apply(mutation),
      ensureEmployee: async agentId => await this.ensureEmployee(agentId),
      deliver: async (agentId, delivery, recall, source, hooks) => await this.deliver(agentId, delivery, recall, source, hooks),
      recoverDelivery: async (agentId, handle, delivery, source, hooks) => await this.recoverDelivery(agentId, handle, delivery, source, hooks),
    })
    const pool = new EmployeeAgentPool(
      agents,
      this,
      (agentId, mode) => this.employeeMaterializationOptions(agentId, mode),
      async (agentId, agent) => {
        await taskDelivery.recoverAgent(agentId, { agent })
      },
      (agentId, revisionId, agentCtx) => this.installWorkspaceRole(agentCtx, agentId, revisionId),
    )
    const dispatcherHost: WorkspaceDispatcherHost = {
      snapshot: () => this.snapshot(),
      execute: async (command, settledActivity) => await this.executeInternal(command, settledActivity),
      apply: async mutation => await this.apply(mutation),
      deliver: async (agentId, delivery, recall, source) => await this.deliver(agentId, delivery, recall, source),
      ensureEmployee: async agentId => await this.ensureEmployee(agentId),
      retireWorkspaceActivity: (activity, workspaceRevision) => this.retireWorkspaceActivity(activity, workspaceRevision),
      assertContinuationAllowed: () => this.assertContinuationAllowed(),
      recordChildCleanupFailure: error => { this.childCleanupFailures.push(error) },
    }
    const dispatcher = new WorkspaceDispatcher(
      dispatcherHost,
      () => this.ctx.get('subagents') as SubagentRuntimeLike | undefined,
      this.config.childProvider,
      { maxAgentHops: 3, maxRepliesPerRoot: 8, recallCharacterBudget: this.config.memoryCharacterBudget },
      taskDelivery,
      this.childControllers,
    )
    this.pool = pool
    this.dispatcher = dispatcher
    this.taskDelivery = taskDelivery
    runtimeCtx.effect(() => () => this.retireRuntime(), 'agentWorkspace.employeeRuntime')
  }

  /** Prevent new operations while retained continuations finish using their current runtime generation. */
  closeAdmission(): void { this.closing = true }

  /** @returns Shared teardown result after generation preparation, exact stops, full operation cleanup, and employee disposal. */
  dispose(): Promise<void> {
    this.closeAdmission()
    if (this.disposal !== undefined) return this.disposal
    this.disposal = Promise.allSettled([this.retireRuntime(), this.preparation]).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'organization runtime disposal failed')
    })
    return this.disposal
  }

  private retireRuntime(): Promise<void> {
    if (this.retirement !== undefined) return this.retirement
    const pool = this.pool
    const dispatcher = this.dispatcher
    const taskDelivery = this.taskDelivery
    this.retirementDrained = false
    const stopping = this.stopAdmittedWork()
    const employees = pool?.disposeAll()
    this.retirement = (async () => {
      const stopped = await Promise.allSettled([stopping, employees])
      await Promise.all([this.admission.drain(), taskDelivery?.drain()])
      this.retirementDrained = true
      if (this.pool === pool) this.pool = undefined
      if (this.dispatcher === dispatcher) this.dispatcher = undefined
      if (this.taskDelivery === taskDelivery) this.taskDelivery = undefined
      this.trackers.clear()
      this.roomRuntime.clear()
      const failures = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      failures.push(...this.childCleanupFailures)
      if (taskDelivery !== undefined) {
        for (const task of Object.values(this.snapshot().tasks)) {
          const phase = inspectTaskDelivery(this.snapshot(), task.id).phase
          if (phase === 'started' || phase === 'accepted') failures.push(new Error('organization has unfinished task delivery'))
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'organization runtime shutdown failed')
    })()
    return this.retirement
  }

  /** @param operation Complete new task operation. @returns Its result after all retained continuations settle. */
  async runNewOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
    return await this.runOperation(operation, true)
  }

  /** @param agentId Employee to materialize. @returns Its live handle in this organization. */
  async ensureEmployee(agentId: AgentId): Promise<AgentHandle> {
    return await this.runOperation(() => this.ensureEmployeeInternal(agentId))
  }

  /** @param agentId Recipient. @param delivery Frozen message. @param recall Personal history. @param source Activity attribution. @param hooks Task settlement hooks. @returns Outcome after Session flush. */
  async deliver(agentId: AgentId, delivery: UserMessage, recall?: UserMessage, source?: WorkspaceActivitySource, hooks?: WorkspaceDeliveryHooks): Promise<WorkspaceTurnOutcome> {
    return await this.runOperation(() => this.deliverInternal(agentId, delivery, recall, source, hooks))
  }

  /** @param expectedRevision Snapshot checkpoint. @param agentId Employee failure. @param signal Caller cancellation. @returns Committed acknowledgement. */
  async acknowledgeAgentFailure(expectedRevision: number, agentId: AgentId, signal?: AbortSignal): Promise<WorkspaceMutationResult<void>> {
    return await this.runOperation(() => this.acknowledgeAgentFailureInternal(expectedRevision, agentId, signal))
  }

  /** @param expectedRevision Snapshot checkpoint. @param identity Exact claimed turn. @param signal Caller cancellation. @returns Stop acknowledgement. */
  async stopActivity(expectedRevision: number, identity: WorkspaceActivityIdentity, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceStopResult>> {
    return await this.runOperation(() => this.stopActivityInternal(expectedRevision, identity, signal))
  }

  /** @param expectedRevision Snapshot checkpoint. @param childRunId Exact child. @param signal Caller cancellation. @returns Durable stop acknowledgement. */
  async stopChildRun(expectedRevision: number, childRunId: ChildRunId, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceStopResult>> {
    return await this.runOperation(() => this.stopChildRunInternal(expectedRevision, childRunId, signal))
  }

  /** @param expectedRevision Snapshot checkpoint. @param humanId Human authority. @param taskId Exact task. @param signal Caller cancellation. @returns Cancelled aggregate. */
  async cancelTask(expectedRevision: number, humanId: HumanId, taskId: TaskId, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceState>> {
    return await this.runOperation(() => this.cancelTaskInternal(expectedRevision, humanId, taskId, signal))
  }

  /** @param expectedRevision Snapshot checkpoint. @param humanId Human authority. @param assigneeAgentId Recipient. @param title Instruction. @param signal Caller cancellation. @returns Durable task with delivery continuing under its reservation. */
  async assignTask(expectedRevision: number, humanId: HumanId, assigneeAgentId: AgentId, title: string, signal?: AbortSignal): Promise<WorkspaceMutationResult<AssignHumanTaskResult>> {
    return await this.runOperation(() => this.assignTaskInternal(expectedRevision, humanId, assigneeAgentId, title, signal))
  }

  /** @param expectedRevision Snapshot checkpoint. @param humanId Human authority. @param granteeAgentId Delegate. @param rootTaskId Authorized task. @param signal Caller cancellation. @returns Committed grant. */
  async grantTaskDelegation(expectedRevision: number, humanId: HumanId, granteeAgentId: AgentId, rootTaskId: TaskId, signal?: AbortSignal): Promise<WorkspaceMutationResult<GrantTaskDelegationResult>> {
    return await this.runOperation(() => this.grantTaskDelegationInternal(expectedRevision, humanId, granteeAgentId, rootTaskId, signal))
  }

  /** @param expectedRevision Snapshot checkpoint. @param humanId Human authority. @param delegationGrantId Grant. @param signal Caller cancellation. @returns Committed aggregate. */
  async revokeTaskDelegation(expectedRevision: number, humanId: HumanId, delegationGrantId: DelegationGrantId, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceState>> {
    return await this.runOperation(() => this.revokeTaskDelegationInternal(expectedRevision, humanId, delegationGrantId, signal))
  }

  /** @param expectedRevision Snapshot checkpoint. @param agentId Recipient. @param signal Caller cancellation. @returns Stable direct room. */
  async openDirectRoom(expectedRevision: number, agentId: AgentId, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceDirectRoomResult>> {
    return await this.runOperation(() => this.openDirectRoomInternal(expectedRevision, agentId, signal))
  }

  /** @param expectedRevision Snapshot checkpoint. @param roomId Selected room. @param humanId Human actor. @param text Message. @param mentions Explicit wake targets. @param signal Caller cancellation. @returns Durable admission while the complete chain remains reserved. */
  async postHumanMessage(expectedRevision: number, roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[], signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceState>> {
    return await this.runOperation(() => this.postHumanMessageInternal(expectedRevision, roomId, humanId, text, mentions, signal))
  }

  /** @param expectedRevision Snapshot checkpoint. @param taskId Retryable task. @param signal Caller cancellation. @returns Full terminal result. */
  async retryTaskDelivery(expectedRevision: number, taskId: TaskId, signal?: AbortSignal): Promise<WorkspaceMutationResult<string>> {
    return await this.runOperation(() => this.retryTaskDeliveryInternal(expectedRevision, taskId, signal))
  }

  /** Stop this organization's exact flights without cancelling durable task ownership. */
  async stopAdmittedWork(): Promise<void> {
    this.stopping = true
    this.taskDelivery?.cancelAllDeliveries()
    for (const activity of this.activityStream.snapshot().activities) {
      const handle = this.pool?.controlHandleFor(activity.agentId)
      if (activity.status === 'queued') {
        handle?.agent.inbox.remove(activity.messageId)
        this.activityStream.discard(activity.activityId, { code: 'delivery-discarded', summary: 'Organization work was stopped before its turn was claimed.' })
      } else if (activity.claimed !== undefined && (activity.status === 'responding' || activity.status === 'stopping')) {
        this.activityController.stopActivity({ activityId: activity.activityId, agentId: activity.agentId, messageId: activity.messageId, sessionId: activity.claimed.sessionId, turn: activity.claimed.turn })
      }
    }
    await this.childControllers.stopAll()
  }

  /** Wait for restored inbox-flight settlement, not merely employee idleness. */
  async drainDeliveries(): Promise<void> { await this.taskDelivery?.drain() }

  /** Reset stop controls only after the directory has durably reopened an idle record. */
  prepareReopen(): void { this.stopping = false; this.childControllers.openGeneration() }

  private async runOperation<Value>(operation: () => Promise<Value>, fresh = false): Promise<Value> {
    const current = this.operations.getStore()
    if (!fresh && current?.active === true) return await operation()
    if (this.closing || this.retirement !== undefined) throw new Error('workspace admission is closed')
    const scope: OperationScope = { pending: 1, active: true, release: this.admission.reserve() }
    return await this.operations.run(scope, async () => {
      try { return await operation() }
      finally { this.releaseScope(scope) }
    })
  }

  private retainBackground(completion: Promise<unknown>): void {
    const scope = this.operations.getStore()
    if (scope?.active !== true) throw new Error('background work has no admission owner')
    scope.pending += 1
    void completion.finally(() => this.releaseScope(scope)).catch((_error) => { /* The operation records its display-safe terminal failure. */ })
  }

  private releaseScope(scope: OperationScope): void {
    scope.pending -= 1
    if (scope.pending !== 0) return
    scope.active = false
    scope.release()
  }

  private assertContinuationAllowed(): void {
    if (this.stopping) throw new Error('organization work is stopping')
  }

  /** A detached copy of the committed local aggregate. */
  snapshot(): WorkspaceState {
    return this.directory.snapshot(this.workspaceId)
  }

  /** @returns Detached workflow and its matching aggregate revision, including archived organizations. */
  workflowSnapshot(): WorkflowSnapshot {
    this.assertWorkflowReadable()
    const record = this.directory.record(this.workspaceId)
    return { workspaceId: this.workspaceId, aggregateRevision: record.aggregate.revision, workflow: record.workflow }
  }

  /** @param request Both revision checkpoints and durable retry identity. @param command Human-only action. @param signal Precommit cancellation. @returns Durable receipt; identical replay never starts delivery. */
  async executeWorkflow<K extends WorkflowEndpoint>(request: WorkflowExpectedRevisions & { readonly operationId: WorkflowOperationId }, command: WorkflowCommand<K>, signal?: AbortSignal): Promise<WorkflowMutationResult<WorkflowMutationValueMap[K]>> {
    this.assertWorkflowWritable()
    return await this.runNewOperation(async () => {
      this.assertContinuationAllowed()
      const result = await this.directory.executeWorkflow(this.workspaceId, { ...request, command }, { humanId: WEB_WORKSPACE_HUMAN_ID, occurredAt: new Date().toISOString() }, signal)
      if (result.replayed) return result
      this.syncActivityProjection(this.snapshot())
      if (command.type === 'workflow/draft/confirm' && 'taskId' in result.value) {
        const delivery = this.taskDelivery
        if (delivery !== undefined) this.retainBackground(delivery.deliver(result.value.taskId).catch((_error) => {
          // The coordinator persists the retryable failure before rejecting.
        }))
      }
      return result
    })
  }

  /** @param expected Both displayed revision checkpoints. @param id Pinned company configuration. @returns Validated preview without reserving IDs or waking employees. */
  previewCompanyTemplate(expected: WorkflowExpectedRevisions, id: CompanyTemplateRevisionId): CompanyTemplatePreview {
    const snapshot = this.workflowSnapshot()
    if (snapshot.aggregateRevision !== expected.expectedAggregateRevision) throw new WorkspaceBusinessError('stale-revision', { expectedRevision: expected.expectedAggregateRevision, actualRevision: snapshot.aggregateRevision })
    if (snapshot.workflow.revision !== expected.expectedWorkflowRevision) throw new WorkflowBusinessError('stale-workflow-revision', { expectedWorkflowRevision: expected.expectedWorkflowRevision, actualWorkflowRevision: snapshot.workflow.revision })
    return { workspaceId: this.workspaceId, aggregateRevision: snapshot.aggregateRevision, workflowRevision: snapshot.workflow.revision, templateRevisionId: id, config: previewCompanyTemplate(this.snapshot(), snapshot.workflow, id) }
  }

  /** @param agent Actual published employee object. @param request Proposed brief with optional suggested owner. @param signal Precommit cancellation. @returns Bounded draft receipt awaiting human confirmation. */
  async proposeTask(agent: Agent, request: WorkflowProposalRequest, signal?: AbortSignal): Promise<WorkflowProposalResult> {
    this.assertWorkflowWritable()
    return await this.runOperation(async () => {
      this.assertContinuationAllowed()
      const committed = await this.directory.updateRecord(this.workspaceId, record => {
        if (record.descriptor.lifecycle === 'archived') throw new WorkflowBusinessError('workflow-read-only', { workspaceId: this.workspaceId })
        this.assertContinuationAllowed()
        const agentId = this.agentIdFor(agent)
        if (agentId === undefined) throw new Error('Workspace proposal caller is not an active employee.')
        const changed = proposeWorkflowDraft({ aggregate: record.aggregate, workflow: record.workflow }, request, { agentId, occurredAt: new Date().toISOString() })
        return { record: { ...record, aggregate: changed.aggregate, workflow: changed.workflow }, value: { draftId: changed.value.draftId, summary: changed.workflow.drafts[changed.value.draftId]!.brief.title.slice(0, this.config.memoryCharacterBudget), status: 'awaiting-human-confirmation' as const } }
      }, signal)
      this.syncActivityProjection(committed.record.aggregate)
      return committed.value
    })
  }

  private assertWorkflowReadable(): void {
    if (this.closing || this.retirement !== undefined) throw new Error('organization runtime is unavailable')
  }

  private assertWorkflowWritable(): void {
    this.assertWorkflowReadable()
    if (this.directory.record(this.workspaceId).descriptor.lifecycle === 'archived') throw new WorkflowBusinessError('workflow-read-only', { workspaceId: this.workspaceId })
    this.assertContinuationAllowed()
  }

  /**
   * Query one agent's read-only memory at an exact aggregate revision.
   * @param query Filters, page limit, cursor, and required snapshot revision.
   * @returns A detached newest-first page from committed state.
   */
  queryMemory(query: MemoryQuery): MemoryPage {
    return queryAgentMemory(this.snapshot(), query)
  }

  /** Project one definition's detached immutable revision history. */
  definitionHistory(definitionId: AgentDefinitionId): readonly DefinitionHistoryItem[] {
    return structuredClone(projectDefinitionHistory(this.snapshot(), definitionId))
  }

  /** Current ephemeral background execution state, detached from internal maps. */
  runtimeStatus(): WorkspaceRuntimeStatus {
    const rooms: Record<string, WorkspaceRoomRuntimeStatus> = {}
    for (const [roomId, status] of this.roomRuntime) {
      rooms[roomId] = status.error === undefined
        ? { pending: status.pending }
        : { pending: status.pending, error: status.error }
    }
    return { rooms }
  }

  /** Current detached activity projection for Browser subscribers. */
  activitySnapshot(): WorkspaceActivitySnapshot {
    return this.activityStream.snapshot()
  }

  /** Wait until the activity projection advances beyond a version. */
  async waitForActivity(afterVersion: number, signal: AbortSignal): Promise<WorkspaceActivitySnapshot> {
    return await this.activityStream.wait(afterVersion, signal)
  }

  /** Retire one transient activity after its durable projection has converged. */
  retireWorkspaceActivity(activity: WorkspaceActivityIdentity, workspaceRevision: number): void {
    this.activityStream.retire(activity, workspaceRevision)
  }

  /** Clear one process-local agent failure after the Browser acknowledges it. */
  private async acknowledgeAgentFailureInternal(
    expectedRevision: number,
    agentId: AgentId,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<void>> {
    const committed = await this.mutateRevisioned(expectedRevision, current => ({
      state: current,
      value: undefined,
    }), signal)
    this.activityStream.acknowledgeAgentFailure(agentId)
    return committed
  }

  /**
   * Stop one exact claimed Workspace turn.
   * @param identity - Complete activity, employee, message, Session, and turn identity.
   * @returns Whether this call started stopping, repeated it, or found no exact activity.
   */
  private async stopActivityInternal(
    expectedRevision: number,
    identity: WorkspaceActivityIdentity,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<WorkspaceStopResult>> {
    const committed = await this.mutateRevisioned(expectedRevision, current => ({
      state: current,
      value: undefined,
    }), signal)
    return { revision: committed.revision, value: this.activityController.stopActivity(identity) }
  }

  /**
   * Stop one exact process-local child run and persist its cancellation.
   * @param childRunId - Durable child identity to stop.
   * @returns Whether this call started stopping, repeated it, or found no live controller.
   */
  private async stopChildRunInternal(
    expectedRevision: number,
    childRunId: ChildRunId,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<WorkspaceStopResult>> {
    let prepared: PreparedChildStop | undefined
    try {
      const committed = await this.mutateRevisioned(expectedRevision, current => {
        prepared = this.childControllers.prepareStop(current, childRunId)
        return { state: prepared.state, value: prepared.value }
      }, signal)
      prepared?.commit()
      return committed
    } catch (error) {
      prepared?.rollback()
      throw error
    }
  }

  /**
   * Cancel a task durably, then clean up only work named by that mutation.
   * @param humanId - Human requesting the cancellation.
   * @param taskId - Root or derived task to cancel.
   * @returns The state after exact queued, active, and child cleanup converges.
   */
  private async cancelTaskInternal(
    expectedRevision: number,
    humanId: HumanId,
    taskId: TaskId,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<WorkspaceState>> {
    let cancellation: CancelTaskResult | undefined
    let taskDelivery: TaskDeliveryCoordinator | undefined
    const childStops: PreparedChildStop[] = []
    let committed: WorkspaceMutationResult<WorkspaceState>
    try {
      committed = await this.mutateMaybeRevisioned(expectedRevision, current => {
        taskDelivery = this.taskDelivery
        const changed = cancelWorkspaceTask(current, { humanId, taskId })
        cancellation = changed
        let state = changed.state
        for (const childRunId of changed.runningChildRunIds) {
          const prepared = this.childControllers.prepareStop(state, childRunId)
          childStops.push(prepared)
          state = prepared.state
        }
        return { state, value: state }
      }, signal)
    } catch (error) {
      for (const prepared of childStops.toReversed()) prepared.rollback()
      throw error
    }
    if (cancellation === undefined) throw new Error(`task '${taskId}' cancellation did not publish its affected work`)
    for (const cancelledTaskId of cancellation.cancelledTaskIds) taskDelivery?.cancelTaskDelivery(cancelledTaskId)
    for (const prepared of childStops) prepared.commit()
    const next = committed.value

    const cancelledTaskIds = new Set(cancellation.cancelledTaskIds)
    const active = this.activityStream.snapshot().activities.flatMap(activity => {
      if (activity.source.kind !== 'task'
        || !cancelledTaskIds.has(activity.source.taskId)
        || (activity.status !== 'responding' && activity.status !== 'stopping')
        || activity.claimed === undefined) return []
      return [{
        activityId: activity.activityId,
        agentId: activity.agentId,
        messageId: activity.messageId,
        sessionId: activity.claimed.sessionId,
        turn: activity.claimed.turn,
      }]
    })

    for (const cancelledTaskId of cancellation.cancelledTaskIds) {
      const inspection = inspectTaskDelivery(next, cancelledTaskId)
      if (inspection.attemptId === undefined || (inspection.phase !== 'started' && inspection.phase !== 'accepted')) continue
      const started = next.events.findLast((event): event is TaskDeliveryProgressEvent => (
        event.type === 'task/delivery-started'
        && event.taskId === cancelledTaskId
        && event.taskDeliveryAttemptId === inspection.attemptId
      ))
      const assignment = Object.values(next.taskAssignments).find(candidate => candidate.taskId === cancelledTaskId)
      if (started === undefined || assignment === undefined) continue
      this.pool?.controlHandleFor(assignment.assigneeAgentId)?.agent.inbox.remove(started.messageId)
    }
    for (const identity of active) this.activityController.stopActivity(identity)
    return committed
  }

  /** Assign one root task, then start its delivery only after the durable commit. */
  private async assignTaskInternal(
    expectedRevision: number,
    humanId: HumanId,
    assigneeAgentId: AgentId,
    title: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<AssignHumanTaskResult>> {
    let delivery: TaskDeliveryCoordinator | undefined
    const committed = await this.mutateRevisioned(expectedRevision, current => {
      delivery = this.requireTaskDelivery()
      const value = assignHumanTask(current, { humanId, assigneeAgentId, title })
      return { state: value.state, value }
    }, signal)
    if (delivery === undefined) throw new Error('task assignment did not resolve its delivery coordinator')
    this.retainBackground(delivery.deliver(committed.value.taskId).catch((_error) => {
      // The coordinator records display-safe delivery failure before rejecting.
    }))
    return committed
  }

  /** Grant one employed assignee delegation authority after a revision check. */
  private async grantTaskDelegationInternal(
    expectedRevision: number,
    humanId: HumanId,
    granteeAgentId: AgentId,
    rootTaskId: TaskId,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<GrantTaskDelegationResult>> {
    return await this.mutateRevisioned(expectedRevision, current => {
      const value = grantWorkspaceTaskDelegation(current, { humanId, granteeAgentId, rootTaskId })
      return { state: value.state, value }
    }, signal)
  }

  /** Revoke one delegation grant after a revision check. */
  private async revokeTaskDelegationInternal(
    expectedRevision: number,
    humanId: HumanId,
    delegationGrantId: DelegationGrantId,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<WorkspaceState>> {
    return await this.mutateRevisioned(expectedRevision, current => {
      const changed = revokeWorkspaceTaskDelegation(current, { humanId, delegationGrantId })
      return { state: changed.state, value: changed.state }
    }, signal)
  }

  /** Open the stable direct room for one employed agent, creating it atomically when absent. */
  private async openDirectRoomInternal(
    expectedRevision: number,
    agentId: AgentId,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<WorkspaceDirectRoomResult>> {
    let resolvedRoomId: RoomId | undefined
    const committed = await this.mutateMaybeRevisioned(expectedRevision, current => {
      const agent = current.agents[agentId]
      if (agent === undefined) {
        throw new WorkspaceBusinessError('agent-missing', { agentId }, `agent '${agentId}' does not exist`)
      }
      if (agent.employmentStatus !== 'employed') {
        throw new WorkspaceBusinessError(
          'agent-departed',
          { agentId },
          `agent '${agentId}' is departed and cannot be opened for direct chat`,
        )
      }

      const matches = Object.values(current.rooms).filter(room => {
        if (room.kind !== 'direct') return false
        const active = Object.values(current.memberships)
          .filter(membership => membership.roomId === room.id && membership.leftEventId === undefined)
        return active.length === 1 && active[0]?.agentId === agentId
      })
      if (matches.length > 1) throw new Error(`agent '${agentId}' has multiple active direct rooms`)
      const existing = matches[0]
      if (existing !== undefined) {
        resolvedRoomId = existing.id
        return { state: current, value: current }
      }

      const created = mutateWorkspace(current, { type: 'room/create', kind: 'direct' })
      const joined = joinRoomWithMemory(created.state, {
        type: 'room/join',
        roomId: created.roomId,
        agentId,
        memoryStart: { type: 'new-events' },
      }).state
      resolvedRoomId = created.roomId
      return { state: joined, value: joined }
    }, signal)
    if (resolvedRoomId === undefined) throw new Error(`failed to resolve direct room for agent '${agentId}'`)
    const value = { state: committed.value, roomId: resolvedRoomId }
    return { revision: committed.revision, value }
  }

  /**
   * Apply one command durably and return the detached committed aggregate.
   * A post-commit resident-role refresh failure retires that runtime, records a
   * safe activity failure, and leaves the durable mutation committed.
   */
  async execute(
    expectedRevision: number,
    command: WorkspaceCommand,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<WorkspaceState>> {
    return await this.runOperation(() => this.executeCommand(expectedRevision, command, undefined, signal))
  }

  /** Commit one Host-owned command whose current revision is selected in the serialized callback. */
  private async executeInternal(command: WorkspaceCommand, settledActivity?: WorkspaceActivityIdentity): Promise<WorkspaceState> {
    return (await this.executeCommand(undefined, command, settledActivity)).value
  }

  private async executeCommand(
    expectedRevision: number | undefined,
    command: WorkspaceCommand,
    settledActivity?: WorkspaceActivityIdentity,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<WorkspaceState>> {
    const committed = await this.mutateMaybeRevisioned(expectedRevision, current => {
      if (command.type === 'room/message') {
        assertRoomMessageAuthorized(current, command.roomId, command.actor, command.mentions)
      }
      const changed = command.type === 'room/join'
        ? joinRoomWithMemory(current, command).state
        : mutateWorkspace(current, command).state
      return { state: changed, value: changed }
    }, signal)
    const next = committed.value

    if (settledActivity !== undefined) this.activityStream.retire(settledActivity, next.revision)
    if (command.type === 'agent/depart') {
      await this.pool?.dispose(command.agentId)
    }
    if (command.type === 'definition/revise' || command.type === 'definition/synchronize' || command.type === 'agent/rename') {
      const selected = command.type === 'agent/rename' ? [command.agentId]
        : command.type === 'definition/revise' ? command.synchronizeAgentIds ?? [] : command.agentIds
      await Promise.all(selected.map(async agentId => {
        const agent = next.agents[agentId]
        if (agent?.employmentStatus !== 'employed' || this.pool?.handleFor(agentId) === undefined) return
        try {
          await this.pool.refreshRole(agentId, agent.definitionRevisionId, { force: command.type === 'agent/rename' })
        } catch {
          this.activityStream.recordAgentFailureIfAbsent(agentId, {
            code: 'agent-role-refresh-failed',
            summary: 'Agent role could not be refreshed.',
          })
          try {
            await this.pool?.dispose(agentId)
          } catch {
            // The pool removes the failed resident before its handle teardown can reject.
          }
        }
      }))
    }
    return committed
  }

  /** Apply an arbitrary pure mutation durably and return the detached committed aggregate. */
  async apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState> {
    return (await this.mutateMaybeRevisioned(undefined, current => {
      const changed = mutation(current)
      return { state: changed, value: changed }
    })).value
  }

  /** The durable session id bound to an agent, or `undefined` when never materialized. */
  sessionIdFor(agentId: AgentId): SessionId | undefined {
    return this.snapshot().sessionBindings[agentId]
  }

  /** Durably record a freshly created or migrated session id for an agent. */
  async recordSessionId(agentId: AgentId, sessionId: SessionId): Promise<void> {
    await this.executeInternal({ type: 'runtime/session-bound', agentId, sessionId })
  }

  /**
   * Classify a persisted employee binding before resume. Sessions produced by
   * the pre-Web-integration plugin can lack `cwd`; DSH deliberately rejects a
   * persona containing `{{cwd}}` for such a header, and resume cannot amend
   * immutable Session metadata. Only that known compatibility gap rotates the
   * binding. Unknown persistence failures still propagate and never create a
   * replacement session.
   */
  async classifySession(_agentId: AgentId, sessionId: SessionId): Promise<EmployeeBoundSessionDisposition> {
    const persistence = this.ctx.get('sessionPersistence') as WorkspaceSessionPersistence | undefined
    if (persistence === undefined) return 'resume'
    const snapshot = await persistence.stat(sessionId)
    if (snapshot === undefined) return 'resume'
    return snapshot.header.cwd === undefined ? 'replace' : 'resume'
  }

  /** Hide one plugin-owned employee Session from the ordinary DSH grouping UI. */
  async hideSession(sessionId: SessionId): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry') as DshWorkspaceRegistry | undefined
    await registry?.archiveSession(sessionId)
  }

  /** Restore one internal employee session while it executes Workspace work. */
  async unhideSession(sessionId: SessionId): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry') as DshWorkspaceRegistry | undefined
    await registry?.unarchiveSession(sessionId)
  }

  /** Admit the live DSH handle for one employed agent, creating or resuming it once. */
  private async ensureEmployeeInternal(agentId: AgentId): Promise<AgentHandle> {
    this.assertContinuationAllowed()
    const agent = this.snapshot().agents[agentId]
    if (agent === undefined) throw new Error(`agent '${agentId}' does not exist`)
    if (agent.employmentStatus !== 'employed') throw new Error(`agent '${agentId}' is departed and cannot be materialized`)
    return await this.requirePool().ensure(agentId)
  }

  /** Resolve one currently published employee Agent handle to its durable id. */
  agentIdFor(agent: Agent): AgentId | undefined {
    return this.pool?.agentIdFor(agent)
  }

  /** Dispose one agent's live handle; its durable session binding stays for later resume. */
  async disposeEmployee(agentId: AgentId): Promise<void> {
    await this.requirePool().dispose(agentId)
  }

  /**
   * Deliver one message to an employed agent and resolve with its reply. The
   * optional recall is injected into the same durable turn, immediately after
   * the delivery. New formal tasks without an explicit recall use the employee's
   * acquired personal events at admission; resumed inbox messages stay frozen.
   */
  private async deliverInternal(
    agentId: AgentId,
    delivery: UserMessage,
    recall?: UserMessage,
    source?: WorkspaceActivitySource,
    hooks?: WorkspaceDeliveryHooks,
  ): Promise<WorkspaceTurnOutcome> {
    this.assertContinuationAllowed()
    const pool = this.pool
    if (pool === undefined) {
      try {
        const handle = await this.ensureEmployee(agentId)
        const tracker = this.trackers.get(agentId)
        if (tracker === undefined) throw new Error(`agent '${agentId}' has no turn tracker`)
        hooks?.beforeAdmission?.()
        const personalRecall = recall ?? (source?.kind === 'task'
          ? createDeliveryMemory(this.snapshot(), agentId, delivery, this.config.memoryCharacterBudget)
          : undefined)
        const outcome = await tracker.deliver(handle.agent, delivery, personalRecall, source, hooks)
        await this.flushEmployeeSession(agentId, handle.agent.session)
        return outcome
      } catch (error) {
        if (this.pool?.handleFor(agentId) === undefined) {
          this.activityStream.recordAgentFailureIfAbsent(agentId, {
            code: 'agent-materialization-failed', summary: 'Agent could not be started.',
          })
        }
        throw error
      }
    }
    const admittedAgent = this.snapshot().agents[agentId]
    if (admittedAgent === undefined || admittedAgent.employmentStatus !== 'employed') {
      throw new Error(`agent '${agentId}' is not employed`)
    }
    const queuedActivityId = source === undefined
      ? undefined
      : this.activityStream.queue({ agentId, messageId: delivery.id, source })
    const run = async (handle: AgentHandle): Promise<WorkspaceTurnOutcome> => {
      this.assertContinuationAllowed()
      const durableAgent = this.snapshot().agents[agentId]
      if (durableAgent === undefined || durableAgent.employmentStatus !== 'employed') {
        throw new Error(`agent '${agentId}' is not employed`)
      }
      const definitionRevisionId = pool.roleRevisionFor(agentId) ?? durableAgent.definitionRevisionId
      const tracker = this.trackers.get(agentId)
      if (tracker === undefined) throw new Error(`agent '${agentId}' has no turn tracker`)
      const capturedHooks = hooks?.onClaim === undefined
        ? hooks
        : { ...hooks, onClaim: async () => await hooks.onClaim?.(definitionRevisionId) }
      capturedHooks?.beforeAdmission?.()
      const personalRecall = recall ?? (source?.kind === 'task'
        ? createDeliveryMemory(this.snapshot(), agentId, delivery, this.config.memoryCharacterBudget)
        : undefined)
      const outcome = await tracker.deliver(handle.agent, delivery, personalRecall, source, capturedHooks)
      await this.flushEmployeeSession(agentId, handle.agent.session)
      return { ...outcome, definitionRevisionId }
    }
    const result = pool.runDelivery(agentId, run)
    return await result.catch(error => {
      const queued = queuedActivityId === undefined
        ? undefined
        : this.activityStream.snapshot().activities.find(activity => activity.activityId === queuedActivityId)
      if (queuedActivityId !== undefined && queued?.status === 'queued') {
        this.activityStream.discard(queuedActivityId, {
          code: 'delivery-discarded', summary: 'Agent delivery was discarded before its turn was claimed.',
        })
      }
      if (this.pool?.handleFor(agentId) === undefined) {
        this.activityStream.recordAgentFailureIfAbsent(agentId, {
          code: 'agent-materialization-failed',
          summary: 'Agent could not be started.',
        })
      }
      throw error
    })
  }

  /**
   * Reconstruct tracking for one message already accepted by a resumed inbox.
   * @param agentId - Workspace employee that owns the delivery.
   * @param handle - Unpublished resumed agent carrying the restored inbox.
   * @param delivery - Exact frozen inbox message.
   * @param source - Durable task-attempt activity source.
   * @param hooks - Optional callbacks for a later inbox claim.
   * @returns The terminal reply after the restored turn settles and flushes.
   */
  async recoverDelivery(
    agentId: AgentId,
    handle: Pick<AgentHandle, 'agent'>,
    delivery: UserMessage,
    source: WorkspaceActivitySource,
    hooks?: WorkspaceDeliveryHooks,
  ): Promise<WorkspaceTurnOutcome> {
    const tracker = this.trackers.get(agentId)
    if (tracker === undefined) throw new Error(`agent '${agentId}' has no turn tracker`)
    const definitionRevisionId = this.pool?.roleRevisionFor(agentId)
      ?? this.snapshot().agents[agentId]?.definitionRevisionId
    if (definitionRevisionId === undefined) throw new Error(`agent '${agentId}' has no role revision for recovered delivery`)
    const capturedHooks = hooks?.onClaim === undefined
      ? hooks
      : { ...hooks, onClaim: async () => await hooks.onClaim?.(definitionRevisionId) }
    const outcome = await tracker.recover(handle.agent, delivery, source, capturedHooks)
    await this.flushEmployeeSession(agentId, handle.agent.session)
    return { ...outcome, definitionRevisionId }
  }

  private async flushEmployeeSession(agentId: AgentId, session: Session): Promise<void> {
    const sessions = this.ctx.get('sessions') as { flush(session: Session): Promise<boolean> } | undefined
    try {
      await sessions?.flush(session)
    } catch (error) {
      this.activityStream.recordAgentFailureIfAbsent(agentId, {
        code: 'agent-session-flush-failed',
        summary: 'Agent session could not be saved.',
      })
      throw error
    }
  }

  private async mutateRevisioned<Value>(
    expectedRevision: number,
    mutation: (state: WorkspaceState) => { readonly state: WorkspaceState; readonly value: Value },
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<Value>> {
    return await this.mutateMaybeRevisioned(expectedRevision, mutation, signal)
  }

  private async mutateMaybeRevisioned<Value>(
    expectedRevision: number | undefined,
    mutation: (state: WorkspaceState) => { readonly state: WorkspaceState; readonly value: Value },
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<Value>> {
    let published = false
    let value!: Value
    const next = await this.directory.updateAggregate(this.workspaceId, current => {
      signal?.throwIfAborted()
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new WorkspaceBusinessError('stale-revision', {
          expectedRevision,
          actualRevision: current.revision,
        })
      }
      const changed = mutation(current)
      value = changed.value
      published = true
      return validateWorkspaceState(changed.state, this.workspaceId)
    })
    if (!published) throw new Error('workspace mutation did not publish its result')
    this.syncActivityProjection(next)
    return structuredClone({ revision: next.revision, value })
  }

  private requirePool(): EmployeeAgentPool {
    if (this.pool === undefined) throw new Error('agent workspace runtime is not available without the agent service')
    return this.pool
  }

  private requireDispatcher(): WorkspaceDispatcher {
    if (this.dispatcher === undefined) throw new Error('agent workspace dispatcher is not available without the agent service')
    return this.dispatcher
  }

  private requireTaskDelivery(): TaskDeliveryCoordinator {
    if (this.taskDelivery === undefined) throw new Error('durable task delivery coordinator is not available without the agent service')
    return this.taskDelivery
  }

  /**
   * Record a human room message and acknowledge it immediately after the
   * durable write. The potentially long collaboration chain continues in the
   * Host and is exposed to the Browser through runtimeStatus().
   */
  private async postHumanMessageInternal(
    expectedRevision: number,
    roomId: RoomId,
    humanId: HumanId,
    text: string,
    mentions: readonly AgentId[],
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<WorkspaceState>> {
    let dispatcher: WorkspaceDispatcher | undefined
    const committed = await this.mutateRevisioned(expectedRevision, current => {
      if (current.rooms[roomId]?.kind === 'direct') assertDirectRoomTextAllowed(roomId, text)
      const targets = resolveHumanWakeTargets(current, roomId, mentions)
      assertRoomMessageAuthorized(current, roomId, { type: 'human', id: humanId }, targets)
      if (targets.length > 0) dispatcher = this.requireDispatcher()
      const changed = mutateWorkspace(current, {
        type: 'room/message', roomId, actor: { type: 'human', id: humanId }, text, mentions: targets,
      })
      return { state: changed.state, value: { state: changed.state, targets, sourceEventId: changed.eventId } }
    }, signal)
    if (committed.value.targets.length === 0) {
      return { revision: committed.revision, value: committed.value.state }
    }
    if (dispatcher === undefined) throw new Error('human room post did not capture its dispatcher')
    this.beginRoomDispatch(roomId)
    const completion = dispatcher.continueCommittedHumanMessage(
      roomId,
      text,
      committed.value.targets,
      committed.value.sourceEventId,
    )
    this.retainBackground(completion.then(
      () => this.finishRoomDispatch(roomId),
      error => this.finishRoomDispatch(roomId, error),
    ))
    return { revision: committed.revision, value: committed.value.state }
  }

  /** Run one one-shot child for a parent agent and record its terminal result. */
  async runChild(parentAgentId: AgentId, taskId: TaskId, prompt: string, signal?: AbortSignal): Promise<string> {
    return await this.runNewOperation(() => this.requireDispatcher().runChild(parentAgentId, taskId, prompt, signal))
  }

  /** Deliver one assigned task through the durable coordinator. */
  async runAssignedTask(agentId: AgentId, taskId: TaskId): Promise<string> {
    return await this.runOperation(() => this.requireDispatcher().runAssignedTask(agentId, taskId))
  }

  /**
   * Retry one failed or interrupted delivery without creating another task.
   * @param taskId - Existing open task whose latest attempt is terminal.
   * @returns The complete terminal task text.
   */
  private async retryTaskDeliveryInternal(
    expectedRevision: number,
    taskId: TaskId,
    signal?: AbortSignal,
  ): Promise<WorkspaceMutationResult<string>> {
    let reservation: TaskDeliveryReservation | undefined
    let prepared: ReturnType<TaskDeliveryReservation['prepare']> | undefined
    try {
      const committed = await this.mutateRevisioned(expectedRevision, current => {
        const delivery = this.requireTaskDelivery()
        reservation = delivery.reserveTaskDelivery(taskId)
        prepared = reservation.prepare(current)
        return { state: prepared.state, value: undefined }
      }, signal)
      if (reservation === undefined || prepared === undefined) {
        throw new Error(`task '${taskId}' retry did not publish its delivery attempt`)
      }
      reservation.commit(prepared)
      const value = await reservation.result()
      return { revision: committed.revision, value }
    } catch (error) {
      reservation?.rollback()
      throw error
    }
  }

  /**
   * Prepare one employee as a real DSH Web agent: choose the deployment's
   * current model, install a session-local model-selection ref, join the same
   * default/persisted preset composition as ordinary Web sessions, and add the
   * Workspace role definition in the agent's own prompt scope.
   */
  private async employeeMaterializationOptions(agentId: AgentId, mode: 'create' | 'resume'): Promise<EmployeeMaterializationOptions> {
    const defaultModel = this.ctx.get('agentDefaultModel') as WorkspaceDefaultModel | undefined
    if (defaultModel === undefined) {
      throw new Error('agent workspace runtime requires the deployment default-model service')
    }
    const selected = defaultModel.currentSelection()
    const presets = this.ctx.get('agentPresets') as WorkspaceAgentPresets | undefined
    const createPresetId = mode === 'create' && presets !== undefined
      ? (await presets.resolve()).id
      : undefined

    return {
      agentOptions: { provider: selected.provider, model: selected.model },
      roleRevisionId: this.requireAgentRevision(agentId),
      ...(mode === 'create'
        ? { meta: { cwd: process.cwd(), ...(createPresetId === undefined ? {} : { agentPreset: createPresetId }) } }
        : {}),
      setup: async (agentCtx, scopedAgent) => {
        let picked: ModelSelection | undefined
        const selectionRef: ModelSelectionRef = {
          get current(): ModelSelection {
            if (picked !== undefined) return picked
            const logged = scopedAgent.session.requestHeader()?.config
            if (logged !== undefined) {
              return {
                provider: logged.provider,
                model: logged.model,
                ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
              }
            }
            return defaultModel.currentSelection()
          },
          set current(next: ModelSelection) {
            picked = next
          },
          assembled: undefined,
        }
        installModelSelection(agentCtx, selectionRef)

        if (presets !== undefined) {
          const persistedPreset = scopedAgent.session.header.agentPreset
          await presets.mount(agentCtx, persistedPreset ?? createPresetId)
        }
        const tracker = new WorkspaceTurnTracker({
          agentId,
          sessionId: scopedAgent.session.header.id,
          stream: this.activityStream,
        })
        tracker.install(agentCtx)
        this.trackers.set(agentId, tracker)
        agentCtx.on('agent/disposed', () => {
          if (this.trackers.get(agentId) === tracker) this.trackers.delete(agentId)
        })
      },
    }
  }

  /** Install the selected definition revision as an agent-scoped role prompt. */
  private requireAgentRevision(agentId: AgentId): DefinitionRevisionId {
    const revisionId = this.snapshot().agents[agentId]?.definitionRevisionId
    if (revisionId === undefined) throw new Error(`agent '${agentId}' disappeared before role setup`)
    return revisionId
  }

  /** Install one exact definition revision as an agent-scoped role prompt. */
  private installWorkspaceRole(agentCtx: Context, agentId: AgentId, revisionId: DefinitionRevisionId): () => void {
    const state = this.snapshot()
    const agent = state.agents[agentId]
    if (agent === undefined) throw new Error(`agent '${agentId}' disappeared before role setup`)
    const definition = state.definitions[agent.definitionId]
    const revision = state.definitionRevisions[revisionId]
    if (definition === undefined || revision === undefined || revision.definitionId !== agent.definitionId) {
      throw new Error(`agent '${agentId}' has an incomplete definition binding`)
    }
    const systemPrompt = agentCtx.get('systemPrompt') as WorkspaceSystemPrompt | undefined
    if (systemPrompt === undefined) throw new Error('agent workspace runtime requires the system-prompt service')
    const text = [
      `你在智能体组织中的身份是“${agent.name}”。`,
      `角色：${definition.name}`,
      revision.description.trim() === '' ? '' : `职责说明：\n${revision.description}`,
      revision.instructions.trim() === '' ? '' : `角色指令：\n${revision.instructions}`,
      '协作规则：你可以阅读当前房间提供的成员目录。如果需要其他成员继续处理，请使用目录里的准确显示名称进行 @，例如 @老周；不要输出内部 agent id。',
      '个人记忆：收到的回忆可能只是片段。缺少既往约定时，使用 workspace_search_memory 按关键词检索；需要引用或核实时，用 workspace_read_memory 读取原文及来源，按 nextOffset 继续读取。引用附带 eventId，不把未检索到的内容当作记忆。',
    ].filter(Boolean).join('\n\n')
    return systemPrompt.section({ name: 'agent-workspace:role', order: 10, text })
  }

  private syncActivityProjection(state: WorkspaceState): void {
    this.activityStream.setWorkspaceProjection(
      state.revision,
      Object.keys(state.agents).map(AgentId),
      taskDeliveryFailures(state),
    )
  }

  private beginRoomDispatch(roomId: RoomId): void {
    const current = this.roomRuntime.get(roomId)
    this.roomRuntime.set(roomId, { pending: (current?.pending ?? 0) + 1 })
  }

  private finishRoomDispatch(roomId: RoomId, error?: unknown): void {
    const current = this.roomRuntime.get(roomId) ?? { pending: 0 }
    const pending = Math.max(0, current.pending - 1)
    const message = error === undefined ? current.error : errorMessage(error)
    if (pending === 0 && message === undefined) {
      this.roomRuntime.delete(roomId)
      return
    }
    this.roomRuntime.set(roomId, message === undefined ? { pending } : { pending, error: message })
  }
}

function taskDeliveryFailures(state: WorkspaceState): WorkspaceActivityDurableFailure[] {
  const failuresByTask = new Map<TaskId, { readonly sequence: number; readonly code: string; readonly summary: string }>()
  for (const event of state.events) {
    if (!('taskId' in event)) continue
    switch (event.type) {
      case 'task/delivery-failed':
        failuresByTask.set(event.taskId, {
          sequence: event.sequence,
          code: event.failureCode,
          summary: event.failureSummary,
        })
        break
      case 'task/delivery-started':
      case 'task/delivery-accepted':
      case 'task/result':
      case 'task/result-after-cancel':
        failuresByTask.delete(event.taskId)
        break
      default:
        break
    }
  }

  const latestByAgent = new Map<AgentId, { readonly sequence: number; readonly code: string; readonly summary: string }>()
  for (const [taskId, failure] of failuresByTask) {
    const assignment = Object.values(state.taskAssignments).find(candidate => candidate.taskId === taskId)
    if (assignment === undefined) continue
    const current = latestByAgent.get(assignment.assigneeAgentId)
    if (current === undefined || current.sequence < failure.sequence) {
      latestByAgent.set(assignment.assigneeAgentId, failure)
    }
  }
  return [...latestByAgent].map(([agentId, failure]) => ({
    agentId,
    error: { code: failure.code, summary: failure.summary },
  }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateWorkspaceState(candidate: WorkspaceState, expectedWorkspaceId: WorkspaceId): WorkspaceState {
  const parsed = workspaceStateSchema.parse(candidate)
  assertWorkspaceInvariants(parsed, expectedWorkspaceId)
  return parsed
}

export default WorkspaceRuntime
export { projectDefinitionHistory } from './definition-history.ts'
export type { DefinitionHistoryItem, DefinitionRevisionCreationEvent } from './definition-history.ts'
export { queryAgentMemory } from './memory-query.ts'
export type {
  MemoryActor,
  MemoryDefinitionRevision,
  MemoryItem,
  MemoryPage,
  MemoryQuery,
  MemorySource,
  MemorySubject,
} from './memory-query.ts'
export {
  AGENT_WORKSPACE_PLUGIN_VERSION,
  createForwardWorkspaceExportV1,
  WORKSPACE_EXPORT_COMPATIBLE_IMPORT_RANGE,
  WORKSPACE_EXPORT_FORMAT,
  WORKSPACE_EXPORT_FORMAT_VERSION,
} from './forward-export.ts'
export type {
  ForwardWorkspaceAggregateV1,
  ForwardWorkspaceDescriptorV1,
  ForwardWorkspaceExportDocumentV1,
  ForwardWorkspaceExportEnvelopeV1,
} from './forward-export.ts'
