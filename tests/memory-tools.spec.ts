import { describe, expect, test, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId, HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { appendRoomMessage, joinRoomWithMemory } from '../packages/host/src/memory.ts'
import { registerWorkspaceMemoryTools } from '../packages/host/src/memory-tools.ts'
import { createInitialState, mutateWorkspace } from '../packages/host/src/state.ts'
import type { WorkspaceTaskToolHost, WorkspaceToolRegistry } from '../packages/host/src/task-tools.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'

type RegisteredTool = Parameters<WorkspaceToolRegistry['register']>[0]
type MemoryHost = Pick<WorkspaceTaskToolHost, 'agentIdFor' | 'snapshot'>

function caller(sessionId: string): Agent {
  return { id: SessionId(sessionId) } as Agent
}

function execution(agent?: Agent) {
  return { agent, signal: new AbortController().signal, concludeTurn: vi.fn(), deferContext: vi.fn() } as never
}

function fixture() {
  const initial = createInitialState(WorkspaceId('local'))
  const definition = mutateWorkspace(initial, { type: 'definition/create', name: 'Engineer', description: 'Build', instructions: 'Ship' })
  const alice = mutateWorkspace(definition.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Alice' })
  const bob = mutateWorkspace(alice.state, { type: 'agent/create', definitionId: definition.definitionId, name: 'Bob' })
  const room = mutateWorkspace(bob.state, { type: 'room/create', kind: 'group', name: 'Planning' })
  const joined = joinRoomWithMemory(room.state, { type: 'room/join', roomId: room.roomId, agentId: alice.agentId, memoryStart: { type: 'new-events' } })
  const note = appendRoomMessage(joined.state, { roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'release decision: Friday', mentions: [] })
  const second = appendRoomMessage(note.state, { roomId: room.roomId, actor: { type: 'human', id: HumanId('owner') }, text: 'release checklist: tests', mentions: [] })
  let state = second.state
  const aliceCaller = caller('alice-session')
  const bobCaller = caller('bob-session')
  const identities = new WeakMap<Agent, AgentId>([[aliceCaller, alice.agentId], [bobCaller, bob.agentId]])
  const host: MemoryHost = { agentIdFor: agent => identities.get(agent), snapshot: () => structuredClone(state) }
  return { host, aliceCaller, bobCaller, aliceId: alice.agentId, identities, firstId: note.eventId, secondId: second.eventId, state: () => state, setState: (next: WorkspaceState) => { state = next } }
}

function tools(host: MemoryHost, characterBudget = 1000, resultLimit = 10) {
  const definitions: RegisteredTool[] = []
  const removed: string[] = []
  const dispose = registerWorkspaceMemoryTools({ register: definition => { definitions.push(definition); return () => { removed.push(definition.name) } } }, host, { characterBudget, resultLimit })
  const get = (name: string) => {
    const definition = definitions.find(candidate => candidate.name === name)
    if (definition === undefined) throw new Error(`Missing tool ${name}`)
    return definition
  }
  return { definitions, dispose, removed, search: () => get('workspace_search_memory'), read: () => get('workspace_read_memory') }
}

describe('employee personal memory tools', () => {
  test('returns searchable source ids and compact JSON without allowing an actor argument', async () => {
    const built = fixture()
    const registered = tools(built.host)
    const result = await registered.search().execute({ query: 'release' }, execution(built.aliceCaller))
    expect(result).toMatchObject({ events: [{ eventId: built.secondId, excerpt: expect.stringContaining('release checklist: tests') }, { eventId: built.firstId, excerpt: expect.stringContaining('release decision: Friday') }], hasMore: false })
    const rendered = registered.search().output.render({ query: 'release' }, result as never)
    expect(rendered).toEqual([{ type: 'text', text: JSON.stringify(result) }])
    expect(Object.keys(registered.search().parameters.properties)).toEqual(['query'])
    expect(Object.keys(registered.read().parameters.properties)).toEqual(['eventId', 'offset'])
    await expect(registered.search().execute({ query: 'release', agentId: built.aliceId }, execution(built.bobCaller))).rejects.toThrow("does not accept argument 'agentId'")
    await expect(registered.read().execute({ eventId: built.firstId, humanId: 'owner' }, execution(built.aliceCaller))).rejects.toThrow("does not accept argument 'humanId'")
  })

  test('bounds search result count and reports omitted matches', async () => {
    const built = fixture()
    const result = await tools(built.host, 1000, 1).search().execute({ query: 'release' }, execution(built.aliceCaller))
    expect(result).toMatchObject({ events: [{ eventId: built.secondId }], hasMore: true })
    await expect(tools(built.host).search().execute({ query: 'unrelated' }, execution(built.aliceCaller))).resolves.toEqual({ events: [], hasMore: false })
    await expect(tools(built.host).search().execute({ query: 'release' }, execution(built.bobCaller))).resolves.toEqual({ events: [], hasMore: false })
  })

  test('reads complete original text in bounded pages with source metadata', async () => {
    const built = fixture()
    const registered = tools(built.host, 8)
    const source = built.state().events.find(event => event.id === built.firstId)!
    await expect(registered.read().execute({ eventId: built.firstId }, execution(built.aliceCaller))).resolves.toEqual({ eventId: built.firstId, sequence: source.sequence, type: 'room/message', acquiredBy: 'room-membership', text: 'release ', offset: 0, totalCharacters: 24, nextOffset: 8 })
    await expect(registered.read().execute({ eventId: built.firstId, offset: 8 }, execution(built.aliceCaller))).resolves.toMatchObject({ text: 'decision', offset: 8, nextOffset: 16 })
    await expect(registered.read().execute({ eventId: built.firstId, offset: 16 }, execution(built.aliceCaller))).resolves.toEqual({ eventId: built.firstId, sequence: source.sequence, type: 'room/message', acquiredBy: 'room-membership', text: ': Friday', offset: 16, totalCharacters: 24 })
    await expect(registered.read().execute({ eventId: built.firstId, offset: 24 }, execution(built.aliceCaller))).resolves.toMatchObject({ text: '', totalCharacters: 24 })
    expect(built.state().events.find(event => event.id === built.firstId)?.text).toBe('release decision: Friday')
  })

  test('attributes search previews and individual read pages to the active turn', async () => {
    const built = fixture()
    const observed: Array<{ eventIds: readonly string[]; rendered: string }> = []
    const host = { ...built.host, recordMemoryToolRead: async (_agent: Agent, eventIds: readonly string[], rendered: string) => {
      observed.push({ eventIds, rendered })
    } }
    const preview = await tools(host, 1000, 1).search().execute({ query: 'release' }, execution(built.aliceCaller))
    const page = await tools(host, 8, 1).read().execute({ eventId: built.firstId, offset: 8 }, execution(built.aliceCaller))
    expect(observed).toEqual([
      { eventIds: [built.secondId], rendered: JSON.stringify(preview) },
      { eventIds: [built.firstId], rendered: JSON.stringify(page) },
    ])
  })

  test('uses one opaque error for an unknown event and an event outside personal memory', async () => {
    const built = fixture()
    const read = tools(built.host).read()
    const unavailable = await read.execute({ eventId: 'SECRET_MISSING' }, execution(built.aliceCaller)).catch((error: unknown) => error)
    const privateEvent = await read.execute({ eventId: built.firstId }, execution(built.bobCaller)).catch((error: unknown) => error)
    expect(unavailable).toMatchObject({ name: 'WorkspaceMemoryToolError', code: 'WORKSPACE_MEMORY_UNAVAILABLE' })
    expect(privateEvent).toMatchObject({ name: 'WorkspaceMemoryToolError', code: 'WORKSPACE_MEMORY_UNAVAILABLE' })
    expect(unavailable).toHaveProperty('message', (privateEvent as Error).message)
    expect(JSON.stringify([unavailable, privateEvent])).not.toContain(built.firstId)
    expect(JSON.stringify([unavailable, privateEvent])).not.toContain('SECRET_MISSING')
  })

  test('authenticates the published handle and current employment on every invocation', async () => {
    const built = fixture()
    const registered = tools(built.host)
    for (const agent of [undefined, caller('SECRET_OUTSIDER')]) {
      await expect(registered.search().execute({ query: 'release' }, execution(agent))).rejects.toMatchObject({ code: 'WORKSPACE_MEMORY_CALLER_UNAVAILABLE' })
    }
    built.identities.delete(built.aliceCaller)
    await expect(registered.read().execute({ eventId: built.firstId }, execution(built.aliceCaller))).rejects.toMatchObject({ code: 'WORKSPACE_MEMORY_CALLER_UNAVAILABLE' })
    built.identities.set(built.aliceCaller, built.aliceId)
    built.setState(mutateWorkspace(built.state(), { type: 'agent/depart', agentId: built.aliceId }).state)
    await expect(registered.read().execute({ eventId: built.firstId }, execution(built.aliceCaller))).rejects.toMatchObject({ code: 'WORKSPACE_MEMORY_CALLER_UNAVAILABLE' })
  })

  test('rejects empty queries and non-integer or negative read offsets', async () => {
    const built = fixture()
    const registered = tools(built.host)
    await expect(registered.search().execute({ query: '   ' }, execution(built.aliceCaller))).rejects.toThrow('query must not be empty')
    for (const offset of [-1, 0.5]) {
      await expect(registered.read().execute({ eventId: built.firstId, offset }, execution(built.aliceCaller))).rejects.toThrow()
    }
  })

  test('removes definitions once in reverse order and rolls back partial registration', () => {
    const built = fixture()
    const registered = tools(built.host)
    registered.dispose()
    registered.dispose()
    expect(registered.removed).toEqual(['workspace_read_memory', 'workspace_search_memory'])
    const retained = new Set<string>()
    const registry: WorkspaceToolRegistry = { register: definition => {
      if (definition.name === 'workspace_read_memory') throw new Error('duplicate tool')
      retained.add(definition.name)
      return () => { retained.delete(definition.name) }
    } }
    expect(() => registerWorkspaceMemoryTools(registry, built.host, { characterBudget: 100, resultLimit: 10 })).toThrow('duplicate tool')
    expect(retained.size).toBe(0)
  })
})
