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
import { AgentId, HumanId, RoomId, TaskId, WorkspaceId } from './ids.ts'
import { WorkspaceDispatcher } from './dispatcher.ts'
import type { DispatcherLimits, SubagentRuntimeLike } from './dispatcher.ts'
import { assertWorkspaceInvariants } from './invariant.ts'
import { joinRoomWithMemory } from './memory.ts'
import { assertRoomMessageAuthorized, resolveHumanWakeTargets } from './room-policy.ts'
import { AGENT_WORKSPACE_RPC_CHANNEL, createWorkspaceRpcHandler } from './rpc.ts'
import type { WorkspaceDirectRoomResult, WorkspaceRoomRuntimeStatus, WorkspaceRuntimeStatus } from './rpc.ts'
import { EmployeeAgentPool } from './runtime.ts'
import type { AgentLifecycle, EmployeeBoundSessionDisposition, EmployeeMaterializationOptions } from './runtime.ts'
import { agentWorkspaceSpec } from './spec.ts'
import { createInitialState, mutateWorkspace } from './state.ts'
import { WorkspaceTurnStream } from './turn-stream.ts'
import type { WorkspaceTurnIdentity, WorkspaceTurnStreamSnapshot } from './turn-stream.ts'
import { WorkspaceTurnTracker } from './turn-tracker.ts'
import type { DeliveryOutcome } from './turn-tracker.ts'
import type { WorkspaceCommand, WorkspaceState } from './types.ts'

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
  private readonly trackers = new Map<AgentId, WorkspaceTurnTracker>()
  private readonly roomRuntime = new Map<RoomId, MutableRoomRuntimeStatus>()
  private readonly turnStream = new WorkspaceTurnStream()

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
      const initial = createInitialState(LOCAL_WORKSPACE_ID)
      assertWorkspaceInvariants(initial)
      await this.table.put(LOCAL_WORKSPACE_ID, initial)
      this.turnStream.setWorkspaceRevision(initial.revision)
    } else {
      assertWorkspaceInvariants(stored)
      this.turnStream.setWorkspaceRevision(stored.revision)
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
      const pool = new EmployeeAgentPool(
        agents,
        this,
        (agentId, mode) => this.employeeMaterializationOptions(agentId, mode),
      )
      const dispatcher = new WorkspaceDispatcher(
        this,
        () => this.ctx.get('subagents') as SubagentRuntimeLike | undefined,
        'spawn-in-process',
        DISPATCHER_LIMITS,
      )
      this.pool = pool
      this.dispatcher = dispatcher
      runtimeCtx.effect(() => async () => {
        if (this.pool === pool) this.pool = undefined
        if (this.dispatcher === dispatcher) this.dispatcher = undefined
        for (const agentId of this.trackers.keys()) this.trackers.delete(agentId)
        this.roomRuntime.clear()
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

  /** Current detached live-turn projection for Browser subscribers. */
  turnStreamSnapshot(): WorkspaceTurnStreamSnapshot {
    return this.turnStream.snapshot()
  }

  /** Wait until the live-turn projection advances beyond a version. */
  async waitForTurnStream(afterVersion: number, signal: AbortSignal): Promise<WorkspaceTurnStreamSnapshot> {
    return await this.turnStream.wait(afterVersion, signal)
  }

  /** Retire one transient turn after its durable room projection has converged. */
  retireWorkspaceTurn(turn: WorkspaceTurnIdentity, workspaceRevision: number): void {
    this.turnStream.retire(turn, workspaceRevision)
  }

  /** Open the stable direct room for one employed agent, creating it atomically when absent. */
  async openDirectRoom(agentId: AgentId): Promise<WorkspaceDirectRoomResult> {
    let resolvedRoomId: RoomId | undefined
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => {
      const agent = current.agents[agentId]
      if (agent === undefined) throw new Error(`agent '${agentId}' does not exist`)
      if (agent.employmentStatus !== 'employed') throw new Error(`agent '${agentId}' is departed and cannot be opened for direct chat`)

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
      assertWorkspaceInvariants(joined)
      resolvedRoomId = created.roomId
      return joined
    })
    if (resolvedRoomId === undefined) throw new Error(`failed to resolve direct room for agent '${agentId}'`)
    this.turnStream.setWorkspaceRevision(next.revision)
    return { state: structuredClone(next), roomId: resolvedRoomId }
  }

  /** Apply one command durably and return the detached committed aggregate. */
  async execute(command: WorkspaceCommand, settledTurn?: WorkspaceTurnIdentity): Promise<WorkspaceState> {
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => {
      if (command.type === 'room/message') {
        assertRoomMessageAuthorized(current, command.roomId, command.actor, command.mentions)
      }
      const changed = command.type === 'room/join'
        ? joinRoomWithMemory(current, command).state
        : mutateWorkspace(current, command).state
      assertWorkspaceInvariants(changed)
      return changed
    })

    if (settledTurn === undefined) this.turnStream.setWorkspaceRevision(next.revision)
    else this.turnStream.retire(settledTurn, next.revision)
    if (command.type === 'agent/depart') {
      await this.pool?.dispose(command.agentId)
    }
    return structuredClone(next)
  }

  /** Apply an arbitrary pure mutation durably and return the detached committed aggregate. */
  async apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState> {
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => {
      const changed = mutation(current)
      assertWorkspaceInvariants(changed)
      return changed
    })
    this.turnStream.setWorkspaceRevision(next.revision)
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
  async deliver(agentId: AgentId, delivery: UserMessage, recall?: UserMessage, roomId?: RoomId): Promise<DeliveryOutcome> {
    const handle = await this.ensureEmployee(agentId)
    const tracker = this.trackers.get(agentId)
    if (tracker === undefined) throw new Error(`agent '${agentId}' has no turn tracker`)
    const outcome = await tracker.deliver(handle.agent, delivery, recall, roomId)
    const sessions = this.ctx.get('sessions') as { flush(session: Session): Promise<boolean> } | undefined
    await sessions?.flush(handle.agent.session)
    return outcome
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

  /**
   * Record a human room message and acknowledge it immediately after the
   * durable write. The potentially long collaboration chain continues in the
   * Host and is exposed to the Browser through runtimeStatus().
   */
  async postHumanMessage(roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[]): Promise<WorkspaceState> {
    const targets = resolveHumanWakeTargets(this.snapshot(), roomId, mentions)
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
          stream: this.turnStream,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default AgentWorkspaceDomainService
