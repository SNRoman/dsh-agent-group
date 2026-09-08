/**
 * Durable Agent Workspace domain service (`ctx.agentWorkspace`). Opens the
 * one-record agent-workspace domain, materializes the local aggregate on first
 * boot, and exposes detached snapshots plus serialized command execution. It
 * also assembles the employee runtime: a pool of long-lived DSH agents and the
 * per-agent turn trackers that correlate a delivery with its reply.
 * @module @dsh-agent-group/host
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceBusinessError } from './errors.ts'
import { AgentId, HumanId, RoomId, TaskId, WorkspaceId } from './ids.ts'
import type { ChildRunId } from './ids.ts'
import { WorkspaceDispatcher } from './dispatcher.ts'
import type { DispatcherLimits, SubagentRuntimeLike } from './dispatcher.ts'
import { assertWorkspaceInvariants } from './invariant.ts'
import { joinRoomWithMemory } from './memory.ts'
import { assertDirectRoomTextAllowed, assertRoomMessageAuthorized, resolveHumanWakeTargets } from './room-policy.ts'
import { AGENT_WORKSPACE_RPC_CHANNEL, createWorkspaceRpcHandler } from './rpc.ts'
import type { WorkspaceDirectRoomResult, WorkspaceRoomRuntimeStatus, WorkspaceRuntimeStatus } from './rpc.ts'
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
import { cancelTask as cancelWorkspaceTask } from './tasks.ts'
import type { CancelTaskResult } from './tasks.ts'
import { inspectTaskDelivery } from './task-delivery.ts'
import { TaskDeliveryCoordinator } from './task-delivery-coordinator.ts'
import type { WorkspaceDeliveryHooks } from './task-delivery-coordinator.ts'
import type { TaskDeliveryProgressEvent, WorkspaceCommand, WorkspaceState } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentWorkspace: AgentWorkspaceDomainService
  }
}

/** Key of the single local workspace record in the domain table. */
export const LOCAL_WORKSPACE_ID = WorkspaceId('local')

/** MVP mention-chain and recall bounds fixed by the specification. */
const DISPATCHER_LIMITS: DispatcherLimits = { maxAgentHops: 3, maxRepliesPerRoot: 8, recallCharacterBudget: 4000 }

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

  constructor(ctx: Context) {
    super(ctx, 'agentWorkspace')
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

    // Agent availability is dynamic: loader siblings mount concurrently, so a
    // one-time ctx.get('agents') sample can race startup and permanently leave
    // the workspace unable to wake anyone. The injected fiber follows the
    // service generation and tears down every retained employee when it leaves.
    this.ctx.inject(['agents'], (runtimeCtx) => {
      const agents = runtimeCtx.get('agents') as AgentLifecycle | undefined
      if (agents === undefined) return
      const taskDelivery = new TaskDeliveryCoordinator(this)
      const pool = new EmployeeAgentPool(
        agents,
        this,
        (agentId, mode) => this.employeeMaterializationOptions(agentId, mode),
        async (agentId, agent) => {
          await taskDelivery.recoverAgent(agentId, { agent })
        },
      )
      const dispatcher = new WorkspaceDispatcher(
        this,
        () => this.ctx.get('subagents') as SubagentRuntimeLike | undefined,
        'spawn-in-process',
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
  acknowledgeAgentFailure(agentId: AgentId): void {
    this.activityStream.acknowledgeAgentFailure(agentId)
  }

  /**
   * Stop one exact claimed Workspace turn.
   * @param identity - Complete activity, employee, message, Session, and turn identity.
   * @returns Whether this call started stopping, repeated it, or found no exact activity.
   */
  stopActivity(identity: WorkspaceActivityIdentity): WorkspaceStopResult {
    return this.activityController.stopActivity(identity)
  }

  /**
   * Stop one exact process-local child run and persist its cancellation.
   * @param childRunId - Durable child identity to stop.
   * @returns Whether this call started stopping, repeated it, or found no live controller.
   */
  async stopChildRun(childRunId: ChildRunId): Promise<WorkspaceStopResult> {
    return await this.childControllers.stopChildRun(childRunId)
  }

  /**
   * Cancel a task durably, then clean up only work named by that mutation.
   * @param humanId - Human requesting the cancellation.
   * @param taskId - Root or derived task to cancel.
   * @returns The state after exact queued, active, and child cleanup converges.
   */
  async cancelTask(humanId: HumanId, taskId: TaskId): Promise<WorkspaceState> {
    let cancellation: CancelTaskResult | undefined
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => {
      const changed = cancelWorkspaceTask(current, { humanId, taskId })
      cancellation = changed
      return validateWorkspaceState(changed.state, LOCAL_WORKSPACE_ID)
    })
    this.syncActivityProjection(next)
    if (cancellation === undefined) throw new Error(`task '${taskId}' cancellation did not publish its affected work`)

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
    for (const identity of active) this.stopActivity(identity)
    for (const childRunId of cancellation.runningChildRunIds) await this.stopChildRun(childRunId)
    return this.snapshot()
  }

  /** Open the stable direct room for one employed agent, creating it atomically when absent. */
  async openDirectRoom(agentId: AgentId): Promise<WorkspaceDirectRoomResult> {
    let resolvedRoomId: RoomId | undefined
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => {
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
        return current
      }

      const created = mutateWorkspace(current, { type: 'room/create', kind: 'direct' })
      const joined = joinRoomWithMemory(created.state, {
        type: 'room/join',
        roomId: created.roomId,
        agentId,
        memoryStart: { type: 'new-events' },
      }).state
      resolvedRoomId = created.roomId
      return validateWorkspaceState(joined, LOCAL_WORKSPACE_ID)
    })
    if (resolvedRoomId === undefined) throw new Error(`failed to resolve direct room for agent '${agentId}'`)
    this.syncActivityProjection(next)
    return { state: structuredClone(next), roomId: resolvedRoomId }
  }

  /** Apply one command durably and return the detached committed aggregate. */
  async execute(command: WorkspaceCommand, settledActivity?: WorkspaceActivityIdentity): Promise<WorkspaceState> {
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => {
      if (command.type === 'room/message') {
        assertRoomMessageAuthorized(current, command.roomId, command.actor, command.mentions)
      }
      const changed = command.type === 'room/join'
        ? joinRoomWithMemory(current, command).state
        : mutateWorkspace(current, command).state
      return validateWorkspaceState(changed, LOCAL_WORKSPACE_ID)
    })

    this.syncActivityProjection(next)
    if (settledActivity !== undefined) this.activityStream.retire(settledActivity, next.revision)
    if (command.type === 'agent/depart') {
      await this.pool?.dispose(command.agentId)
    }
    return structuredClone(next)
  }

  /** Apply an arbitrary pure mutation durably and return the detached committed aggregate. */
  async apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState> {
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => {
      const changed = mutation(current)
      return validateWorkspaceState(changed, LOCAL_WORKSPACE_ID)
    })
    this.syncActivityProjection(next)
    return structuredClone(next)
  }

  /** The durable session id bound to an agent, or `undefined` when never materialized. */
  sessionIdFor(agentId: AgentId): SessionId | undefined {
    return this.snapshot().sessionBindings[agentId]
  }

  /** Durably record a freshly created or migrated session id for an agent. */
  async recordSessionId(agentId: AgentId, sessionId: SessionId): Promise<void> {
    await this.execute({ type: 'runtime/session-bound', agentId, sessionId })
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
    let handle: AgentHandle
    try {
      handle = await this.ensureEmployee(agentId)
    } catch (error) {
      this.activityStream.recordAgentFailureIfAbsent(agentId, {
        code: 'agent-materialization-failed',
        summary: 'Agent could not be started.',
      })
      throw error
    }
    const tracker = this.trackers.get(agentId)
    if (tracker === undefined) throw new Error(`agent '${agentId}' has no turn tracker`)
    const outcome = await tracker.deliver(handle.agent, delivery, recall, source, hooks)
    await this.flushEmployeeSession(agentId, handle.agent.session)
    return outcome
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
    const outcome = await tracker.recover(handle.agent, delivery, source, hooks)
    await this.flushEmployeeSession(agentId, handle.agent.session)
    return outcome
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
  async postHumanMessage(roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[]): Promise<WorkspaceState> {
    const snapshot = this.snapshot()
    if (snapshot.rooms[roomId]?.kind === 'direct') assertDirectRoomTextAllowed(roomId, text)
    const targets = resolveHumanWakeTargets(snapshot, roomId, mentions)
    const started = await this.requireDispatcher().startHumanMessage(roomId, humanId, text, targets)
    if (targets.length === 0) return started.state
    this.beginRoomDispatch(roomId)
    void started.completion.then(
      () => this.finishRoomDispatch(roomId),
      error => this.finishRoomDispatch(roomId, error),
    )
    return started.state
  }

  /** Run one one-shot child for a parent agent and record its terminal result. */
  async runChild(parentAgentId: AgentId, taskId: TaskId, prompt: string, signal?: AbortSignal): Promise<string> {
    return await this.requireDispatcher().runChild(parentAgentId, taskId, prompt, signal)
  }

  /**
   * Retry one failed or interrupted delivery without creating another task.
   * @param taskId - Existing open task whose latest attempt is terminal.
   * @returns The complete terminal task text.
   */
  async retryTaskDelivery(taskId: TaskId): Promise<string> {
    return await this.requireTaskDelivery().retryTaskDelivery(taskId)
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
        this.installWorkspaceRole(agentCtx, agentId)

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
  private installWorkspaceRole(agentCtx: Context, agentId: AgentId): void {
    const state = this.snapshot()
    const agent = state.agents[agentId]
    if (agent === undefined) throw new Error(`agent '${agentId}' disappeared before role setup`)
    const definition = state.definitions[agent.definitionId]
    const revision = state.definitionRevisions[agent.definitionRevisionId]
    if (definition === undefined || revision === undefined) {
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
    systemPrompt.section({ name: 'agent-workspace:role', order: 10, text })
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
