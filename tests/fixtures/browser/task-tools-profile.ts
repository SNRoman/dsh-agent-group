/** Profile-only human-task seed for the real task-tool release smoke. */

import { access, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentWorkspaceDomainService } from '../../../packages/host/src/index.ts'
import { HumanId } from '../../../packages/host/src/ids.ts'
import { assignHumanTask } from '../../../packages/host/src/tasks.ts'
import type { WorkspaceCommand, WorkspaceState } from '../../../packages/host/src/types.ts'

const TASK_TOOLS_REQUEST = 'PROFILE_TASK_TOOLS_REQUEST'
const SCRIPTED_LLM_READY_TIMEOUT_MS = 30_000

export const name = 'agent-workspace-task-tools-profile'
export const inject = ['agentWorkspace', 'agents', 'tools']

/** Seed one human-owned task after the loaded Host and its tool registry are available. */
export async function apply(ctx: Context): Promise<void> {
  const fixturePath = requireTaskToolsFixturePath()
  await waitForScriptedLlmAdapter(fixturePath)
  const service = ctx.agentWorkspace as AgentWorkspaceDomainService
  const seed = service as unknown as {
    executeInternal(command: WorkspaceCommand): Promise<WorkspaceState>
    apply(mutation: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState>
  }
  await seed.executeInternal({
    type: 'definition/create',
    name: 'Task tools profile engineer',
    description: 'Executes the deterministic task tools smoke scenario.',
    instructions: 'Use the requested task tool and return its result.',
  })
  const definition = Object.values(service.snapshot().definitions).find(item => item.name === 'Task tools profile engineer')
  if (definition === undefined) throw new Error('profile task-tools definition was not created')
  await seed.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Task tools Alice' })
  await seed.executeInternal({ type: 'agent/create', definitionId: definition.id, name: 'Task tools Bob' })
  const state = service.snapshot()
  const alice = Object.values(state.agents).find(agent => agent.name === 'Task tools Alice')
  const bob = Object.values(state.agents).find(agent => agent.name === 'Task tools Bob')
  if (alice === undefined || bob === undefined) throw new Error('profile task-tools employees were not created')
  const assigned = assignHumanTask(state, {
    humanId: HumanId('profile-task-human'),
    assigneeAgentId: alice.id,
    title: TASK_TOOLS_REQUEST,
  })
  await seed.apply(() => assigned.state)
  await writeFile(fixturePath, `${JSON.stringify({ taskId: assigned.taskId, deniedAssigneeAgentId: bob.id })}\n`, 'utf8')
  const result = await service.runAssignedTask(alice.id, assigned.taskId)
  if (result !== 'PROFILE_TASK_TOOL_RESULT') throw new Error('profile task tool completion did not settle the assigned task')
}

function requireTaskToolsFixturePath(): string {
  const fixturePath = process.env['DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE']
  if (fixturePath === undefined) throw new Error('DSH_AGENT_GROUP_TASK_TOOLS_FIXTURE is required for profile task tools')
  return fixturePath
}

function scriptedReadyPath(fixturePath: string): string {
  return `${fixturePath}.scripted-llm-ready`
}

async function waitForScriptedLlmAdapter(fixturePath: string): Promise<void> {
  const readyPath = scriptedReadyPath(fixturePath)
  const deadline = Date.now() + SCRIPTED_LLM_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      await access(readyPath)
      return
    } catch (error) {
      if (!isMissingFile(error)) throw error
      if (Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw new Error('profile task-tools seed timed out waiting for the scripted LLM adapter')
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
