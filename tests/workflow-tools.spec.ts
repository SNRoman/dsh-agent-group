import { expect, test } from 'vitest'
import { registerWorkspaceWorkflowTools } from '../packages/host/src/workflow-tools.ts'
import { workflowRuntime, publishEmployee, brief, joinWorkflowChat } from './workflow-test-support.ts'
import type { WorkspaceToolRegistry } from '../packages/host/src/task-tools.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mutateWorkspace } from '../packages/host/src/state.ts'
import { WorkspaceId } from '../packages/host/src/ids.ts'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as domainApply, Config as DomainConfig, inject as domainInject } from '@deepseek-ai/dsh-storage-domain'
import { apply as jsonApply, Config as JsonConfig, inject as jsonInject } from '@deepseek-ai/dsh-storage-json'
import AgentWorkspaceDomainService from '../packages/host/src/index.ts'
import { WorkspaceOperationId } from '../packages/host/src/workspace-record.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('proposal registration exposes no confirmation or grant tools and disposes its definition', () => {
  const names: string[] = []; const removed: string[] = []
  const dispose = registerWorkspaceWorkflowTools({ register: tool => { names.push(tool.name); return () => { removed.push(tool.name) } } }, () => undefined)
  expect(names).toEqual(['workspace_propose_task']); dispose(); dispose(); expect(removed).toEqual(names)
})

test('real registered proposal authenticates live objects and rejects forged, absent, revoked and departed callers', async () => {
  const fixture = await workflowRuntime(); const { runtime } = fixture
  const employee = await publishEmployee(runtime, fixture.agentId)
  const roomId = await joinWorkflowChat(runtime, fixture.agentId)
  let registered!: Parameters<WorkspaceToolRegistry['register']>[0]
  const remove = registerWorkspaceWorkflowTools({ register: tool => { registered = tool; return () => {} } }, caller => runtime.agentIdFor(caller) === undefined ? undefined : runtime)
  const exec = (agent?: Agent) => ({ agent, signal: new AbortController().signal }) as never
  try {
    const result = await registered.execute({ roomId, brief }, exec(employee.agent))
    expect(result).toEqual({ draftId: expect.any(String), summary: brief.title, status: 'awaiting-human-confirmation' })
    expect(Object.values(runtime.snapshot().tasks)).toHaveLength(0); expect(Object.values(runtime.snapshot().delegationGrants)).toHaveLength(0)
    expect(runtime.workflowSnapshot().workflow.facts[0]).toMatchObject({ actor: { type: 'employee', id: fixture.agentId } })
    await expect(registered.execute({ roomId, brief }, exec({ id: employee.agent.id } as Agent))).rejects.toThrow('active employee')
    await expect(registered.execute({ roomId, brief }, exec())).rejects.toThrow('active employee')
    for (const key of ['actor', 'workspaceId', 'occurredAt', 'source', 'operationId', 'expectedAggregateRevision', 'expectedWorkflowRevision']) await expect(registered.execute({ roomId, brief, [key]: 'forged' }, exec(employee.agent))).rejects.toThrow()
    await fixture.directory.updateAggregate(runtime.workspaceId, state => mutateWorkspace(state, { type: 'agent/depart', agentId: fixture.agentId }).state)
    await expect(registered.execute({ roomId, brief }, exec(employee.agent))).rejects.toThrow('active employee')
    await employee.pool.dispose(fixture.agentId)
    await expect(registered.execute({ roomId, brief }, exec(employee.agent))).rejects.toThrow('active employee')
    expect(runtime.directory.record(runtime.workspaceId).workflow.facts).toHaveLength(1)
  } finally { remove(); await employee.pool.disposeAll() }
})

test('same employee IDs in different organizations resolve only the actual pool owner', async () => {
  const first = await workflowRuntime(WorkspaceId('org-one')); const second = await workflowRuntime(WorkspaceId('org-two'))
  expect(first.agentId).toBe(second.agentId)
  const one = await publishEmployee(first.runtime, first.agentId, 'one'); const two = await publishEmployee(second.runtime, second.agentId, 'two')
  const roomId = await joinWorkflowChat(first.runtime, first.agentId)
  let registered!: Parameters<WorkspaceToolRegistry['register']>[0]
  const remove = registerWorkspaceWorkflowTools({ register: tool => { registered = tool; return () => {} } }, agent => [first.runtime, second.runtime].find(runtime => runtime.agentIdFor(agent) !== undefined))
  try {
    await registered.execute({ roomId, brief }, { agent: one.agent, signal: new AbortController().signal } as never)
    expect(first.runtime.workflowSnapshot().workflow.revision).toBe(1); expect(second.runtime.workflowSnapshot().workflow.revision).toBe(0)
    await expect(second.runtime.proposeTask(one.agent, { roomId, brief })).rejects.toThrow('active employee')
  } finally { remove(); await one.pool.disposeAll(); await two.pool.disposeAll() }
})

test('root service registers proposal under effects and resolves the actual employee organization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-tools-')); const ctx = new Context()
  const definitions = new Map<string, Parameters<WorkspaceToolRegistry['register']>[0]>()
  const fibers: Array<{ dispose(): Promise<void> }> = []
  try {
    fibers.push(await ctx.plugin(Storage))
    fibers.push(await ctx.plugin({ apply: jsonApply, Config: JsonConfig, inject: jsonInject }, { root }))
    fibers.push(await ctx.plugin({ apply: domainApply, Config: DomainConfig, inject: domainInject }, { backend: 'json' }))
    fibers.push(await ctx.plugin(toolCtx => { toolCtx.provide('tools', { register: (tool: Parameters<WorkspaceToolRegistry['register']>[0]) => { definitions.set(tool.name, tool); return () => { definitions.delete(tool.name) } } } as never) }))
    const host = await ctx.plugin(AgentWorkspaceDomainService); fibers.push(host)
    const one = ctx.agentWorkspace.forWorkspace(WorkspaceId('local'))
    const organization = await ctx.agentWorkspace.createOrganization(WorkspaceOperationId('other'), 'Other')
    const two = ctx.agentWorkspace.forWorkspace(organization.descriptor.id)
    const employeeIds = []
    for (const runtime of [one, two]) {
      await runtime.execute(runtime.snapshot().revision, { type: 'definition/create', name: 'Writer', description: '', instructions: 'Write' })
      await runtime.execute(runtime.snapshot().revision, { type: 'agent/create', definitionId: Object.values(runtime.snapshot().definitions)[0]!.id, name: 'Alice' })
      employeeIds.push(Object.values(runtime.snapshot().agents)[0]!.id)
    }
    expect(employeeIds[0]).toBe(employeeIds[1])
    const employee = await publishEmployee(two, employeeIds[1]!, 'scoped-session')
    const roomId = await joinWorkflowChat(two, employeeIds[1]!)
    const tool = definitions.get('workspace_propose_task')!
    expect(tool).toBeDefined()
    expect(await tool.execute({ roomId, brief }, { agent: employee.agent, signal: new AbortController().signal } as never)).toEqual({ draftId: expect.any(String), summary: brief.title, status: 'awaiting-human-confirmation' })
    expect(one.workflowSnapshot().workflow.revision).toBe(0); expect(two.workflowSnapshot().workflow.revision).toBe(1)
    await host.dispose(); fibers.pop(); expect(definitions.has('workspace_propose_task')).toBe(false)
  } finally { for (const fiber of fibers.toReversed()) await fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('proposal tool bounds its summary with the configured text budget while persisting the full brief', async () => {
  const fixture = await workflowRuntime(); const employee = await publishEmployee(fixture.runtime, fixture.agentId)
  const roomId = await joinWorkflowChat(fixture.runtime, fixture.agentId)
  let registered!: Parameters<WorkspaceToolRegistry['register']>[0]
  const remove = registerWorkspaceWorkflowTools({ register: tool => { registered = tool; return () => {} } }, () => fixture.runtime)
  try {
    const full = { ...brief, title: 'x'.repeat(5000) }
    const result = await registered.execute({ roomId, brief: full }, { agent: employee.agent, signal: new AbortController().signal } as never) as { draftId: string; summary: string; status: string }
    expect(result.summary).toHaveLength(4000)
    expect(Object.values(fixture.runtime.workflowSnapshot().workflow.drafts)[0]!.brief.title).toBe(full.title)
    expect(Object.keys(result)).toEqual(['draftId', 'summary', 'status'])
  } finally { remove(); await employee.pool.disposeAll() }
})
