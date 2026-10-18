/** File-driven synthetic organization for the supported Web profile. */
import { access, readFile, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceRuntime } from '../../../packages/host/src/workspace-runtime.ts'
import { AgentId, RoomId, WorkspaceId } from '../../../packages/host/src/ids.ts'
import type { ContextResetId } from '../../../packages/host/src/communication-contract.ts'
import { WEB_WORKSPACE_HUMAN_ID } from '../../../packages/host/src/rpc.ts'
import { assignHumanTask, cancelTask } from '../../../packages/host/src/tasks.ts'

export const name = 'agent-workspace-scene-memory-profile'
export const inject = ['agentWorkspace', 'agents', 'tools']

const HUMAN = WEB_WORKSPACE_HUMAN_ID

/** Seed only synthetic people and messages, then save checkpoints for the disk reader. */
export async function apply(ctx: Context): Promise<void> {
  const root = process.env['DSH_AGENT_GROUP_SCENE_EVIDENCE']
  const phase = process.env['DSH_AGENT_GROUP_SCENE_PHASE']
  if (root === undefined || !['scripted', 'restart', 'real', 'formal'].includes(phase ?? '')) throw new Error('scene profile requires evidence root and phase')
  if (phase !== 'real') await waitForFile(join(root, 'adapter.ready'))
  const service: WorkspaceRuntime = ctx.agentWorkspace.forWorkspace(WorkspaceId('local'))
  if (phase === 'restart') {
    const seed = JSON.parse(await readFile(join(root, 'seed-state.json'), 'utf8')) as { readonly aliceId: string; readonly targetRoomId: string; readonly sourceEventId: string }
    const previous = service.snapshot()
    if (!previous.memoryEntries.some(entry => entry.agentId === seed.aliceId && entry.eventId === seed.sourceEventId)) throw new Error('restart lost acquired source')
    const before = service.memoryProcessingStatus(AgentId(seed.aliceId))
    await writeFile(join(root, 'restart-before.json'), `${JSON.stringify({ cwd: process.cwd(), snapshot: previous, processing: before })}\n`, 'utf8')
    await post(service, RoomId(seed.targetRoomId), 'SCENE_RESTART_RECALL 请从已保存的原文回答。', [AgentId(seed.aliceId)], 'SCENE_RESTART_RECALL_OK')
    await writeFile(join(root, 'restart-after.json'), `${JSON.stringify({ snapshot: service.snapshot(), processing: service.memoryProcessingStatus(AgentId(seed.aliceId)) })}\n`, 'utf8')
    return
  }
  await service.execute(service.snapshot().revision, { type: 'definition/create', name: 'Scene memory colleague', description: 'Answer the synthetic scenario.', instructions: 'Use sourced memory and current request.' })
  const definition = Object.values(service.snapshot().definitions).find(item => item.name === 'Scene memory colleague')!
  for (const name of ['Alice', 'Bob', 'Carol']) await service.execute(service.snapshot().revision, { type: 'agent/create', definitionId: definition.id, name })
  for (const name of ['Source room', 'Target room']) await service.execute(service.snapshot().revision, { type: 'room/create', kind: 'group', name })
  const state = service.snapshot()
  const alice = Object.values(state.agents).find(agent => agent.name === 'Alice')!
  const bob = Object.values(state.agents).find(agent => agent.name === 'Bob')!
  const carol = Object.values(state.agents).find(agent => agent.name === 'Carol')!
  const sourceRoom = Object.values(state.rooms).find(room => room.name === 'Source room')!
  const targetRoom = Object.values(state.rooms).find(room => room.name === 'Target room')!
  for (const roomId of [sourceRoom.id, targetRoom.id]) await service.execute(service.snapshot().revision, { type: 'room/join', roomId, agentId: alice.id, memoryStart: { type: 'new-events' } })
  for (const roomId of [sourceRoom.id, targetRoom.id]) await service.execute(service.snapshot().revision, { type: 'room/join', roomId, agentId: carol.id, memoryStart: { type: 'new-events' } })
  await service.execute(service.snapshot().revision, { type: 'room/join', roomId: targetRoom.id, agentId: bob.id, memoryStart: { type: 'new-events' } })
  await service.postHumanMessage(service.snapshot().revision, sourceRoom.id, HUMAN, `OLD_LONG_BAIT ${'旧会议记录与过时安排。'.repeat(300)}`, [])
  await service.postHumanMessage(service.snapshot().revision, sourceRoom.id, HUMAN, 'SRC_NO_MENTION 在本群请叫我邵老师。', [])
  const source = service.snapshot().events.find(event => event.text?.includes('SRC_NO_MENTION'))!
  if (service.snapshot().sessionBindings[alice.id] !== undefined) throw new Error('passive no-mention source materialized Alice')
  if (service.snapshot().sessionBindings[carol.id] !== undefined) throw new Error('passive no-mention source materialized Carol')
  await service.postHumanMessage(service.snapshot().revision, sourceRoom.id, HUMAN, 'For all correspondence, please send email in English.', [])
  await writeFile(join(root, 'seed-state.json'), `${JSON.stringify({ cwd: process.cwd(), aliceId: alice.id, bobId: bob.id, carolId: carol.id,
    sourceRoomId: sourceRoom.id, targetRoomId: targetRoom.id, sourceEventId: source.id, sourceSequence: source.sequence,
    sessionBeforeWake: service.snapshot().sessionBindings[alice.id] ?? null })}\n`, 'utf8')
  if (phase === 'formal') {
    await service.directory.updateAggregate(service.workspaceId, state => {
      const assigned = assignHumanTask(state, { humanId: HUMAN, assigneeAgentId: alice.id, title: '旧项目：整理上季度材料' })
      return cancelTask(assigned.state, { humanId: HUMAN, taskId: assigned.taskId }).state
    })
    const taskId = Object.values(service.snapshot().tasks).find(task => task.title === '旧项目：整理上季度材料')?.id
    if (taskId === undefined) throw new Error('formal task was not persisted')
    if (service.snapshot().tasks[taskId]?.status !== 'cancelled') throw new Error('formal task was not durably cancelled')
    await post(service, targetRoom.id, '上次项目怎样了？', [alice.id], 'FORMAL_STOPPED_OK')
    await writeFile(join(root, 'formal-after.json'), `${JSON.stringify({ taskId, cwd: process.cwd(), snapshot: service.snapshot() })}\n`, 'utf8')
    return
  }
  if (phase === 'real') {
    await post(service, targetRoom.id, '现在知道了吗？', [alice.id, carol.id])
    await post(service, targetRoom.id, '请用中文简短回复，并记得我的邮件语言约定。', [alice.id])
    await writeFile(join(root, 'real-after.json'), `${JSON.stringify({ snapshot: service.snapshot(), processing: service.memoryProcessingStatus(alice.id) })}\n`, 'utf8')
    return
  }
  await post(service, targetRoom.id, '现在知道了吗？', [alice.id, carol.id], '知道了，称呼邵老师。', 2)
  await post(service, targetRoom.id, 'SCENE_CROSS_ALICE 请从来源群回忆称呼。', [alice.id], 'SCENE_CROSS_ALICE_OK')
  await post(service, targetRoom.id, 'SCENE_STRANGER_BOB 请回答，但不要读取其他同事的来源。', [bob.id], 'SCENE_STRANGER_BOB_OK')
  await post(service, targetRoom.id, 'SCENE_LANGUAGE_SWITCH 请用中文回复此前 email 约定。', [alice.id], 'SCENE_LANGUAGE_SWITCH_OK 中文回复')
  await service.postHumanMessage(service.snapshot().revision, targetRoom.id, HUMAN, 'VERSION_A_OLD 此任务使用方案 A。', [])
  await service.postHumanMessage(service.snapshot().revision, targetRoom.id, HUMAN, 'VERSION_B_CURRENT 现在改用方案 B，撤回 A。', [])
  const changed = service.snapshot().events.findLast(event => event.text?.includes('VERSION_B_CURRENT'))!
  await post(service, targetRoom.id, 'SCENE_VERSION_B 当前方案是什么？', [alice.id], 'SCENE_VERSION_B_OK')
  const prior = service.snapshot()
  await service.recallMessage({ operationId: 'scene-withdraw-b' as ContextResetId, roomId: targetRoom.id, eventId: changed.id,
    expectedRevision: prior.revision, restoreFiles: false })
  await post(service, targetRoom.id, 'SCENE_AFTER_WITHDRAWAL 现在仍有什么方案？', [alice.id], 'SCENE_AFTER_WITHDRAWAL_OK')
  await service.postHumanMessage(service.snapshot().revision, sourceRoom.id, HUMAN, `TOOL_ONLY_SOURCE ${'x'.repeat(1600)} TOOL_ONLY_SECRET_617`, [])
  await post(service, targetRoom.id, 'SCENE_TOOL_ONLY 请通过工具核对完整原文。', [alice.id], 'SCENE_TOOL_ONLY_OK')
  const toolSource = service.snapshot().events.find(event => event.text?.startsWith('TOOL_ONLY_SOURCE'))!
  await service.recallMessage({ operationId: 'scene-withdraw-tool-source' as ContextResetId, roomId: sourceRoom.id, eventId: toolSource.id,
    expectedRevision: service.snapshot().revision, restoreFiles: false })
  await post(service, targetRoom.id, 'SCENE_AFTER_TOOL_WITHDRAWAL 请勿使用已撤回资料。', [alice.id], 'SCENE_AFTER_TOOL_WITHDRAWAL_OK')
  await service.postHumanMessage(service.snapshot().revision, targetRoom.id, HUMAN, 'SCENE_OLD_WORK_SECRET 旧工作应被立即停止。', [alice.id])
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('old work did not become active')), 30_000)
  timer.unref()
  try {
    let activity = service.activitySnapshot().activities.find(item => item.agentId === alice.id && item.status === 'responding' && item.claimed !== undefined)
    while (activity === undefined) {
      const snapshot = service.activitySnapshot()
      const next = await service.waitForActivity(snapshot.version, controller.signal)
      activity = next.activities.find(item => item.agentId === alice.id && item.status === 'responding' && item.claimed !== undefined)
    }
    const stopped = await service.stopActivity(service.snapshot().revision, { activityId: activity.activityId, agentId: activity.agentId,
      messageId: activity.messageId, sessionId: activity.claimed!.sessionId, turn: activity.claimed!.turn })
    if (stopped.value.status !== 'stopping') throw new Error(`old work stop was ${stopped.value.status}`)
  } finally { clearTimeout(timer) }
  await service.admission.drain()
  await post(service, targetRoom.id, 'SCENE_AFTER_STOP 新请求不要继续旧工作。', [alice.id], 'SCENE_AFTER_STOP_OK')
  await writeFile(join(root, 'scripted-after.json'), `${JSON.stringify({ snapshot: service.snapshot(), processing: service.memoryProcessingStatus(alice.id),
    withdrawnEventId: changed.id, priorRevision: prior.revision })}\n`, 'utf8')
}

async function post(service: WorkspaceRuntime, roomId: RoomId, text: string, mentions: readonly AgentId[], expected?: string, expectedCount = 1): Promise<void> {
  const beforeSequence = service.snapshot().nextSequence
  await service.postHumanMessage(service.snapshot().revision, roomId, HUMAN, text, mentions)
  await service.admission.drain()
  await service.waitForMemoryProcessing()
  const status = service.runtimeStatus().rooms[roomId]
  if (status?.error !== undefined) throw new Error(`scene profile delivery failed: ${status.error}`)
  if (expected !== undefined && service.snapshot().events.filter(event => event.sequence >= beforeSequence && event.text === expected).length !== expectedCount) {
    throw new Error(`scene profile response missing: ${expected}`)
  }
}

async function waitForFile(path: string): Promise<void> {
  try { await access(path); return } catch { /* Adapter registration may follow seed registration. */ }
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), async (_event, filename) => {
      if (filename !== null && String(filename) !== basename(path)) return
      try { await access(path); clearTimeout(timer); watcher.close(); resolve() } catch { /* Wait for the named file. */ }
    })
    const timer = setTimeout(() => { watcher.close(); reject(new Error('scene scripted adapter did not register')) }, 30_000)
    timer.unref()
    void access(path).then(() => { clearTimeout(timer); watcher.close(); resolve() }).catch(() => {})
  })
}
