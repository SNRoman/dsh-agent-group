/**
 * Durable Agent Workspace domain service (`ctx.agentWorkspace`). Opens the
 * one-record agent-workspace domain, materializes the local aggregate on first
 * boot, and exposes detached snapshots plus serialized command execution.
 * @module @dsh-agent-workspace/host
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from './ids.ts'
import { agentWorkspaceSpec } from './spec.ts'
import { createInitialState, mutateWorkspace } from './state.ts'
import type { WorkspaceCommand, WorkspaceState } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentWorkspace: AgentWorkspaceDomainService
  }
}

/** Key of the single local workspace record in the domain table. */
export const LOCAL_WORKSPACE_ID = WorkspaceId('local')

/**
 * Serialized, durable access to one local Workspace aggregate. Reads return
 * detached copies of committed state; {@link execute} applies one command
 * atomically and leaves the committed aggregate unchanged when the command is
 * invalid or the backend write fails.
 */
export class AgentWorkspaceDomainService extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<WorkspaceId, WorkspaceState>

  constructor(ctx: Context) {
    super(ctx, 'agentWorkspace')
  }

  /** Open the domain, materialize the local aggregate, and own the handle's lifecycle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentWorkspaceSpec)
    this.ctx.effect(() => () => domain.close(), 'agentWorkspace.domainClose')
    this.table = domain.table('workspaces')
    if (this.table.get(LOCAL_WORKSPACE_ID) === undefined) {
      await this.table.put(LOCAL_WORKSPACE_ID, createInitialState(LOCAL_WORKSPACE_ID))
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

  private requireTable(): KvTable<WorkspaceId, WorkspaceState> {
    if (this.table === undefined) throw new Error('agent workspace service is not started yet')
    return this.table
  }
}

export default AgentWorkspaceDomainService
