/** Pure task-center projections over canonical Workspace and activity snapshots. */

import type {
  AgentId,
  ChildRunId,
  DelegationGrantId,
  TaskDeliveryAttemptId,
  TaskId,
  WorkspaceActivity,
  WorkspaceActivityIdentity,
  WorkspaceActivitySnapshot,
  WorkspaceActorView,
  WorkspaceEventView,
  WorkspaceSnapshot,
  WorkspaceTaskView,
} from './contracts.ts'

export interface TaskParty { readonly id: string; readonly label: string }
export type TaskActor = (WorkspaceActorView & TaskParty)

export interface TaskAssignmentProjection {
  readonly id: string
  readonly assignee: TaskParty
  readonly assigningActor?: TaskActor | undefined
  readonly grantId?: DelegationGrantId | undefined
}

export interface TaskGrantProjection {
  readonly id: DelegationGrantId
  readonly status: 'active' | 'expired'
  readonly expirationReason?: 'revoked' | 'root-terminal' | 'unavailable' | undefined
  readonly grantee: TaskParty
  readonly grantedBy: TaskParty
  readonly eventSequences: readonly number[]
}

export interface TaskDeliveryProjection {
  readonly attemptId?: TaskDeliveryAttemptId | undefined
  readonly phase: 'not-started' | 'started' | 'accepted' | 'failed' | 'interrupted' | 'completed'
  readonly retryable: boolean
  readonly failure?: { readonly code: string; readonly summary: string } | undefined
  readonly result?: string | undefined
}

export interface TaskActivityProjection {
  readonly activityId: string
  readonly agentId: AgentId
  readonly agentLabel: string
  readonly attemptId: TaskDeliveryAttemptId
  readonly messageId: string
  readonly status: WorkspaceActivity['status']
  readonly stopIdentity?: WorkspaceActivityIdentity | undefined
}

export interface TaskChildProjection {
  readonly id: ChildRunId
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly parent: TaskParty
  readonly result?: string | undefined
  readonly eventSequences: readonly number[]
}

export interface TaskProjection {
  readonly id: TaskId
  readonly rootTaskId: TaskId
  readonly title: string
  readonly status: WorkspaceTaskView['status']
  readonly cancellation?: { readonly scope: 'root-cascade' | 'derived-only'; readonly eventSequence: number } | undefined
  readonly firstEventSequence?: number | undefined
  readonly assignment?: TaskAssignmentProjection | undefined
  readonly delivery: TaskDeliveryProjection
  readonly children: readonly TaskChildProjection[]
  readonly activities: readonly TaskActivityProjection[]
  readonly eventSequences: readonly number[]
}

export interface TaskRootProjection extends TaskProjection {
  readonly grants: readonly TaskGrantProjection[]
  readonly derivedTasks: readonly TaskProjection[]
}

/**
 * Group durable tasks by root and attach only canonical event and runtime facts.
 * @param snapshot Durable Workspace aggregate returned by the Host.
 * @param activity Current process-local activity projection.
 * @returns Stable root trees ordered by their first related event sequence.
 */
export function projectTaskRoots(
  snapshot: WorkspaceSnapshot,
  activity: WorkspaceActivitySnapshot,
): readonly TaskRootProjection[] {
  const assignments = new Map(Object.values(snapshot.taskAssignments).map(item => [item.taskId, item]))
  const eventsByTask = new Map<TaskId, WorkspaceEventView[]>()
  const eventsByGrant = new Map<DelegationGrantId, WorkspaceEventView[]>()
  const eventsByChild = new Map<ChildRunId, WorkspaceEventView[]>()
  const taskByAssignment = new Map(Object.values(snapshot.taskAssignments).map(item => [item.id, item.taskId]))
  const taskByChild = new Map(Object.values(snapshot.childRuns).map(item => [item.id, item.taskId]))

  for (const event of snapshot.events) {
    const directTaskId = 'taskId' in event ? event.taskId : undefined
    const subjectTaskId = event.subjectId !== undefined && snapshot.tasks[event.subjectId] !== undefined
      ? event.subjectId as TaskId
      : undefined
    const assignmentTaskId = event.subjectId === undefined ? undefined : taskByAssignment.get(event.subjectId)
    const childTaskId = event.subjectId === undefined ? undefined : taskByChild.get(event.subjectId as ChildRunId)
    const taskId = directTaskId ?? subjectTaskId ?? assignmentTaskId ?? childTaskId
    if (taskId !== undefined) addMapItem(eventsByTask, taskId, event)
    if (event.subjectId !== undefined && snapshot.delegationGrants[event.subjectId] !== undefined) {
      addMapItem(eventsByGrant, event.subjectId as DelegationGrantId, event)
    }
    if (event.subjectId !== undefined && snapshot.childRuns[event.subjectId] !== undefined) {
      addMapItem(eventsByChild, event.subjectId as ChildRunId, event)
    }
  }

  const projectTask = (task: WorkspaceTaskView): TaskProjection => {
    const events = ordered(eventsByTask.get(task.id) ?? [])
    const assignment = assignments.get(task.id)
    const assignmentEvent = assignment === undefined ? undefined : events.find(event => (
      (event.type === 'task/assigned' || event.type === 'task/delegated') && event.subjectId === assignment.id
    ))
    const cancellationEvent = events.findLast(event => event.type === 'task/cancelled' && event.subjectId === task.id)
    const root = snapshot.tasks[task.rootTaskId]
    const children = Object.values(snapshot.childRuns)
      .filter(child => child.taskId === task.id)
      .map(child => {
        const childEvents = ordered(eventsByChild.get(child.id) ?? [])
        return {
          id: child.id,
          status: child.status,
          parent: party(snapshot, child.parentAgentId),
          ...(child.status === 'running' ? {} : { result: child.result }),
          eventSequences: childEvents.map(event => event.sequence),
        }
      })
      .sort((left, right) => compareFirst(left.eventSequences[0], right.eventSequences[0], left.id, right.id))
    const activities = activity.activities
      .filter(item => item.source.kind === 'task' && item.source.taskId === task.id)
      .sort((left, right) => left.startOrder - right.startOrder || left.activityId.localeCompare(right.activityId))
      .map(item => projectActivity(snapshot, item))
    return {
      id: task.id,
      rootTaskId: task.rootTaskId,
      title: task.title,
      status: task.status,
      ...(cancellationEvent === undefined ? {} : {
        cancellation: {
          scope: task.id === task.rootTaskId || root?.status === 'cancelled' ? 'root-cascade' as const : 'derived-only' as const,
          eventSequence: cancellationEvent.sequence,
        },
      }),
      ...(events[0] === undefined ? {} : { firstEventSequence: events[0].sequence }),
      ...(assignment === undefined ? {} : {
        assignment: {
          id: assignment.id,
          assignee: party(snapshot, assignment.assigneeAgentId),
          ...(assignmentEvent?.actor === undefined ? {} : { assigningActor: actor(snapshot, assignmentEvent.actor) }),
          ...(assignment.grantId === undefined ? {} : { grantId: assignment.grantId }),
        },
      }),
      delivery: projectDelivery(task, events),
      children,
      activities,
      eventSequences: events.map(event => event.sequence),
    }
  }

  const byRoot = new Map<TaskId, WorkspaceTaskView[]>()
  for (const task of Object.values(snapshot.tasks)) addMapItem(byRoot, task.rootTaskId, task)
  const roots: TaskRootProjection[] = []
  for (const [rootTaskId, tasks] of byRoot) {
    const root = snapshot.tasks[rootTaskId]
    if (root === undefined) continue
    const projectedRoot = projectTask(root)
    const grants = Object.values(snapshot.delegationGrants)
      .filter(grant => grant.rootTaskId === rootTaskId)
      .map(grant => {
        const grantEvents = ordered(eventsByGrant.get(grant.id) ?? [])
        const explicitlyRevoked = grantEvents.some(event => event.type === 'task/delegation-revoked')
        return {
          id: grant.id,
          status: grant.status,
          ...(grant.status === 'active' ? {} : {
            expirationReason: explicitlyRevoked ? 'revoked' as const : root.status === 'open' ? 'unavailable' as const : 'root-terminal' as const,
          }),
          grantee: party(snapshot, grant.granteeAgentId),
          grantedBy: { id: grant.grantedByHumanId, label: grant.grantedByHumanId },
          eventSequences: grantEvents.map(event => event.sequence),
        }
      })
      .sort((left, right) => compareFirst(left.eventSequences[0], right.eventSequences[0], left.id, right.id))
    const derivedTasks = tasks.filter(task => task.id !== rootTaskId).map(projectTask)
      .sort((left, right) => compareFirst(left.firstEventSequence, right.firstEventSequence, left.id, right.id))
    const allSequences = new Set<number>(projectedRoot.eventSequences)
    for (const grant of grants) for (const sequence of grant.eventSequences) allSequences.add(sequence)
    for (const derived of derivedTasks) for (const sequence of derived.eventSequences) allSequences.add(sequence)
    const eventSequences = [...allSequences].sort((left, right) => left - right)
    roots.push({
      ...projectedRoot,
      ...(eventSequences[0] === undefined ? {} : { firstEventSequence: eventSequences[0] }),
      grants,
      derivedTasks,
      eventSequences,
    })
  }
  return roots.sort((left, right) => compareFirst(left.firstEventSequence, right.firstEventSequence, left.id, right.id))
}

/** Keep the highest observed stream version when refresh and long-poll responses race. */
export function selectNewerActivitySnapshot(
  current: WorkspaceActivitySnapshot,
  candidate: WorkspaceActivitySnapshot,
): WorkspaceActivitySnapshot {
  return candidate.version < current.version ? current : candidate
}

/** Keep the highest observed durable revision when reads and mutations race. */
export function selectNewerWorkspaceSnapshot(
  current: WorkspaceSnapshot | undefined,
  candidate: WorkspaceSnapshot,
): WorkspaceSnapshot {
  return current !== undefined && candidate.revision < current.revision ? current : candidate
}

function projectDelivery(task: WorkspaceTaskView, events: readonly WorkspaceEventView[]): TaskDeliveryProjection {
  const deliveryEvents = events.filter(event => event.type.startsWith('task/delivery-') || event.type === 'task/result' || event.type === 'task/result-after-cancel')
  const latestAttemptId = [...deliveryEvents].reverse().find(event => 'taskDeliveryAttemptId' in event)?.taskDeliveryAttemptId
  if (latestAttemptId === undefined) return { phase: 'not-started', retryable: task.status === 'open' }
  const attemptEvents = deliveryEvents.filter(event => 'taskDeliveryAttemptId' in event && event.taskDeliveryAttemptId === latestAttemptId)
  const last = attemptEvents.at(-1)
  if (last?.type === 'task/result' || last?.type === 'task/result-after-cancel') {
    return { attemptId: latestAttemptId, phase: 'completed', retryable: false, result: last.text }
  }
  if (last?.type === 'task/delivery-failed') {
    const interrupted = last.failureCode.toLowerCase().includes('interrupt')
    return {
      attemptId: latestAttemptId,
      phase: interrupted ? 'interrupted' : 'failed',
      retryable: task.status === 'open',
      failure: { code: last.failureCode, summary: last.failureSummary },
    }
  }
  return {
    attemptId: latestAttemptId,
    phase: last?.type === 'task/delivery-accepted' ? 'accepted' : 'started',
    retryable: false,
  }
}

function projectActivity(snapshot: WorkspaceSnapshot, item: WorkspaceActivity): TaskActivityProjection {
  if (item.source.kind !== 'task') throw new Error('task activity projection requires a task source')
  return {
    activityId: item.activityId,
    agentId: item.agentId,
    agentLabel: snapshot.agents[item.agentId]?.name ?? item.agentId,
    attemptId: item.source.attemptId,
    messageId: item.messageId,
    status: item.status,
    ...(item.claimed === undefined ? {} : {
      stopIdentity: {
        activityId: item.activityId,
        agentId: item.agentId,
        messageId: item.messageId,
        sessionId: item.claimed.sessionId,
        turn: item.claimed.turn,
      },
    }),
  }
}

function party(snapshot: WorkspaceSnapshot, id: AgentId): TaskParty {
  return { id, label: snapshot.agents[id]?.name ?? id }
}

function actor(snapshot: WorkspaceSnapshot, value: WorkspaceActorView): TaskActor {
  return value.type === 'agent'
    ? { type: 'agent', ...party(snapshot, value.id) }
    : { type: 'human', id: value.id, label: value.id }
}

function ordered(events: readonly WorkspaceEventView[]): WorkspaceEventView[] {
  return [...events].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
}

function compareFirst(left: number | undefined, right: number | undefined, leftId: string, rightId: string): number {
  return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER) || leftId.localeCompare(rightId)
}

function addMapItem<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const items = map.get(key)
  if (items === undefined) map.set(key, [value])
  else items.push(value)
}
