import { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceRuntime } from '../packages/host/src/workspace-runtime.ts'
import { WorkspaceDirectory } from '../packages/host/src/workspace-directory.ts'
import { WorkspaceId } from '../packages/host/src/ids.ts'
import type { AgentId } from '../packages/host/src/ids.ts'
import type { StoredWorkspace } from '../packages/host/src/workspace-record.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import type { ResolvedConfig } from '../packages/host/src/index.ts'

export async function workflowRuntime(workspaceId = WorkspaceId('local')) {
  const rows = new Map<WorkspaceId, StoredWorkspace>([[workspaceId, { recordVersion: 2, descriptor: { id: workspaceId, label: 'Test organization', lifecycle: 'active' }, aggregate: createInitialState(workspaceId), workflow: createInitialWorkflowState() }]])
  let fail = false
  let beforeUpdate: (() => Promise<void>) | undefined
  let afterTransform: (() => void) | undefined
  const table: KvTable<WorkspaceId, StoredWorkspace> = {
    get: id => rows.get(id), entries: () => rows.entries(), keys: () => rows.keys(), get size() { return rows.size },
    put: async (id, value) => { if (fail) throw new Error('disk failed'); rows.set(id, structuredClone(value)) },
    delete: async id => rows.delete(id),
    update: async (id, fn) => { await beforeUpdate?.(); const next = fn(rows.get(id)!); afterTransform?.(); await table.put(id, next); return next },
  }
  const directory = new WorkspaceDirectory(table); await directory.initialize()
  let agentId!: AgentId
  await directory.updateAggregate(workspaceId, state => {
    const role = mutateWorkspace(state, { type: 'definition/create', name: 'Writer', description: '', instructions: 'Write' })
    const agent = mutateWorkspace(role.state, { type: 'agent/create', name: 'Alice', definitionId: role.definitionId! })
    agentId = agent.agentId!; return agent.state
  })
  const runtime = new WorkspaceRuntime(new Context(), AgentWorkspaceDomainService.Config({}) as ResolvedConfig, directory, workspaceId)
  return { runtime, directory, agentId, rows, table, fail: () => { fail = true }, beforeUpdate: (hook?: () => Promise<void>) => { beforeUpdate = hook }, afterTransform: (hook?: () => void) => { afterTransform = hook } }
}
export const brief = { title: 'Ship', instructions: 'Complete all details', expectedArtifacts: ['report'], acceptanceCriteria: ['Reviewed'] }
export async function joinWorkflowChat(runtime: WorkspaceRuntime, agentId: AgentId) {
  const room = mutateWorkspace(runtime.snapshot(), { type: 'room/create', kind: 'group', name: 'Work chat' })
  const joined = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId, memoryStart: { type: 'new-events' } })
  await runtime.directory.updateAggregate(runtime.workspaceId, () => joined.state)
  return room.roomId
}
export function expected(runtime: WorkspaceRuntime) { const snapshot = runtime.workflowSnapshot(); return { expectedAggregateRevision: snapshot.aggregateRevision, expectedWorkflowRevision: snapshot.workflow.revision } }
export async function publishEmployee(runtime: WorkspaceRuntime, agentId: AgentId, sessionId = 'employee') {
  const agent = { id: SessionId(sessionId), whenIdle: async () => {} } as Agent
  const pool = new EmployeeAgentPool({ create: async () => ({ agent, dispose: async () => {} }), resume: async () => ({ agent, dispose: async () => {} }) }, { sessionIdFor: () => undefined, recordSessionId: async () => {} })
  Object.assign(runtime, { pool }); await pool.ensure(agentId)
  return { agent, pool }
}
