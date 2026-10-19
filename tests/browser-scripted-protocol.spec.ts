import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId, type GenerateOptions, type LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema, validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply, protocolStep, taskIdentity, waitForObservedStop } from './fixtures/browser/scripted-llm.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HumanId, RoomId, TaskDeliveryAttemptId, WorkspaceEventId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { assignDelegatedTask, assignHumanTask, grantTaskDelegation } from '../packages/host/src/tasks.ts'
import { registerWorkspaceTaskTools, type WorkspaceTaskToolHost } from '../packages/host/src/task-tools.ts'
import { registerWorkspaceWorkflowTools } from '../packages/host/src/workflow-tools.ts'
import { workflowRuntime, publishEmployee, joinWorkflowChat } from './workflow-test-support.ts'

function adapter(): LlmAdapter {
  let registered: LlmAdapter | undefined
  apply({ llm: { registerAdapter: (_providers: string[], value: LlmAdapter) => { registered = value } } } as unknown as Context)
  if (registered === undefined) throw new Error('scripted adapter was not registered')
  return registered
}

function request(...texts: string[]): GenerateOptions {
  return {
    provider: 'agent-workspace-scripted', model: 'workspace-smoke', system: '身份是“Alice”',
    messages: texts.map(text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })),
  }
}

async function output(options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter().stream(options)) chunks.push(chunk)
  return chunks
}

describe('Browser scripted request protocol', () => {
  it('records the scripted employee proposal in its current delivered room without executing work', async () => {
    const fixture = await workflowRuntime()
    const employee = await publishEmployee(fixture.runtime, fixture.agentId)
    const roomId = await joinWorkflowChat(fixture.runtime, fixture.agentId)
    const tools: ToolDefinition[] = []
    const dispose = registerWorkspaceWorkflowTools({ register: tool => { tools.push(tool); return () => {} } }, () => fixture.runtime)
    const brief = { title: 'WF_EMPLOYEE_PROPOSAL', instructions: 'WF_EMPLOYEE_FULL_INSTRUCTIONS', expectedArtifacts: ['WF_EMPLOYEE_ARTIFACT'], acceptanceCriteria: ['WF_EMPLOYEE_CRITERION'] }
    try {
      const delivery = (deliveredRoomId: ReturnType<typeof RoomId>) => createUserMessage({ content: [{ type: 'text', text: 'WF_PROPOSE_REQUEST' }], source: {
        kind: 'agent-workspace-delivery', workspaceId: fixture.runtime.workspaceId, source: { kind: 'room', roomId: deliveredRoomId }, sourceEventId: WorkspaceEventId('request-event'),
      } })
      const options: GenerateOptions = { ...request('WF_PROPOSE_REQUEST'), sessionId: employee.agent.id, tools, messages: [delivery(RoomId('historical-room')), delivery(roomId)] }
      const chunk = (await output(options)).find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      if (chunk?.type !== 'block-end' || chunk.block.type !== 'tool-call') throw new Error('scripted proposal call is missing')
      expect(chunk.block.name).toBe('workspace_propose_task')
      const args: unknown = JSON.parse(chunk.block.arguments)
      const tool = tools.find(tool => tool.name === chunk.block.name)!
      assertObjectJsonSchema(tool.parameters)
      expect(validateJsonSchemaValue(tool.parameters, args)).toEqual([])
      expect(args).toEqual({ roomId, brief })
      const before = fixture.directory.record(fixture.runtime.workspaceId)
      await expect(tool.execute(args, { agent: employee.agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({ summary: brief.title, status: 'awaiting-human-confirmation' })
      const after = fixture.directory.record(fixture.runtime.workspaceId)
      const draft = Object.values(after.workflow.drafts)[0]!
      expect(draft).toMatchObject({ status: 'draft', brief, source: { type: 'employee', id: fixture.agentId } })
      expect(draft).not.toHaveProperty('taskId')
      const source = after.communication.draftSources[draft.id]!
      expect(source.roomId).toBe(roomId)
      expect(after.aggregate.events.find(event => event.id === source.eventId)).toMatchObject({ type: 'room/message', subjectId: roomId, actor: { type: 'agent', id: fixture.agentId }, text: brief.instructions, mentions: [] })
      for (const key of ['tasks', 'taskAssignments', 'delegationGrants', 'childRuns', 'sessionBindings'] as const) expect(after.aggregate[key]).toEqual(before.aggregate[key])
      options.messages.push(createToolResultMessage({ callId: ToolCallId('wf-propose-task'), content: [{ type: 'text', text: `Draft ${draft.id}: ${brief.title}\nAwaiting human confirmation.` }], isError: false }))
      expect((await output(options)).filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'WF_PROPOSAL_READY' }])
    } finally { dispose(); await employee.pool.disposeAll(); await fixture.runtime.dispose() }
  })

  it.each(['v020-safe-failure', 'v020-hold-tool', 'v020-delegate'] as const)('routes %s through the selected chat schema and delegation authority', async callId => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-delegation-protocol-'))
    const definition = mutateWorkspace(createInitialState(WorkspaceId('local')), { type: 'definition/create', name: 'Release engineer', description: 'Release', instructions: 'Run the fixture' })
    const alice = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
    const bob = mutateWorkspace(alice.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Bob' })
    const decoy = mutateWorkspace(bob.state, { type: 'room/create', kind: 'group', name: 'Task tools requirements' })
    const room = mutateWorkspace(decoy.state, { type: 'room/create', kind: 'group', name: 'Release room' })
    let state = room.state
    for (const agentId of [alice.agentId, bob.agentId]) state = mutateWorkspace(state, { type: 'room/join', roomId: room.roomId, agentId, memoryStart: { type: 'new-events' } }).state
    const held = callId === 'v020-hold-tool'
    const title = held ? 'V020_HOLD' : 'V020_ROOT V020_DELEGATE'
    const assigned = assignHumanTask(state, { humanId: HumanId('owner'), assigneeAgentId: alice.agentId, title })
    state = assigned.state
    const granted = callId === 'v020-delegate'
    if (granted) state = grantTaskDelegation(state, { humanId: HumanId('owner'), rootTaskId: assigned.taskId, granteeAgentId: alice.agentId }).state
    const caller = { id: SessionId('scripted-alice') } as Agent
    const host: WorkspaceTaskToolHost = {
      agentIdFor: agent => agent === caller ? alice.agentId : undefined,
      snapshot: () => structuredClone(state),
      apply: async mutation => { state = mutation(state); return structuredClone(state) },
      delegateTask: async (_agent, request) => {
        const changed = assignDelegatedTask(state, { ...request, actorAgentId: alice.agentId })
        state = changed.state
        return { taskId: changed.taskId, taskAssignmentId: changed.taskAssignmentId }
      },
      runAssignedTask: async () => 'peer result',
      runChild: async () => { throw new Error('delegation fixture must not run a child') },
    }
    const tools: ToolDefinition[] = []
    const dispose = registerWorkspaceTaskTools({ register: tool => { tools.push(tool); return () => {} } }, host)
    const gate = join(directory, 'browser-gate')
    try {
      vi.stubEnv('DSH_HOME', directory)
      vi.stubEnv('DSH_AGENT_GROUP_SMOKE_GATE', gate)
      vi.stubEnv('DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE', undefined)
      await mkdir(join(directory, 'storages'))
      await writeFile(join(directory, 'storages', 'agent_workspace.json'), JSON.stringify({ tables: { workspaces: { local: { aggregate: state } } } }), 'utf8')
      if (granted) await writeFile(`${gate}.denial-observed`, 'release\n', 'utf8')
      const options: GenerateOptions = {
        ...request(title), sessionId: caller.id, tools,
        messages: [createUserMessage({ content: [{ type: 'text', text: title }], source: {
          kind: 'agent-workspace-delivery', workspaceId: state.workspaceId,
          source: { kind: 'task', taskId: assigned.taskId }, sourceEventId: WorkspaceEventId('source-event'), taskDeliveryAttemptId: TaskDeliveryAttemptId('attempt'),
        } })],
      }
      if (granted) options.messages.push(createToolResultMessage({ callId: ToolCallId('v020-safe-failure'), content: [{ type: 'text', text: 'Workspace task request is not permitted.' }], isError: true }))
      const chunk = (await output(options)).find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      if (chunk?.type !== 'block-end' || chunk.block.type !== 'tool-call') throw new Error('scripted delegation call is missing')
      expect(chunk.block.id).toBe(callId)
      expect(chunk.block.name).toBe('workspace_delegate_task')
      const args: unknown = JSON.parse(chunk.block.arguments)
      const tool = tools.find(tool => tool.name === chunk.block.name)
      if (tool === undefined) throw new Error('workspace delegation tool is missing')
      assertObjectJsonSchema(tool.parameters)
      expect(validateJsonSchemaValue(tool.parameters, args)).toEqual([])
      expect(args).toEqual({ roomId: room.roomId, rootTaskId: assigned.taskId, assigneeAgentId: bob.agentId, title: granted ? 'V020_CHILD' : held ? 'V020_HOLD_SAFE_FAILURE' : 'V020_SAFE_FAILURE' })
      const before = structuredClone(state)
      const execution = tool.execute(args, { agent: caller, signal: new AbortController().signal, concludeTurn: () => {}, deferContext: () => {} } as never)
      if (granted) {
        await expect(execution).resolves.toMatchObject({ result: 'peer result' })
        expect(Object.values(state.tasks).find(task => task.title === 'V020_CHILD')?.rootTaskId).toBe(assigned.taskId)
      } else {
        await expect(execution).rejects.toMatchObject({ name: 'WorkspaceTaskToolError', code: 'WORKSPACE_TASK_POLICY_DENIED', message: 'Workspace task request is not permitted.' })
        expect(state).toEqual(before)
      }
    } finally {
      dispose()
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires the visible held-turn tool before starting the stop hold', async () => {
    const options = request('V020_HOLD')
    const held = { ...options, sessionId: 'session', messages: [{ ...options.messages[0], source: { kind: 'agent-workspace-delivery', source: { kind: 'task', taskId: 'held' }, taskDeliveryAttemptId: 'attempt' } }] } as unknown as GenerateOptions
    await expect(output(held)).rejects.toThrow('held turn requires workspace_delegate_task')
  })
  it('keeps an aborted provider pending until the Browser acknowledges Stopping and releases it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-stop-protocol-'))
    const path = join(directory, 'stop')
    const controller = new AbortController()
    const identity = { taskId: 'task', attemptId: 'attempt', sessionId: 'session', messageId: 'message' }
    let settled = false
    const pending = waitForObservedStop(path, controller.signal, identity).then(() => { settled = true }, () => { settled = true })
    try {
      controller.abort()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(JSON.parse(await readFile(`${path}.held`, 'utf8'))).toEqual(identity)
      expect(JSON.parse(await readFile(`${path}.abort-received`, 'utf8'))).toEqual(identity)
      await writeFile(`${path}.stopping-observed`, JSON.stringify(identity), 'utf8')
      await writeFile(path, 'release\n', 'utf8')
      await pending
      expect(settled).toBe(true)
      expect(JSON.parse(await readFile(`${path}.released`, 'utf8'))).toEqual(identity)
    } finally {
      await writeFile(`${path}.stopping-observed`, JSON.stringify(identity), 'utf8')
      await writeFile(path, 'release\n', 'utf8')
      await pending
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('does not carry the previous task step into another request in the same session', () => {
    const previous = request('V020_ROOT V020_DELEGATE')
    previous.messages.push(createToolResultMessage({ callId: ToolCallId('v020-safe-failure'), content: [{ type: 'text', text: 'denied' }], isError: true }))
    expect(protocolStep(previous, ['v020-safe-failure', 'v020-delegate'])).toBe(1)
    previous.messages.push(...request('V020_CHILD').messages)
    expect(protocolStep(previous, ['v020-child-run', 'v020-child-complete'])).toBe(0)
  })

  it('rejects tool results from a different protocol and a completed protocol', () => {
    const options = request('V020_CHILD')
    options.messages.push(createToolResultMessage({ callId: ToolCallId('v020-child-run'), content: [], isError: false }))
    expect(() => protocolStep(options, ['v020-safe-failure', 'v020-delegate'])).toThrow('unexpected tool result')
    expect(() => protocolStep(options, ['v020-child-run'])).toThrow('already completed')
  })

  it('rejects a task with no authoritative delivery identity', () => {
    expect(() => taskIdentity(request('V020_CHILD'))).toThrow('session, task and attempt identity')
  })
  it.each(['V020_DELEGATE', 'V020_CHILD', 'PROFILE_TASK_TOOLS_REQUEST', 'HOLD_WAKE'])('does not route a new room request using historical %s', async marker => {
    const chunks = await output(request(marker, '@Alice NAMED_WAKE'))
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'NAMED_REPLY Alice' }])
  })

  it('rejects a task marker without published task tools', async () => {
    await expect(output(request('V020_ROOT V020_DELEGATE'))).rejects.toThrow('workspace_delegate_task')
  })

  it('rejects an employee reply without employee identity', async () => {
    await expect(output({ ...request('NAMED_WAKE'), system: '' })).rejects.toThrow('employee identity')
  })

  it('reads employee identity from loop-built system history after the first turn', async () => {
    const options = request('NAMED_WAKE')
    options.messages.unshift(createSystemMessage('身份是“Alice”'))
    delete options.system
    const chunks = await output(options)
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'NAMED_REPLY Alice' }])
  })

  it('still uses history as evidence for an explicit memory check', async () => {
    const chunks = await output(request('MEMORY_SEED', 'V020_DELEGATE', 'CHECK_MEMORY'))
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'MEMORY_OK Alice' }])
  })
})
