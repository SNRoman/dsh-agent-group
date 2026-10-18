// @vitest-environment jsdom

import { act, createElement, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceOverlay } from '../packages/web/src/client/WorkspaceUi.tsx'
import { WorkspaceOrganizations } from '../packages/web/src/client/WorkspaceOrganizations.tsx'
import { WorkspaceColleagueProfile } from '../packages/web/src/client/WorkspaceColleagueProfile.tsx'
import { createWorkspaceUiStore } from '../packages/web/src/client/store.ts'
import type { WorkspaceUiState } from '../packages/web/src/client/store.ts'
import { WorkspaceApiClient, WorkspaceApiError } from '../packages/web/src/client/api.ts'
import type { WorkspaceActivitySnapshot } from '../packages/web/src/client/contracts.ts'
import type { CommunicationSnapshot } from '../packages/web/src/client/communication-api.ts'
import { en } from '../packages/web/src/client/locales.ts'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import { joinRoomWithMemory } from '../packages/host/src/memory.ts'
import { createInitialWorkflowState } from '../packages/host/src/workflow.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ MarkdownText: ({ text }: { text: string }) => text, DisclosureRow: () => null }))
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
const mounted: Array<{ root: Root; container: HTMLDivElement }> = []
const restoreScrollMetrics: Array<() => void> = []
afterEach(async () => {
  try { for (const item of mounted.splice(0)) await act(async () => { item.root.unmount(); item.container.remove() }) }
  finally { for (const restore of restoreScrollMetrics.splice(0).reverse()) restore() }
})

function installScrollMetrics(): void {
  const positions = new WeakMap<HTMLElement, number>()
  const height = (element: HTMLElement): number => element.querySelectorAll('[data-message-id]').length * 600
    + [...element.querySelectorAll('.dsh-agent-group-live-blocks')].reduce((total, block) => total + 200 + (block.textContent?.length ?? 0) * 10, 0)
  // jsdom has no layout or automatic scroll clamping after children disappear.
  for (const name of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    const inherited = Object.getOwnPropertyDescriptor(Element.prototype, name)!
    restoreScrollMetrics.push(() => {
      if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
      else Object.defineProperty(HTMLElement.prototype, name, original)
    })
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.classList.contains('dsh-agent-group-messages')) return inherited.get!.call(this)
        if (name === 'scrollHeight') return Math.max(200, height(this))
        if (name === 'clientHeight') return 400
        const top = Math.max(0, Math.min(positions.get(this) ?? 0, height(this) - 400))
        positions.set(this, top)
        return top
      },
      ...(name === 'scrollTop' ? { set(this: HTMLElement, top: number) {
        if (!this.classList.contains('dsh-agent-group-messages')) { inherited.set!.call(this, top); return }
        positions.set(this, Math.max(0, Math.min(top, height(this) - 400)))
      } } : {}),
    })
  }
}

async function mount(withAnotherColleague: boolean | number = false, renameFails = false, departedColleague = false, withProposal = false, withSecondRoom = false, options: { readonly shadow?: boolean; readonly organizations?: boolean } = {}) {
  const definition = mutateWorkspace(createInitialState(WorkspaceId('local')), { type: 'definition/create', name: '工程师', description: '当前职责', instructions: '当前指令' })
  const agent = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: '小林' })
  const room = mutateWorkspace(agent.state, { type: 'room/create', kind: 'group', name: '产品讨论' })
  let state = mutateWorkspace(room.state, { type: 'room/join', roomId: room.roomId, agentId: agent.agentId, memoryStart: { type: 'new-events' } }).state
  for (let index = 0; index < (typeof withAnotherColleague === 'number' ? withAnotherColleague : withAnotherColleague ? 1 : 0); index++) {
    const other = mutateWorkspace(state, { type: 'agent/create', definitionId: definition.definitionId, name: index === 0 ? '小王' : '小陈' })
    state = departedColleague ? mutateWorkspace(other.state, { type: 'agent/depart', agentId: other.agentId }).state : other.state
  }
  state = mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('web-user') }, text: '请 <@' + agent.agentId + '> 看一下', mentions: [agent.agentId] }).state
  state = mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: agent.agentId }, text: '好的', mentions: [] }).state
  if (withSecondRoom) {
    const second = mutateWorkspace(state, { type: 'room/create', kind: 'group', name: '另一群' })
    state = mutateWorkspace(second.state, { type: 'room/message', roomId: second.roomId, actor: { type: 'human', id: HumanId('web-user') }, text: '第二群的问题', mentions: [] }).state
    state = mutateWorkspace(state, { type: 'room/message', roomId: second.roomId, actor: { type: 'agent', id: agent.agentId }, text: '第二群的回复', mentions: [] }).state
  }
  let stream: WorkspaceActivitySnapshot = { version: 0, workspaceRevision: state.revision, activities: [], agents: [] }
  let metadataGate: Promise<void> | undefined
  let joinFailure: { readonly agentId: string; readonly stale: boolean } | undefined
  let leaveFailure = false
  let leaveGate: Promise<void> | undefined
  let memoryRemoval: CommunicationSnapshot['communication']['resets'][string] | undefined
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const rpc = { call: async (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'organization/list') return { ok: true, value: [{ descriptor: { id: 'local', label: 'Local organization', lifecycle: 'active' }, revision: state.revision, agentCount: Object.keys(state.agents).length, eventCount: state.events.length }] }
    if (endpoint === 'snapshot') return { ok: true, value: state }
    if (endpoint === 'runtime/activity/snapshot') return { ok: true, value: stream }
    if (endpoint === 'runtime/activity/wait') return await new Promise<never>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }) })
    if (endpoint === 'definition/history') return { ok: true, value: [] }
    if (endpoint === 'communication/snapshot') {
      const value: CommunicationSnapshot = { workspaceId: 'local', aggregateRevision: state.revision, workflowRevision: 0, communication: { revision: 0, nextCheckpointOrder: 1, messages: {}, taskSources: {}, draftSources: withProposal ? { proposal: { roomId: room.roomId, eventId: state.events.at(-1)!.id } } : {}, inputs: {}, contexts: {}, resets: memoryRemoval === undefined ? {} : { [memoryRemoval.id]: memoryRemoval }, fileCheckpoints: {}, operations: {} } }
      await metadataGate
      return { ok: true, value }
    }
    if (endpoint === 'workflow/snapshot') return { ok: true, value: { workspaceId: 'local', aggregateRevision: state.revision, workflow: { ...createInitialWorkflowState(), drafts: { proposal: { id: 'proposal', revision: 1, status: 'draft', source: { type: 'employee', id: agent.agentId }, suggestedAssigneeAgentId: agent.agentId, brief: { title: 'Report', instructions: 'Write the report', expectedArtifacts: [], acceptanceCriteria: [] } } } } } }
    if (endpoint === 'communication/assign') {
      const input = payload as { roomId: string; brief: { instructions: string }; assigneeAgentId: string }
      const posted = mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('web-user') }, text: input.brief.instructions, mentions: [agent.agentId] })
      state = posted.state
      return { ok: true, value: { workspaceId: 'local', aggregateRevision: state.revision, workflowRevision: 2, communicationRevision: 1, value: { source: { roomId: room.roomId, eventId: posted.eventId }, draftId: 'draft', taskId: 'work', taskAssignmentId: 'assigned' }, replayed: false } }
    }
    if (endpoint === 'room/post') {
      const input = payload as { text: string }
      state = mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'human', id: HumanId('web-user') }, text: input.text, mentions: [] }).state
      return { ok: true, value: { revision: state.revision, value: state } }
    }
    if (endpoint === 'room/join') {
      if (renameFails) throw new Error('Join unavailable')
      const input = payload as { roomId: string; agentId: string; memoryStart: { type: 'event-range'; startSequence: number; endSequence: number }; expectedRevision: number }
      if (joinFailure?.agentId === input.agentId) {
        const { stale } = joinFailure
        joinFailure = undefined
        if (!stale) throw new Error('Join unavailable')
        state = mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: agent.agentId }, text: '批量加入期间的新消息', mentions: [] }).state
      }
      if (input.expectedRevision !== state.revision) throw new WorkspaceApiError({ kind: 'business', code: 'stale-revision', message: 'Workspace changed', details: { expectedRevision: input.expectedRevision, actualRevision: state.revision } })
      state = joinRoomWithMemory(state, { type: 'room/join', roomId: input.roomId as typeof room.roomId, agentId: input.agentId as typeof agent.agentId, memoryStart: input.memoryStart }).state
      return { ok: true, value: { revision: state.revision, value: state } }
    }
    if (endpoint === 'room/leave' || endpoint === 'room/leave-and-forget') {
      await leaveGate
      if (leaveFailure) { leaveFailure = false; throw new Error('Leave unavailable') }
      const input = payload as { membershipId: keyof typeof state.memberships; operationId?: string }
      if (state.memberships[input.membershipId]?.leftEventId === undefined) state = mutateWorkspace(state, { type: 'room/leave', membershipId: input.membershipId }).state
      if (memoryRemoval !== undefined && memoryRemoval.id === input.operationId) memoryRemoval = { ...memoryRemoval, status: 'completed', error: undefined }
      return { ok: true, value: { revision: state.revision, value: state } }
    }
    if (endpoint === 'definition/create') {
      const input = payload as { name: string; description: string; instructions: string }
      state = mutateWorkspace(state, { type: 'definition/create', ...input }).state
      return { ok: true, value: { revision: state.revision, value: state } }
    }
    if (endpoint === 'memory/query') {
      const event = state.events.find(item => item.type === 'room/message')!
      return { ok: true, value: { snapshotRevision: state.revision, items: [{ eventId: event.id, sequence: event.sequence, type: event.type, provenance: 'room-membership', source: { kind: 'room', id: room.roomId, label: '产品讨论' }, text: event.text, definitionRevision: { status: 'unresolved' } }] } }
    }
    if (endpoint === 'room/rename' || endpoint === 'agent/rename') {
      if (renameFails) throw new Error('RPC unavailable')
      const value = payload as { roomId?: string; agentId?: string; name: string; expectedRevision: number }
      state = endpoint === 'room/rename'
        ? mutateWorkspace(state, { type: 'room/rename', roomId: room.roomId, name: value.name }).state
        : mutateWorkspace(state, { type: 'agent/rename', agentId: agent.agentId, name: value.name }).state
      return { ok: true, value: { revision: state.revision, value: state } }
    }
    throw new Error('Unexpected endpoint: ' + endpoint)
  } }
  const rootApi = new WorkspaceApiClient({ rpc } as never)
  const api = options.organizations ? rootApi : rootApi.forWorkspace('local')
  const container = document.createElement('div')
  const host = options.shadow ? document.createElement('div') : container
  if (options.shadow) host.attachShadow({ mode: 'open' }).append(container)
  document.body.append(host)
  const root = createRoot(container)
  mounted.push({ root, container: host })
  const store = createWorkspaceUiStore() as { definition: { actions: Record<string, (draft: WorkspaceUiState, ...args: never[]) => void> } }
  function Harness() {
    const [ui, setUi] = useState<WorkspaceUiState>({ open: true, mode: 'conversations', selectedWorkspaceId: 'local', selectedRoomId: room.roomId, snapshot: state, busy: false })
    const actions = useMemo(() => Object.fromEntries(Object.entries(store.definition.actions).map(([name, action]) => [name, (...args: never[]) => setUi(current => { const next = { ...current }; action(next, ...args); return next })])), [])
    const t = (key: string, params?: Record<string, string | number>) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key as keyof typeof en] ?? key)
    return createElement(options.organizations ? WorkspaceOrganizations : WorkspaceOverlay, { api, useStore: (select: (value: WorkspaceUiState) => unknown) => select(ui), actions, t } as never)
  }
  await act(async () => root.render(createElement(Harness)))
  return {
    container, agentId: agent.agentId, roomId: room.roomId, current: () => state, calls,
    failNextJoinFor: (agentId: string, stale = false) => { joinFailure = { agentId, stale } },
    failNextLeave: () => { leaveFailure = true },
    seedMemoryRemoval: (status: 'pending' | 'failed') => {
      const membership = Object.values(state.memberships).find(item => item.agentId === agent.agentId)!
      state = mutateWorkspace(state, { type: 'room/leave', membershipId: membership.id }).state
      const source = state.events.at(-1)!
      memoryRemoval = { id: 'pending-memory-removal', kind: 'room-memory-forget', membershipId: membership.id, source: { roomId: room.roomId, eventId: source.id }, requestedByHumanId: 'web-user', fromSequence: source.sequence, throughSequence: source.sequence, affectedAgentIds: [agent.agentId], previousGenerations: { [agent.agentId]: 0 }, forgottenEventIds: [], invalidatedEventIds: [], invalidatedTaskIds: [], invalidatedDraftIds: [], invalidatedTemplateRevisionIds: [], invalidatedArtifactIds: [], requestedAt: '2026-10-17T12:00:00.000Z', fileRestoreRequested: false, ...(status === 'failed' ? { status, error: 'Cleanup unavailable' } : { status }) }
      return membership.id
    },
    delayLeave: () => {
      let release = (): void => { throw new Error('Leave gate is not initialized') }
      leaveGate = new Promise<void>(resolve => { release = resolve })
      return (): void => { leaveGate = undefined; release() }
    },
    delayMetadata: () => {
      let release = (): void => { throw new Error('Metadata gate is not initialized') }
      let fail = (_error: Error): void => { throw new Error('Metadata gate is not initialized') }
      metadataGate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject })
      return (error?: Error): void => {
        metadataGate = undefined
        if (error === undefined) release()
        else fail(error)
      }
    },
    appendReply: () => {
      state = mutateWorkspace(state, { type: 'room/message', roomId: room.roomId, actor: { type: 'agent', id: agent.agentId }, text: '完成后的回复', mentions: [] }).state
      stream = { version: stream.version + 1, workspaceRevision: state.revision, activities: [], agents: [] }
    },
    setLiveText: (text: string) => {
      stream = { version: stream.version + 1, workspaceRevision: state.revision, activities: [{ activityId: 'streaming-reply', agentId: agent.agentId, source: { kind: 'room', roomId: room.roomId }, messageId: 'message', startOrder: 1, status: 'responding', claimed: { sessionId: 'session', turn: 1 }, blocks: [{ kind: 'text', index: 0, text }] }], agents: [] }
    },
    setAgentStatus: (status: WorkspaceActivitySnapshot['agents'][number]['status']) => {
      stream = { version: stream.version + 1, workspaceRevision: state.revision, activities: [], agents: [{ agentId: agent.agentId, status, usingTool: false }] }
    },
  }
}

it.each([{ position: 800, restored: 1400, label: 'bottom following' }, { position: 300, restored: 300, label: 'an earlier reading position' }])('preserves $label when reply metadata arrives after the durable snapshot', async ({ position, restored }) => {
  installScrollMetrics()
  const fixture = await mount()
  const messages = fixture.container.querySelector<HTMLDivElement>('.dsh-agent-group-messages')!
  await act(async () => { messages.scrollTop = position; messages.dispatchEvent(new Event('scroll', { bubbles: true })) })
  const releaseMetadata = fixture.delayMetadata()
  fixture.appendReply()
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click())
  expect(messages.querySelectorAll('[data-message-id]')).toHaveLength(0)
  expect(messages.textContent).not.toContain('完成后的回复')
  await act(async () => messages.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(messages.scrollTop).toBe(0)
  await act(async () => releaseMetadata())
  expect(fixture.container.querySelector('.dsh-agent-group-messages')).toBe(messages)
  expect(messages.querySelectorAll('[data-message-id]')).toHaveLength(3)
  expect(messages.scrollTop).toBe(restored)
})

it('follows streaming growth and stays at the final reply after stream retirement', async () => {
  installScrollMetrics()
  const fixture = await mount()
  const messages = fixture.container.querySelector<HTMLDivElement>('.dsh-agent-group-messages')!
  expect(messages.scrollTop).toBe(800)
  fixture.setLiveText('hello')
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click())
  expect(messages.scrollTop).toBe(1050)
  fixture.setLiveText('hello again')
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click())
  expect(messages.scrollTop).toBe(1110)
  const releaseMetadata = fixture.delayMetadata()
  fixture.appendReply()
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click())
  await act(async () => messages.dispatchEvent(new Event('scroll', { bubbles: true })))
  await act(async () => releaseMetadata())
  expect(messages.querySelector('.dsh-agent-group-live-turn')).toBeNull()
  expect(messages.textContent).toContain('完成后的回复')
  expect(messages.scrollTop).toBe(1400)
})

it('opens another room at the latest message after reading earlier messages in the current room', async () => {
  installScrollMetrics()
  const fixture = await mount(false, false, false, false, true)
  const first = fixture.container.querySelector<HTMLDivElement>('.dsh-agent-group-messages')!
  await act(async () => { first.scrollTop = 300; first.dispatchEvent(new Event('scroll', { bubbles: true })) })
  const otherRoom = [...fixture.container.querySelectorAll<HTMLButtonElement>('.dsh-agent-group-list-button')].find(button => button.textContent?.includes('另一群'))!
  await act(async () => otherRoom.click())
  const second = fixture.container.querySelector<HTMLDivElement>('.dsh-agent-group-messages')!
  expect(second).not.toBe(first)
  expect(second.textContent).toContain('第二群的回复')
  expect(second.scrollTop).toBe(800)
})

it('follows the human message after sending while reading earlier messages', async () => {
  installScrollMetrics()
  const fixture = await mount()
  const messages = fixture.container.querySelector<HTMLDivElement>('.dsh-agent-group-messages')!
  await act(async () => { messages.scrollTop = 300; messages.dispatchEvent(new Event('scroll', { bubbles: true })) })
  const composer = fixture.container.querySelector<HTMLTextAreaElement>('.dsh-agent-group-compose-row textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, '我发送的新消息')
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('.dsh-agent-group-compose-row button')!.click())
  expect(messages.textContent).toContain('我发送的新消息')
  expect(composer.value).toBe('')
  expect(messages.scrollTop).toBe(1400)
})

it('keeps reply text hidden after metadata failure and restores the reading position on retry', async () => {
  installScrollMetrics()
  const fixture = await mount()
  const messages = fixture.container.querySelector<HTMLDivElement>('.dsh-agent-group-messages')!
  await act(async () => { messages.scrollTop = 300; messages.dispatchEvent(new Event('scroll', { bubbles: true })) })
  const releaseMetadata = fixture.delayMetadata()
  fixture.appendReply()
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click())
  await act(async () => releaseMetadata(new Error('Metadata request failed')))
  expect(messages.querySelectorAll('[data-message-id]')).toHaveLength(0)
  expect(messages.textContent).not.toContain('完成后的回复')
  expect(messages.querySelector('[role="alert"]')).not.toBeNull()
  await act(async () => messages.dispatchEvent(new Event('scroll', { bubbles: true })))
  await act(async () => messages.querySelector<HTMLButtonElement>('[role="alert"] button')!.click())
  expect(messages.querySelector('[role="alert"]')).toBeNull()
  expect(messages.textContent).toContain('完成后的回复')
  expect(messages.scrollTop).toBe(300)
})

it('keeps the source reading position across metadata refresh before a scroll event arrives', async () => {
  installScrollMetrics()
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  restoreScrollMetrics.push(() => {
    if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original)
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: HTMLElement) {
      const messages = this.closest<HTMLDivElement>('.dsh-agent-group-messages')
      if (messages !== null) messages.scrollTop = 200
    },
  })
  const fixture = await mount()
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button.dsh-agent-group-mention')!.click())
  const memory = [...fixture.container.querySelectorAll<HTMLButtonElement>('[data-colleague-id][role="dialog"] button')].find(button => button.textContent === en['people.memory'])!
  await act(async () => memory.click())
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('[data-memory-source]')!.click())
  const messages = fixture.container.querySelector<HTMLDivElement>('.dsh-agent-group-messages')!
  expect(messages.querySelector('[data-highlighted="true"]')).not.toBeNull()
  expect(messages.scrollTop).toBe(200)
  const releaseMetadata = fixture.delayMetadata()
  fixture.appendReply()
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click())
  await act(async () => messages.dispatchEvent(new Event('scroll', { bubbles: true })))
  await act(async () => releaseMetadata())
  expect(messages.querySelector('[data-highlighted="true"]')).not.toBeNull()
  expect(messages.scrollTop).toBe(200)
})

it('shows different message bubbles for the human and colleague', async () => {
  const { container } = await mount()
  expect(container.querySelectorAll('.dsh-agent-group-message[data-author="human"]')).toHaveLength(1)
  expect(container.querySelectorAll('.dsh-agent-group-message[data-author="agent"]')).toHaveLength(1)
})

it('shows the role and employment beside the group member identity', async () => {
  const { container, agentId } = await mount()
  const member = container.querySelector<HTMLElement>('[role="group"][aria-label="小林"]')!
  const identity = member.querySelector<HTMLButtonElement>(`button[data-agent-id="${agentId}"]`)!
  expect(identity.querySelector('.dsh-agent-group-avatar')?.textContent).toBe('小')
  expect(identity.textContent).toContain('小林')
  expect(identity.textContent).toContain('工程师')
  expect(identity.textContent).toContain(en['agent.employed'])
  expect(identity.querySelector('button')).toBeNull()
  expect([...member.querySelectorAll('.dsh-agent-group-member-actions button')].map(button => button.textContent)).toEqual([en['room.direct'], en['room.remove']])
})

it.each(['idle', 'active', 'failed'] as const)('uses the same %s runtime status in group members and the colleague directory', async status => {
  const fixture = await mount()
  fixture.setAgentStatus(status)
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click())
  const member = fixture.container.querySelector<HTMLElement>('[role="group"][aria-label="小林"]')!
  if (status === 'idle') expect(member.querySelector('.dsh-agent-group-runtime-badges')).toBeNull()
  else expect(member.querySelector('.dsh-agent-group-runtime-badges')?.textContent).toBe(en[`activity.status.${status}`])
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Colleagues"]')!.click())
  const colleague = fixture.container.querySelector<HTMLElement>(`[data-colleague-list] [data-agent-id="${fixture.agentId}"]`)!
  if (status === 'idle') expect(colleague.querySelector('.dsh-agent-group-runtime-badges')).toBeNull()
  else expect(colleague.querySelector('.dsh-agent-group-runtime-badges')?.textContent).toBe(en[`activity.status.${status}`])
  expect(colleague.textContent).toContain('工程师')
  expect(colleague.textContent).toContain(en['agent.employed'])
})

it('shows the role and employment when selecting a colleague to add', async () => {
  const fixture = await mount(true)
  const other = Object.values(fixture.current().agents).find(agent => agent.name === '小王')!
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Add colleague"]')!.click())
  const choice = fixture.container.querySelector<HTMLElement>(`[data-add-colleague] [data-agent-id="${other.id}"]`)!
  expect(choice.querySelector('.dsh-agent-group-avatar')?.textContent).toBe('小')
  expect(choice.textContent).toContain('小王')
  expect(choice.textContent).toContain('工程师')
  expect(choice.textContent).toContain(en['agent.employed'])
  expect(choice.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
})

it('confirms removal with personal group memory retained by default', async () => {
  const fixture = await mount()
  const membership = Object.values(fixture.current().memberships).find(item => item.agentId === fixture.agentId)!
  const revision = fixture.current().revision
  const remove = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="小林"] button')].find(button => button.textContent === en['room.remove'])!
  remove.focus()
  await act(async () => remove.click())
  const dialog = fixture.container.querySelector<HTMLElement>('[role="dialog"][data-remove-colleague]')
  expect(dialog).not.toBeNull()
  expect(fixture.calls.some(call => call.endpoint.startsWith('room/leave'))).toBe(false)
  expect(dialog!.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
  await act(async () => dialog!.querySelector<HTMLButtonElement>('[data-confirm-remove]')!.click())
  expect(fixture.calls.filter(call => call.endpoint.startsWith('room/leave'))).toEqual([
    { endpoint: 'room/leave', payload: { workspaceId: 'local', membershipId: membership.id, expectedRevision: revision } },
  ])
  expect(fixture.container.querySelector('[data-remove-colleague]')).toBeNull()
  expect(fixture.container.querySelector('[role="group"][aria-label="小林"]')).toBeNull()
  expect(fixture.container.querySelectorAll('[data-message-id]')).toHaveLength(2)
})

it('opts into removing only this colleague group memory in the confirmation', async () => {
  const fixture = await mount()
  const membership = Object.values(fixture.current().memberships).find(item => item.agentId === fixture.agentId)!
  const revision = fixture.current().revision
  const remove = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="小林"] button')].find(button => button.textContent === en['room.remove'])!
  await act(async () => remove.click())
  const dialog = fixture.container.querySelector<HTMLElement>('[role="dialog"][data-remove-colleague]')
  expect(dialog).not.toBeNull()
  expect(dialog!.textContent).toContain('current reply')
  expect(dialog!.textContent).toContain('Other members')
  expect(dialog!.textContent).toContain('all group history')
  await act(async () => dialog!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await act(async () => dialog!.querySelector<HTMLButtonElement>('[data-confirm-remove]')!.click())
  expect(fixture.calls.filter(call => call.endpoint.startsWith('room/leave'))).toEqual([
    { endpoint: 'room/leave-and-forget', payload: { workspaceId: 'local', membershipId: membership.id, operationId: expect.any(String), expectedRevision: revision } },
  ])
  expect(fixture.container.querySelector('[data-remove-colleague]')).toBeNull()
  expect(fixture.container.querySelectorAll('[data-message-id]')).toHaveLength(2)
})

it('keeps the memory removal selection and operation identity for retry and prevents closing while pending', async () => {
  const fixture = await mount()
  fixture.failNextLeave()
  const remove = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="小林"] button')].find(button => button.textContent === en['room.remove'])!
  await act(async () => remove.click())
  const dialog = fixture.container.querySelector<HTMLElement>('[role="dialog"][data-remove-colleague]')
  expect(dialog).not.toBeNull()
  const forget = dialog!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  const confirm = dialog!.querySelector<HTMLButtonElement>('[data-confirm-remove]')!
  await act(async () => forget.click())
  await act(async () => confirm.click())
  expect(dialog!.querySelector('[role="alert"]')).not.toBeNull()
  expect(forget.checked).toBe(true)
  const release = fixture.delayLeave()
  await act(async () => confirm.click())
  expect(confirm.disabled).toBe(true)
  expect(forget.disabled).toBe(true)
  expect([...dialog!.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
  await act(async () => dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(fixture.container.querySelector('[data-remove-colleague]')).toBe(dialog)
  const requests = fixture.calls.filter(call => call.endpoint === 'room/leave-and-forget')
  expect(requests).toHaveLength(2)
  expect(requests[0]!.payload).toEqual(requests[1]!.payload)
  await act(async () => release())
  expect(fixture.container.querySelector('[data-remove-colleague]')).toBeNull()
})

it('contains focus in removal confirmation and returns it on Escape without removing anyone', async () => {
  const fixture = await mount()
  const remove = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="小林"] button')].find(button => button.textContent === en['room.remove'])!
  remove.focus()
  await act(async () => remove.click())
  const dialog = fixture.container.querySelector<HTMLElement>('[role="dialog"][data-remove-colleague]')
  expect(dialog).not.toBeNull()
  const controls = [...dialog!.querySelectorAll<HTMLElement>('input,button')]
  expect(document.activeElement).toBe(controls[0])
  controls.at(-1)!.focus()
  await act(async () => controls.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(controls[0])
  await act(async () => dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(fixture.container.querySelector('[data-remove-colleague]')).toBeNull()
  expect(fixture.container.querySelector('[data-mode="conversations"]')).not.toBeNull()
  expect(document.activeElement).toBe(remove)
  expect(fixture.calls.some(call => call.endpoint.startsWith('room/leave'))).toBe(false)
})

it.each(['pending', 'failed'] as const)('reopens %s group memory cleanup for an already removed colleague with its saved operation identity', async status => {
  const fixture = await mount()
  const membershipId = fixture.seedMemoryRemoval(status)
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click())
  expect(fixture.container.querySelector('[role="group"][aria-label="小林"]')).toBeNull()
  const retry = fixture.container.querySelector<HTMLButtonElement>('[data-retry-memory-removal]')
  expect(retry).not.toBeNull()
  expect(retry!.textContent).toContain('小林')
  await act(async () => retry!.click())
  const dialog = fixture.container.querySelector<HTMLElement>('[data-remove-colleague]')!
  const choice = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(choice.checked).toBe(true)
  expect(choice.disabled).toBe(true)
  expect(dialog.querySelector('[data-confirm-remove]')?.textContent).toBe('Retry')
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-confirm-remove]')!.click())
  expect(fixture.calls.filter(call => call.endpoint === 'room/leave-and-forget')).toEqual([
    { endpoint: 'room/leave-and-forget', payload: { workspaceId: 'local', membershipId, operationId: 'pending-memory-removal', expectedRevision: fixture.current().revision } },
  ])
  expect(fixture.container.querySelector('[data-remove-colleague]')).toBeNull()
  expect(fixture.container.querySelector('[data-retry-memory-removal]')).toBeNull()
  expect(fixture.container.querySelectorAll('[data-message-id]')).toHaveLength(2)
})

it('adds a selected colleague with all group history without asking for event numbers', async () => {
  const fixture = await mount(true)
  const other = Object.values(fixture.current().agents).find(agent => agent.name === '小王')!
  const add = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Add colleague"]')
  expect(add).not.toBeNull()
  await act(async () => add!.click())
  const dialog = fixture.container.querySelector<HTMLElement>('[role="dialog"][data-add-colleague]')!
  expect(dialog).not.toBeNull()
  expect(dialog.querySelector('select')).toBeNull()
  expect(dialog.querySelector('input[type="number"]')).toBeNull()
  expect(dialog.textContent).toContain('All group history and future messages')
  expect(dialog.querySelector(`[data-agent-id="${fixture.agentId}"]`)).toBeNull()
  const choice = dialog.querySelector<HTMLInputElement>(`input[value="${other.id}"]`)!
  const join = dialog.querySelector<HTMLButtonElement>('button[data-confirm-join]')!
  expect(join.disabled).toBe(true)
  await act(async () => choice.click())
  expect(join.disabled).toBe(false)
  await act(async () => join.click())
  expect(fixture.calls.filter(call => call.endpoint === 'room/join')).toEqual([{ endpoint: 'room/join', payload: { workspaceId: 'local', roomId: fixture.roomId, agentId: other.id, memoryStart: { type: 'event-range', startSequence: 1, endSequence: 7 }, expectedRevision: 7 } }])
  expect(fixture.container.querySelector('[data-add-colleague]')).toBeNull()
  expect(fixture.container.querySelector(`[role="group"][aria-label="小王"]`)).not.toBeNull()
})

it('adds multiple colleagues with current revisions and retains selections across searches', async () => {
  const fixture = await mount(2)
  const [first, second] = Object.values(fixture.current().agents).filter(agent => agent.id !== fixture.agentId)
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Add colleague"]')!.click())
  const dialog = fixture.container.querySelector<HTMLElement>('[data-add-colleague]')!
  const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!
  const select = async (id: string): Promise<void> => { await act(async () => dialog.querySelector<HTMLInputElement>(`input[value="${id}"]`)!.click()) }
  await select(first!.id)
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, second!.name); search.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(dialog.querySelector(`[data-agent-id="${first!.id}"]`)).toBeNull()
  await select(second!.id)
  expect(dialog.textContent).toContain('Selected: 2')
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, ''); search.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(dialog.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(2)
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-confirm-join]')!.click())
  expect(fixture.calls.filter(call => call.endpoint === 'room/join').map(call => call.payload)).toEqual([
    { workspaceId: 'local', roomId: fixture.roomId, agentId: first!.id, memoryStart: { type: 'event-range', startSequence: 1, endSequence: 8 }, expectedRevision: 8 },
    { workspaceId: 'local', roomId: fixture.roomId, agentId: second!.id, memoryStart: { type: 'event-range', startSequence: 1, endSequence: 9 }, expectedRevision: 9 },
  ])
  expect(fixture.container.querySelector('[data-add-colleague]')).toBeNull()
  for (const colleague of [first!, second!]) {
    expect(fixture.container.querySelector(`[role="group"][aria-label="${colleague.name}"]`)).not.toBeNull()
    expect(fixture.current().memoryEntries.filter(entry => entry.agentId === colleague.id).map(entry => entry.eventId)).toEqual(expect.arrayContaining(fixture.current().events.filter(event => event.type === 'room/message').map(event => event.id)))
  }
})

it.each(['dialog', 'banner'] as const)('retains only remaining colleagues after a partial join and retries from the %s without duplicate admission', async retryFrom => {
  const fixture = await mount(2)
  const [first, second] = Object.values(fixture.current().agents).filter(agent => agent.id !== fixture.agentId)
  fixture.failNextJoinFor(second!.id, retryFrom === 'banner')
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Add colleague"]')!.click())
  const dialog = fixture.container.querySelector<HTMLElement>('[data-add-colleague]')!
  await act(async () => dialog.querySelector<HTMLInputElement>(`input[value="${first!.id}"]`)!.click())
  await act(async () => dialog.querySelector<HTMLInputElement>(`input[value="${second!.id}"]`)!.click())
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-confirm-join]')!.click())
  expect(dialog.querySelector('[role="alert"]')).not.toBeNull()
  expect(dialog.querySelector(`[data-agent-id="${first!.id}"]`)).toBeNull()
  expect(dialog.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(1)
  expect(dialog.textContent).toContain('Selected: 1')
  expect(fixture.container.querySelector(`[role="group"][aria-label="${first!.name}"]`)).not.toBeNull()
  if (retryFrom === 'banner') {
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    const retry = [...fixture.container.querySelectorAll<HTMLButtonElement>('.dsh-agent-group-retry button')].find(button => button.textContent === en['workspace.retry'])!
    await act(async () => retry.click())
  } else {
    await act(async () => dialog.querySelector<HTMLButtonElement>('[data-confirm-join]')!.click())
  }
  expect(fixture.calls.filter(call => call.endpoint === 'room/join').map(call => call.payload)).toEqual([
    { workspaceId: 'local', roomId: fixture.roomId, agentId: first!.id, memoryStart: { type: 'event-range', startSequence: 1, endSequence: 8 }, expectedRevision: 8 },
    { workspaceId: 'local', roomId: fixture.roomId, agentId: second!.id, memoryStart: { type: 'event-range', startSequence: 1, endSequence: 9 }, expectedRevision: 9 },
    { workspaceId: 'local', roomId: fixture.roomId, agentId: second!.id, memoryStart: { type: 'event-range', startSequence: 1, endSequence: retryFrom === 'banner' ? 10 : 9 }, expectedRevision: retryFrom === 'banner' ? 10 : 9 },
  ])
  expect(fixture.container.querySelector('[data-add-colleague]')).toBeNull()
  expect(fixture.container.querySelector(`[role="group"][aria-label="${second!.name}"]`)).not.toBeNull()
  expect(Object.values(fixture.current().memberships).filter(membership => membership.roomId === fixture.roomId && membership.agentId === first!.id)).toHaveLength(1)
  expect(fixture.current().memoryEntries.filter(entry => entry.agentId === second!.id).map(entry => entry.eventId)).toEqual(expect.arrayContaining(fixture.current().events.filter(event => event.type === 'room/message').map(event => event.id)))
})

it('includes concurrent group history when retrying admission from the workspace banner', async () => {
  const fixture = await mount(true)
  const other = Object.values(fixture.current().agents).find(agent => agent.name === '小王')!
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Add colleague"]')!.click())
  const dialog = fixture.container.querySelector<HTMLElement>('[data-add-colleague]')!
  await act(async () => dialog.querySelector<HTMLInputElement>(`input[value="${other.id}"]`)!.click())
  fixture.appendReply()
  const concurrentEventId = fixture.current().events.at(-1)!.id
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-confirm-join]')!.click())
  expect(dialog.querySelector('[role="alert"]')).not.toBeNull()
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  const retry = [...fixture.container.querySelectorAll<HTMLButtonElement>('.dsh-agent-group-retry button')].find(button => button.textContent === en['workspace.retry'])!
  await act(async () => retry.click())
  expect(fixture.current().memoryEntries.filter(entry => entry.agentId === other.id).map(entry => entry.eventId)).toContain(concurrentEventId)
  expect(fixture.container.querySelector('[role="group"][aria-label="小王"]')).not.toBeNull()
})

it('searches eligible colleagues and closes only the add-colleague dialog on Escape', async () => {
  const { container } = await mount(true)
  const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add colleague"]')
  expect(add).not.toBeNull()
  add!.focus()
  await act(async () => add!.click())
  const dialog = container.querySelector<HTMLElement>('[role="dialog"][data-add-colleague]')!
  const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!
  expect(document.activeElement).toBe(search)
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '不存在的同事'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(dialog.querySelector('input[type="checkbox"]')).toBeNull()
  expect(dialog.textContent).toContain('No colleagues match')
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(container.querySelector('[data-add-colleague]')).toBeNull()
  expect(container.querySelector('[data-mode="conversations"]')).not.toBeNull()
  expect(document.activeElement).toBe(add)
})

it('keeps join failure feedback and the selected colleague inside the dialog', async () => {
  const { container, calls } = await mount(true, true)
  const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add colleague"]')
  expect(add).not.toBeNull()
  await act(async () => add!.click())
  const dialog = container.querySelector<HTMLElement>('[data-add-colleague]')!
  await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await act(async () => dialog.querySelector<HTMLButtonElement>('button[data-confirm-join]')!.click())
  expect(container.querySelector('[data-add-colleague]')).toBe(dialog)
  expect(dialog.querySelector('input[type="checkbox"]:checked')).not.toBeNull()
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Could not add')
  expect(calls.filter(call => call.endpoint === 'room/join')).toHaveLength(1)
})

it('shows a pending proposal in its chat and brings confirmation into the same composer without assigning work', async () => {
  const { container, calls } = await mount(false, false, false, true)
  const proposal = container.querySelector('[data-mode="conversations"] [data-pending-work="proposal"]')
  expect(proposal).not.toBeNull()
  const confirm = [...proposal!.querySelectorAll('button')].find(button => button.textContent === 'Confirm in chat')!
  await act(async () => confirm.click())
  expect(container.querySelector<HTMLTextAreaElement>('.dsh-agent-group-compose-row textarea')?.value).toBe('Write the report')
  expect(container.querySelector('[data-chat-work]')).not.toBeNull()
  expect(calls.some(call => call.endpoint === 'communication/confirm')).toBe(false)
})

it('opens the same colleague profile from a message avatar, author and group member', async () => {
  const { container, agentId } = await mount()
  const avatar = container.querySelector<HTMLButtonElement>(`.dsh-agent-group-message button[data-agent-id="${agentId}"]`)
  expect(avatar).not.toBeNull()
  await act(async () => avatar!.click())
  expect(container.querySelector('[role="dialog"][data-colleague-id]')?.getAttribute('data-colleague-id')).toBe(agentId)
  expect(container.textContent).toContain('当前职责')
})

it('provides a rename action in the group title', async () => {
  const { container } = await mount()
  expect(container.querySelector('button[aria-label="Rename group"]')).not.toBeNull()
})

it('closes the member panel locally and returns focus without closing the workspace', async () => {
  const { container } = await mount()
  const trigger = container.querySelector<HTMLButtonElement>('.dsh-agent-group-member-toggle')!
  await act(async () => trigger.click())
  const panel = container.querySelector<HTMLElement>('.dsh-agent-group-member-panel')!
  const close = panel.querySelector<HTMLButtonElement>('button[aria-label="Hide group members"]')
  expect(close).not.toBeNull()
  close!.focus()
  await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(panel.dataset.open).toBe('false')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(container.querySelector('.dsh-agent-group-workbench')).not.toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it.each(['document', 'shadow'] as const)('dismisses the activity drawer before group members on Escape in %s', async surface => {
  const { container } = await mount(false, false, false, false, false, { shadow: surface === 'shadow' })
  const membersTrigger = container.querySelector<HTMLButtonElement>('.dsh-agent-group-member-toggle')!
  await act(async () => membersTrigger.click())
  const panel = container.querySelector<HTMLElement>('.dsh-agent-group-member-panel')!
  const activityTrigger = container.querySelector<HTMLButtonElement>('.dsh-agent-group-activity-trigger')!
  await act(async () => activityTrigger.click())
  const activityClose = container.querySelector<HTMLButtonElement>('.dsh-agent-group-activity-drawer button[aria-label="Close runtime activity"]')!
  expect(activityClose).not.toBeNull()
  await act(async () => activityClose.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })))
  expect(container.querySelector('.dsh-agent-group-activity-drawer')).toBeNull()
  expect(panel.dataset.open).toBe('true')
  expect(container.querySelector('.dsh-agent-group-workbench')).not.toBeNull()
  expect((container.getRootNode() as Document | ShadowRoot).activeElement).toBe(activityTrigger)
  await act(async () => activityTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })))
  expect(panel.dataset.open).toBe('false')
  expect(container.querySelector('.dsh-agent-group-workbench')).not.toBeNull()
  expect((container.getRootNode() as Document | ShadowRoot).activeElement).toBe(membersTrigger)
})

it.each(['document', 'shadow'] as const)('dismisses organization management before group members on Escape in %s', async surface => {
  const { container } = await mount(false, false, false, false, false, { shadow: surface === 'shadow', organizations: true })
  const membersTrigger = container.querySelector<HTMLButtonElement>('.dsh-agent-group-member-toggle')!
  await act(async () => membersTrigger.click())
  const panel = container.querySelector<HTMLElement>('.dsh-agent-group-member-panel')!
  const management = container.querySelector<HTMLDetailsElement>('.dsh-agent-group-organization-management')!
  const summary = management.querySelector('summary')!
  await act(async () => summary.click())
  const label = management.querySelector<HTMLInputElement>('input[aria-label="Organization label"]')!
  label.focus()
  expect(management.open).toBe(true)
  await act(async () => label.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })))
  expect(management.open).toBe(false)
  expect(panel.dataset.open).toBe('true')
  expect(container.querySelector('.dsh-agent-group-workbench')).not.toBeNull()
  expect((container.getRootNode() as Document | ShadowRoot).activeElement).toBe(summary)
  await act(async () => summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })))
  expect(panel.dataset.open).toBe('false')
  expect(container.querySelector('.dsh-agent-group-workbench')).not.toBeNull()
  expect((container.getRootNode() as Document | ShadowRoot).activeElement).toBe(membersTrigger)
})

it.each(['document', 'shadow'] as const)('dismisses keyboard-opened runtime activity before organization management and members in %s', async surface => {
  const { container } = await mount(false, false, false, false, false, { shadow: surface === 'shadow', organizations: true })
  const membersTrigger = container.querySelector<HTMLButtonElement>('.dsh-agent-group-member-toggle')!
  await act(async () => membersTrigger.click())
  const panel = container.querySelector<HTMLElement>('.dsh-agent-group-member-panel')!
  const management = container.querySelector<HTMLDetailsElement>('.dsh-agent-group-organization-management')!
  const summary = management.querySelector('summary')!
  await act(async () => summary.click())
  const activityTrigger = container.querySelector<HTMLButtonElement>('.dsh-agent-group-activity-trigger')!
  // Keyboard activation emits click without the outside pointerdown dismissal.
  await act(async () => activityTrigger.click())
  const close = container.querySelector<HTMLButtonElement>('.dsh-agent-group-activity-drawer button[aria-label="Close runtime activity"]')!
  await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })))
  expect(container.querySelector('.dsh-agent-group-activity-drawer')).toBeNull()
  expect(management.open).toBe(true)
  expect(panel.dataset.open).toBe('true')
  await act(async () => activityTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })))
  expect(management.open).toBe(false)
  expect(panel.dataset.open).toBe('true')
  expect((container.getRootNode() as Document | ShadowRoot).activeElement).toBe(summary)
})

it('lists actual colleagues before role templates on the people page', async () => {
  const { container } = await mount()
  const navigation = container.querySelector<HTMLButtonElement>('button[aria-label="Colleagues"]')!
  await act(async () => navigation.click())
  expect(container.querySelector('[data-mode="colleagues"] [data-colleague-list]')?.textContent).toContain('小林')
  expect(container.querySelector('details[data-role-management]')?.hasAttribute('open')).toBe(false)
})

it('saves a group display name without replacing its message history', async () => {
  const { container, roomId, current } = await mount()
  const original = current().events
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Rename group"]')!.click())
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '新群名称')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(current().rooms[roomId]!.name).toBe('新群名称')
  expect(current().events).toEqual(original)
  expect(container.querySelectorAll('.dsh-agent-group-message')).toHaveLength(2)
})

it.each(['.dsh-agent-group-avatar', '.dsh-agent-group-identity', '.dsh-agent-group-mention', '.dsh-agent-group-member-identity'])('opens one identity from %s and returns focus after closing', async selector => {
  const { container, agentId } = await mount()
  const trigger = container.querySelector<HTMLButtonElement>(`button${selector}`)!
  trigger.focus()
  await act(async () => trigger.click())
  const dialog = container.querySelector<HTMLElement>('[role="dialog"][data-colleague-id]')!
  expect(dialog.getAttribute('data-colleague-id')).toBe(agentId)
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('[data-colleague-id][role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('keeps role history folded in the colleague directory', async () => {
  const { container } = await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Colleagues"]')!.click())
  expect(container.querySelector('details[data-revision-history]')).not.toBeNull()
  expect(container.querySelector('details[data-revision-history]')!.hasAttribute('open')).toBe(false)
})

it('opens a colleague as a profile and edits their name only on request', async () => {
  const { container } = await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button.dsh-agent-group-mention')!.click())
  const dialog = container.querySelector<HTMLElement>('[role="dialog"][data-colleague-id]')!
  expect(dialog.querySelector('h2')?.textContent).toBe('小林')
  expect(dialog.querySelector('header')?.textContent).toContain('工程师')
  expect(dialog.querySelector('input')).toBeNull()
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-profile-edit]')!.click())
  expect(dialog.querySelector<HTMLInputElement>('input')?.value).toBe('小林')
  expect(document.activeElement).toBe(dialog.querySelector('input'))
})

it('focuses the available close action when a busy colleague profile opens', async () => {
  const fixture = await mount()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => root.render(createElement(WorkspaceColleagueProfile, {
    snapshot: fixture.current(), agentId: fixture.agentId, busy: true, modal: true,
    onClose: () => {}, onRename: async () => true, onSetEmployment: async () => {},
    onOpenDirect: async () => {}, onView: () => {}, onEditRole: () => {},
    t: (key: keyof typeof en) => en[key],
  } as never)))
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
  expect(close).not.toBeNull()
  expect(document.activeElement).toBe(close)
})

it('cancels profile edits and restores the saved name when editing again', async () => {
  const { container, current, agentId, calls } = await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button.dsh-agent-group-mention')!.click())
  const dialog = container.querySelector<HTMLElement>('[role="dialog"][data-colleague-id]')!
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-profile-edit]')!.click())
  const input = dialog.querySelector<HTMLInputElement>('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '未保存姓名'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-profile-edit-cancel]')!.click())
  expect(dialog.querySelector('input')).toBeNull()
  expect(document.activeElement).toBe(dialog.querySelector('[data-profile-edit]'))
  expect(current().agents[agentId]!.name).toBe('小林')
  expect(calls.some(call => call.endpoint === 'agent/rename')).toBe(false)
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-profile-edit]')!.click())
  expect(dialog.querySelector<HTMLInputElement>('input')?.value).toBe('小林')
})

it('clears profile edits and departure confirmation when selecting another colleague', async () => {
  const { container, agentId, current } = await mount(true)
  const other = Object.values(current().agents).find(agent => agent.id !== agentId)!
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Colleagues"]')!.click())
  const profile = container.querySelector<HTMLElement>('main [data-colleague-id]')!
  await act(async () => profile.querySelector<HTMLButtonElement>('[data-profile-edit]')!.click())
  const input = profile.querySelector<HTMLInputElement>('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '未保存姓名'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  const depart = [...profile.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === en['agent.depart'])!
  await act(async () => depart.click())
  expect(profile.querySelector('[role="alert"]')?.textContent).toContain('小林')
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-colleague-list] button[data-agent-id="${other.id}"]`)!.click())
  const next = container.querySelector<HTMLElement>('main [data-colleague-id]')!
  expect(next.querySelector('h2')?.textContent).toBe('小王')
  expect(next.querySelector('input')).toBeNull()
  expect(next.querySelector('[role="alert"]')).toBeNull()
  expect(container.querySelector(`[data-colleague-list] button[data-agent-id="${other.id}"]`)?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => next.querySelector<HTMLButtonElement>('[data-profile-edit]')!.click())
  expect(next.querySelector<HTMLInputElement>('input')?.value).toBe('小王')
})

it('renames the selected colleague without changing the role, identity or historical mention routing', async () => {
  const { container, agentId, current } = await mount()
  const original = structuredClone(current().agents[agentId]!)
  await act(async () => container.querySelector<HTMLButtonElement>('button.dsh-agent-group-mention')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[role="dialog"][data-colleague-id] [data-profile-edit]')!.click())
  const input = container.querySelector<HTMLInputElement>('[role="dialog"][data-colleague-id] input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '小李')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(current().agents[agentId]).toEqual({ ...original, name: '小李' })
  expect(container.querySelector('.dsh-agent-group-mention')?.textContent).toBe('@小李')
  expect(container.querySelector('.dsh-agent-group-mention')?.getAttribute('data-agent-id')).toBe(agentId)
  expect(container.querySelector('[role="dialog"][data-colleague-id] input')).toBeNull()
  expect(document.activeElement).toBe(container.querySelector('[role="dialog"][data-colleague-id] [data-profile-edit]'))
})

it('rejects a colleague name collision in the profile without switching identities', async () => {
  const { container, agentId, current } = await mount(true)
  await act(async () => container.querySelector<HTMLButtonElement>('button.dsh-agent-group-mention')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[role="dialog"][data-colleague-id] [data-profile-edit]')!.click())
  const input = container.querySelector<HTMLInputElement>('[role="dialog"][data-colleague-id] input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' 小王 ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(current().agents[agentId]!.name).toBe('小林')
  expect(container.querySelector('[data-colleague-id][role="dialog"]')?.getAttribute('data-colleague-id')).toBe(agentId)
  expect(container.querySelector('[data-colleague-id] [role="alert"]')?.textContent).toContain('nonempty name')
})

it('keeps a failed save and retry feedback inside the colleague dialog', async () => {
  const { container } = await mount(false, true)
  await act(async () => container.querySelector<HTMLButtonElement>('button.dsh-agent-group-mention')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[role="dialog"][data-colleague-id] [data-profile-edit]')!.click())
  const input = container.querySelector<HTMLInputElement>('[data-colleague-id][role="dialog"] input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '新姓名'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(container.querySelector('[data-colleague-id][role="dialog"] [role="alert"]')?.textContent).toContain('Save failed')
  expect(input.value).toBe('新姓名')
  expect(document.activeElement).toBe(input)
})

it('keeps the profile owner when opening memory and jumps back to the exact source message', async () => {
  const { container, agentId, current } = await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button.dsh-agent-group-mention')!.click())
  const memory = [...container.querySelectorAll<HTMLButtonElement>('[data-colleague-id][role="dialog"] button')].find(item => item.textContent === en['people.memory'])!
  await act(async () => memory.click())
  expect(container.querySelector('[data-memory-owner]')?.textContent).toContain('小林')
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Colleague"]')?.value).toBe(agentId)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-memory-source]')!.click())
  const message = current().events.find(item => item.type === 'room/message')!
  expect(container.querySelector(`[data-message-id="${message.id}"]`)?.getAttribute('data-highlighted')).toBe('true')
  expect(document.activeElement).toBe(container.querySelector(`[data-message-id="${message.id}"]`))
})

it('filters departed colleagues without removing their profiles or histories', async () => {
  const { container } = await mount(true, false, true)
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Colleagues"]')!.click())
  const filter = container.querySelector<HTMLSelectElement>('select[aria-label="Employment status"]')!
  expect(filter).not.toBeNull()
  await act(async () => { filter.value = 'departed'; filter.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelector('[data-colleague-list]')?.textContent).toContain('小王')
  expect(container.querySelector('[data-colleague-list]')?.textContent).not.toContain('小林')
})

it('creates a shared role inside the add-colleague flow', async () => {
  const { container, current } = await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Colleagues"]')!.click())
  const add = [...container.querySelectorAll<HTMLButtonElement>('[data-mode="colleagues"] aside button')].find(item => item.textContent === en['people.add'])!
  await act(async () => add.click())
  const create = container.querySelector<HTMLButtonElement>('button[data-create-role]')
  expect(create).not.toBeNull()
  await act(async () => create!.click())
  const input = container.querySelector<HTMLInputElement>('input[aria-label="New role name"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '设计师'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => container.querySelector<HTMLButtonElement>('button[data-save-new-role]')!.click())
  expect(Object.values(current().definitions).some(role => role.name === '设计师')).toBe(true)
  expect([...container.querySelectorAll<HTMLSelectElement>('select')].find(item => item.getAttribute('aria-label') === en['people.selectRole'])?.selectedOptions[0]?.textContent).toBe('设计师')
})

it('assigns complete instructions from chat with an explicit owner and default-off delegation', async () => {
  const { container, agentId, calls } = await mount()
  const toggle = container.querySelector<HTMLButtonElement>('button[data-compose-work]')
  expect(toggle).not.toBeNull()
  await act(async () => toggle!.click())
  const assignee = container.querySelector<HTMLSelectElement>('select[aria-label="Assignee"]')!
  expect(assignee.value).toBe('')
  const send = container.querySelector<HTMLButtonElement>('button[data-send-work]')!
  expect(send.disabled).toBe(true)
  const instructions = container.querySelector<HTMLTextAreaElement>('.dsh-agent-group-compose-row textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(instructions, '完整指令\n第二行'); instructions.dispatchEvent(new Event('input', { bubbles: true })); assignee.value = agentId; assignee.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelector<HTMLInputElement>('input[data-allow-delegation]')?.checked).toBe(false)
  await act(async () => send.click())
  const request = calls.find(item => item.endpoint === 'communication/assign')?.payload
  expect(request).toMatchObject({ assigneeAgentId: agentId, allowDelegation: false, brief: { instructions: '完整指令\n第二行', expectedArtifacts: [], acceptanceCriteria: [] } })
  expect(calls.filter(item => item.endpoint === 'communication/assign')).toHaveLength(1)
  expect(calls.filter(item => item.endpoint === 'room/message')).toHaveLength(0)
})
