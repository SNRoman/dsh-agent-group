/** Employee-scoped tools for searching and reading immutable personal memories. */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AgentId } from './ids.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { recallAgentEvents } from './memory.ts'
import type { WorkspaceTaskToolHost, WorkspaceToolRegistry } from './task-tools.ts'
import type { WorkspaceState } from './types.ts'

type MemoryToolHost = Pick<WorkspaceTaskToolHost, 'agentIdFor' | 'snapshot'> & {
  readonly effectiveSnapshot?: (() => WorkspaceState) | undefined
  readonly recordMemoryToolRead?: ((agent: Agent, eventIds: readonly WorkspaceEventId[], rendered: string) => Promise<UserMessage | void>) | undefined
}
import type { WorkspaceEventId } from './ids.ts'
type MemoryToolHosts = MemoryToolHost | ((agent: Agent) => MemoryToolHost | undefined)
type MemoryToolLimits = { characterBudget: number; resultLimit: number }

class WorkspaceMemoryToolError extends Error {
  override readonly name = 'WorkspaceMemoryToolError'
  readonly code: 'WORKSPACE_MEMORY_UNAVAILABLE' | 'WORKSPACE_MEMORY_CALLER_UNAVAILABLE'

  constructor(code: 'WORKSPACE_MEMORY_UNAVAILABLE' | 'WORKSPACE_MEMORY_CALLER_UNAVAILABLE') {
    super(code === 'WORKSPACE_MEMORY_UNAVAILABLE'
      ? 'Personal memory is unavailable.'
      : 'Workspace memory tool caller is not an active employee.')
    this.code = code
  }
}

/**
 * Register employee-scoped personal memory tools with bounded model output.
 * @param registry Registry receiving the complete tool set.
 * @param host Live employee identities and immutable workspace snapshots.
 * @param limits Maximum excerpt/page characters and search result count.
 * @returns An idempotent disposer that unregisters definitions in reverse order.
 */
export function registerWorkspaceMemoryTools(
  registry: WorkspaceToolRegistry,
  host: MemoryToolHosts,
  limits: MemoryToolLimits,
): () => void {
  const disposers: Array<() => void> = []
  try {
    for (const definition of memoryTools(host, limits)) disposers.push(registry.register(definition))
  } catch (error) {
    disposeDefinitions(disposers)
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeDefinitions(disposers)
  }
}

function memoryTools(host: MemoryToolHosts, limits: MemoryToolLimits): readonly ToolDefinition[] {
  const search = defineTool({
    name: 'workspace_search_memory',
    description: 'Search your personal event memories across rooms and tasks. Results are original excerpts; read an event id for its complete source.',
    parameters: {
      query: { type: 'string', required: true, description: 'Non-empty words or a phrase describing the remembered fact.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          events: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: { eventId: { type: 'string', required: true }, excerpt: { type: 'string', required: true } },
            },
          },
          hasMore: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      assertExactArguments('workspace_search_memory', args, ['query'])
      const query = args.query.trim()
      if (query === '') throw new Error('workspace_search_memory query must not be empty')
      const { agentId, state, owner } = resolveActor(host, exec)
      const recalled = recallAgentEvents(state, {
        agentId, query, characterBudget: limits.characterBudget,
        matchingOnly: true, resultLimit: limits.resultLimit,
      })
      const value = {
        events: recalled.entries.map(entry => ({ eventId: entry.eventId, excerpt: entry.rendered })),
        hasMore: recalled.hasMore === true,
      }
      const ids = value.events.map(event => event.eventId)
      if (ids.length > 0 && exec.agent !== undefined) {
        const context = await owner.recordMemoryToolRead?.(exec.agent, ids, JSON.stringify(value))
        if (context !== undefined) exec.deferContext(context)
      }
      assertReturnedSources(host, exec, ids)
      return value
    },
  })

  const read = defineTool({
    name: 'workspace_read_memory',
    description: 'Read the original text of one of your remembered events. Follow nextOffset to read long sources; cite eventId when using the source.',
    parameters: {
      eventId: { type: 'string', required: true, description: 'An event id returned by personal memory recall or search.' },
      offset: { type: 'integer', description: 'Zero-based character offset; defaults to 0.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          eventId: { type: 'string', required: true },
          sequence: { type: 'integer', required: true },
          type: { type: 'string', required: true },
          acquiredBy: { type: 'string', enum: ['room-membership', 'history-sync', 'task', 'child-result'], required: true },
          text: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          totalCharacters: { type: 'integer', required: true },
          nextOffset: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      assertExactArguments('workspace_read_memory', args, ['eventId', 'offset'])
      const offset = args.offset ?? 0
      if (offset < 0) throw new Error('workspace_read_memory offset must not be negative')
      const { agentId, state, owner } = resolveActor(host, exec)
      const entry = state.memoryEntries.find(candidate => candidate.agentId === agentId && candidate.eventId === args.eventId)
      const event = entry === undefined ? undefined : state.events.find(candidate => candidate.id === entry.eventId)
      if (entry === undefined || event === undefined) throw new WorkspaceMemoryToolError('WORKSPACE_MEMORY_UNAVAILABLE')
      const text = event.text ?? ''
      const end = Math.min(text.length, offset + limits.characterBudget)
      const value = {
        eventId: event.id, sequence: event.sequence, type: event.type, acquiredBy: entry.acquiredBy,
        text: text.slice(offset, end), offset, totalCharacters: text.length,
        ...(end < text.length ? { nextOffset: end } : {}),
      }
      if (exec.agent !== undefined) {
        const context = await owner.recordMemoryToolRead?.(exec.agent, [event.id], JSON.stringify(value))
        if (context !== undefined) exec.deferContext(context)
      }
      assertReturnedSources(host, exec, [event.id])
      return value
    },
  })

  return [search, read]
}

function resolveActor(hosts: MemoryToolHosts, exec: ToolRunContext): { agentId: AgentId; state: WorkspaceState; owner: MemoryToolHost } {
  if (exec.agent === undefined) throw new WorkspaceMemoryToolError('WORKSPACE_MEMORY_CALLER_UNAVAILABLE')
  const host = typeof hosts === 'function' ? hosts(exec.agent) : hosts
  if (host === undefined) throw new WorkspaceMemoryToolError('WORKSPACE_MEMORY_CALLER_UNAVAILABLE')
  const agentId = host.agentIdFor(exec.agent)
  if (agentId === undefined) throw new WorkspaceMemoryToolError('WORKSPACE_MEMORY_CALLER_UNAVAILABLE')
  const state = host.effectiveSnapshot?.() ?? host.snapshot()
  if (state.agents[agentId]?.employmentStatus !== 'employed') throw new WorkspaceMemoryToolError('WORKSPACE_MEMORY_CALLER_UNAVAILABLE')
  return { agentId, state, owner: host }
}

function assertReturnedSources(hosts: MemoryToolHosts, exec: ToolRunContext, eventIds: readonly WorkspaceEventId[]): void {
  const { agentId, state } = resolveActor(hosts, exec)
  const owned = new Set(state.memoryEntries.filter(entry => entry.agentId === agentId).map(entry => entry.eventId))
  const present = new Set(state.events.map(event => event.id))
  if (eventIds.some(id => !owned.has(id) || !present.has(id))) throw new WorkspaceMemoryToolError('WORKSPACE_MEMORY_UNAVAILABLE')
}

function disposeDefinitions(disposers: readonly (() => void)[]): void {
  for (const dispose of disposers.toReversed()) dispose()
}

function assertExactArguments(toolName: string, args: object, expected: readonly string[]): void {
  const allowed = new Set(expected)
  const unsupported = Object.keys(args).find(name => !allowed.has(name))
  if (unsupported !== undefined) throw new Error(`${toolName} does not accept argument '${unsupported}'`)
}
