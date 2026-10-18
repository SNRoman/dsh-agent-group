/** One fixed organization's employee runtime and complete-operation lifecycle. */

import { Context } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceBusinessError } from './errors.ts'
import { AgentDefinitionId, AgentId, HumanId, RoomId, TaskId, WorkspaceId } from './ids.ts'
import type { DefinitionRevisionId, MembershipId } from './ids.ts'
import type { ChildRunId } from './ids.ts'
import { WorkspaceDispatcher } from './dispatcher.ts'
import type { SubagentRuntimeLike, WorkspaceDispatcherHost } from './dispatcher.ts'
import { assertWorkspaceInvariants } from './invariant.ts'
import { joinRoomWithMemory } from './memory.ts'
import { prepareDeliveryMemory } from './delivery-memory.ts'
import type { MemoryFact, MemoryLimits, PreparedSceneMemory } from './scene-memory-contract.ts'
import { MemoryProcessor } from './memory-processor.ts'
import type { MemoryProcessingProgress } from './memory-processor.ts'
import type { MemoryAudit, MemoryProjection, MemoryTable } from './memory-projection.ts'
import { extractMemoryWithModel, requestMemoryFragments, resolveMemoryExtractionParameters } from './memory-model.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
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
  assignDelegatedTask,
  cancelTask as cancelWorkspaceTask,
  grantTaskDelegation as grantWorkspaceTaskDelegation,
  revokeTaskDelegation as revokeWorkspaceTaskDelegation,
} from './tasks.ts'
import type { AssignDelegatedTaskRequest, AssignDelegatedTaskResult, AssignHumanTaskResult, CancelTaskResult, GrantTaskDelegationResult } from './tasks.ts'
import { failTaskDelivery, inspectTaskDelivery } from './task-delivery.ts'
import { TaskDeliveryCoordinator } from './task-delivery-coordinator.ts'
import type { TaskDeliveryReservation, WorkspaceDeliveryHooks } from './task-delivery-coordinator.ts'
import type { TaskDeliveryProgressEvent, WorkspaceCommand, WorkspaceState } from './types.ts'
import type { DelegationGrantId } from './ids.ts'
import { projectDefinitionHistory } from './definition-history.ts'
import type { DefinitionHistoryItem } from './definition-history.ts'
import { WEB_WORKSPACE_HUMAN_ID } from './rpc.ts'
import type { CompanyTemplatePreview, CompanyTemplateRevisionId, WorkflowCommand, WorkflowEndpoint, WorkflowExpectedRevisions, WorkflowMutationResult, WorkflowMutationValueMap, WorkflowOperationId, WorkflowProposalResult, WorkflowSnapshot } from './workflow-contract.ts'
import { previewCompanyTemplate, proposeWorkflowDraft, WorkflowBusinessError } from './workflow.ts'
import { workflowTaskInstructions } from './workflow-delivery.ts'
import type { ChatProposalRequest, ChatWorkCommand, ChatWorkRequest, ChatWorkResult, CommunicationSnapshot } from './chat-work-contract.ts'
import { chatAssignmentRequestSchema, chatConfirmationRequestSchema } from './chat-work-schema.ts'
import { applyChatWork, chatWorkRequestDigest } from './chat-work.ts'
import { workflowCommandSchema } from './workflow-schema.ts'
import { effectiveWorkspaceState, getCommunicationInvalidation } from './communication.ts'
import { prepareMessageRecall, previewMessageRecall, completeMessageRecall, failMessageRecall, messageRecallInputIds } from './message-recall.ts'
import { prepareRoomMemoryForget } from './room-memory-forget.ts'
import type { MessageRecallPreview } from './message-recall.ts'
import type { ContextResetId } from './communication-contract.ts'
import type { WorkspaceEventId } from './ids.ts'
import type { WorkspaceRecordV3 } from './workspace-record.ts'
import type { ChatSource } from './communication-contract.ts'
import type { CommunicationInput, CommunicationInputId } from './communication-contract.ts'
import { FileCheckpointJournal } from './file-checkpoints.ts'
import type { ManagedFileInput } from './file-checkpoints.ts'
import { observeWorkspaceFileTool } from './file-checkpoint-tools.ts'

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
  readonly contextGenerations: Readonly<Record<AgentId, number>>
}

interface ChildCleanupRetry {
  readonly error: unknown
  readonly retry: () => Promise<void>
  flight?: Promise<void>
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
  private readonly freshResetSessions = new Map<AgentId, SessionId>()
  private recallFlight: Promise<CommunicationSnapshot> | undefined
  private roomForgetFlight: Promise<WorkspaceMutationResult<WorkspaceState>> | undefined
  private readonly childCleanupFailuresByParent = new Map<AgentId, Set<ChildCleanupRetry>>()
  private readonly managedInputs = new WeakMap<Agent, ManagedFileInput>()
  private readonly recoveredInputs = new WeakMap<Agent, Map<MessageId, ManagedFileInput>>()
  private readonly memoryLimits: MemoryLimits
  private memoryProcessor: MemoryProcessor | undefined
  private fileJournal: FileCheckpointJournal | undefined
  private readonly workingDirectory = process.cwd()
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
    this.memoryLimits = {
      sceneCharacters: config.memorySceneCharacters, newCharacters: config.memoryNewCharacters,
      coreCharacters: config.memoryCoreCharacters, historyCharacters: config.memoryCharacterBudget,
      itemCharacters: config.memoryItemCharacters, recentConversationLimit: config.memoryRecentConversationLimit,
      factLimit: config.memoryFactLimit, historyLimit: config.memoryHistoryLimit,
    }
    if (directory.record(workspaceId).descriptor.lifecycle === 'archived') this.admission.close()
  }

  /** @returns Resolution after startup repair and runtime registrations. */
  async initialize(): Promise<void> {
    const stored = this.snapshot()
    const repaired = repairOrphanedChildRuns(stored)
    if (repaired !== stored) await this.directory.updateAggregate(this.workspaceId, () => repaired)
    this.syncActivityProjection(repaired)
    if (Object.values(this.directory.record(this.workspaceId).communication.resets).some(reset => reset.status !== 'completed')) this.admission.close()
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
    for (const agentId of this.childCleanupFailuresByParent.keys()) await this.retryChildCleanup(agentId)
    this.prepareReopen()
    this.retirement = undefined
    this.retirementDrained = false
    this.childCleanupFailures.length = 0
    const taskDelivery = new TaskDeliveryCoordinator({
      snapshot: () => this.effectiveSnapshot(),
      taskInstructions: taskId => {
        const record = this.directory.record(this.workspaceId)
        if (getCommunicationInvalidation(record.aggregate, record.communication).taskIds.has(taskId)) throw new Error('Withdrawn work instructions cannot be delivered.')
        return workflowTaskInstructions(record, taskId)
      },
      apply: async mutation => await this.apply(mutation),
      ensureEmployee: async agentId => await this.ensureEmployee(agentId),
      deliver: async (agentId, delivery, recall, source, hooks) => await this.deliver(agentId, delivery, recall, source, hooks),
      recoverDelivery: async (agentId, handle, delivery, source, hooks, recall) => await this.recoverDelivery(agentId, handle, delivery, source, hooks, recall),
      prepareRecoveredDelivery: async (agentId, handle, delivery, source) => await this.prepareRecoveredDelivery(agentId, handle, delivery, source),
      discardRecoveredDelivery: (handle, delivery) => this.discardRecoveredDelivery(handle, delivery),
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
      snapshot: () => this.effectiveSnapshot(),
      execute: async (command, settledActivity) => await this.executeInternal(command, settledActivity),
      apply: async mutation => await this.apply(mutation),
      deliver: async (agentId, delivery, recall, source) => await this.deliver(agentId, delivery, recall, source),
      ensureEmployee: async agentId => await this.ensureEmployee(agentId),
      retireWorkspaceActivity: (activity, workspaceRevision) => this.retireWorkspaceActivity(activity, workspaceRevision),
      assertContinuationAllowed: () => this.assertContinuationAllowed(),
      recordChildCleanupFailure: (error, parentAgentId, retry) => {
        this.childCleanupFailures.push(error)
        const failures = this.childCleanupFailuresByParent.get(parentAgentId) ?? new Set<ChildCleanupRetry>()
        failures.add({ error, retry })
        this.childCleanupFailuresByParent.set(parentAgentId, failures)
      },
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
    for (const reset of Object.values(this.directory.record(this.workspaceId).communication.resets)) {
      if (reset.status !== 'completed') {
        try { if (reset.kind === 'room-memory-forget') await this.finishRoomMemoryForget(reset.id); else await this.finishMessageRecall(reset.id) }
        catch (_error) { /* Persisted failure keeps old contexts blocked; the human can retry. */ }
      }
    }
  }

  /** Prevent new operations while retained continuations finish using their current runtime generation. */
  closeAdmission(): void { this.closing = true; this.memoryProcessor?.close() }

  /** @returns Shared teardown result after generation preparation, exact stops, full operation cleanup, and employee disposal. */
  dispose(): Promise<void> {
    this.closeAdmission()
    if (this.disposal !== undefined) return this.disposal
    this.disposal = Promise.allSettled([this.retireRuntime(), this.preparation, this.memoryProcessor?.settled()]).then(results => {
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
    const memorySettlement = this.memoryProcessor?.stop()
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
    const results = await Promise.allSettled([this.childControllers.stopAll(), memorySettlement])
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length !== 0) throw new AggregateError(failures, 'Organization work could not be stopped')
  }

  /** Wait for restored inbox-flight settlement, not merely employee idleness. */
  async drainDeliveries(): Promise<void> { await this.taskDelivery?.drain() }

  /** Reset stop controls only after old delivery and recovery flights have drained. */
  prepareReopen(): void { this.taskDelivery?.reopenDeliveries(); this.memoryProcessor?.reopen(); this.childControllers.openGeneration(); this.stopping = false }

  private async runOperation<Value>(operation: () => Promise<Value>, fresh = false): Promise<Value> {
    const current = this.operations.getStore()
    if (!fresh && current?.active === true) return await operation()
    if (this.closing || this.retirement !== undefined) throw new Error('workspace admission is closed')
    const record = this.directory.record(this.workspaceId)
    const scope: OperationScope = { pending: 1, active: true, release: this.admission.reserve(), contextGenerations: Object.fromEntries(Object.values(record.aggregate.agents).map(agent => [agent.id, record.communication.contexts[agent.id]?.generation ?? 0])) }
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

  private assertMemoryAdmissionAllowed(): void {
    if (this.stopping) throw new Error('organization work is stopping')
    if (this.closing || this.recallFlight !== undefined) throw new Error('workspace memory admission is closed')
  }

  /** A detached copy of the committed local aggregate. */
  snapshot(): WorkspaceState {
    return this.directory.snapshot(this.workspaceId)
  }

  /** @returns Model/tool input projection; never persist or mutate this event-gapped value. */
  effectiveSnapshot(): WorkspaceState {
    const record = this.directory.record(this.workspaceId)
    return effectiveWorkspaceState(record.aggregate, record.communication)
  }

  /** @returns Detached usable workflow and its matching aggregate revision, including archived organizations; withdrawn audit data remains stored. */
  workflowSnapshot(): WorkflowSnapshot {
    this.assertWorkflowReadable()
    const record = this.directory.record(this.workspaceId)
    return { workspaceId: this.workspaceId, aggregateRevision: record.aggregate.revision, workflow: this.directory.effectiveWorkflowSnapshot(this.workspaceId) }
  }

  /** @returns Detached communication metadata paired with current aggregate and workflow revisions. */
  communicationSnapshot(): CommunicationSnapshot {
    this.assertWorkflowReadable()
    const record = this.directory.record(this.workspaceId)
    return { workspaceId: this.workspaceId, aggregateRevision: record.aggregate.revision, workflowRevision: record.workflow.revision, communication: record.communication }
  }

  /** @param request Room, complete brief, explicit owner and default-off delegation. @param signal Precommit cancellation. @returns Stable confirmed work and its real chat source; replay performs no delivery. */
  assignChatWork(request: ChatWorkRequest<Extract<ChatWorkCommand, { type: 'communication/assign' }>>, signal?: AbortSignal): Promise<ChatWorkResult> {
    const { operationId, expectedAggregateRevision, expectedWorkflowRevision, ...fields } = chatAssignmentRequestSchema.parse(request)
    return this.commitChatWork({ operationId, expectedAggregateRevision, expectedWorkflowRevision }, { type: 'communication/assign', ...fields }, signal)
  }

  /** @param request Selected room and editable proposed draft with explicit owner. @param signal Precommit cancellation. @returns Stable confirmed work; a new human confirmation message records its source. */
  confirmChatWork(request: ChatWorkRequest<Extract<ChatWorkCommand, { type: 'communication/confirm' }>>, signal?: AbortSignal): Promise<ChatWorkResult> {
    const { operationId, expectedAggregateRevision, expectedWorkflowRevision, ...fields } = chatConfirmationRequestSchema.parse(request)
    return this.commitChatWork({ operationId, expectedAggregateRevision, expectedWorkflowRevision }, { type: 'communication/confirm', ...fields }, signal)
  }

  private async commitChatWork(request: WorkflowExpectedRevisions & { readonly operationId: WorkflowOperationId }, command: ChatWorkCommand, signal?: AbortSignal): Promise<ChatWorkResult> {
    this.assertWorkflowWritable()
    return this.runNewOperation(async () => {
      const digest = chatWorkRequestDigest(WEB_WORKSPACE_HUMAN_ID, command)
      const committed = await this.directory.updateRecord(this.workspaceId, record => {
        this.assertContinuationAllowed()
        if (record.descriptor.lifecycle !== 'active') throw new WorkflowBusinessError('workflow-read-only', { workspaceId: this.workspaceId })
        if (command.type === 'communication/confirm' && getCommunicationInvalidation(record.aggregate, record.communication).draftIds.has(command.draftId)) throw new Error('Withdrawn proposal cannot be confirmed.')
        const previous = Object.hasOwn(record.communication.operations, request.operationId) ? record.communication.operations[request.operationId] : undefined
        if (previous !== undefined) {
          if (previous.requestDigest !== digest) throw new WorkflowBusinessError('workflow-operation-reused', { operationId: request.operationId })
          return { record, value: { receipt: previous.receipt, replayed: true } }
        }
        if (record.aggregate.revision !== request.expectedAggregateRevision) throw new WorkspaceBusinessError('stale-revision', { expectedRevision: request.expectedAggregateRevision, actualRevision: record.aggregate.revision })
        if (record.workflow.revision !== request.expectedWorkflowRevision) throw new WorkflowBusinessError('stale-workflow-revision', { expectedWorkflowRevision: request.expectedWorkflowRevision, actualWorkflowRevision: record.workflow.revision })
        const changed = applyChatWork(record, command, { humanId: WEB_WORKSPACE_HUMAN_ID, occurredAt: new Date().toISOString() })
        const operation = { id: request.operationId, humanId: WEB_WORKSPACE_HUMAN_ID, command, requestDigest: digest, receipt: changed.value, aggregateRevision: changed.record.aggregate.revision, workflowRevision: changed.record.workflow.revision }
        return { record: { ...changed.record, communication: { ...changed.record.communication, operations: { ...changed.record.communication.operations, [request.operationId]: operation } } }, value: { receipt: changed.value, replayed: false } }
      }, signal)
      if (!committed.value.replayed) {
        this.syncActivityProjection(committed.record.aggregate)
        const delivery = this.taskDelivery
        if (delivery !== undefined) this.retainBackground(delivery.deliver(committed.value.receipt.taskId).catch((_error) => { /* The coordinator records the retryable delivery failure. */ }))
      }
      return { workspaceId: this.workspaceId, aggregateRevision: committed.record.aggregate.revision, workflowRevision: committed.record.workflow.revision, communicationRevision: committed.record.communication.revision, value: committed.value.receipt, replayed: committed.value.replayed }
    })
  }

  /** @param request Both revision checkpoints and durable retry identity. @param command Human-only action. @param signal Precommit cancellation. @returns Durable receipt; identical replay never starts delivery. */
  async executeWorkflow<K extends WorkflowEndpoint>(request: WorkflowExpectedRevisions & { readonly operationId: WorkflowOperationId; readonly roomId?: RoomId }, command: WorkflowCommand<K>, signal?: AbortSignal): Promise<WorkflowMutationResult<WorkflowMutationValueMap[K]>> {
    this.assertWorkflowWritable()
    const action = workflowCommandSchema.parse(command)
    if (action.type === 'workflow/draft/create' || action.type === 'workflow/draft/confirm' || action.type === 'workflow/task-template/apply' || (request.roomId === undefined && (action.type === 'workflow/result/handoff' || (action.type === 'workflow/result/review' && action.decision === 'changes-requested')))) throw new WorkflowBusinessError('workflow-reference-invalid', { entityKind: 'chat-source-required', entityId: action.type })
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
  async proposeTask(agent: Agent, request: ChatProposalRequest, signal?: AbortSignal): Promise<WorkflowProposalResult> {
    this.assertWorkflowWritable()
    return await this.runOperation(async () => {
      this.assertContinuationAllowed()
      const committed = await this.directory.updateRecord(this.workspaceId, record => {
        if (record.descriptor.lifecycle === 'archived') throw new WorkflowBusinessError('workflow-read-only', { workspaceId: this.workspaceId })
        this.assertContinuationAllowed()
        const agentId = this.agentIdFor(agent)
        if (agentId === undefined) throw new Error('Workspace proposal caller is not an active employee.')
        const { roomId, ...proposal } = request
        assertRoomMessageAuthorized(record.aggregate, roomId, { type: 'agent', id: agentId }, [])
        if (record.aggregate.rooms[roomId]?.kind === 'direct') assertDirectRoomTextAllowed(roomId, proposal.brief.instructions)
        const message = mutateWorkspace(record.aggregate, { type: 'room/message', roomId, actor: { type: 'agent', id: agentId }, text: proposal.brief.instructions, mentions: [] })
        const changed = proposeWorkflowDraft({ aggregate: message.state, workflow: record.workflow }, proposal, { agentId, occurredAt: new Date().toISOString() })
        const source = { roomId, eventId: message.eventId }
        const communication = { ...record.communication, revision: record.communication.revision + 1, messages: { ...record.communication.messages, [message.eventId]: { eventId: message.eventId, intent: 'proposal' as const } }, draftSources: { ...record.communication.draftSources, [changed.value.draftId]: source } }
        return { record: { ...record, aggregate: changed.aggregate, workflow: changed.workflow, communication }, value: { draftId: changed.value.draftId, summary: changed.workflow.drafts[changed.value.draftId]!.brief.title.slice(0, this.config.memoryCharacterBudget), status: 'awaiting-human-confirmation' as const } }
      }, signal)
      this.syncActivityProjection(committed.record.aggregate)
      return committed.value
    })
  }

  /** @param agent Actual published caller, authenticated during the atomic commit. @param request Selected chat and granted peer work. @param signal Precommit cancellation. @returns Assignment and its persisted agent-authored chat source; delivery is owned by the caller. */
  async delegateTask(agent: Agent, request: Omit<AssignDelegatedTaskRequest, 'actorAgentId'> & { readonly roomId: RoomId }, signal?: AbortSignal): Promise<Omit<AssignDelegatedTaskResult, 'state'> & { readonly source: ChatSource }> {
    this.assertWorkflowWritable()
    return await this.runOperation(async () => {
      const committed = await this.directory.updateRecord(this.workspaceId, record => {
        this.assertContinuationAllowed()
        if (record.descriptor.lifecycle !== 'active') throw new WorkflowBusinessError('workflow-read-only', { workspaceId: this.workspaceId })
        const actorAgentId = this.agentIdFor(agent)
        if (actorAgentId === undefined) throw new Error('Workspace task tool caller is not an active employee.')
        const { roomId, ...assignment } = request
        if (getCommunicationInvalidation(record.aggregate, record.communication).taskIds.has(assignment.rootTaskId)) throw new Error('Withdrawn work cannot authorize delegation.')
        assertRoomMessageAuthorized(record.aggregate, roomId, { type: 'agent', id: actorAgentId }, [assignment.assigneeAgentId])
        resolveHumanWakeTargets(record.aggregate, roomId, [assignment.assigneeAgentId])
        if (record.aggregate.rooms[roomId]?.kind === 'direct') assertDirectRoomTextAllowed(roomId, assignment.title)
        const message = mutateWorkspace(record.aggregate, { type: 'room/message', roomId, actor: { type: 'agent', id: actorAgentId }, text: assignment.title, mentions: [assignment.assigneeAgentId] })
        const changed = assignDelegatedTask(message.state, { ...assignment, actorAgentId })
        const source = { roomId, eventId: message.eventId }
        const communication = { ...record.communication, revision: record.communication.revision + 1, messages: { ...record.communication.messages, [message.eventId]: { eventId: message.eventId, intent: 'delegation' as const } }, taskSources: { ...record.communication.taskSources, [changed.taskId]: source } }
        return { record: { ...record, aggregate: changed.state, communication }, value: { taskId: changed.taskId, taskAssignmentId: changed.taskAssignmentId, source } }
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
    const page = queryAgentMemory(this.effectiveSnapshot(), query)
    const processing = this.memoryProcessingStatus(query.agentId)
    return { ...page, items: page.items.map(item => {
      const source = processing.sources.find(candidate => candidate.eventId === item.eventId)
      return { ...item, processing: { status: source?.status ?? (item.text === undefined ? 'not-applicable' as const : 'unprocessed' as const),
        available: processing.available,
        ranges: source?.ranges ?? [], facts: processing.facts.filter(fact => fact.sourceEventIds.includes(item.eventId)) } }
    }) }
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
    void expectedRevision; void humanId; void assigneeAgentId; void title; void signal
    throw new WorkflowBusinessError('workflow-reference-invalid', { entityKind: 'chat-source-required', entityId: 'task-assignment' })
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
    return this.effectiveSnapshot().sessionBindings[agentId]
  }

  /** Durably record a freshly created or migrated session id for an agent. */
  async recordSessionId(agentId: AgentId, sessionId: SessionId): Promise<void> {
    if (this.directory.record(this.workspaceId).communication.contexts[agentId]?.blockedBy !== undefined) {
      this.freshResetSessions.set(agentId, sessionId)
      return
    }
    await this.directory.updateRecord(this.workspaceId, record => {
      const context = record.communication.contexts[agentId]
      if (context?.blockedBy !== undefined) throw new Error('Context reset owns session publication.')
      const aggregate = mutateWorkspace(record.aggregate, { type: 'runtime/session-bound', agentId, sessionId }).state
      return { record: { ...record, aggregate, communication: context === undefined ? record.communication : {
        ...record.communication, revision: record.communication.revision + 1,
        contexts: { ...record.communication.contexts, [agentId]: { ...context, sessionId } },
      } }, value: undefined }
    })
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
    if (this.directory.record(this.workspaceId).communication.contexts[agentId]?.blockedBy !== undefined) throw new Error('Colleague context reset is not complete.')
    return await this.requirePool().ensure(agentId)
  }

  /** Resolve one currently published employee Agent handle to its durable id. */
  agentIdFor(agent: Agent): AgentId | undefined {
    const id = this.pool?.agentIdFor(agent)
    return id !== undefined && this.directory.record(this.workspaceId).communication.contexts[id]?.blockedBy === undefined ? id : undefined
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
        const loggedRecall = await this.admitManagedInput(agentId, handle.agent, delivery, recall, source)
        let outcome: WorkspaceTurnOutcome
        try {
          if (source === undefined) this.assertContinuationAllowed()
          else this.assertMemoryAdmissionAllowed()
          outcome = await tracker.deliver(handle.agent, delivery, loggedRecall, source, hooks)
        } finally { this.managedInputs.delete(handle.agent) }
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
      if (this.directory.record(this.workspaceId).communication.contexts[agentId]?.blockedBy !== undefined) throw new Error('Colleague context reset is not complete.')
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
      const loggedRecall = await this.admitManagedInput(agentId, handle.agent, delivery, recall, source)
      let outcome: WorkspaceTurnOutcome
      try {
        if (source === undefined) this.assertContinuationAllowed()
        else this.assertMemoryAdmissionAllowed()
        outcome = await tracker.deliver(handle.agent, delivery, loggedRecall, source, capturedHooks)
      } finally { this.managedInputs.delete(handle.agent) }
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
    recall?: UserMessage,
  ): Promise<WorkspaceTurnOutcome> {
    const managed = this.recoveredInputs.get(handle.agent)?.get(delivery.id)
    if (managed === undefined || source.kind !== 'task' || recall?.source.kind !== 'agent-workspace-context'
      || recall.source.id !== managed.inputId || managed.agentId !== agentId) throw new Error('Recovered task has no validated managed input.')
    try {
      const context = this.directory.record(this.workspaceId).communication.contexts[agentId]
      if (context?.blockedBy !== undefined || managed.generation !== (context?.generation ?? 0)) throw new Error('Recovered task belongs to an old colleague context.')
      const tracker = this.trackers.get(agentId)
      if (tracker === undefined) throw new Error(`agent '${agentId}' has no turn tracker`)
      const definitionRevisionId = this.pool?.roleRevisionFor(agentId)
        ?? this.snapshot().agents[agentId]?.definitionRevisionId
      if (definitionRevisionId === undefined) throw new Error(`agent '${agentId}' has no role revision for recovered delivery`)
      const capturedHooks = { ...hooks, onClaim: async () => {
        await hooks?.onClaim?.(definitionRevisionId)
        this.managedInputs.set(handle.agent, managed)
      } }
      const outcome = await tracker.recover(handle.agent, delivery, source, capturedHooks, recall)
      await this.flushEmployeeSession(agentId, handle.agent.session)
      return { ...outcome, definitionRevisionId }
    } finally {
      if (this.managedInputs.get(handle.agent) === managed) this.managedInputs.delete(handle.agent)
      const prepared = this.recoveredInputs.get(handle.agent)
      prepared?.delete(delivery.id)
      if (prepared?.size === 0) this.recoveredInputs.delete(handle.agent)
    }
  }

  /** Rebind the persisted task input and prepare a receipt before the pending native inbox resumes. */
  async prepareRecoveredDelivery(agentId: AgentId, handle: Pick<AgentHandle, 'agent'>, delivery: UserMessage, source: WorkspaceActivitySource): Promise<UserMessage | undefined> {
    if (source.kind !== 'task') throw new Error('Only pending tasks can restore a managed input.')
    const agent = handle.agent
    if (delivery.source.kind !== 'agent-workspace-delivery') throw new Error('Recovered task delivery source differs.')
    const triggerEventId = delivery.source.sourceEventId
    if (agent.inbox.nextTurn.concat(agent.inbox.nextStep).filter(message => message.id === delivery.id).length !== 1
      || agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === delivery.id)) throw new Error('Recovered task inbox is inconsistent.')
    const record = this.directory.record(this.workspaceId)
    this.assertTaskDeliveryIdentity(record, agentId, agent, delivery, source)
    const existing = Object.values(record.communication.inputs).filter(input => input.target.kind === 'task' && input.target.taskId === source.taskId)
    const matching = existing.filter(input => input.deliveryMessageId === delivery.id && input.taskDeliveryAttemptId === source.attemptId)
    const started = record.aggregate.events.find(event => event.type === 'task/delivery-started'
      && event.taskId === source.taskId && event.taskDeliveryAttemptId === source.attemptId)!
    if (matching.length > 1 || (matching.length === 0 && existing.some(input => input.taskDeliveryAttemptId === source.attemptId
      || (input.deliveryMessageId === undefined && input.recordedAtSequence >= started.sequence)))) throw new Error('Recovered task input identity is ambiguous.')
    if (this.recoveredInputs.get(agent)?.has(delivery.id)) throw new Error('Recovered task was prepared twice.')
    if (matching.length === 0) {
      const recall = await this.admitManagedInput(agentId, agent, delivery, undefined, source)
      const managed = this.managedInputs.get(agent)
      if (managed === undefined) throw new Error('Recovered task input was not admitted.')
      this.managedInputs.delete(agent)
      this.rememberRecoveredInput(agent, delivery.id, managed)
      return recall
    }
    const inputId = matching[0]!.id
    const committed = await this.directory.updateRecord(this.workspaceId, current => {
      this.assertMemoryAdmissionAllowed()
      this.assertTaskDeliveryIdentity(current, agentId, agent, delivery, source)
      const input = current.communication.inputs[inputId]
      const generation = current.communication.contexts[agentId]?.generation ?? 0
      if (input === undefined || input.agentId !== agentId || input.contextGeneration !== generation
        || input.deliveryMessageId !== delivery.id || input.taskDeliveryAttemptId !== source.attemptId) throw new Error('Recovered task input generation or identity differs.')
      if (agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source?.kind === 'agent-workspace-context'
        && event.data.source.id === input.id)) throw new Error('Recovered task input already has a logged receipt.')
      const invalid = getCommunicationInvalidation(current.aggregate, current.communication)
      if (invalid.inputIds.has(input.id) || invalid.taskIds.has(source.taskId)) throw new Error('Recovered task input is withdrawn.')
      const snapshot = effectiveWorkspaceState(current.aggregate, current.communication)
      const prepared = prepareDeliveryMemory(snapshot, { session: agent.session, agentId, contextGeneration: generation,
        source, triggerEventId,
        delivery, organization: { id: this.workspaceId, name: current.descriptor.label },
        facts: this.sceneFactCandidates(snapshot, agentId), limits: this.memoryLimits, historyContextCharacters: this.config.memoryContextCharacters })
      if (prepared.eventIds.some(eventId => invalid.eventIds.has(eventId))) throw new Error('Withdrawn recall cannot be recovered.')
      const updated: CommunicationInput = { ...input, recordedAtSequence: current.aggregate.nextSequence - 1, recalledEventIds: [...prepared.eventIds] }
      return { record: { ...current, communication: { ...current.communication, revision: current.communication.revision + 1,
        inputs: { ...current.communication.inputs, [input.id]: updated } } }, value: { input: updated, prepared } }
    })
    this.assertMemoryAdmissionAllowed()
    this.rememberRecoveredInput(agent, delivery.id, this.managedFileInput(agent, committed.value.input))
    return this.memoryContextMessage(agentId, committed.value.input, committed.value.prepared)
  }

  private discardRecoveredDelivery(handle: Pick<AgentHandle, 'agent'>, delivery: UserMessage): void {
    const prepared = this.recoveredInputs.get(handle.agent)
    prepared?.delete(delivery.id)
    if (prepared?.size === 0) this.recoveredInputs.delete(handle.agent)
  }

  private rememberRecoveredInput(agent: Agent, messageId: MessageId, input: ManagedFileInput): void {
    const pending = this.recoveredInputs.get(agent) ?? new Map<MessageId, ManagedFileInput>()
    pending.set(messageId, input)
    this.recoveredInputs.set(agent, pending)
  }

  private assertTaskDeliveryIdentity(record: WorkspaceRecordV3, agentId: AgentId, agent: Agent, delivery: UserMessage, source: Extract<WorkspaceActivitySource, { readonly kind: 'task' }>): void {
    const deliverySource = delivery.source
    if (deliverySource.kind !== 'agent-workspace-delivery') throw new Error('Recovered task delivery source differs.')
    if (deliverySource.workspaceId !== this.workspaceId || deliverySource.source.kind !== 'task' || deliverySource.source.taskId !== source.taskId
      || deliverySource.taskDeliveryAttemptId !== source.attemptId || record.aggregate.sessionBindings[agentId] !== agent.session.id) throw new Error('Recovered task delivery source or session differs.')
    const inspection = inspectTaskDelivery(record.aggregate, source.taskId)
    const started = record.aggregate.events.find(event => event.type === 'task/delivery-started'
      && event.taskId === source.taskId && event.taskDeliveryAttemptId === source.attemptId && event.messageId === delivery.id)
    const assignment = Object.values(record.aggregate.taskAssignments).find(item => item.taskId === source.taskId && item.assigneeAgentId === agentId)
    const trigger = record.aggregate.events.find(event => event.id === deliverySource.sourceEventId)
    if (inspection.attemptId !== source.attemptId || (inspection.phase !== 'started' && inspection.phase !== 'accepted')
      || started === undefined || assignment === undefined || trigger?.subjectId !== assignment.id
      || record.aggregate.tasks[source.taskId]?.status !== 'open'
      || record.communication.contexts[agentId]?.blockedBy !== undefined) throw new Error('Recovered task attempt is not current and assigned.')
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
    const committed = await this.directory.updateRecord(this.workspaceId, record => {
      const current = record.aggregate
      signal?.throwIfAborted()
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new WorkspaceBusinessError('stale-revision', {
          expectedRevision,
          actualRevision: current.revision,
        })
      }
      const changed = mutation(current)
      this.assertGeneratedCommit(record, changed.state)
      value = changed.value
      published = true
      const aggregate = validateWorkspaceState(changed.state, this.workspaceId)
      const messages = { ...record.communication.messages }, inputs = { ...record.communication.inputs }
      let attributed = false
      for (const event of aggregate.events.slice(current.events.length)) {
        const agentId = event.actor?.type === 'agent' ? event.actor.id : event.type === 'child/run-finished' && event.subjectId !== undefined ? aggregate.childRuns[event.subjectId as ChildRunId]?.parentAgentId : undefined
        if (agentId === undefined || event.text === undefined) continue
        const generation = record.communication.contexts[agentId]?.generation ?? 0
        const prior = Object.values(inputs).filter(input => input.agentId === agentId && input.contextGeneration === generation)
        const id = randomUUID() as CommunicationInputId
        inputs[id] = { id, agentId, contextGeneration: generation, target: { kind: 'event', eventId: event.id }, recordedAtSequence: aggregate.nextSequence - 1, directEventIds: [], recalledEventIds: [], sessionEventIds: [...new Set(prior.flatMap(input => [...input.directEventIds, ...input.recalledEventIds, ...input.sessionEventIds]))] }
        if (event.type === 'room/message') messages[event.id] = { ...messages[event.id], eventId: event.id, intent: messages[event.id]?.intent ?? 'message', contextGeneration: generation }
        attributed = true
      }
      return { record: { ...record, aggregate, communication: attributed ? { ...record.communication, revision: record.communication.revision + 1, messages, inputs } : record.communication }, value: undefined }
    })
    const next = committed.record.aggregate
    if (!published) throw new Error('workspace mutation did not publish its result')
    this.syncActivityProjection(next)
    return structuredClone({ revision: next.revision, value })
  }

  private assertGeneratedCommit(record: WorkspaceRecordV3, next: WorkspaceState): void {
    const scope = this.operations.getStore()
    for (const event of next.events.slice(record.aggregate.events.length)) {
      const agentId = event.actor?.type === 'agent' ? event.actor.id : (event.type === 'child/run-finished' || event.type === 'child/run-started') && event.subjectId !== undefined ? next.childRuns[event.subjectId as ChildRunId]?.parentAgentId : undefined
      // Stop/cancel/failure settlement has no reusable model output and must be allowed to drain.
      if (agentId === undefined || (event.text === undefined && event.type !== 'child/run-started') || (event.type === 'child/run-finished' && event.childRunStatus === 'cancelled')) continue
      const context = record.communication.contexts[agentId]
      if (context?.blockedBy !== undefined || (scope !== undefined && (scope.contextGenerations[agentId] ?? 0) !== (context?.generation ?? 0))) throw new Error('Old colleague context cannot publish new model output.')
    }
  }

  /** @param roomId Actual chat. @param eventId Human-authored message. @returns Conservative named-subject preview with no writes. */
  async previewRecall(roomId: RoomId, eventId: WorkspaceEventId): Promise<MessageRecallPreview> {
    const record = this.directory.record(this.workspaceId)
    const existing = Object.values(record.communication.resets).find(reset => reset.source.eventId === eventId && reset.source.roomId === roomId)
    const request = { roomId, eventId, operationId: existing?.id ?? `preview-${eventId}` as ContextResetId, humanId: WEB_WORKSPACE_HUMAN_ID, requestedAt: new Date().toISOString(), restoreFiles: existing?.fileRestoreRequested ?? false }
    const preview = previewMessageRecall(record, request)
    const inputs = messageRecallInputIds(prepareMessageRecall(record, request), request.operationId)
    const files = await this.journal().preview({ cwd: this.workingDirectory, workspaceId: this.workspaceId, hostLocal: true }, inputs)
    return { ...preview, files }
  }

  /** @param request Stable withdrawal and displayed aggregate revision. @param signal Precommit cancellation only. @returns Reset metadata after old work drains and fresh sessions are bound; failure remains retryable and blocked. */
  async recallMessage(request: { readonly operationId: ContextResetId; readonly roomId: RoomId; readonly eventId: WorkspaceEventId; readonly expectedRevision: number; readonly restoreFiles: boolean }, signal?: AbortSignal): Promise<CommunicationSnapshot> {
    if (this.recallFlight !== undefined || this.roomForgetFlight !== undefined) throw new Error('Context reset is already running.')
    const flight = (async () => {
      const rollback = this.admission.close()
      try {
        const committed = await this.directory.updateRecord(this.workspaceId, record => {
          const existing = record.communication.resets[request.operationId]
          if (existing === undefined && record.aggregate.revision !== request.expectedRevision) throw new WorkspaceBusinessError('stale-revision', { expectedRevision: request.expectedRevision, actualRevision: record.aggregate.revision })
          return { record: prepareMessageRecall(record, { ...request, humanId: WEB_WORKSPACE_HUMAN_ID, requestedAt: new Date().toISOString() }), value: undefined }
        }, signal)
        this.syncActivityProjection(committed.record.aggregate)
      } catch (error) { rollback(); throw error }
      return this.finishMessageRecall(request.operationId)
    })()
    this.recallFlight = flight
    try { return await flight }
    finally { if (this.recallFlight === flight) this.recallFlight = undefined }
  }

  /** @param id Completed withdrawal with prior file consent. @returns File retry outcomes without another context generation change. */
  async retryRecallFiles(id: ContextResetId): Promise<CommunicationSnapshot> {
    if (this.recallFlight !== undefined || this.roomForgetFlight !== undefined) throw new Error('Context reset is already running.')
    const reset = this.directory.record(this.workspaceId).communication.resets[id]
    if (reset?.status !== 'completed' || !reset.fileRestoreRequested || reset.requestedByHumanId !== WEB_WORKSPACE_HUMAN_ID) throw new Error('File retry requires a completed author-owned withdrawal with file consent.')
    const flight = (async () => {
      this.admission.close()
      try {
        await this.stopAdmittedWork()
        await this.admission.drain()
        await this.drainDeliveries()
        const record = this.directory.record(this.workspaceId)
        await this.journal().restore({ cwd: this.workingDirectory, workspaceId: this.workspaceId, hostLocal: true }, messageRecallInputIds(record, id))
        return this.communicationSnapshot()
      } finally { this.prepareReopen(); this.admission.reopen() }
    })()
    this.recallFlight = flight
    try { return await flight } finally { if (this.recallFlight === flight) this.recallFlight = undefined }
  }

  private async finishMessageRecall(id: ContextResetId): Promise<CommunicationSnapshot> {
    const reset = this.directory.record(this.workspaceId).communication.resets[id]
    if (reset === undefined || reset.kind !== undefined) throw new Error('Message withdrawal operation does not exist.')
    if (reset.status === 'completed') { if (this.admission.pending === 0) this.admission.reopen(); return this.communicationSnapshot() }
    this.admission.close()
    this.freshResetSessions.clear()
    try {
      const stop = this.stopAdmittedWork()
      const pool = this.pool
      const disposal = Promise.all(reset.affectedAgentIds.map(async agentId => { await pool?.dispose(agentId) }))
      await Promise.all([stop, disposal])
      await this.admission.drain()
      await this.drainDeliveries()
      for (const agentId of reset.affectedAgentIds) await this.retryChildCleanup(agentId)
      if (this.childCleanupFailures.length > 0) throw new AggregateError(this.childCleanupFailures, 'Child cleanup failed.')
      for (const agentId of reset.affectedAgentIds) {
        if (this.snapshot().agents[agentId]?.employmentStatus !== 'employed') continue
        if (pool === undefined) throw new Error('Agent runtime is unavailable for context reset.')
        await pool.ensure(agentId)
      }
      if (reset.fileRestoreRequested) {
        const record = this.directory.record(this.workspaceId)
        await this.journal().restore({ cwd: this.workingDirectory, workspaceId: this.workspaceId, hostLocal: true }, messageRecallInputIds(record, id))
      }
      const sessions = Object.fromEntries(this.freshResetSessions)
      const committed = await this.directory.updateRecord(this.workspaceId, record => ({ record: completeMessageRecall(record, id, sessions), value: undefined }))
      this.syncActivityProjection(committed.record.aggregate)
      this.prepareReopen()
      this.admission.reopen()
      return this.communicationSnapshot()
    } catch (error) {
      await this.directory.updateRecord(this.workspaceId, record => ({ record: failMessageRecall(record, id), value: undefined }))
      throw error
    } finally { this.freshResetSessions.clear() }
  }

  /** @param request Group membership and stable cleanup retry identity. @param signal Precommit cancellation only. @returns Current snapshot after the colleague's personal room memory and native Session have been reset. */
  async leaveRoomAndForget(request: { readonly membershipId: MembershipId; readonly operationId: ContextResetId; readonly expectedRevision: number }, signal?: AbortSignal): Promise<WorkspaceMutationResult<WorkspaceState>> {
    if (this.closing || this.retirement !== undefined) throw new Error('workspace admission is closed')
    if (this.recallFlight !== undefined || this.roomForgetFlight !== undefined) throw new Error('Context reset is already running.')
    const flight = (async () => {
      const existing = this.directory.record(this.workspaceId).communication.resets[request.operationId]
      const rollback = existing?.status === 'completed' ? () => {} : this.admission.close()
      try {
        const committed = await this.directory.updateRecord(this.workspaceId, record => {
          if (record.communication.resets[request.operationId] === undefined && record.aggregate.revision !== request.expectedRevision) throw new WorkspaceBusinessError('stale-revision', { expectedRevision: request.expectedRevision, actualRevision: record.aggregate.revision })
          return { record: prepareRoomMemoryForget(record, request.membershipId, request.operationId, WEB_WORKSPACE_HUMAN_ID, new Date().toISOString()), value: undefined }
        }, signal)
        this.syncActivityProjection(committed.record.aggregate)
      } catch (error) { rollback(); throw error }
      return await this.finishRoomMemoryForget(request.operationId)
    })()
    this.roomForgetFlight = flight
    try { return await flight }
    finally { if (this.roomForgetFlight === flight) this.roomForgetFlight = undefined }
  }

  private async finishRoomMemoryForget(id: ContextResetId): Promise<WorkspaceMutationResult<WorkspaceState>> {
    const reset = this.directory.record(this.workspaceId).communication.resets[id]
    if (reset?.kind !== 'room-memory-forget') throw new Error('Room memory removal operation does not exist.')
    if (reset.status === 'completed') { const value = this.snapshot(); return { revision: value.revision, value } }
    const agentId = reset.affectedAgentIds[0]!
    this.admission.close()
    this.freshResetSessions.clear()
    try {
      for (const assignment of Object.values(this.snapshot().taskAssignments)) {
        if (assignment.assigneeAgentId === agentId) this.taskDelivery?.cancelTaskDelivery(assignment.taskId)
      }
      for (const activity of this.activityStream.snapshot().activities) {
        if (activity.agentId !== agentId) continue
        const handle = this.pool?.controlHandleFor(agentId)
        if (activity.status === 'queued') {
          handle?.agent.inbox.remove(activity.messageId)
          this.activityStream.discard(activity.activityId, { code: 'delivery-discarded', summary: 'Colleague memory reset stopped this queued delivery.' })
        } else if (activity.claimed !== undefined && (activity.status === 'responding' || activity.status === 'stopping')) {
          this.activityController.stopActivity({ activityId: activity.activityId, agentId, messageId: activity.messageId, sessionId: activity.claimed.sessionId, turn: activity.claimed.turn })
        }
      }
      const children = (async () => {
        await this.childControllers.drainStarts()
        await Promise.all(Object.values(this.snapshot().childRuns).filter(child => child.parentAgentId === agentId && child.status === 'running').map(child => this.childControllers.stopChildRun(child.id)))
      })()
      const stopped = await Promise.allSettled([children, this.pool?.dispose(agentId)])
      const failures = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'Colleague context cleanup failed.')
      await this.admission.drain()
      await this.drainDeliveries()
      await this.retryChildCleanup(agentId)
      await this.apply(current => {
        let state = current
        for (const assignment of Object.values(current.taskAssignments)) {
          if (assignment.assigneeAgentId !== agentId) continue
          const attempt = inspectTaskDelivery(state, assignment.taskId)
          if (attempt.phase !== 'started' && attempt.phase !== 'accepted') continue
          const started = state.events.findLast(event => event.type === 'task/delivery-started' && event.taskId === assignment.taskId && event.taskDeliveryAttemptId === attempt.attemptId)
          if (started?.type !== 'task/delivery-started') throw new Error('Open task attempt has no start identity.')
          state = failTaskDelivery(state, { taskId: assignment.taskId, attemptId: started.taskDeliveryAttemptId, messageId: started.messageId, failureCode: 'interrupted', failureSummary: 'Colleague memory reset interrupted this delivery.' }).state
        }
        return state
      })
      if (this.closing || this.stopping) throw new Error('Organization stopped during colleague memory reset.')
      if (this.snapshot().agents[agentId]?.employmentStatus === 'employed') {
        if (this.pool === undefined) throw new Error('Agent runtime is unavailable for context reset.')
        await this.pool.ensure(agentId)
      }
      const sessions = Object.fromEntries(this.freshResetSessions)
      const committed = await this.directory.updateRecord(this.workspaceId, record => ({ record: completeMessageRecall(record, id, sessions), value: undefined }))
      this.syncActivityProjection(committed.record.aggregate)
      if (!this.closing && !this.stopping) this.admission.reopen()
      return { revision: committed.record.aggregate.revision, value: structuredClone(committed.record.aggregate) }
    } catch (error) {
      await this.directory.updateRecord(this.workspaceId, record => ({ record: failMessageRecall(record, id), value: undefined }))
      if (!this.closing && !this.stopping && this.admission.pending === 0) this.admission.reopen()
      throw error
    } finally { this.freshResetSessions.clear() }
  }

  private async retryChildCleanup(agentId: AgentId): Promise<void> {
    const retained = this.childCleanupFailuresByParent.get(agentId)
    if (retained === undefined) return
    const results = await Promise.allSettled([...retained].map(async entry => {
      const flight = entry.flight ??= Promise.resolve().then(entry.retry)
      try {
        await flight
        retained.delete(entry)
        const index = this.childCleanupFailures.indexOf(entry.error)
        if (index !== -1) this.childCleanupFailures.splice(index, 1)
      } finally { if (entry.flight === flight) delete entry.flight }
    }))
    if (retained.size === 0) this.childCleanupFailuresByParent.delete(agentId)
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'Colleague child cleanup failed.')
  }

  private async admitManagedInput(agentId: AgentId, agent: Agent, delivery: UserMessage, recall: UserMessage | undefined, source: WorkspaceActivitySource | undefined): Promise<UserMessage | undefined> {
    if (source === undefined) return recall
    if (delivery.source.kind !== 'agent-workspace-delivery' || delivery.source.workspaceId !== this.workspaceId) throw new Error('Managed delivery source is invalid.')
    const sourceEventId = delivery.source.sourceEventId
    const id = randomUUID() as CommunicationInputId
    const committed = await this.directory.updateRecord(this.workspaceId, record => {
      this.assertMemoryAdmissionAllowed()
      const context = record.communication.contexts[agentId]
      const scope = this.operations.getStore()
      if (scope !== undefined && (scope.contextGenerations[agentId] ?? 0) !== (context?.generation ?? 0)) throw new Error('Old colleague context cannot admit new model input.')
      if (context?.blockedBy !== undefined) throw new Error('Colleague context reset is not complete.')
      const invalid = getCommunicationInvalidation(record.aggregate, record.communication)
      const directEventId = source.kind === 'room' ? record.aggregate.events.find(event => event.id === sourceEventId)?.id : undefined
      if (source.kind === 'room' && (directEventId === undefined || invalid.eventIds.has(directEventId))) throw new Error('Withdrawn or missing room input cannot be delivered.')
      if (source.kind === 'task') {
        this.assertTaskDeliveryIdentity(record, agentId, agent, delivery, source)
        if (invalid.taskIds.has(source.taskId)) throw new Error('Withdrawn or missing work cannot be delivered.')
      }
      const snapshot = effectiveWorkspaceState(record.aggregate, record.communication)
      const prepared = prepareDeliveryMemory(snapshot, { session: agent.session, agentId, contextGeneration: context?.generation ?? 0,
        source, triggerEventId: sourceEventId, delivery, organization: { id: this.workspaceId, name: record.descriptor.label },
        facts: this.sceneFactCandidates(snapshot, agentId), limits: this.memoryLimits, historyContextCharacters: this.config.memoryContextCharacters })
      const recalledEventIds = [...prepared.eventIds]
      if (recalledEventIds.some(eventId => invalid.eventIds.has(eventId))) throw new Error('Withdrawn recall cannot be delivered.')
      const prior = Object.values(record.communication.inputs).filter(input => input.agentId === agentId && input.contextGeneration === (context?.generation ?? 0))
      const taskSource = source.kind === 'task' ? record.communication.taskSources[source.taskId] : undefined
      const input: CommunicationInput = { id, agentId, contextGeneration: context?.generation ?? 0, target: source.kind === 'room' ? { kind: 'room-input', eventId: directEventId! } : { kind: 'task', taskId: source.taskId },
        deliveryMessageId: delivery.id, ...(source.kind === 'task' ? { taskDeliveryAttemptId: source.attemptId } : {}),
        recordedAtSequence: record.aggregate.nextSequence - 1, directEventIds: directEventId !== undefined ? [directEventId] : taskSource === undefined ? [] : [taskSource.eventId], recalledEventIds, sessionEventIds: [...new Set(prior.flatMap(item => [...item.directEventIds, ...item.recalledEventIds, ...item.sessionEventIds]))] }
      return { record: { ...record, communication: { ...record.communication, revision: record.communication.revision + 1, inputs: { ...record.communication.inputs, [id]: input } } }, value: { input, prepared } }
    })
    this.assertMemoryAdmissionAllowed()
    this.managedInputs.set(agent, this.managedFileInput(agent, committed.value.input))
    const { input, prepared } = committed.value
    return this.memoryContextMessage(agentId, input, prepared)
  }

  private managedFileInput(agent: Agent, input: CommunicationInput): ManagedFileInput {
    const cwd = agent.session.header.cwd
    const fs = agent.ctx.get('fs') as { processPathFromHostPath(path: string): string | undefined } | undefined
    const policy = agent.ctx.get('sandboxPolicy') as { readonly workspaceRoot?: string } | undefined
    const hostLocal = cwd !== undefined && resolve(cwd) === resolve(this.workingDirectory) && fs?.processPathFromHostPath(cwd) === cwd && (policy?.workspaceRoot === undefined || resolve(policy.workspaceRoot) === resolve(cwd))
    return { inputId: input.id, agentId: input.agentId, generation: input.contextGeneration, cwd: cwd ?? this.workingDirectory, workspaceId: this.workspaceId, hostLocal }
  }

  private memoryContextMessage(agentId: AgentId, input: CommunicationInput, prepared: PreparedSceneMemory): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text: prepared.rendered }], source: {
      kind: 'agent-workspace-context', ...input,
      memoryReceipt: { version: 1, workspaceId: this.workspaceId, agentId, contextGeneration: input.contextGeneration, coverage: prepared.coverage },
    } })
  }

  private sceneFactCandidates(snapshot: WorkspaceState, agentId: AgentId): readonly MemoryFact[] {
    return this.memoryProcessor?.facts(snapshot, agentId) ?? []
  }

  /** Attach the domain owner's independently versioned audit and disposable projection. */
  configureMemoryProcessing(tables: { audit: MemoryTable<MemoryAudit>; projection: MemoryTable<MemoryProjection> }): void {
    if (this.memoryProcessor !== undefined) throw new Error('Memory processor is already configured')
    this.memoryProcessor = new MemoryProcessor({ ...tables, snapshot: () => this.effectiveSnapshot(), maxPending: this.config.memoryExtractionMaxPending,
      metadataTimeoutMs: this.config.memoryExtractionTimeoutMs,
      canCommit: () => !this.closing && !this.stopping && this.recallFlight === undefined,
      resolveParameters: async (route, signal) => {
        const llm = this.ctx.get('llm')
        if (llm === undefined) throw new Error('Memory extraction requires the llm service')
        return await resolveMemoryExtractionParameters(llm, route, this.config.memoryExtractionReasoningEffort, this.config.memoryExtractionMaxTokens, signal)
      },
      extract: async request => {
        const llm = this.ctx.get('llm')
        if (llm === undefined) throw new Error('Memory extraction requires the llm service')
        return await extractMemoryWithModel(llm, request, this.config.memoryExtractionTimeoutMs)
      } })
  }

  /** Personal read-only diagnostics; extraction state does not grant source eligibility. */
  memoryProcessingStatus(agentId: AgentId): { mode: 'disabled' | 'same-model-on-use'; available: boolean; retrieval: 'local-lexical'; sources: readonly MemoryProcessingProgress[]; facts: readonly MemoryFact[] } {
    const snapshot = this.effectiveSnapshot()
    return { mode: this.config.memoryExtractionMode, available: this.memoryProcessor !== undefined && this.ctx.get('llm') !== undefined,
      retrieval: 'local-lexical', sources: this.memoryProcessor?.progress(snapshot, agentId) ?? [], facts: this.sceneFactCandidates(snapshot, agentId) }
  }

  /** Wait for currently admitted auxiliary work, including its durable settlements. */
  async waitForMemoryProcessing(): Promise<void> { await this.memoryProcessor?.settled() }

  /** Schedule only personally valid fragments observed in the employee's actual model request. */
  observeMemoryRequest(agentId: AgentId, request: GenerateOptions): void {
    const processor = this.memoryProcessor
    if (processor === undefined || this.config.memoryExtractionMode !== 'same-model-on-use' || this.closing || this.stopping || this.recallFlight !== undefined) return
    const generation = this.directory.record(this.workspaceId).communication.contexts[agentId]?.generation ?? 0
    const fragments = requestMemoryFragments(this.effectiveSnapshot(), agentId, generation, request, this.config.memoryExtractionCharacters)
      .filter(fragment => !processor.has(fragment)).slice(0, this.config.memoryExtractionSourcesPerRequest)
    for (const fragment of fragments) void processor.process(fragment, { provider: request.provider, model: request.model,
      parameters: JSON.stringify({ maxTokens: this.config.memoryExtractionMaxTokens }) })
  }

  /** @param exec Actual first-party dispatch. @param next Remaining tool execution. @returns Original tool result with an attributed byte journal where supported. */
  async observeFileTool(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const input = exec.agent === undefined ? undefined : this.managedInputs.get(exec.agent)
    return input === undefined ? await next() : await observeWorkspaceFileTool(this.journal(), input, exec, next)
  }

  /** Attribute sources returned by a memory tool to the current managed turn and its next logged context. */
  async recordMemoryToolRead(agent: Agent, eventIds: readonly WorkspaceEventId[], rendered: string): Promise<UserMessage | undefined> {
    const managed = this.managedInputs.get(agent)
    if (managed === undefined) {
      if (this.pool?.agentIdFor(agent) !== undefined) throw new Error('Memory tool source has no managed input.')
      return undefined
    }
    if (eventIds.length === 0) return undefined
    if (rendered === '' || this.closing || this.stopping || this.recallFlight !== undefined) throw new Error('Memory tool result cannot be attributed to this turn.')
    const unique = [...new Set(eventIds)]
    const committed = await this.directory.updateRecord(this.workspaceId, record => {
      if (this.closing || this.stopping || this.recallFlight !== undefined || this.managedInputs.get(agent) !== managed) throw new Error('Memory tool result arrived after turn closure.')
      const input = record.communication.inputs[managed.inputId]
      const context = record.communication.contexts[managed.agentId]
      if (input === undefined || context?.blockedBy !== undefined || (context?.generation ?? 0) !== managed.generation || input.contextGeneration !== managed.generation) throw new Error('Memory tool context is unavailable.')
      const invalid = getCommunicationInvalidation(record.aggregate, record.communication)
      const snapshot = effectiveWorkspaceState(record.aggregate, record.communication)
      const owned = new Set(snapshot.memoryEntries.filter(entry => entry.agentId === managed.agentId).map(entry => entry.eventId))
      const present = new Set(snapshot.events.map(event => event.id))
      if (unique.some(id => invalid.eventIds.has(id) || !owned.has(id) || !present.has(id))) throw new Error('Memory tool source is unavailable.')
      const updated: CommunicationInput = { ...input, recordedAtSequence: record.aggregate.nextSequence - 1,
        recalledEventIds: [...new Set([...input.recalledEventIds, ...unique])] }
      return { record: { ...record, communication: { ...record.communication, revision: record.communication.revision + 1,
        inputs: { ...record.communication.inputs, [input.id]: updated } } }, value: updated }
    })
    return createUserMessage({ content: [{ type: 'text', text: `Memory tool sources: ${unique.join(', ')}` }],
      source: { kind: 'agent-workspace-context', ...committed.value } })
  }

  private journal(): FileCheckpointJournal {
    if (this.fileJournal !== undefined) return this.fileJournal
    this.fileJournal = new FileCheckpointJournal({ cwd: this.workingDirectory, workspaceId: this.workspaceId,
      blobDirectory: join(this.config.fileCheckpointDirectory, encodeURIComponent(this.workspaceId)), maxFileBytes: this.config.fileCheckpointMaxFileBytes, maxFiles: this.config.fileCheckpointMaxFiles, maxTotalBytes: this.config.fileCheckpointMaxTotalBytes,
      persistence: {
        snapshot: () => Object.values(this.directory.record(this.workspaceId).communication.fileCheckpoints),
        append: async value => (await this.directory.updateRecord(this.workspaceId, record => {
          const checkpoint = { ...value, order: record.communication.nextCheckpointOrder }
          return { record: { ...record, communication: { ...record.communication, revision: record.communication.revision + 1, nextCheckpointOrder: checkpoint.order + 1, fileCheckpoints: { ...record.communication.fileCheckpoints, [checkpoint.id]: checkpoint } } }, value: checkpoint }
        })).value,
        update: async (id, update) => {
          await this.directory.updateRecord(this.workspaceId, record => {
            const checkpoint = record.communication.fileCheckpoints[id]
            if (checkpoint === undefined) throw new Error('File checkpoint is missing.')
            return { record: { ...record, communication: { ...record.communication, revision: record.communication.revision + 1, fileCheckpoints: { ...record.communication.fileCheckpoints, [id]: { ...checkpoint, ...update } } } }, value: undefined }
          })
        },
        unavailable: async () => { /* No complete checkpoint exists; recall explicitly reports no automatic restoration for untracked effects. */ },
      },
    })
    return this.fileJournal
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
        const runtime = this
        agentCtx.on('llm/stream', async function* (request, next) {
          yield* next()
          runtime.observeMemoryRequest(agentId, request)
        })
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
