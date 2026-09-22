/**
 * Durable Agent Workspace domain service (`ctx.agentWorkspace`). Opens the
 * one-record agent-workspace domain, materializes the local aggregate on first
 * boot, and exposes detached snapshots plus serialized command execution. It
 * also assembles the employee runtime: a pool of long-lived DSH agents and the
 * per-agent turn trackers that correlate a delivery with its reply.
 * @module @dsh-agent-group/host
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceBusinessError } from './errors.ts'
import { AgentDefinitionId, AgentId, HumanId, RoomId, TaskId, WorkspaceId } from './ids.ts'
import type { DefinitionRevisionId } from './ids.ts'
import type { ChildRunId } from './ids.ts'
import { WorkspaceDispatcher } from './dispatcher.ts'
import type { DispatcherLimits, SubagentRuntimeLike, WorkspaceDispatcherHost } from './dispatcher.ts'
import { assertWorkspaceInvariants } from './invariant.ts'
import { joinRoomWithMemory } from './memory.ts'
import { queryAgentMemory } from './memory-query.ts'
import type { MemoryPage, MemoryQuery } from './memory-query.ts'
import { assertDirectRoomTextAllowed, assertRoomMessageAuthorized, resolveHumanWakeTargets } from './room-policy.ts'
import { AGENT_WORKSPACE_RPC_CHANNEL, createWorkspaceRpcHandler } from './rpc.ts'
import type { WorkspaceDirectRoomResult, WorkspaceMutationResult, WorkspaceRoomRuntimeStatus, WorkspaceRuntimeStatus } from './rpc.ts'
import { EmployeeAgentPool } from './runtime.ts'
import type { AgentLifecycle, EmployeeBoundSessionDisposition, EmployeeMaterializationOptions } from './runtime.ts'
import { agentWorkspaceSpec, workspaceStateSchema } from './spec.ts'
import { createInitialState, mutateWorkspace } from './state.ts'
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
import { registerWorkspaceTaskTools } from './task-tools.ts'
import type { WorkspaceToolRegistry } from './task-tools.ts'
import type { TaskDeliveryProgressEvent, WorkspaceCommand, WorkspaceState } from './types.ts'
import type { DelegationGrantId } from './ids.ts'
import { projectDefinitionHistory } from './definition-history.ts'
import type { DefinitionHistoryItem } from './definition-history.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentWorkspace: AgentWorkspaceDomainService
  }
}

/** Key of the single local workspace record in the domain table. */
export const LOCAL_WORKSPACE_ID = WorkspaceId('local')

/** MVP mention-chain and recall bounds fixed by the specification. */
const DISPATCHER_LIMITS: DispatcherLimits = { maxAgentHops: 3, maxRepliesPerRoot: 8, recallCharacterBudget: 4000 }

/** Host deployment settings. */
export interface Config {
  /** Registered DSH subagent provider used for one-shot child runs. */
  childProvider?: string
}

type ResolvedConfig = Required<Config>

/** Optional Host Connection shape used by the Browser adapter. */
interface WorkspaceHostConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
      options: { readonly authority: 'trusted-host' | 'loopback' },
    ): () => Promise<void>
  }
}

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
  inspect(sessionId: SessionId): Promise<{ readonly meta: { readonly cwd?: string } }>
}

/** Minimal DSH workspace-registry view used to hide plugin-owned sessions. */
interface DshWorkspaceRegistry {
  archiveSession(sessionId: SessionId): Promise<void>
}

/** Mutable internal counterpart of the public readonly runtime status. */
interface MutableRoomRuntimeStatus {
  pending: number
  error?: string
}

/**
 * Serialized, durable access to one local Workspace aggregate, plus the
 * employee runtime that gives each employed top-level agent one stable DSH
 * session. Reads return detached copies of committed state; {@link execute}
 * applies one command atomically and leaves the committed aggregate unchanged
 * when the command is invalid or the backend write fails.
 */
export class AgentWorkspaceDomainService extends Service {
  static inject = ['storageDomain']
  static Config: z<Config> = z.object({
    childProvider: z.string().default('spawn'),
  })

  private readonly config: ResolvedConfig
  private table?: KvTable<WorkspaceId, WorkspaceState>
  private pool: EmployeeAgentPool | undefined
  private dispatcher: WorkspaceDispatcher | undefined
  private taskDelivery: TaskDeliveryCoordinator | undefined
  private readonly trackers = new Map<AgentId, WorkspaceTurnTracker>()
  private readonly roomRuntime = new Map<RoomId, MutableRoomRuntimeStatus>()
  private readonly activityStream = new WorkspaceActivityStream()
  private readonly activityController = new WorkspaceActivityController(this.activityStream, {
    handleFor: agentId => this.pool?.handleFor(agentId),
  })
  private readonly childControllers = new ChildControllerRegistry(async request => {
    await this.apply(current => finishChildRun(current, request).state)
  })

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentWorkspace')
    this.config = config as ResolvedConfig
  }

  /** Open the domain, materialize the local aggregate, and assemble the employee runtime. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentWorkspaceSpec)
    this.ctx.effect(() => () => domain.close(), 'agentWorkspace.domainClose')
    this.table = domain.table('workspaces')
    const stored = this.table.get(LOCAL_WORKSPACE_ID)
    if (stored === undefined) {
      const initial = validateWorkspaceState(createInitialState(LOCAL_WORKSPACE_ID), LOCAL_WORKSPACE_ID)
      await this.table.put(LOCAL_WORKSPACE_ID, initial)
      this.syncActivityProjection(initial)
    } else {
      const validated = validateWorkspaceState(stored, LOCAL_WORKSPACE_ID)
      const repaired = repairOrphanedChildRuns(validated)
      if (repaired !== validated) await this.table.put(LOCAL_WORKSPACE_ID, repaired)
      this.syncActivityProjection(repaired)
    }

    // Browser transport is an optional child capability. Headless deployments
    // never wait for it, while web deployments register this plugin's own RPC
    // channel when Connection appears. No core /api endpoint is intercepted.
    this.ctx.inject(['connection'], (rpcCtx) => {
      const connection = rpcCtx.get('connection') as WorkspaceHostConnection | undefined
      if (connection === undefined) return
      rpcCtx.effect(
        () => connection.rpc.handle(
          AGENT_WORKSPACE_RPC_CHANNEL,
          createWorkspaceRpcHandler(this),
          { authority: 'trusted-host' },
        ),
        'agentWorkspace.rpc',
      )
    })

    this.ctx.inject(['tools'], (toolCtx) => {
      const tools = toolCtx.get('tools') as WorkspaceToolRegistry | undefined
      if (tools === undefined) return
      toolCtx.effect(
        () => registerWorkspaceTaskTools(tools, {
          agentIdFor: agent => this.agentIdFor(agent),
          snapshot: () => this.snapshot(),
          apply: async mutation => await this.apply(mutation),
          runAssignedTask: async (agentId, taskId) => await this.runAssignedTask(agentId, taskId),
          runChild: async (parentAgentId, taskId, prompt, signal) => await this.runChild(parentAgentId, taskId, prompt, signal),
        }),
        'agentWorkspace.taskTools',
      )
    })

    // Agent availability is dynamic: loader siblings mount concurrently, so a
    // one-time ctx.get('agents') sample can race startup and permanently leave
    // the workspace unable to wake anyone. The injected fiber follows the
    // service generation and tears down every retained employee when it leaves.
    this.ctx.inject(['agents'], (runtimeCtx) => {
      const agents = runtimeCtx.get('agents') as AgentLifecycle | undefined
      if (agents === undefined) return
      this.childControllers.openGeneration()
      const taskDelivery = new TaskDeliveryCoordinator({
        snapshot: () => this.snapshot(),
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
      }
      const dispatcher = new WorkspaceDispatcher(
        dispatcherHost,
        () => this.ctx.get('subagents') as SubagentRuntimeLike | undefined,
        this.config.childProvider,
        DISPATCHER_LIMITS,
        taskDelivery,
        this.childControllers,
      )
      this.pool = pool
      this.dispatcher = dispatcher
      this.taskDelivery = taskDelivery
      runtimeCtx.effect(() => async () => {
        if (this.pool === pool) this.pool = undefined
        if (this.dispatcher === dispatcher) this.dispatcher = undefined
        if (this.taskDelivery === taskDelivery) this.taskDelivery = undefined
        for (const agentId of this.trackers.keys()) this.trackers.delete(agentId)
        this.roomRuntime.clear()
        await this.childControllers.stopAll()
        await pool.disposeAll()
      }, 'agentWorkspace.employeeRuntime')
    })
  }

  /** A detached copy of the committed local aggregate. */
  snapshot(): WorkspaceState {
    const current = this.requireTable().get(LOCAL_WORKSPACE_ID)
    if (current === undefined) throw new Error('agent workspace aggregate is not initialized')
    return structuredClone(current)
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
  async acknowledgeAgentFailure(
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
  async stopActivity(
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
  async stopChildRun(
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
  async cancelTask(
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
      this.pool?.handleFor(assignment.assigneeAgentId)?.agent.inbox.remove(started.messageId)
    }
    for (const identity of active) this.activityController.stopActivity(identity)
    return committed
  }

  /** Assign one root task, then start its delivery only after the durable commit. */
  async assignTask(
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
    void delivery.deliver(committed.value.taskId).catch(() => {
      // The coordinator records display-safe delivery failure before rejecting.
    })
    return committed
  }

  /** Grant one employed assignee delegation authority after a revision check. */
  async grantTaskDelegation(
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
  async revokeTaskDelegation(
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
  async openDirectRoom(
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
    return await this.executeCommand(expectedRevision, command, undefined, signal)
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
    if (command.type === 'definition/revise' || command.type === 'definition/synchronize') {
      const selected = command.type === 'definition/revise' ? command.synchronizeAgentIds ?? [] : command.agentIds
      await Promise.all(selected.map(async agentId => {
        const agent = next.agents[agentId]
        if (agent?.employmentStatus !== 'employed' || this.pool?.handleFor(agentId) === undefined) return
        try {
          await this.pool.refreshRole(agentId, agent.definitionRevisionId)
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
  private async apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState> {
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
    const inspected = await persistence.inspect(sessionId)
    return inspected.meta.cwd === undefined ? 'replace' : 'resume'
  }

  /** Hide one plugin-owned employee Session from the ordinary DSH grouping UI. */
  async hideSession(sessionId: SessionId): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry') as DshWorkspaceRegistry | undefined
    await registry?.archiveSession(sessionId)
  }

  /** Admit the live DSH handle for one employed agent, creating or resuming it once. */
  async ensureEmployee(agentId: AgentId): Promise<AgentHandle> {
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
   * the delivery.
   */
  async deliver(
    agentId: AgentId,
    delivery: UserMessage,
    recall?: UserMessage,
    source?: WorkspaceActivitySource,
    hooks?: WorkspaceDeliveryHooks,
  ): Promise<WorkspaceTurnOutcome> {
    const pool = this.pool
    if (pool === undefined) {
      try {
        const handle = await this.ensureEmployee(agentId)
        const tracker = this.trackers.get(agentId)
        if (tracker === undefined) throw new Error(`agent '${agentId}' has no turn tracker`)
        hooks?.beforeAdmission?.()
        const outcome = await tracker.deliver(handle.agent, delivery, recall, source, hooks)
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
      const outcome = await tracker.deliver(handle.agent, delivery, recall, source, capturedHooks)
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
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => {
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
      return validateWorkspaceState(changed.state, LOCAL_WORKSPACE_ID)
    })
    if (!published) throw new Error('workspace mutation did not publish its result')
    this.syncActivityProjection(next)
    return structuredClone({ revision: next.revision, value })
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceState> {
    if (this.table === undefined) throw new Error('agent workspace service is not started yet')
    return this.table
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
  async postHumanMessage(
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
    void completion.then(
      () => this.finishRoomDispatch(roomId),
      error => this.finishRoomDispatch(roomId, error),
    )
    return { revision: committed.revision, value: committed.value.state }
  }

  /** Run one one-shot child for a parent agent and record its terminal result. */
  async runChild(parentAgentId: AgentId, taskId: TaskId, prompt: string, signal?: AbortSignal): Promise<string> {
    return await this.requireDispatcher().runChild(parentAgentId, taskId, prompt, signal)
  }

  /** Deliver one assigned task through the durable coordinator. */
  async runAssignedTask(agentId: AgentId, taskId: TaskId): Promise<string> {
    return await this.requireDispatcher().runAssignedTask(agentId, taskId)
  }

  /**
   * Retry one failed or interrupted delivery without creating another task.
   * @param taskId - Existing open task whose latest attempt is terminal.
   * @returns The complete terminal task text.
   */
  async retryTaskDelivery(
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
      setup: async (agentCtx) => {
        const scopedAgent = agentCtx.agent
        if (scopedAgent === undefined) throw new Error(`agent '${agentId}' setup has no scoped DSH agent`)
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
      `你在 Agent Workspace 中的身份是“${agent.name}”。`,
      `角色：${definition.name}`,
      revision.description.trim() === '' ? '' : `职责说明：\n${revision.description}`,
      revision.instructions.trim() === '' ? '' : `角色指令：\n${revision.instructions}`,
      '协作规则：你可以阅读当前房间提供的成员目录。如果需要其他成员继续处理，请使用目录里的准确显示名称进行 @，例如 @老周；不要输出内部 agent id。',
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

export default AgentWorkspaceDomainService
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
