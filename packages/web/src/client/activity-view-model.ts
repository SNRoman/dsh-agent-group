/** Pure shared runtime projection over one Host activity snapshot. */

import type {
  RoomId,
  TaskId,
  WorkspaceActivity,
  WorkspaceActivityBlock,
  WorkspaceActivityError,
  WorkspaceActivityIdentity,
  WorkspaceActivitySnapshot,
  WorkspaceAgentActivitySummary,
  WorkspaceSnapshot,
} from './contracts.ts'

export interface ActivitySubject {
  readonly id: string
  readonly label: string
  readonly known: boolean
}

export type ActivitySourceProjection =
  | { readonly kind: 'room'; readonly roomId: RoomId; readonly label: string; readonly known: boolean }
  | { readonly kind: 'task'; readonly taskId: TaskId; readonly attemptId: string; readonly label: string; readonly known: boolean }

export interface ActivityProjection {
  readonly activityId: string
  readonly agent: ActivitySubject
  readonly source: ActivitySourceProjection
  readonly messageId: string
  readonly startOrder: number
  readonly status: WorkspaceActivity['status']
  readonly owned: boolean
  readonly usingTool: boolean
  readonly blocks: readonly WorkspaceActivityBlock[]
  readonly terminalReason?: string | undefined
  readonly error?: WorkspaceActivityError | undefined
  readonly stopIdentity?: WorkspaceActivityIdentity | undefined
}

export interface AgentActivityProjection extends ActivitySubject {
  readonly status: WorkspaceAgentActivitySummary['status']
  readonly usingTool: boolean
  readonly error?: WorkspaceActivityError | undefined
  readonly activities: readonly ActivityProjection[]
}

export interface WorkspaceActivityProjection {
  readonly version: number
  readonly workspaceRevision: number
  readonly activities: readonly ActivityProjection[]
  readonly summary: { readonly status: WorkspaceAgentActivitySummary['status']; readonly usingTool: boolean }
  readonly agents: Readonly<Record<string, AgentActivityProjection>>
  readonly rooms: Readonly<Record<string, readonly ActivityProjection[]>>
  readonly tasks: Readonly<Record<string, readonly ActivityProjection[]>>
}

/**
 * Resolve all runtime surfaces from canonical ids without inferring ownership.
 * @param snapshot Current durable Workspace aggregate.
 * @param runtime Current Host-owned activity snapshot.
 * @returns Deterministic, duplicate-free shared runtime presentation.
 */
export function projectWorkspaceActivity(
  snapshot: WorkspaceSnapshot,
  runtime: WorkspaceActivitySnapshot,
): WorkspaceActivityProjection {
  const activities = uniqueBy(runtime.activities, item => item.activityId)
    .sort((left, right) => left.startOrder - right.startOrder || left.activityId.localeCompare(right.activityId))
    .map(item => projectActivity(snapshot, item))
  const summaries = new Map(uniqueBy(runtime.agents, item => item.agentId).map(item => [item.agentId, item]))
  const agents: Record<string, AgentActivityProjection> = {}
  for (const agent of Object.values(snapshot.agents).sort((left, right) => left.id.localeCompare(right.id))) {
    const summary = summaries.get(agent.id)
    agents[agent.id] = {
      id: agent.id,
      label: agent.name,
      known: true,
      status: summary?.status ?? 'idle',
      usingTool: summary?.usingTool ?? false,
      ...(summary?.error === undefined ? {} : { error: structuredClone(summary.error) }),
      activities: activities.filter(item => item.agent.id === agent.id),
    }
  }
  const rooms: Record<string, readonly ActivityProjection[]> = {}
  const tasks: Record<string, readonly ActivityProjection[]> = {}
  for (const item of activities) {
    if (item.source.kind === 'room' && item.source.known) append(rooms, item.source.roomId, item)
    if (item.source.kind === 'task' && item.source.known) append(tasks, item.source.taskId, item)
  }
  const agentValues = Object.values(agents)
  const status = agentValues.some(agent => agent.status === 'failed')
    ? 'failed'
    : agentValues.some(agent => agent.status === 'active') ? 'active' : 'idle'
  return {
    version: runtime.version,
    workspaceRevision: runtime.workspaceRevision,
    activities,
    summary: { status, usingTool: agentValues.some(agent => agent.usingTool) },
    agents,
    rooms,
    tasks,
  }
}

function projectActivity(snapshot: WorkspaceSnapshot, activity: WorkspaceActivity): ActivityProjection {
  const canonicalAgent = snapshot.agents[activity.agentId]
  const source: ActivitySourceProjection = activity.source.kind === 'room'
    ? {
        kind: 'room', roomId: activity.source.roomId,
        label: snapshot.rooms[activity.source.roomId]?.name ?? activity.source.roomId,
        known: snapshot.rooms[activity.source.roomId] !== undefined,
      }
    : {
        kind: 'task', taskId: activity.source.taskId, attemptId: activity.source.attemptId,
        label: snapshot.tasks[activity.source.taskId]?.title ?? activity.source.taskId,
        known: snapshot.tasks[activity.source.taskId] !== undefined,
      }
  const owned = canonicalAgent !== undefined
    && source.known
    && activity.claimed !== undefined
  const actionable = owned && activity.status === 'responding'
  return {
    activityId: activity.activityId,
    agent: { id: activity.agentId, label: canonicalAgent?.name ?? activity.agentId, known: canonicalAgent !== undefined },
    source,
    messageId: activity.messageId,
    startOrder: activity.startOrder,
    status: activity.status,
    owned,
    usingTool: activity.blocks.some(block => block.kind === 'tool' && block.status === 'running'),
    blocks: structuredClone(activity.blocks),
    ...(activity.terminalReason === undefined ? {} : { terminalReason: activity.terminalReason }),
    ...(activity.error === undefined ? {} : { error: structuredClone(activity.error) }),
    ...(actionable ? {
      stopIdentity: {
        activityId: activity.activityId,
        agentId: activity.agentId,
        messageId: activity.messageId,
        sessionId: activity.claimed!.sessionId,
        turn: activity.claimed!.turn,
      },
    } : {}),
  }
}

function uniqueBy<Value>(items: readonly Value[], id: (value: Value) => string): Value[] {
  const selected = new Map<string, { readonly value: Value; readonly signature: string }>()
  for (const value of items) {
    const key = id(value)
    const signature = stableJson(value)
    const current = selected.get(key)
    if (current === undefined || signature.localeCompare(current.signature) < 0) selected.set(key, { value, signature })
  }
  return [...selected.values()].map(item => item.value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function append<Key extends string, Value>(target: Record<Key, readonly Value[]>, key: Key, value: Value): void {
  target[key] = [...(target[key] ?? []), value]
}
