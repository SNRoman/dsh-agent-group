/** Profile-only human-task seed for the real task-tool release smoke. */

import { access, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceRuntime } from '../../../packages/host/src/workspace-runtime.ts'
import { HumanId, WorkspaceId } from '../../../packages/host/src/ids.ts'
import { applyChatWork } from '../../../packages/host/src/chat-work.ts'
import { applyWorkflowCommand } from '../../../packages/host/src/workflow.ts'

const TASK_TOOLS_REQUEST = 'PROFILE_TASK_TOOLS_REQUEST 请核对 UTF-8 导出需求并完成任务。'
const MEMORY_REQUIREMENT = '导出要求：CSV 使用 UTF-8 编码，保留中文标题，不添加 BOM。'
const SCRIPTED_LLM_READY_TIMEOUT_MS = 30_000

export const name = 'agent-workspace-task-tools-profile'
export const inject = ['agentWorkspace', 'agents', 'tools']

/** Seed one human-owned task after the loaded Host and its tool registry are available. */
export async function apply(ctx: Context): Promise<void> {
  const fixturePath = requireTaskToolsFixturePath()
  await waitForScriptedLlmAdapter(fixturePath)
  const service: WorkspaceRuntime = ctx.agentWorkspace.forWorkspace(WorkspaceId('local'))
  await service.execute(service.snapshot().revision, {
    type: 'definition/create',
    name: 'Task tools profile engineer',
    description: 'Executes the deterministic task tools smoke scenario.',
    instructions: 'Use the requested task tool and return its result.',
  })
  const definition = Object.values(service.snapshot().definitions).find(item => item.name === 'Task tools profile engineer')
  if (definition === undefined) throw new Error('profile task-tools definition was not created')
  await service.execute(service.snapshot().revision, { type: 'agent/create', definitionId: definition.id, name: 'Task tools Alice' })
  await service.execute(service.snapshot().revision, { type: 'agent/create', definitionId: definition.id, name: 'Task tools Bob' })
  const state = service.snapshot()
  const alice = Object.values(state.agents).find(agent => agent.name === 'Task tools Alice')
  const bob = Object.values(state.agents).find(agent => agent.name === 'Task tools Bob')
  if (alice === undefined || bob === undefined) throw new Error('profile task-tools employees were not created')
  await service.execute(service.snapshot().revision, { type: 'room/create', kind: 'group', name: 'Task tools requirements' })
  const room = Object.values(service.snapshot().rooms).find(item => item.name === 'Task tools requirements')
  if (room === undefined) throw new Error('profile task-tools requirements room was not created')
  for (const agent of [alice, bob]) {
    await service.execute(service.snapshot().revision, { type: 'room/join', roomId: room.id, agentId: agent.id, memoryStart: { type: 'new-events' } })
  }
  await service.postHumanMessage(service.snapshot().revision, room.id, HumanId('profile-task-human'), MEMORY_REQUIREMENT, [])
  const remembered = service.snapshot()
  const requirement = remembered.events.find(event => event.type === 'room/message' && event.text === MEMORY_REQUIREMENT)
  if (requirement === undefined) throw new Error('profile task-tools passive requirement was not recorded')
  if (remembered.sessionBindings[alice.id] !== undefined || remembered.sessionBindings[bob.id] !== undefined) {
    throw new Error('profile task-tools passive requirement materialized an employee')
  }
  const assigned = (await service.directory.updateRecord(service.workspaceId, record => applyChatWork(record, {
    type: 'communication/assign', roomId: room.id, assigneeAgentId: alice.id, allowDelegation: false,
    brief: { title: TASK_TOOLS_REQUEST, instructions: TASK_TOOLS_REQUEST, expectedArtifacts: [], acceptanceCriteria: [] },
  }, { humanId: HumanId('profile-task-human'), occurredAt: new Date().toISOString() }))).value
  await writeFile(fixturePath, `${JSON.stringify({
    taskId: assigned.taskId,
    roomId: room.id,
    deniedAssigneeAgentId: bob.id,
    aliceAgentId: alice.id,
    memoryEventId: requirement.id,
    memorySequence: requirement.sequence,
  })}\n`, 'utf8')
  const result = await service.runAssignedTask(alice.id, assigned.taskId)
  if (result !== 'PROFILE_TASK_TOOL_RESULT') throw new Error('profile task tool completion did not settle the assigned task')
  const passive = service.snapshot()
  for (const brief of [
    { title: 'WF_REPORT', instructions: 'WF_BEFORE_EDIT', expectedArtifacts: ['WF_EXPECTED_A', 'WF_EXPECTED_B'], acceptanceCriteria: ['WF_CRITERION_A', 'WF_CRITERION_B'] },
    { title: 'WF_DISCARD', instructions: 'WF_DISPOSABLE_INSTRUCTIONS', expectedArtifacts: [], acceptanceCriteria: [] },
  ]) {
    await service.directory.updateRecord(service.workspaceId, record => {
      const changed = applyWorkflowCommand(record, { type: 'workflow/draft/create', brief }, { humanId: HumanId('profile-task-human'), occurredAt: new Date().toISOString() })
      return { record: { ...record, aggregate: changed.aggregate, workflow: changed.workflow }, value: changed.value }
    })
  }
  if (JSON.stringify(service.snapshot()) !== JSON.stringify(passive)) throw new Error('profile passive workflow setup changed business records or Sessions')
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
  await new Promise<void>((resolveReady, reject) => {
    let settled = false
    let watcher: ReturnType<typeof watch> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      watcher?.close()
      if (timer !== undefined) clearTimeout(timer)
      if (error === undefined) resolveReady()
      else reject(error)
    }
    const check = async (): Promise<void> => {
      try {
        await access(readyPath)
        finish()
      } catch (error) {
        if (!isMissingFile(error)) finish(error)
      }
    }
    watcher = watch(dirname(readyPath), (_event, filename) => {
      if (filename === null || String(filename) === basename(readyPath)) void check()
    })
    watcher.once('error', finish)
    timer = setTimeout(() => finish(new Error('profile task-tools seed timed out waiting for the scripted LLM adapter')), SCRIPTED_LLM_READY_TIMEOUT_MS)
    timer.unref()
    void check()
  })
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
