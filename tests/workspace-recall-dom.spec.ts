// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { WorkspaceRecallDialog } from '../packages/web/src/client/WorkspaceRecall.tsx'
import { en } from '../packages/web/src/client/locales.ts'
const cleanups: (() => Promise<void>)[] = []
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function mount(files: readonly { id: string; path: string; status: string; before: { existed: false }; after: { existed: false }; text?: { before: string; after: string } }[] = [], fail = false, refreshFails = false) {
  const calls: unknown[] = [], changed = vi.fn(), closed = vi.fn()
  if (refreshFails) changed.mockRejectedValue(new Error('refresh failed'))
  const api = { workspaceId: 'local', readOnly: false, callCommunication: async (endpoint: string, payload: unknown) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'communication/recall-preview') return { affectedAgentIds: ['alice'], invalidatedEventIds: ['source'], invalidatedTaskIds: [], fileCheckpointIds: [], conservative: true, files }
    if (endpoint === 'communication/recall') { if (fail) throw new Error('network'); return { workspaceId: 'local', aggregateRevision: 3, workflowRevision: 0, communication: { revision: 1, nextCheckpointOrder: 1, messages: {}, taskSources: {}, draftSources: {}, inputs: {}, contexts: {}, resets: {}, fileCheckpoints: {}, operations: {} } } }
    throw new Error(endpoint)
  } }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove() })
  const snapshot = { revision: 2, agents: { alice: { name: 'Alice' } } }
  const t = (key: string, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce((text, [k, value]) => text.replaceAll(`{${k}}`, String(value)), en[key as keyof typeof en] ?? key)
  await act(async () => root.render(createElement(WorkspaceRecallDialog, { api, snapshot, event: { id: 'source', subjectId: 'room' }, onChanged: changed, onClose: closed, t } as never)))
  return { container, calls, changed, closed }
}
test('withdrawal preview names affected people, leaves optional file recovery off and excludes unsupported recovery', async () => {
  const f = await mount()
  expect(f.container.textContent).toContain('Alice')
  expect(f.container.querySelector('input[type="checkbox"]')).toBeNull()
  expect(f.container.textContent).toContain(en['recall.untracked'])
})

test('keeps cancellation secondary to withdrawal confirmation and closes without submitting', async () => {
  const f = await mount()
  const cancel = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === en['room.cancel'])!
  const confirm = f.container.querySelector<HTMLButtonElement>('[data-confirm-recall]')!
  expect(cancel.getAttribute('data-variant')).toBe('ghost')
  expect(confirm.getAttribute('data-variant')).not.toBe('ghost')
  await act(async () => cancel.click())
  expect(f.closed).toHaveBeenCalledOnce()
  expect(f.calls).toHaveLength(1)
})
test('file restoration is opt-in and retry keeps the same durable withdrawal identity', async () => {
  const f = await mount([{ id: 'cp', path: 'result.txt', status: 'restorable', before: { existed: false }, after: { existed: false } }], true)
  const checkbox = f.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(checkbox.checked).toBe(false)
  const submit = () => f.container.querySelector<HTMLButtonElement>('button[data-confirm-recall]')!
  await act(async () => submit().click())
  expect(f.container.querySelector('[role="alert"]')).not.toBeNull()
  await act(async () => submit().click())
  const requests = f.calls.filter((call): call is { endpoint: string; payload: { operationId: string; restoreFiles: boolean } } => (call as { endpoint: string }).endpoint === 'communication/recall')
  expect(requests).toHaveLength(2)
  expect(requests[0]!.payload.operationId).toBe(requests[1]!.payload.operationId)
  expect(requests[0]!.payload.restoreFiles).toBe(false)
  expect(f.closed).not.toHaveBeenCalled()
})

test('a failed view refresh cannot relabel completed memory cleanup as failed', async () => {
  const f = await mount([], false, true)
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-confirm-recall]')!.click())
  expect(f.container.textContent).toContain(en['recall.memoryComplete'])
  expect(f.container.textContent).not.toContain(en['recall.failed'])
  expect(f.container.textContent).toContain(en['recall.refreshFailed'])
})

test('shows trusted before and after file text in a folded difference preview', async () => {
  const f = await mount([{ id: 'cp', path: 'report.txt', status: 'restorable', before: { existed: false }, after: { existed: false }, text: { before: '原稿\r\n', after: '修订\n' } }])
  const preview = f.container.querySelector<HTMLDetailsElement>('[data-file-diff]')
  expect(preview?.open).toBe(false)
  expect(preview?.textContent).toContain('原稿')
  expect(preview?.textContent).toContain('修订')
})
