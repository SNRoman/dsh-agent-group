import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceApi, WorkspaceApiClient } from '../packages/web/src/client/api.ts'

function workspaceSnapshot(revision = 1) {
  return {
    workspaceId: 'local',
    revision,
    definitions: {},
    definitionRevisions: {},
    agents: {},
    rooms: {},
    memberships: {},
    events: [],
    nextId: 1,
    nextSequence: 1,
    memoryEntries: [],
    tasks: {},
    taskAssignments: {},
    delegationGrants: {},
    childRuns: {},
    sessionBindings: {},
  }
}

function apiFixture(responses: Record<string, unknown>) {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown; signal?: AbortSignal }> = []
  const rpc = {
    call: async (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
      calls.push({ channel, endpoint, payload, signal })
      if (!(endpoint in responses)) return { ok: false, error: { message: `unexpected ${endpoint}` } }
      return { ok: true, value: responses[endpoint] }
    },
  }
  return { api: new WorkspaceApiClient({ rpc } as never), calls }
}

describe('WorkspaceApiClient upgraded conversation contract', () => {
  it('adds the exact expected revision and unwraps a committed mutation result', async () => {
    const state = workspaceSnapshot(6)
    const { api, calls } = apiFixture({
      'definition/create': { revision: 6, value: state },
    })

    await expect(api.mutate('definition/create', {
      name: 'Engineer', description: '', instructions: '',
    }, 5)).resolves.toEqual({ revision: 6, value: state })
    expect(calls[0]?.payload).toEqual({
      expectedRevision: 5,
      name: 'Engineer',
      description: '',
      instructions: '',
    })
  })

  it('rejects malformed mutation envelopes', async () => {
    const { api } = apiFixture({ 'agent/depart': workspaceSnapshot(6) })
    await expect(api.mutate('agent/depart', { agentId: 'agent-1' }, 5))
      .rejects.toThrow('invalid mutation result')
  })

  it('rejects client actor fields before transport', async () => {
    const { api, calls } = apiFixture({})
    await expect(api.mutate('task/assign', {
      assigneeAgentId: 'agent-1', title: 'Review', humanId: 'forged-user',
    }, 5)).rejects.toThrow('client-owned actor')
    expect(calls).toEqual([])
  })

  it('exports the typed WorkspaceApi foundation', () => {
    expect(WorkspaceApi).toBeTypeOf('function')
  })

  it('passes the human-selected membership memory start to the Host', async () => {
    const state = workspaceSnapshot(5)
    const { api, calls } = apiFixture({ 'room/join': { revision: 5, value: state } })
    const controller = new AbortController()

    await expect(api.joinRoom('room-1', 'agent-1', {
      type: 'event-range',
      startSequence: 2,
      endSequence: 4,
    }, 4, controller.signal)).resolves.toEqual(state)
    expect(calls).toEqual([expect.objectContaining({
      channel: '/agent-workspace',
      endpoint: 'room/join',
      payload: {
        expectedRevision: 4,
        roomId: 'room-1',
        agentId: 'agent-1',
        memoryStart: { type: 'event-range', startSequence: 2, endSequence: 4 },
      },
      signal: controller.signal,
    })])
  })

  it('rejects an inverted membership event range before transport', async () => {
    const { api, calls } = apiFixture({})
    await expect(api.joinRoom('room-1', 'agent-1', {
      type: 'event-range', startSequence: 4, endSequence: 3,
    }, 1)).rejects.toThrow('event range')
    expect(calls).toEqual([])
  })

  it('normalizes the Host direct-room result into a browser snapshot and room id', async () => {
    const state = workspaceSnapshot(4)
    const { api, calls } = apiFixture({
      'room/direct/open': { revision: 4, value: { state, roomId: 'room-direct' } },
    })

    await expect(api.openDirect('agent-1', 3)).resolves.toEqual({ snapshot: state, roomId: 'room-direct' })
    expect(calls).toEqual([expect.objectContaining({
      channel: '/agent-workspace',
      endpoint: 'room/direct/open',
      payload: { expectedRevision: 3, agentId: 'agent-1' },
    })])
  })

  it('subscribes to the versioned live turn stream through the plugin RPC channel', async () => {
    const initial = { version: 2, workspaceRevision: 4, activities: [], agents: [] }
    const changed = {
      version: 3,
      workspaceRevision: 4,
      activities: [{
        activityId: 'activity-1', agentId: 'agent-1', source: { kind: 'room', roomId: 'room-1' },
        messageId: 'message-1', startOrder: 1, claimed: { sessionId: 'session-1', turn: 7 }, status: 'responding',
        blocks: [{ kind: 'text', index: 0, text: '**流式**' }],
      }],
      agents: [{ agentId: 'agent-1', status: 'active', usingTool: false }],
    }
    const { api, calls } = apiFixture({ 'runtime/activity/snapshot': initial, 'runtime/activity/wait': changed })
    const controller = new AbortController()

    await expect(api.activitySnapshot(controller.signal)).resolves.toEqual(initial)
    await expect(api.waitForActivity(2, controller.signal)).resolves.toEqual(changed)
    expect(calls.map(call => [call.endpoint, call.payload])).toEqual([
      ['runtime/activity/snapshot', {}],
      ['runtime/activity/wait', { afterVersion: 2 }],
    ])
  })
})

describe('Workspace Browser source contract', () => {
  it('uses event-driven stream waits rather than interval polling', () => {
    const source = readFileSync(resolve('packages/web/src/client/WorkspaceUi.tsx'), 'utf8')
    expect(source).toContain('waitForActivity')
    expect(source).not.toContain('setInterval')
    expect(source).not.toContain('window.setInterval')
  })

  it('exposes private chat and group-only @all composition in the workspace UI', () => {
    const source = readFileSync(resolve('packages/web/src/client/WorkspaceUi.tsx'), 'utf8')
    expect(source).toContain('openDirect')
    expect(source).toContain("props.t('room.direct')")
    expect(source).toContain('@all')
    expect(source).toContain("selectedRoom.kind === 'group'")
  })

  it('renders live turns through public DSH markdown and disclosure primitives only', () => {
    const path = resolve('packages/web/src/client/WorkspaceTurn.tsx')
    expect(existsSync(path)).toBe(true)
    if (!existsSync(path)) return
    const source = readFileSync(path, 'utf8')
    expect(source).toContain("from '@deepseek-ai/dsh-client-ui-primitives'")
    expect(source).toContain('MarkdownText')
    expect(source).toContain('DisclosureRow')
    expect(source).not.toMatch(/@deepseek-ai\/[^'\"]+\/src\//)
  })

  it('bundles ui-primitives the same way DSH browser packages do', () => {
    const pkg = JSON.parse(readFileSync(resolve('packages/web/package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>
      dsh?: { client?: { inject?: string[] } }
    }
    expect(pkg.devDependencies?.['@deepseek-ai/dsh-client-ui-primitives']).toBeDefined()
    expect(pkg.dsh?.client?.inject ?? []).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
  })
})
