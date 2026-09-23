/**
 * Long-lived DSH employee pool: one stable {@link AgentHandle} per employed
 * top-level agent, created or resumed once with single-flight admission, and
 * disposed when the agent departs.
 * @module @dsh-agent-group/host/runtime
 */

import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle, AgentOptions, AgentSetup, AgentSetupCommit, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentId, DefinitionRevisionId } from './ids.ts'

/** The agent lifecycle surface the pool drives (typically `ctx.agents`). */
export interface AgentLifecycle {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: { readonly resumeSessionId: SessionId; readonly agentOptions?: AgentOptions; readonly setup?: AgentSetup }): Promise<AgentHandle>
}

/** Explicit handling decision for an already-bound employee session. */
export type EmployeeBoundSessionDisposition = 'resume' | 'replace'

/** Durable source of an agent's materialized DSH session identity. */
export interface EmployeeSessionSource {
  /** The session id bound to this agent, or `undefined` when never materialized. */
  sessionIdFor(agentId: AgentId): SessionId | undefined
  /** Durably record a freshly created or migrated session id for this agent. */
  recordSessionId(agentId: AgentId, sessionId: SessionId): Promise<void>
  /**
   * Classify a known binding before admission. `replace` is an explicit
   * compatibility migration, never a fallback from a failed resume.
   */
  classifySession?(agentId: AgentId, sessionId: SessionId): Promise<EmployeeBoundSessionDisposition>
  /** Hide one internal employee session from ordinary DSH grouping surfaces. */
  hideSession?(sessionId: SessionId): Promise<void>
}

/** Runtime configuration prepared immediately before one create/resume. */
export interface EmployeeMaterializationOptions {
  readonly agentOptions?: AgentOptions
  readonly meta?: CreateAgentOptions['meta']
  readonly setup?: AgentSetup
  /** Definition revision installed in the employee's scoped role section. */
  readonly roleRevisionId?: DefinitionRevisionId
}

/** Prepare model, preset and scoped setup for one employee admission. */
export type EmployeeMaterializationOptionsFactory = (
  agentId: AgentId,
  mode: 'create' | 'resume',
) => EmployeeMaterializationOptions | Promise<EmployeeMaterializationOptions>

/**
 * Reconcile one resumed agent during unpublished setup.
 * @param agentId - Workspace employee whose persisted Session is resuming.
 * @param agent - Unpublished DSH agent with its restored inbox and Session.
 * @returns Fulfillment after durable delivery recovery completes.
 */
export type EmployeeRecovery = (agentId: AgentId, agent: Agent) => Promise<void>

/** Install one exact immutable role revision in an employee's scoped prompt. */
export type EmployeeRoleInstaller = (
  agentId: AgentId,
  revisionId: DefinitionRevisionId,
  agentCtx: Agent['ctx'],
) => () => void

interface EmployeeRoleContribution {
  readonly revisionId: DefinitionRevisionId
  readonly dispose: () => void
}

/**
 * Owns the live DSH handles for employed workspace agents. `ensure()` admits
 * one handle per agent (single-flight across concurrent calls), resuming a
 * compatible materialized session or explicitly rotating a binding classified
 * as incompatible. An ordinary resume failure never creates a replacement.
 * Departure invalidates any in-flight admission before disposing the resident
 * handle, so an async create cannot publish a stale handle after removal.
 */
export class EmployeeAgentPool {
  private readonly handles = new Map<AgentId, AgentHandle>()
  private readonly agentIds = new WeakMap<Agent, AgentId>()
  private readonly inFlight = new Map<AgentId, Promise<AgentHandle>>()
  private readonly generations = new Map<AgentId, number>()
  private readonly operations = new Map<AgentId, Promise<void>>()
  private readonly roles = new Map<AgentId, EmployeeRoleContribution>()
  private stopped = false

  constructor(
    private readonly agents: AgentLifecycle,
    private readonly source: EmployeeSessionSource,
    private readonly optionsFactory?: EmployeeMaterializationOptionsFactory,
    private readonly recover?: EmployeeRecovery,
    private readonly roleInstaller?: EmployeeRoleInstaller,
  ) {}

  /** The live handle for an agent, or `undefined` when not materialized. */
  handleFor(agentId: AgentId): AgentHandle | undefined {
    return this.handles.get(agentId)
  }

  /** Resolve a currently published employee handle without trusting caller data. */
  agentIdFor(agent: Agent): AgentId | undefined {
    return this.agentIds.get(agent)
  }

  /** Admit the live handle for one agent, creating or resuming it exactly once. */
  async ensure(agentId: AgentId): Promise<AgentHandle> {
    if (this.stopped) throw new Error('employee agent pool is disposed')
    const existing = this.handles.get(agentId)
    if (existing !== undefined) return existing
    const pending = this.inFlight.get(agentId)
    if (pending !== undefined) return pending

    const generation = this.generationOf(agentId)
    const promise = this.materialize(agentId, generation).then(async handle => {
      if (this.generationOf(agentId) !== generation) {
        try {
          await handle.dispose()
        } finally {
          throw new Error(`agent '${agentId}' admission was invalidated by disposal`)
        }
      }
      this.handles.set(agentId, handle)
      this.agentIds.set(handle.agent, agentId)
      return handle
    }).catch(error => {
      this.roles.delete(agentId)
      throw error
    })
    this.inFlight.set(agentId, promise)
    try {
      return await promise
    } finally {
      if (this.inFlight.get(agentId) === promise) this.inFlight.delete(agentId)
    }
  }

  /** Run one plugin-owned delivery in per-agent request order. */
  async runDelivery<T>(agentId: AgentId, delivery: (handle: AgentHandle) => Promise<T>): Promise<T> {
    return await this.serialize(agentId, async () => await delivery(await this.ensure(agentId)))
  }

  /**
   * Replace only the resident role section after all earlier work reaches idle.
   * Later plugin-owned deliveries remain queued until replacement settles.
   */
  async refreshRole(agentId: AgentId, revisionId: DefinitionRevisionId): Promise<void> {
    if (this.roleInstaller === undefined) throw new Error('employee role installer is not configured')
    await this.serialize(agentId, async () => {
      const generation = this.generationOf(agentId)
      const handle = this.handles.get(agentId)
      if (handle === undefined) throw new Error(`agent '${agentId}' is not resident`)
      try {
        await handle.agent.whenIdle()
        if (this.generationOf(agentId) !== generation || this.handles.get(agentId) !== handle) {
          throw new Error(`agent '${agentId}' role refresh was invalidated by disposal`)
        }
        await handle.agent.runMaintenance(async () => {
          if (this.generationOf(agentId) !== generation || this.handles.get(agentId) !== handle) {
            throw new Error(`agent '${agentId}' role refresh was invalidated by disposal`)
          }
          const prior = this.roles.get(agentId)
          if (prior?.revisionId === revisionId) return
          if (prior === undefined) {
            const dispose = this.roleInstaller!(agentId, revisionId, handle.agent.ctx)
            this.roles.set(agentId, { revisionId, dispose })
            return
          }
          prior.dispose()
          this.roles.delete(agentId)
          try {
            const dispose = this.roleInstaller!(agentId, revisionId, handle.agent.ctx)
            this.roles.set(agentId, { revisionId, dispose })
          } catch (replacementError) {
            try {
              const dispose = this.roleInstaller!(agentId, prior.revisionId, handle.agent.ctx)
              this.roles.set(agentId, { revisionId: prior.revisionId, dispose })
            } catch (rollbackError) {
              throw new AggregateError(
                [replacementError, rollbackError],
                `agent '${agentId}' role replacement and rollback both failed`,
              )
            }
            throw replacementError
          }
        })
      } catch (error) {
        await this.retireResident(agentId, handle)
        throw error
      }
    })
  }

  /** The exact role revision currently installed in a resident employee. */
  roleRevisionFor(agentId: AgentId): DefinitionRevisionId | undefined {
    return this.roles.get(agentId)?.revisionId
  }

  /** Dispose one agent's handle and invalidate any admission already in flight. */
  async dispose(agentId: AgentId): Promise<void> {
    this.generations.set(agentId, this.generationOf(agentId) + 1)
    const handle = this.handles.get(agentId)
    const pending = this.inFlight.get(agentId)
    this.handles.delete(agentId)
    this.roles.delete(agentId)
    if (handle !== undefined) this.agentIds.delete(handle.agent)

    let disposeError: unknown
    if (handle !== undefined) {
      try {
        await handle.dispose()
      } catch (error) {
        disposeError = error
      }
    }
    if (pending !== undefined) {
      try {
        await pending
      } catch {
        // The stale admission rejects after disposing its unpublished handle.
      }
    }
    if (disposeError !== undefined) throw disposeError
  }

  /** Dispose every live handle and invalidate every admission in flight. */
  async disposeAll(): Promise<void> {
    this.stopped = true
    const ids = new Set<AgentId>([...this.handles.keys(), ...this.inFlight.keys(), ...this.operations.keys()])
    for (const agentId of ids) this.generations.set(agentId, this.generationOf(agentId) + 1)

    const handles = [...this.handles.values()]
    const pending = [...this.inFlight.values()]
    const operations = [...this.operations.values()]
    for (const handle of handles) this.agentIds.delete(handle.agent)
    this.handles.clear()
    this.roles.clear()
    await Promise.allSettled([
      ...handles.map(handle => handle.dispose()),
      ...pending,
      ...operations,
    ])
  }

  private generationOf(agentId: AgentId): number {
    return this.generations.get(agentId) ?? 0
  }

  private async serialize<T>(agentId: AgentId, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error('employee agent pool is disposed')
    const generation = this.generationOf(agentId)
    const previous = this.operations.get(agentId) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(async () => {
      if (this.stopped || this.generationOf(agentId) !== generation) {
        throw new Error(`agent '${agentId}' operation was invalidated by disposal`)
      }
      return await operation()
    })
    const settled = result.then(() => {}, () => {})
    this.operations.set(agentId, settled)
    try {
      return await result
    } finally {
      if (this.operations.get(agentId) === settled) this.operations.delete(agentId)
    }
  }

  private async materialize(agentId: AgentId, generation: number): Promise<AgentHandle> {
    const bound = this.source.sessionIdFor(agentId)
    if (bound !== undefined) {
      const disposition = await this.source.classifySession?.(agentId, bound) ?? 'resume'
      this.assertAdmissionActive(agentId, generation)
      if (disposition === 'resume') {
        await this.source.hideSession?.(bound)
        this.assertAdmissionActive(agentId, generation)
        const options = await this.optionsFactory?.(agentId, 'resume')
        this.assertAdmissionActive(agentId, generation)
        // A compatible materialized session never falls back to create: a
        // resume failure remains a real persistence/runtime fault.
        const setup = this.resumeSetup(agentId, this.roleSetup(agentId, options))
        return await this.agents.resume({
          resumeSessionId: bound,
          ...(options?.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
          ...(setup === undefined ? {} : { setup }),
        })
      }
      // Replacement is intentional only after the source positively identifies
      // a known compatibility gap. Retire the visible legacy row before minting
      // the new internal identity.
      await this.source.hideSession?.(bound)
      this.assertAdmissionActive(agentId, generation)
    }
    return await this.createFresh(agentId, generation)
  }

  private roleSetup(agentId: AgentId, options: EmployeeMaterializationOptions | undefined): AgentSetup | undefined {
    const setup = options?.setup
    const revisionId = options?.roleRevisionId
    if (revisionId === undefined || this.roleInstaller === undefined) return setup
    return async (agentCtx, agent): Promise<AgentSetupCommit | void> => {
      const commit = await setup?.(agentCtx, agent)
      const dispose = this.roleInstaller!(agentId, revisionId, agentCtx)
      this.roles.set(agentId, { revisionId, dispose })
      return commit
    }
  }

  private resumeSetup(agentId: AgentId, setup: AgentSetup | undefined): AgentSetup | undefined {
    if (this.recover === undefined) return setup
    return async (agentCtx, agent): Promise<AgentSetupCommit | void> => {
      const commit = await setup?.(agentCtx, agent)
      await this.recover?.(agentId, agent)
      return commit
    }
  }

  private async createFresh(agentId: AgentId, generation: number): Promise<AgentHandle> {
    const sessionId = SessionId(randomUUID())
    const options = await this.optionsFactory?.(agentId, 'create')
    this.assertAdmissionActive(agentId, generation)
    const setup = this.roleSetup(agentId, options)
    const handle = await this.agents.create({
      sessionId,
      ...(options?.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
      ...(options?.meta === undefined ? {} : { meta: options.meta }),
      ...(setup === undefined ? {} : { setup }),
    })
    try {
      this.assertAdmissionActive(agentId, generation)
      // The created Session is already live when create() resolves, so the DSH
      // workspace registry can archive it before any Agent Workspace delivery
      // makes it a visible ordinary conversation.
      await this.source.hideSession?.(sessionId)
      this.assertAdmissionActive(agentId, generation)
      await this.source.recordSessionId(agentId, sessionId)
      this.assertAdmissionActive(agentId, generation)
    } catch (error) {
      await handle.dispose()
      throw error
    }
    return handle
  }

  private assertAdmissionActive(agentId: AgentId, generation: number): void {
    if (this.stopped || this.generationOf(agentId) !== generation) {
      throw new Error(`agent '${agentId}' admission was invalidated by disposal`)
    }
  }

  private async retireResident(agentId: AgentId, handle: AgentHandle): Promise<void> {
    if (this.handles.get(agentId) !== handle) return
    this.generations.set(agentId, this.generationOf(agentId) + 1)
    this.handles.delete(agentId)
    this.roles.delete(agentId)
    this.agentIds.delete(handle.agent)
    await handle.dispose()
  }
}
