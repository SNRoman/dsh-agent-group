/**
 * Durable Agent Workspace domain service (`ctx.agentWorkspace`). Opens the
 * one-record agent-workspace domain, materializes the local aggregate on first
 * boot, and exposes detached snapshots plus serialized command execution. It
 * also assembles the employee runtime: a pool of long-lived DSH agents and the
 * per-agent turn trackers that correlate a delivery with its reply.
 * @module @dsh-agent-group/host
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { AgentId, HumanId, RoomId, TaskId, WorkspaceId } from './ids.ts'
import { WorkspaceDispatcher } from './dispatcher.ts'
import type { DispatcherLimits, SubagentRuntimeLike } from './dispatcher.ts'
import { EmployeeAgentPool } from './runtime.ts'
import type { AgentLifecycle } from './runtime.ts'
import { agentWorkspaceSpec } from './spec.ts'
import { createInitialState, mutateWorkspace } from './state.ts'
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
  private pool?: EmployeeAgentPool
  private dispatcher?: WorkspaceDispatcher
  private readonly trackers = new Map<AgentId, WorkspaceTurnTracker>()

  constructor(ctx: Context) {
    super(ctx, 'agentWorkspace')
  }

  /** Open the domain, materialize the local aggregate, and assemble the employee runtime. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentWorkspaceSpec)
    this.ctx.effect(() => () => domain.close(), 'agentWorkspace.domainClose')
    this.table = domain.table('workspaces')
    if (this.table.get(LOCAL_WORKSPACE_ID) === undefined) {
      await this.table.put(LOCAL_WORKSPACE_ID, createInitialState(LOCAL_WORKSPACE_ID))
    }
    const agents = this.ctx.get('agents') as AgentLifecycle | undefined
    const subagents = this.ctx.get('subagents') as SubagentRuntimeLike | undefined
    if (agents !== undefined && subagents !== undefined) {
      this.pool = new EmployeeAgentPool(agents, this, (agentId) => (agentCtx) => {
        const tracker = new WorkspaceTurnTracker()
        tracker.install(agentCtx)
        this.trackers.set(agentId, tracker)
        agentCtx.on('agent/disposed', () => {
          this.trackers.delete(agentId)
        })
      })
      this.dispatcher = new WorkspaceDispatcher(this, subagents, 'spawn-in-process', DISPATCHER_LIMITS)
      this.ctx.effect(() => async () => {
        await this.pool?.disposeAll()
      })
    }
  }

  /** A detached copy of the committed local aggregate. */
  snapshot(): WorkspaceState {
    const current = this.requireTable().get(LOCAL_WORKSPACE_ID)
    if (current === undefined) throw new Error('agent workspace aggregate is not initialized')
    return structuredClone(current)
  }

  /** Apply one command durably and return the detached committed aggregate. */
  async execute(command: WorkspaceCommand): Promise<WorkspaceState> {
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => mutateWorkspace(current, command).state)
    return structuredClone(next)
  }

  /** Apply an arbitrary pure mutation durably and return the detached committed aggregate. */
  async apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState> {
    const next = await this.requireTable().update(LOCAL_WORKSPACE_ID, current => mutation(current))
    return structuredClone(next)
  }

  /** The durable session id bound to an agent, or `undefined` when never materialized. */
  sessionIdFor(agentId: AgentId): SessionId | undefined {
    return this.snapshot().sessionBindings[agentId]
  }

  /** Durably record a freshly created session id for an agent. */
  async recordSessionId(agentId: AgentId, sessionId: SessionId): Promise<void> {
    await this.execute({ type: 'runtime/session-bound', agentId, sessionId })
  }

  /** Admit the live DSH handle for one employed agent, creating or resuming it once. */
  async ensureEmployee(agentId: AgentId): Promise<AgentHandle> {
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
  async deliver(agentId: AgentId, delivery: UserMessage, recall?: UserMessage): Promise<DeliveryOutcome> {
    const handle = await this.requirePool().ensure(agentId)
    const tracker = this.trackers.get(agentId)
    if (tracker === undefined) throw new Error(`agent '${agentId}' has no turn tracker`)
    const outcome = await tracker.deliver(handle.agent, delivery, recall)
    const sessions = this.ctx.get('sessions') as { flush(session: Session): Promise<boolean> } | undefined
    await sessions?.flush(handle.agent.session)
    return outcome
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceState> {
    if (this.table === undefined) throw new Error('agent workspace service is not started yet')
    return this.table
  }

  private requirePool(): EmployeeAgentPool {
    if (this.pool === undefined) throw new Error('agent workspace service is not started yet')
    return this.pool
  }

  private requireDispatcher(): WorkspaceDispatcher {
    if (this.dispatcher === undefined) throw new Error('agent workspace dispatcher is not available without the agent and subagent services')
    return this.dispatcher
  }

  /** Record a human room message and wake its explicitly mentioned agents. */
  async postHumanMessage(roomId: RoomId, humanId: HumanId, text: string, mentions: readonly AgentId[]): Promise<void> {
    await this.requireDispatcher().postHumanMessage(roomId, humanId, text, mentions)
  }

  /** Run one one-shot child for a parent agent and record its terminal result. */
  async runChild(parentAgentId: AgentId, taskId: TaskId, prompt: string): Promise<string> {
    return await this.requireDispatcher().runChild(parentAgentId, taskId, prompt)
  }
}

export default AgentWorkspaceDomainService
