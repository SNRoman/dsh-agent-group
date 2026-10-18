// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceWorkflow } from '../packages/web/src/client/WorkspaceWorkflow.tsx'
import { WorkspaceApi } from '../packages/web/src/client/api.ts'
import { en } from '../packages/web/src/client/locales.ts'
import { workflowBrowserFixture } from './fixtures/workflow-browser.ts'
import type { WorkspaceApiClient } from '../packages/web/src/client/api.ts'
import type { WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import type { Root } from 'react-dom/client'
import { WorkspaceWorkflowApi } from '../packages/web/src/client/workflow-api.ts'
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
const roots: Root[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()) })
function t(key: keyof typeof en, params?: Record<string, string | number>) { return Object.entries(params ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key]) }
async function mount(api: WorkspaceApiClient, snapshot: WorkspaceSnapshot) {
  const node = document.createElement('div'); const root = createRoot(node); roots.push(root)
  const brought: { brief: unknown; draft?: unknown }[] = []
  const onBringToChat = (brief: unknown, draft?: unknown) => brought.push({ brief, draft })
  await act(async () => root.render(createElement(WorkspaceWorkflow, { api, snapshot, onSnapshot: () => {}, onBringToChat, t: t as never })))
  return { node, root, brought, render: async (api: WorkspaceApiClient, snapshot: WorkspaceSnapshot) => { await act(async () => root.render(createElement(WorkspaceWorkflow, { api, snapshot, onSnapshot: () => {}, onBringToChat, t: t as never }))) } }
}
function control(node: HTMLElement, name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const label = [...node.querySelectorAll('label')].find(v => v.querySelector('span')?.textContent === name)
  const input = label?.querySelector('input,textarea,select')
  if (!input) throw new Error(`Missing field ${name}`)
  return input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
}
async function fill(node: HTMLElement, name: string, value: string) {
  const input = control(node, name)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
function button(node: HTMLElement, name: string) { const found = [...node.querySelectorAll('button')].find(b => b.textContent === name); if (!found) throw new Error(`Missing button ${name}`); return found }
async function click(node: HTMLElement, name: string) { await act(async () => button(node, name).click()) }
async function writeBrief(node: HTMLElement, title = 'Report') { await fill(node, 'Work title', title); await fill(node, 'Full instructions', 'Write a complete report'); await fill(node, 'Expected artifacts (one per line)', 'Report file'); await fill(node, 'Acceptance criteria (one per line)', 'Reviewed') }
it('waits for withdrawal metadata before displaying initial result options and offers refresh after failure', async () => {
  const f = workflowBrowserFixture(); f.seedConfirmed(); f.complete()
  const barrier = Promise.withResolvers<void>(); let fail = true
  const api = new WorkspaceApi({ rpc: { call: async (_channel: string, endpoint: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    if (endpoint === 'communication/snapshot' && fail) { await barrier.promise; throw new Error('Metadata unavailable') }
    return { ok: true, value: endpoint === 'snapshot' ? await f.api.snapshot(signal) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), signal) }
  } } } as never).forWorkspace('workspace')
  const { node } = await mount(api, f.aggregate)
  expect((control(node, 'Exact result selection') as HTMLSelectElement).options).toHaveLength(1)
  await act(async () => barrier.resolve())
  expect(node.textContent).toContain(en['workflow.refreshFailed'])
  expect((control(node, 'Exact result selection') as HTMLSelectElement).options).toHaveLength(1)
  fail = false; await click(node, 'Refresh workflow')
  expect((control(node, 'Exact result selection') as HTMLSelectElement).options).toHaveLength(2)
})
it('removes displayed result text when withdrawal metadata refresh fails', async () => {
  const f = workflowBrowserFixture(); f.seedConfirmed(); f.complete(); let fail = false
  const api = new WorkspaceApi({ rpc: { call: async (_channel: string, endpoint: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    if (endpoint === 'communication/snapshot' && fail) throw new Error('Metadata unavailable')
    return { ok: true, value: endpoint === 'snapshot' ? await f.api.snapshot(signal) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), signal) }
  } } } as never).forWorkspace('workspace')
  const { node } = await mount(api, f.aggregate)
  await fill(node, 'Exact result selection', f.aggregate.events.find(event => event.type === 'task/result')!.id)
  expect(node.textContent).toContain('<script>unsafe</script> Result')
  fail = true; await click(node, 'Refresh workflow')
  expect(node.textContent).not.toContain('<script>unsafe</script> Result')
  expect(node.textContent).toContain(en['workflow.refreshFailed'])
})
it('renders human draft controls with no implicit assignee and archived writes disabled', async () => {
  const f = workflowBrowserFixture()
  const api = f.api.forWorkspace('workspace', true)
  const node = document.createElement('div'); const root = createRoot(node)
  const t = ((key: keyof typeof en) => en[key]) as never
  await act(async () => root.render(createElement(WorkspaceWorkflow, { api, snapshot: f.aggregate, onSnapshot: () => {}, t })))
  expect(node.textContent).toContain('Workflow')
  expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Create draft')).toBe(false)
  expect(button(node, 'Create task template').disabled).toBe(true)
  await act(async () => root.unmount())
})
it('edits and discards existing drafts and brings saved confirmation to chat', async () => {
  const f = workflowBrowserFixture(); f.seedDraft(); const { node, brought } = await mount(f.api, f.aggregate)
  const draft = Object.values(f.workflow.drafts)[0]!
  expect(Object.values(f.aggregate.tasks)).toHaveLength(0)
  await fill(node, 'Draft selection', draft.id); await fill(node, 'Work title', 'Edited report')
  expect(button(node, en['chat.confirmInChat']).disabled).toBe(true)
  await click(node, 'Save draft changes')
  expect(f.workflow.drafts[draft.id]?.revision).toBe(1)
  expect(control(node, 'Confirmation assignee').value).toBe('')
  await click(node, en['chat.confirmInChat'])
  expect(brought).toEqual([{ brief: f.workflow.drafts[draft.id]!.brief, draft: { id: draft.id, revision: 1 } }])
  expect(Object.values(f.aggregate.tasks)).toHaveLength(0)
  f.seedDraft({ title: 'Discard me', instructions: 'Discard work', expectedArtifacts: [], acceptanceCriteria: [] }); await click(node, 'Refresh workflow')
  const second = Object.values(f.workflow.drafts).at(-1)!
  await fill(node, 'Draft selection', second.id); await click(node, 'Discard draft')
  expect(f.workflow.drafts[second.id]?.status).toBe('discarded')
  expect(Object.values(f.aggregate.delegationGrants)).toHaveLength(0)
})
it('creates and revises a task template and brings its pinned revision to chat', async () => {
  const f = workflowBrowserFixture(); const id = f.seedDraft(); const { node, brought } = await mount(f.api, f.aggregate)
  await fill(node, 'Draft selection', id)
  await writeBrief(node); await fill(node, 'Task template name', 'Reusable'); await click(node, 'Create task template')
  const template = Object.values(f.workflow.taskTemplates)[0]!
  await fill(node, 'Task template selection', template.id); await fill(node, 'Full instructions', 'Later instructions'); await click(node, 'Save task template revision')
  expect(f.workflow.taskTemplates[template.id]?.revisionIds).toHaveLength(2)
  await fill(node, 'Task template revision', template.currentRevisionId); await click(node, en['chat.templateToChat'])
  expect(brought.at(-1)?.brief).toMatchObject({ instructions: 'Write a complete report' })
  expect(Object.values(f.aggregate.tasks)).toHaveLength(0)
})
it('creates revises previews and explicitly confirms company new-events configuration without tasks', async () => {
  const f = workflowBrowserFixture(); const { node } = await mount(f.api, f.aggregate)
  await fill(node, 'Company template name', 'Team'); await click(node, 'Add configured colleague'); await fill(node, 'New colleague name', 'Bob'); await fill(node, 'Pinned role revision', f.roleRevisionId)
  await click(node, 'Add configured group'); await fill(node, 'New group name', 'New group')
  const member = [...node.querySelectorAll('label')].find(l => l.textContent === 'Bob')!.querySelector('input')!
  await act(async () => member.click()); await click(node, 'Create company template')
  const template = Object.values(f.workflow.companyTemplates)[0]!
  await fill(node, 'Company template selection', template.id); await click(node, 'Save company template revision')
  await fill(node, 'Company template revision', template.currentRevisionId); await click(node, 'Preview selected company revision')
  expect(Object.values(f.aggregate.agents)).toHaveLength(1)
  expect(button(node, 'Confirm company configuration').disabled).toBe(true)
  const confirm = [...node.querySelectorAll('label')].find(l => l.textContent?.startsWith('I confirm:'))!.querySelector('input')!
  await act(async () => confirm.click()); await click(node, 'Confirm company configuration')
  expect(Object.values(f.aggregate.agents)).toHaveLength(2)
  expect(Object.values(f.aggregate.memberships)[0]?.memoryStart).toEqual({ type: 'new-events' })
  expect(Object.values(f.aggregate.sessionBindings)).toHaveLength(0)
  expect(Object.values(f.aggregate.tasks)).toHaveLength(0)
})
it('registers inert path URL and no reference, reviews exact results and hands off only selected artifacts', async () => {
  const f = workflowBrowserFixture(); const { node } = await mount(f.api, f.aggregate)
  f.seedConfirmed()
  f.complete(); await click(node, 'Refresh workflow')
  const result = f.aggregate.events.find(e => e.type === 'task/result')!
  await fill(node, 'Exact result selection', result.id)
  for (const [label, kind, reference] of [['Selected', 'path', 'C:/report.txt'], ['Unselected', 'url', 'https://example.test/report'], ['Plain', 'none', '']] as const) {
    await fill(node, 'Artifact label', label); await fill(node, 'Artifact summary', 'Summary'); await fill(node, 'Artifact reference type', kind); if (kind !== 'none') await fill(node, 'Reference value', reference)
    await click(node, 'Register artifact for this result')
  }
  expect(node.querySelectorAll('a,script')).toHaveLength(0)
  expect(node.textContent).toContain('Unverified reference')
  await fill(node, en['workflow.continuationRoom'], f.roomId)
  await fill(node, 'Human review decision', 'changes-requested'); await fill(node, 'Review comment', 'Revise this'); await click(node, 'Submit review for this result')
  expect(Object.values(f.workflow.drafts).at(-1)?.source.type).toBe('changes-requested')
  await fill(node, 'Human review decision', 'accepted'); await fill(node, 'Review comment', ''); await click(node, 'Submit review for this result')
  expect(Object.values(f.workflow.reviews).at(-1)?.result.eventId).toBe(result.id)
  const selected = [...node.querySelectorAll('label')].find(l => l.textContent?.startsWith('Selected ·'))!.querySelector('input')!
  await act(async () => selected.click()); await click(node, 'Create handoff draft with selected artifacts')
  expect(Object.values(f.workflow.drafts).at(-1)?.handoff?.artifacts.map(a => a.label)).toEqual(['Selected'])
  expect(Object.values(f.aggregate.tasks)).toHaveLength(1)
})
it('keeps coherent pairs monotonic when an older refresh finishes last', async () => {
  const f = workflowBrowserFixture(); let hold = false
  const pending: (() => void)[] = []
  const api = new WorkspaceApi({ rpc: { call: async (_c: string, endpoint: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    const value = endpoint === 'snapshot' ? await f.api.snapshot(signal) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), signal)
    if (hold) await new Promise<void>(resolve => pending.push(resolve))
    return { ok: true, value }
  } } } as never).forWorkspace('workspace')
  const { node } = await mount(api, f.aggregate)
  hold = true; await click(node, 'Refresh workflow'); hold = false
  f.seedDraft({ title: 'New draft', instructions: 'Work', expectedArtifacts: [], acceptanceCriteria: [] })
  await click(node, 'Refresh workflow')
  expect(node.textContent).toContain('Workflow revision 1')
  await act(async () => pending.forEach(resolve => resolve()))
  expect(node.textContent).toContain('Workflow revision 1')
  expect(node.textContent).toContain('New draft')
})
it.each(['workflow/snapshot', 'snapshot', 'workflow/company-template/create', 'workflow/company-template/preview'])('aborts and isolates late %s on organization switch', async endpointToHold => {
  const f = workflowBrowserFixture(); let hold = false; let release: (() => void) | undefined; let signal: AbortSignal | undefined
  if (endpointToHold === 'workflow/company-template/preview') await new WorkspaceWorkflowApi(f.api).mutate('workflow/company-template/create', { name: 'Old company', config: { colleagues: [{ name: 'Bob', definitionRevisionId: f.roleRevisionId }], groups: [] } }, { expectedAggregateRevision: f.aggregate.revision, expectedWorkflowRevision: 0 }, 'company')
  const api = new WorkspaceApi({ rpc: { call: async (_c: string, endpoint: string, payload: Record<string, unknown>, s: AbortSignal) => {
    const value = endpoint === 'snapshot' ? await f.api.snapshot(s) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), s)
    if (hold && endpoint === endpointToHold) { signal = s; await new Promise<void>(resolve => { release = resolve }) }
    return { ok: true, value }
  } } } as never).forWorkspace('workspace')
  const mounted = await mount(api, f.aggregate)
  hold = true
  if (endpointToHold === 'workflow/company-template/create') { await configureCompany(mounted.node, f); await fill(mounted.node, 'Company template name', 'Old workspace draft'); await click(mounted.node, 'Create company template') }
  else if (endpointToHold === 'workflow/company-template/preview') { await fill(mounted.node, 'Company template revision', Object.values(f.workflow.companyTemplates)[0]!.currentRevisionId); await click(mounted.node, 'Preview selected company revision') }
  else await click(mounted.node, 'Refresh workflow')
  expect(signal?.aborted).toBe(false)
  const other = workflowBrowserFixture('other')
  await mounted.render(other.api, other.aggregate)
  expect(signal?.aborted).toBe(true)
  await act(async () => release?.())
  expect(mounted.node.textContent).not.toContain('Old workspace draft')
  expect(mounted.node.textContent).not.toContain('Old company')
  expect(mounted.node.textContent).toContain('Workflow revision 0')
})
it('keeps identical company creation retry identity and allocates a new identity for changed input', async () => {
  const f = workflowBrowserFixture(); let stale = true; const operationIds: string[] = []
  const api = new WorkspaceApi({ rpc: { call: async (_c: string, endpoint: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    if (endpoint === 'workflow/company-template/create') {
      operationIds.push(String(payload['operationId']))
      if (stale) { stale = false; return { ok: false, error: { kind: 'business', code: 'stale-workflow-revision', message: 'Stale', details: { expectedWorkflowRevision: 0, actualWorkflowRevision: 1 } } } }
    }
    const value = endpoint === 'snapshot' ? await f.api.snapshot(signal) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), signal)
    return { ok: true, value }
  } } } as never).forWorkspace('workspace')
  const { node } = await mount(api, f.aggregate)
  await configureCompany(node, f); await click(node, 'Create company template')
  expect(node.textContent).toContain('Workflow revision changed from 0 to 1')
  expect(node.textContent).toContain(`Organization revision ${f.aggregate.revision} · Workflow revision 0`)
  await click(node, 'Retry identical workflow action')
  expect(operationIds[0]).toBe(operationIds[1])
  await fill(node, 'Company template name', 'Changed'); await click(node, 'Create company template')
  expect(operationIds[2]).not.toBe(operationIds[1])
})
it('rejects draft edits against a revision changed after the displayed editor', async () => {
  const f = workflowBrowserFixture(); const workflowApi = new WorkspaceWorkflowApi(f.api)
  f.seedDraft({ title: 'Draft', instructions: 'Work', expectedArtifacts: [], acceptanceCriteria: [] })
  const id = Object.values(f.workflow.drafts)[0]!.id
  const api = new WorkspaceApi({ rpc: { call: async (_c: string, endpoint: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    if (endpoint === 'workflow/draft/edit') {
      await workflowApi.mutate('workflow/draft/edit', { draftId: id, expectedDraftRevision: 0, brief: { title: 'Changed externally', instructions: 'Changed', expectedArtifacts: [], acceptanceCriteria: [] } }, { expectedAggregateRevision: f.aggregate.revision, expectedWorkflowRevision: 1 }, 'edited')
      return { ok: false, error: { kind: 'business', code: 'stale-draft-revision', message: 'Stale', details: { draftId: id, expectedDraftRevision: 0, actualDraftRevision: 1 } } }
    }
    return { ok: true, value: endpoint === 'snapshot' ? await f.api.snapshot(signal) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), signal) }
  } } } as never).forWorkspace('workspace')
  const { node } = await mount(api, f.aggregate)
  await fill(node, 'Draft selection', id); await click(node, 'Save draft changes')
  expect(node.textContent).toContain('Draft revision changed from 0 to 1')
  expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Retry identical workflow action')).toBe(false)
  expect(button(node, en['chat.confirmInChat']).disabled).toBe(true)
  expect(Object.values(f.aggregate.tasks)).toHaveLength(0)
})
it('reports saved metadata when the post-commit refresh fails', async () => {
  const f = workflowBrowserFixture(); let committed = false
  const api = new WorkspaceApi({ rpc: { call: async (_c: string, endpoint: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    if (committed && (endpoint === 'snapshot' || endpoint === 'workflow/snapshot')) throw new Error('Disconnected')
    const value = endpoint === 'snapshot' ? await f.api.snapshot(signal) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), signal)
    if (endpoint === 'workflow/company-template/create') committed = true
    return { ok: true, value }
  } } } as never).forWorkspace('workspace')
  const { node } = await mount(api, f.aggregate)
  await configureCompany(node, f); await click(node, 'Create company template')
  expect(Object.values(f.workflow.companyTemplates)).toHaveLength(1)
  expect(node.textContent).toContain('The action was saved. Refresh to display durable metadata.')
})
it('aborts pending workflow reads when the overlay is removed', async () => {
  const f = workflowBrowserFixture(); let hold = false; const signals: AbortSignal[] = []; const releases: (() => void)[] = []
  const api = new WorkspaceApi({ rpc: { call: async (_c: string, endpoint: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    const value = endpoint === 'snapshot' ? await f.api.snapshot(signal) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), signal)
    if (hold) { signals.push(signal); await new Promise<void>(resolve => releases.push(resolve)) }
    return { ok: true, value }
  } } } as never).forWorkspace('workspace')
  const { node, root } = await mount(api, f.aggregate); hold = true; await click(node, 'Refresh workflow')
  await act(async () => root.unmount()); roots.splice(roots.indexOf(root), 1)
  expect(signals).toHaveLength(3); expect(signals.every(s => s.aborted)).toBe(true)
  await act(async () => releases.forEach(resolve => resolve()))
  expect(node.textContent).toBe('')
})
it.each([false, true])('pins the editor revision across an external edit (dirty=%s)', async dirty => {
  const f = workflowBrowserFixture(); const client = new WorkspaceWorkflowApi(f.api)
  f.seedDraft({ title: 'Draft', instructions: 'Original instruction', expectedArtifacts: [], acceptanceCriteria: [] })
  const id = Object.values(f.workflow.drafts)[0]!.id
  const { node } = await mount(f.api, f.aggregate)
  await fill(node, 'Draft selection', id); await fill(node, 'Confirmation assignee', f.agentId)
  if (dirty) await fill(node, 'Full instructions', 'Unsaved local edit')
  await client.mutate('workflow/draft/edit', { draftId: id, expectedDraftRevision: 0, brief: { title: 'Draft', instructions: 'External edit', expectedArtifacts: [], acceptanceCriteria: [] } }, { expectedAggregateRevision: f.aggregate.revision, expectedWorkflowRevision: 1 }, 'external')
  await click(node, 'Refresh workflow')
  expect(control(node, 'Full instructions').value).toBe(dirty ? 'Unsaved local edit' : 'Original instruction')
  expect(button(node, 'Save draft changes').disabled).toBe(true)
  expect(button(node, 'Discard draft').disabled).toBe(true)
  expect(button(node, en['chat.confirmInChat']).disabled).toBe(true)
  await click(node, 'Save draft changes'); await click(node, 'Discard draft'); await click(node, en['chat.confirmInChat'])
  expect(f.workflow.drafts[id]?.brief.instructions).toBe('External edit')
  expect(f.workflow.drafts[id]?.revision).toBe(1)
  expect(node.textContent).toContain('Loaded draft revision 0 differs from current revision 1')
  await click(node, 'Reload selected draft')
  expect(control(node, 'Full instructions').value).toBe('External edit')
  expect(control(node, 'Confirmation assignee').value).toBe('')
  await fill(node, 'Full instructions', 'Reviewed external edit'); await click(node, 'Save draft changes')
  expect(f.workflow.drafts[id]?.revision).toBe(2)
  expect(f.commands.at(-1)).toMatchObject({ type: 'workflow/draft/edit', expectedDraftRevision: 1 })
})
function failOnce(f: ReturnType<typeof workflowBrowserFixture>, endpointToFail: string, afterCommit = false) {
  let failed = false
  const attempts: Record<string, unknown>[] = []
  const api = new WorkspaceApi({ rpc: { call: async (_c: string, endpoint: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    const shouldFail = endpoint === endpointToFail && !failed
    if (endpoint === endpointToFail) attempts.push(structuredClone(payload))
    if (shouldFail && !afterCommit) { failed = true; return { ok: false, error: { kind: 'business', code: 'stale-workflow-revision', message: 'Stale', details: { expectedWorkflowRevision: Number(payload['expectedWorkflowRevision']), actualWorkflowRevision: f.workflow.revision + 1 } } } }
    const value = endpoint === 'snapshot' ? await f.api.snapshot(signal) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), signal)
    if (shouldFail) { failed = true; throw new Error('Connection lost after commit') }
    return { ok: true, value }
  } } } as never).forWorkspace('workspace')
  return { api, attempts }
}
it('revokes the visible draft edit retry on an assignee change while retaining its semantic operation', async () => {
  const f = workflowBrowserFixture(); const bob = f.addColleague('Bob')
  f.seedDraft({ title: 'Draft', instructions: 'Work', expectedArtifacts: [], acceptanceCriteria: [] })
  const failed = failOnce(f, 'workflow/draft/edit'); const { node } = await mount(failed.api, f.aggregate)
  await fill(node, 'Draft selection', Object.values(f.workflow.drafts)[0]!.id); await fill(node, 'Confirmation assignee', f.agentId); await click(node, 'Save draft changes')
  expect(button(node, 'Retry identical workflow action')).toBeDefined()
  await fill(node, 'Confirmation assignee', bob)
  expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Retry identical workflow action')).toBe(false)
  await click(node, 'Save draft changes')
  expect(failed.attempts[1]?.['operationId']).toBe(failed.attempts[0]?.['operationId'])
  expect(Object.values(f.workflow.drafts)[0]?.revision).toBe(1)
  expect(Object.values(f.aggregate.tasks)).toHaveLength(0)
})
it('revokes a retained draft edit retry when refresh changes its pinned revision', async () => {
  const f = workflowBrowserFixture(); const client = new WorkspaceWorkflowApi(f.api)
  f.seedDraft({ title: 'Draft', instructions: 'Work', expectedArtifacts: [], acceptanceCriteria: [] })
  const id = Object.values(f.workflow.drafts)[0]!.id
  const failed = failOnce(f, 'workflow/draft/edit'); const { node } = await mount(failed.api, f.aggregate)
  await fill(node, 'Draft selection', id); await click(node, 'Save draft changes')
  expect(button(node, 'Retry identical workflow action')).toBeDefined()
  await client.mutate('workflow/draft/edit', { draftId: id, expectedDraftRevision: 0, brief: { title: 'Draft', instructions: 'New external work', expectedArtifacts: [], acceptanceCriteria: [] } }, { expectedAggregateRevision: f.aggregate.revision, expectedWorkflowRevision: f.workflow.revision }, 'external')
  await click(node, 'Refresh workflow')
  expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Retry identical workflow action')).toBe(false)
  expect(Object.values(f.aggregate.tasks)).toHaveLength(0)
})
it.each([
  ['Full instructions', 'Changed brief'], ['Task template name', 'Changed template'], ['Company template name', 'Changed company'],
])('revokes a retained retry after changing %s', async (label, value) => {
  const f = workflowBrowserFixture(); const id = f.seedDraft(); const failed = failOnce(f, 'workflow/draft/edit'); const { node } = await mount(failed.api, f.aggregate)
  await fill(node, 'Draft selection', id); await writeBrief(node); await click(node, 'Save draft changes'); expect(button(node, 'Retry identical workflow action')).toBeDefined()
  await fill(node, label, value)
  expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Retry identical workflow action')).toBe(false)
})
it.each([['Human review decision', 'changes-requested'], ['Review comment', 'Changed review'], ['Exact result selection', ''], ['Artifact label', 'Changed artifact']])('revokes result retry after changing %s', async (label, value) => {
  const f = workflowBrowserFixture(); f.seedConfirmed()
  f.complete()
  const failed = failOnce(f, 'workflow/result/review'); const { node } = await mount(failed.api, f.aggregate)
  await fill(node, 'Exact result selection', f.aggregate.events.find(e => e.type === 'task/result')!.id); await click(node, 'Submit review for this result')
  expect(button(node, 'Retry identical workflow action')).toBeDefined()
  await fill(node, label, value)
  expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Retry identical workflow action')).toBe(false)
})
it('retries an unknown committed company creation with the same identity without duplicating a template', async () => {
  const f = workflowBrowserFixture(); const failed = failOnce(f, 'workflow/company-template/create', true); const { node } = await mount(failed.api, f.aggregate)
  await configureCompany(node, f); await click(node, 'Create company template')
  expect(node.textContent).toContain('The action outcome is unavailable')
  expect(Object.values(f.workflow.companyTemplates)).toHaveLength(1)
  await click(node, 'Retry identical workflow action')
  expect(Object.values(f.workflow.companyTemplates)).toHaveLength(1)
  expect(failed.attempts[1]?.['operationId']).toBe(failed.attempts[0]?.['operationId'])
})
it.each(['Expected artifacts (one per line)', 'Acceptance criteria (one per line)'])('retains Enter and subsequent typed characters in %s', async label => {
  const f = workflowBrowserFixture(); const id = f.seedDraft(); const { node } = await mount(f.api, f.aggregate)
  await fill(node, 'Draft selection', id); await fill(node, 'Work title', 'Multiline'); await fill(node, 'Full instructions', 'Work')
  await fill(node, label, '')
  const input = control(node, label) as HTMLTextAreaElement
  const type = async (key: string) => {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, input.value + (key === 'Enter' ? '\n' : key))
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: key === 'Enter' ? 'insertLineBreak' : 'insertText', data: key === 'Enter' ? null : key }))
      input.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
    })
  }
  for (const char of 'First item') await type(char)
  await type('Enter')
  expect(input.value).toBe('First item\n')
  for (const char of 'Second item') await type(char)
  expect(input.value).toBe('First item\nSecond item')
  await type('Enter'); await type(' ')
  expect(input.value).toBe('First item\nSecond item\n ')
  await click(node, 'Save draft changes')
  const brief = Object.values(f.workflow.drafts)[0]!.brief
  expect(label.startsWith('Expected') ? brief.expectedArtifacts : brief.acceptanceCriteria).toEqual(['First item', 'Second item'])
})
async function fillAt(node: HTMLElement, name: string, index: number, value: string) {
  const label = [...node.querySelectorAll('label')].filter(l => l.querySelector('span')?.textContent === name)[index]!
  const input = label.querySelector('input,select') as HTMLInputElement | HTMLSelectElement
  await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })
}
function memberCheckbox(node: HTMLElement, name: string, index = 0): HTMLInputElement { return [...node.querySelectorAll('label')].filter(l => l.textContent === name)[index]!.querySelector('input')! }
async function configureCompany(node: HTMLElement, f: ReturnType<typeof workflowBrowserFixture>) {
  await fill(node, 'Company template name', 'Team'); await click(node, 'Add configured colleague'); await fill(node, 'New colleague name', 'Bob'); await fill(node, 'Pinned role revision', f.roleRevisionId)
  await click(node, 'Add configured group'); await fill(node, 'New group name', 'Group'); await act(async () => memberCheckbox(node, 'Bob').click())
}
it('renames a selected company colleague without losing or hiding group membership', async () => {
  const f = workflowBrowserFixture(); const { node } = await mount(f.api, f.aggregate); await configureCompany(node, f)
  await fill(node, 'New colleague name', 'Robert')
  expect(memberCheckbox(node, 'Robert').checked).toBe(true)
  await click(node, 'Create company template')
  const revision = Object.values(f.workflow.companyTemplateRevisions)[0]!
  expect(revision.config.groups[0]?.memberNames).toEqual(['Robert'])
  expect(revision.config.colleagues[0]?.name).toBe('Robert')
})
it('removes a selected company colleague and its group reference without selecting another row', async () => {
  const f = workflowBrowserFixture(); const { node } = await mount(f.api, f.aggregate); await configureCompany(node, f)
  await click(node, 'Add configured colleague'); await fillAt(node, 'New colleague name', 1, 'Carol'); await fillAt(node, 'Pinned role revision', 1, f.roleRevisionId)
  await click(node, 'Remove configured colleague')
  expect(memberCheckbox(node, 'Carol').checked).toBe(false)
  await click(node, 'Create company template')
  const revision = Object.values(f.workflow.companyTemplateRevisions)[0]!
  expect(revision.config.colleagues.map(c => c.name)).toEqual(['Carol'])
  expect(revision.config.groups[0]?.memberNames).toEqual([])
})
it('rejects duplicate and blank names while preserving membership on its original row', async () => {
  const f = workflowBrowserFixture(); const { node } = await mount(f.api, f.aggregate); await configureCompany(node, f)
  await click(node, 'Add configured colleague'); await fillAt(node, 'New colleague name', 1, 'Carol'); await fillAt(node, 'Pinned role revision', 1, f.roleRevisionId)
  await fill(node, 'New colleague name', 'Carol')
  expect(memberCheckbox(node, 'Carol', 0).checked).toBe(true)
  expect(memberCheckbox(node, 'Carol', 1).checked).toBe(false)
  await click(node, 'Create company template'); expect(Object.values(f.workflow.companyTemplates)).toHaveLength(0)
  await fillAt(node, 'New colleague name', 1, 'Dave'); await fill(node, 'New colleague name', ' ')
  await click(node, 'Create company template'); expect(Object.values(f.workflow.companyTemplates)).toHaveLength(0)
  await fill(node, 'New colleague name', 'Robert'); expect(memberCheckbox(node, 'Robert').checked).toBe(true); expect(memberCheckbox(node, 'Dave').checked).toBe(false)
  await click(node, 'Create company template')
  expect(Object.values(f.workflow.companyTemplateRevisions)[0]?.config.groups[0]?.memberNames).toEqual(['Robert'])
})
it('invalidates old company preview and new-events confirmation when its editor configuration changes', async () => {
  const f = workflowBrowserFixture(); const { node } = await mount(f.api, f.aggregate); await configureCompany(node, f); await click(node, 'Create company template')
  const root = Object.values(f.workflow.companyTemplates)[0]!
  await fill(node, 'Company template selection', root.id); await fill(node, 'Company template revision', root.currentRevisionId); await click(node, 'Preview selected company revision')
  await act(async () => [...node.querySelectorAll('label')].find(l => l.textContent?.startsWith('I confirm:'))!.querySelector('input')!.click())
  expect(button(node, 'Confirm company configuration').disabled).toBe(false)
  await fill(node, 'New colleague name', 'Robert')
  expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Confirm company configuration')).toBe(false)
  expect(Object.values(f.aggregate.agents)).toHaveLength(1)
  await click(node, 'Save company template revision')
  const updated = f.workflow.companyTemplates[root.id]!
  await fill(node, 'Company template revision', updated.currentRevisionId); await click(node, 'Preview selected company revision')
  expect(node.textContent).toContain('New colleague Robert')
  expect(button(node, 'Confirm company configuration').disabled).toBe(true)
  expect(f.workflow.companyTemplateRevisions[root.currentRevisionId]?.config.colleagues[0]?.name).toBe('Bob')
})
it.each([['New colleague name', 'Robert'], ['New group name', 'Changed group'], ['Pinned role revision', '']])('revokes company creation retry when %s changes', async (label, value) => {
  const f = workflowBrowserFixture(); const failed = failOnce(f, 'workflow/company-template/create'); const { node } = await mount(failed.api, f.aggregate)
  await configureCompany(node, f); await click(node, 'Create company template')
  expect(button(node, 'Retry identical workflow action')).toBeDefined()
  await fill(node, label, value)
  expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Retry identical workflow action')).toBe(false)
  if (label !== 'Pinned role revision') {
    await click(node, 'Create company template')
    expect(Object.values(f.workflow.companyTemplates)).toHaveLength(1)
    expect(failed.attempts[1]?.['operationId']).not.toBe(failed.attempts[0]?.['operationId'])
  }
})
it('revokes company creation retry when a selected member is removed from the form', async () => {
  const f = workflowBrowserFixture(); const failed = failOnce(f, 'workflow/company-template/create'); const { node } = await mount(failed.api, f.aggregate)
  await configureCompany(node, f); await click(node, 'Create company template'); expect(button(node, 'Retry identical workflow action')).toBeDefined()
  await act(async () => memberCheckbox(node, 'Bob').click())
  expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Retry identical workflow action')).toBe(false)
  await click(node, 'Create company template')
  expect(Object.values(f.workflow.companyTemplateRevisions)[0]?.config.groups[0]?.memberNames).toEqual([])
  expect(failed.attempts[1]?.['operationId']).not.toBe(failed.attempts[0]?.['operationId'])
})
function holdSuccess(f: ReturnType<typeof workflowBrowserFixture>, heldEndpoint: string) {
  let reached!: () => void; let release!: () => void
  const pending = new Promise<void>(resolve => { reached = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const api = new WorkspaceApi({ rpc: { call: async (_c: string, endpoint: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    const value = endpoint === 'snapshot' ? await f.api.snapshot(signal) : await f.api.callWorkflow(endpoint as never, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'workspaceId')), signal)
    if (endpoint === heldEndpoint) { reached(); await barrier }
    return { ok: true, value }
  } } } as never).forWorkspace('workspace')
  return { api, pending, release }
}
it.each(['unchanged', 'edited', 'different draft'] as const)('preserves current edits after pending task template creation (%s)', async change => {
  const f = workflowBrowserFixture(); const bob = f.addColleague('Bob')
  const submittedId = f.seedDraft()
  const existingId = change === 'different draft' ? f.seedDraft({ title: 'Existing draft', instructions: 'Existing instructions', expectedArtifacts: [], acceptanceCriteria: [] }) : undefined
  const held = holdSuccess(f, 'workflow/task-template/create'); const { node } = await mount(held.api, f.aggregate)
  try {
    await fill(node, 'Draft selection', submittedId); await writeBrief(node, 'Submitted title'); await fill(node, 'Full instructions', 'Submitted instructions'); await fill(node, 'Confirmation assignee', f.agentId); await fill(node, 'Task template name', 'Submitted template')
    await click(node, 'Create task template'); await held.pending
    expect(f.commands.filter(c => c.type === 'workflow/task-template/create' && c.brief.title === 'Submitted title')).toHaveLength(1)
    expect(control(node, 'Work title').disabled).toBe(false)
    if (change === 'edited') {
      await fill(node, 'Work title', 'New unsaved title'); await fill(node, 'Full instructions', 'New unsaved instructions')
      await fill(node, 'Expected artifacts (one per line)', 'New artifact\nSecond artifact'); await fill(node, 'Acceptance criteria (one per line)', 'New criterion')
      await fill(node, 'Confirmation assignee', bob)
      expect(control(node, 'Work title').value).toBe('New unsaved title')
      expect(control(node, 'Full instructions').value).toBe('New unsaved instructions')
    } else if (change === 'different draft') {
      await fill(node, 'Draft selection', existingId!); await fill(node, 'Confirmation assignee', bob)
      expect(control(node, 'Work title').value).toBe('Existing draft')
    }
    await act(async () => held.release())
    const saved = Object.values(f.workflow.taskTemplateRevisions).find(d => d.brief.title === 'Submitted title')!
    expect(saved.brief).toEqual({ title: 'Submitted title', instructions: 'Submitted instructions', expectedArtifacts: ['Report file'], acceptanceCriteria: ['Reviewed'] })
    expect(f.commands.filter(c => c.type === 'workflow/task-template/create' && c.brief.title === 'Submitted title')).toHaveLength(1)
    expect(control(node, 'Work title').value).toBe(change === 'edited' ? 'New unsaved title' : change === 'different draft' ? 'Existing draft' : 'Submitted title')
    expect(control(node, 'Full instructions').value).toBe(change === 'edited' ? 'New unsaved instructions' : change === 'different draft' ? 'Existing instructions' : 'Submitted instructions')
    expect(control(node, 'Confirmation assignee').value).toBe(change === 'unchanged' ? f.agentId : bob)
    if (change === 'edited') {
      expect(control(node, 'Expected artifacts (one per line)').value).toBe('New artifact\nSecond artifact')
      expect(control(node, 'Acceptance criteria (one per line)').value).toBe('New criterion')
    }
    expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Retry identical workflow action')).toBe(false)
  } finally { await act(async () => held.release()) }
})
it.each([false, true])('clears only submitted artifact inputs after pending success (edited=%s)', async edited => {
  const f = workflowBrowserFixture(); f.seedConfirmed()
  f.complete()
  const held = holdSuccess(f, 'workflow/artifact/register'); const { node } = await mount(held.api, f.aggregate)
  try {
    const result = f.aggregate.events.find(e => e.type === 'task/result')!
    await fill(node, 'Exact result selection', result.id); await fill(node, 'Artifact label', 'Submitted artifact'); await fill(node, 'Artifact summary', 'Submitted summary')
    await fill(node, 'Artifact reference type', 'path'); await fill(node, 'Reference value', 'C:/submitted.txt')
    await click(node, 'Register artifact for this result'); await held.pending
    expect(Object.values(f.workflow.artifacts)).toHaveLength(1)
    expect(control(node, 'Artifact label').disabled).toBe(false)
    if (edited) {
      await fill(node, 'Artifact label', 'New unsaved artifact'); await fill(node, 'Artifact summary', 'New unsaved summary')
      await fill(node, 'Artifact reference type', 'url'); await fill(node, 'Reference value', 'https://example.test/new')
      expect(control(node, 'Artifact label').value).toBe('New unsaved artifact')
      expect(control(node, 'Artifact summary').value).toBe('New unsaved summary')
    }
    await act(async () => held.release())
    expect(Object.values(f.workflow.artifacts)).toHaveLength(1)
    expect(Object.values(f.workflow.artifacts)[0]).toMatchObject({ label: 'Submitted artifact', summary: 'Submitted summary', reference: { kind: 'path', value: 'C:/submitted.txt' }, result: { eventId: result.id } })
    expect(f.commands.filter(c => c.type === 'workflow/artifact/register')).toHaveLength(1)
    expect(control(node, 'Artifact label').value).toBe(edited ? 'New unsaved artifact' : '')
    expect(control(node, 'Artifact summary').value).toBe(edited ? 'New unsaved summary' : '')
    expect(control(node, 'Artifact reference type').value).toBe(edited ? 'url' : 'path')
    expect(control(node, 'Reference value').value).toBe(edited ? 'https://example.test/new' : '')
    expect([...node.querySelectorAll('button')].some(b => b.textContent === 'Retry identical workflow action')).toBe(false)
  } finally { await act(async () => held.release()) }
})
