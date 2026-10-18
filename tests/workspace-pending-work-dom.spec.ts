// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceTasks } from '../packages/web/src/client/WorkspaceTasks.tsx'
import { WorkflowApiError } from '../packages/web/src/client/workflow-api.ts'
import { en } from '../packages/web/src/client/locales.ts'
import { workflowBrowserFixture, emptyWorkflow } from './fixtures/workflow-browser.ts'
import type { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import type { TaskDraft, TaskBrief } from '../packages/web/src/client/workflow-contracts.ts'
import type { CommunicationSnapshot } from '../packages/web/src/client/communication-api.ts'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
const roots: Root[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); vi.restoreAllMocks() })
const brief: TaskBrief = { title: 'Report proposal', instructions: 'Write the full report', expectedArtifacts: ['report.md'], acceptanceCriteria: ['Reviewed'] }
const translate = ((key: keyof typeof en, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key])) as never
function fixture() {
  const f = workflowBrowserFixture()
  let draft: TaskDraft = { id: 'proposal', revision: 2, status: 'draft', source: { type: 'employee', id: f.agentId }, suggestedAssigneeAgentId: f.agentId, brief }
  let workflowRevision = 3
  let failRead = false
  let failWrite: Error | undefined
  const writes: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
  const snapshot = { ...f.aggregate, rooms: { room: { id: 'room', kind: 'group' as const, name: 'Planning' } }, events: [...f.aggregate.events, { id: 'message', sequence: 10, type: 'room/message' as const, subjectId: 'room', actor: { type: 'agent' as const, id: f.agentId }, text: 'I propose <@' + f.agentId + '> writes a report', mentions: [f.agentId] }] }
  const api: WorkspaceApiClient = { ...f.api, readOnly: false, snapshot: async () => snapshot,
    callCommunication: async () => ({ workspaceId: 'workspace', aggregateRevision: snapshot.revision, workflowRevision, communication: { revision: 1, nextCheckpointOrder: 1, messages: {}, taskSources: {}, draftSources: { proposal: { roomId: 'room', eventId: 'message' } }, inputs: {}, contexts: {}, resets: {}, fileCheckpoints: {}, operations: {} } }),
    callWorkflow: async (endpoint, payload) => {
      if (endpoint === 'workflow/snapshot') { if (failRead) throw new Error('Network'); return { workspaceId: 'workspace', aggregateRevision: snapshot.revision, workflow: { ...emptyWorkflow(), revision: workflowRevision, drafts: { proposal: draft } } } }
      writes.push({ endpoint, payload })
      if (failWrite) throw failWrite
      if (endpoint === 'workflow/draft/edit') draft = { ...draft, revision: draft.revision + 1, brief: payload['brief'] as TaskBrief, suggestedAssigneeAgentId: payload['suggestedAssigneeAgentId'] as string | undefined }
      if (endpoint === 'workflow/draft/discard') draft = { ...draft, revision: draft.revision + 1, status: 'discarded' }
      workflowRevision++
      return { workspaceId: 'workspace', aggregateRevision: snapshot.revision, workflowRevision, value: { draftId: draft.id }, replayed: false }
    },
  }
  return { api, snapshot, writes, agentId: f.agentId, get draft() { return draft }, setFailRead(value: boolean) { failRead = value }, setFailWrite(value?: Error) { failWrite = value } }
}
async function mount(f: ReturnType<typeof fixture>) {
  const node = document.createElement('div'); const root = createRoot(node); roots.push(root)
  const onBringToChat = vi.fn(); const onOpenSource = vi.fn()
  await act(async () => root.render(createElement(WorkspaceTasks, { api: f.api, snapshot: f.snapshot, activity: { version: 2, workspaceRevision: f.snapshot.revision, agents: [], activities: [] }, onSnapshot: () => {}, onActivity: () => {}, selectedAgentId: f.agentId, onBringToChat, onOpenSource, t: translate })))
  return { node, onBringToChat, onOpenSource }
}
function button(node: HTMLElement, text: string) { const b = [...node.querySelectorAll('button')].find(v => v.textContent === text); if (!b) throw new Error(`Missing ${text}`); return b }
async function click(node: HTMLElement, text: string) { await act(async () => button(node, text).click()) }
async function fill(node: HTMLElement, label: string, value: string) {
  const input = [...node.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent === label)?.querySelector('input,textarea,select') as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  if (!input) throw new Error(`Missing ${label}`)
  await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })
}
it('saves every brief field at the loaded draft revision before confirmation in its source chat', async () => {
  const f = fixture(); const { node, onBringToChat, onOpenSource } = await mount(f)
  await click(node, 'From chat · Planning'); expect(onOpenSource).toHaveBeenCalledWith('room', 'message')
  await click(node, 'Edit proposal')
  await fill(node, 'Work title', 'Edited report'); await fill(node, 'Full instructions', 'Complete new instructions')
  await fill(node, 'Expected artifacts (one per line)', 'report.md\nchart.png'); await fill(node, 'Acceptance criteria (one per line)', 'Reviewed\nReproducible')
  expect(button(node, 'Confirm in chat').disabled).toBe(true)
  await click(node, 'Save proposal')
  expect(f.writes[0]).toMatchObject({ endpoint: 'workflow/draft/edit', payload: { draftId: 'proposal', expectedDraftRevision: 2, expectedAggregateRevision: f.snapshot.revision, expectedWorkflowRevision: 3, suggestedAssigneeAgentId: f.agentId, brief: { title: 'Edited report', instructions: 'Complete new instructions', expectedArtifacts: ['report.md', 'chart.png'], acceptanceCriteria: ['Reviewed', 'Reproducible'] } } })
  await click(node, 'Confirm in chat')
  expect(onBringToChat).toHaveBeenCalledWith(f.draft.brief, { id: 'proposal', revision: 3 }, { roomId: 'room', eventId: 'message' })
  expect(f.writes).toHaveLength(1)
})
it('rejects a proposal without creating work', async () => {
  const f = fixture(); const { node } = await mount(f)
  await click(node, 'Reject proposal')
  expect(f.draft.status).toBe('discarded'); expect(node.querySelector('[data-pending-work]')).toBeNull()
  expect(f.writes[0]).toMatchObject({ endpoint: 'workflow/draft/discard', payload: { draftId: 'proposal', expectedDraftRevision: 2 } })
})

it('keeps empty proposals compact and retains a low emphasis reload', async () => {
  const f = fixture(); const { node } = await mount(f)
  await click(node, 'Reject proposal')
  const section = node.querySelector(`section[aria-label="${en['pending.heading']}"]`)!
  expect(section.querySelector('.dsh-agent-group-section-head')).toBeNull()
  expect(section.textContent).toContain(en['pending.empty'])
  expect(button(section as HTMLElement, en['pending.reload']).getAttribute('data-variant')).toBe('ghost')
  await click(section as HTMLElement, en['pending.reload'])
  expect(section.querySelector('[data-pending-work]')).toBeNull()
})

it('does not display a stale proposal brief after its source is withdrawn', async () => {
  const f = fixture()
  const read = f.api.callCommunication.bind(f.api)
  vi.spyOn(f.api, 'callCommunication').mockImplementation(async (...args) => {
    const value = await read(...args) as CommunicationSnapshot
    return { ...value, communication: { ...value.communication, messages: { message: { eventId: 'message', intent: 'message', withdrawnBy: 'reset' } } } }
  })
  const { node } = await mount(f)
  expect(node.textContent).not.toContain('Write the full report')
  expect(node.querySelector('[data-pending-work="proposal"]')).toBeNull()
})
it('keeps edits on write failure and retries the same request identity', async () => {
  const f = fixture(); f.setFailWrite(new Error('Disconnected')); const { node } = await mount(f)
  await click(node, 'Edit proposal'); await fill(node, 'Full instructions', 'Unsaved text'); await click(node, 'Save proposal')
  expect(node.querySelector('textarea')?.value).toBe('Unsaved text')
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('Proposal action failed')
  f.setFailWrite(); await click(node, 'Retry proposal action')
  expect(f.writes[1]?.payload['operationId']).toBe(f.writes[0]?.payload['operationId']); expect(f.draft.brief.instructions).toBe('Unsaved text')
})
it('requires reloading a draft after a revision conflict and retains the local editor', async () => {
  const f = fixture(); f.setFailWrite(new WorkflowApiError({ kind: 'business', code: 'stale-draft-revision', message: 'Stale', details: { draftId: 'proposal', expectedDraftRevision: 2, actualDraftRevision: 3 } })); const { node } = await mount(f)
  await click(node, 'Edit proposal'); await fill(node, 'Full instructions', 'Local text'); await click(node, 'Save proposal')
  expect(node.querySelector('textarea')?.value).toBe('Local text'); expect(button(node, 'Confirm in chat').disabled).toBe(true)
  expect(node.textContent).toContain('Proposal changed. Reload'); expect(f.writes).toHaveLength(1)
})
it('shows unavailable reads and allows a read retry', async () => {
  const f = fixture(); f.setFailRead(true); const { node } = await mount(f)
  expect(node.textContent).toContain('Could not load pending proposals'); f.setFailRead(false)
  await click(node, 'Reload proposals'); expect(node.querySelector('[data-pending-work="proposal"]')).not.toBeNull()
})
it('keeps archived proposals readable with write actions disabled', async () => {
  const f = fixture(); const archived = { ...f, api: { ...f.api, readOnly: true } }; const { node } = await mount(archived)
  expect(node.textContent).toContain('Read-only organization')
  expect(button(node, 'Edit proposal').disabled).toBe(true); expect(button(node, 'Reject proposal').disabled).toBe(true); expect(button(node, 'Confirm in chat').disabled).toBe(true)
})

it('retains invalidated task records while hiding instructions, results and execution actions', async () => {
  const f = fixture()
  const current = { ...f.snapshot, tasks: { root: { id: 'root', rootTaskId: 'root', title: 'WITHDRAWN_TITLE', status: 'open' as const }, derived: { id: 'derived', rootTaskId: 'root', title: 'WITHDRAWN_DERIVED_TITLE', status: 'completed' as const } }, taskAssignments: { rootAssignment: { id: 'rootAssignment', taskId: 'root', rootTaskId: 'root', assigneeAgentId: f.agentId }, derivedAssignment: { id: 'derivedAssignment', taskId: 'derived', rootTaskId: 'root', assigneeAgentId: f.agentId } }, events: [...f.snapshot.events, { id: 'root-assigned', sequence: 11, type: 'task/assigned' as const, subjectId: 'rootAssignment' }, { id: 'root-failed', sequence: 12, type: 'task/delivery-failed' as const, taskId: 'root', taskDeliveryAttemptId: 'attempt', messageId: 'delivered', failureCode: 'interrupted', failureSummary: 'Interrupted' }, { id: 'derived-result', sequence: 13, type: 'task/result' as const, taskId: 'derived', taskDeliveryAttemptId: 'attempt2', definitionRevisionId: 'rev', text: 'WITHDRAWN_RESULT' }] }
  const source = { roomId: 'room', eventId: 'message' }
  const api: WorkspaceApiClient = { ...f.api, snapshot: async () => current, callCommunication: async () => ({ workspaceId: 'workspace', aggregateRevision: current.revision, workflowRevision: 3, communication: { revision: 2, nextCheckpointOrder: 1, messages: { message: { eventId: 'message', intent: 'message', withdrawnBy: 'reset' } }, taskSources: { root: source, derived: source }, draftSources: {}, inputs: {}, contexts: {}, resets: { reset: { id: 'reset', source, requestedByHumanId: 'owner', fromSequence: 10, throughSequence: 13, affectedAgentIds: [f.agentId], previousGenerations: {}, invalidatedEventIds: ['message'], invalidatedTaskIds: ['root', 'derived'], invalidatedDraftIds: ['proposal'], invalidatedTemplateRevisionIds: [], invalidatedArtifactIds: [], requestedAt: '2026-10-13T00:00:00.000Z', fileRestoreRequested: false, status: 'completed' } }, fileCheckpoints: {}, operations: {} } }) }
  const { node, onOpenSource } = await mount({ ...f, api, snapshot: current })
  const rootCard = node.querySelector<HTMLElement>('[data-task-id="root"]')!
  const derivedCard = node.querySelector<HTMLElement>('[data-task-id="derived"]')!
  expect(rootCard.textContent).toContain('Source withdrawn; work invalidated')
  expect(derivedCard.textContent).toContain('Source withdrawn; work invalidated')
  expect(node.textContent).not.toContain('WITHDRAWN_TITLE'); expect(node.textContent).not.toContain('WITHDRAWN_DERIVED_TITLE'); expect(node.textContent).not.toContain('WITHDRAWN_RESULT')
  expect(node.querySelector('.dsh-agent-group-work-source')?.textContent).not.toContain('I propose')
  expect(rootCard.querySelectorAll('button:not(.dsh-agent-group-identity)')).toHaveLength(0)
  expect(derivedCard.querySelectorAll('button:not(.dsh-agent-group-identity)')).toHaveLength(0)
  expect(node.querySelector('[data-pending-work="proposal"]')).toBeNull()
  expect(node.textContent).not.toContain('Write the full report')
  await click(node, 'From chat · Planning'); expect(onOpenSource).toHaveBeenCalledWith('room', 'message')
})
