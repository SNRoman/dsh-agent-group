import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceApiClient } from '../packages/web/src/client/api.ts'

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
  it('normalizes the Host direct-room result into a browser snapshot and room id', async () => {
    const state = workspaceSnapshot(4)
    const { api, calls } = apiFixture({ 'room/direct/open': { state, roomId: 'room-direct' } })

    await expect(api.openDirect('agent-1')).resolves.toEqual({ snapshot: state, roomId: 'room-direct' })
    expect(calls).toEqual([expect.objectContaining({
      channel: '/agent-workspace',
      endpoint: 'room/direct/open',
      payload: { agentId: 'agent-1' },
    })])
  })

  it('subscribes to the versioned live turn stream through the plugin RPC channel', async () => {
    const initial = { version: 2, workspaceRevision: 4, turns: [] }
    const changed = {
      version: 3,
      workspaceRevision: 4,
      turns: [{
        roomId: 'room-1', agentId: 'agent-1', sessionId: 'session-1', turn: 7, status: 'running',
        blocks: [{ kind: 'text', index: 0, text: '**流式**' }],
      }],
    }
    const { api, calls } = apiFixture({ 'stream/snapshot': initial, 'stream/wait': changed })
    const controller = new AbortController()

    await expect(api.streamSnapshot(controller.signal)).resolves.toEqual(initial)
    await expect(api.waitForStream(2, controller.signal)).resolves.toEqual(changed)
    expect(calls.map(call => [call.endpoint, call.payload])).toEqual([
      ['stream/snapshot', {}],
      ['stream/wait', { afterVersion: 2 }],
    ])
  })
})

describe('Workspace Browser source contract', () => {
  it('uses event-driven stream waits rather than interval polling', () => {
    const source = readFileSync(resolve('packages/web/src/client/WorkspaceUi.tsx'), 'utf8')
    expect(source).toContain('waitForStream')
    expect(source).not.toContain('setInterval')
    expect(source).not.toContain('window.setInterval')
  })

  it('exposes private chat and group-only @all composition in the workspace UI', () => {
    const source = readFileSync(resolve('packages/web/src/client/WorkspaceUi.tsx'), 'utf8')
    expect(source).toContain('openDirect')
    expect(source).toContain('私聊')
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
