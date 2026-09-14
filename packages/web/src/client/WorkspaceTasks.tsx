/** Human task-management surface for the Agent Workspace Browser. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspaceApiError } from './api.ts'
import type { WorkspaceApiClient } from './api.ts'
import type { AgentId, WorkspaceActivitySnapshot, WorkspaceSnapshot } from './contracts.ts'
import { projectTaskRoots } from './task-view-model.ts'
import type { TaskProjection, TaskRootProjection } from './task-view-model.ts'

interface WorkspaceTasksProps {
  readonly snapshot: WorkspaceSnapshot
  readonly activity: WorkspaceActivitySnapshot
  readonly api: WorkspaceApiClient
  readonly onSnapshot: (snapshot: WorkspaceSnapshot) => void
  readonly onActivity: (activity: WorkspaceActivitySnapshot) => void
  readonly t: TranslateNS<'agentWorkspace'>
}

type RevisionedAction = (revision: number) => Promise<unknown>
interface RetryAction { readonly key: string; readonly label: string; readonly run: RevisionedAction; readonly clear?: (() => void) | undefined; readonly convergence?: ConvergenceMarker | undefined }
type ConvergenceMarker =
  | { readonly kind: 'delivery'; readonly key: string; readonly taskId: string }
  | { readonly kind: 'activity'; readonly key: string; readonly activityId: string }
  | { readonly kind: 'child'; readonly key: string; readonly childId: string }
interface RefreshLegs { readonly snapshot: Promise<WorkspaceSnapshot | undefined>; readonly activity: Promise<boolean> }

/** Render canonical task trees and exact Host-owned task controls. */
export function WorkspaceTasks(props: WorkspaceTasksProps) {
  const roots = useMemo(() => projectTaskRoots(props.snapshot, props.activity), [props.snapshot, props.activity])
  const employed = useMemo(() => Object.values(props.snapshot.agents).filter(agent => agent.employmentStatus === 'employed'), [props.snapshot])
  const [title, setTitle] = useState('')
  const [assigneeId, setAssigneeId] = useState<AgentId | ''>('')
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | undefined>()
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [notice, setNotice] = useState<'stopping' | 'already-stopping' | undefined>()
  const [retries, setRetries] = useState<ReadonlyMap<string, RetryAction>>(() => new Map())
  const [convergences, setConvergences] = useState<ReadonlyMap<string, ConvergenceMarker>>(() => new Map())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    setConvergences(current => reconcileConvergences(current, roots))
  }, [roots])

  const refresh = (): RefreshLegs => {
    const markFailed = (): void => { if (mounted.current) setRefreshFailed(true) }
    return {
      snapshot: Promise.resolve().then(() => props.api.snapshot()).then(value => {
        if (mounted.current) props.onSnapshot(value)
        return value
      }, () => { markFailed(); return undefined }),
      activity: Promise.resolve().then(() => props.api.activitySnapshot()).then(value => {
        if (mounted.current) props.onActivity(value)
        return true
      }, () => { markFailed(); return false }),
    }
  }

  const execute = async (
    key: string,
    label: string,
    run: RevisionedAction,
    clear?: () => void,
    convergence?: ConvergenceMarker,
  ): Promise<void> => {
    setPending(current => new Set(current).add(key))
    setError(undefined)
    setRefreshFailed(false)
    setNotice(undefined)
    try {
      const result = await run(props.snapshot.revision)
      if (!mounted.current) return
      const committed = committedSnapshot(result)
      if (committed !== undefined) props.onSnapshot(committed)
      if (committed === undefined && convergence !== undefined) {
        setConvergences(current => new Map(current).set(key, convergence))
      }
      if (isStopMutation(result)) {
        if (result.value.status === 'stopping' || result.value.status === 'already-stopping') setNotice(result.value.status)
      }
      setRetries(current => withoutRetry(current, key))
      clear?.()
      const refreshes = refresh()
      if (committed === undefined) {
        await (convergence?.kind === 'activity' ? refreshes.activity : refreshes.snapshot)
      }
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof WorkspaceApiError && cause.kind === 'business' && cause.code === 'stale-revision') {
        const refreshed = await refresh().snapshot
        if (mounted.current) {
          const requiredRevision = 'actualRevision' in cause.details ? cause.details.actualRevision : props.snapshot.revision + 1
          if (refreshed !== undefined && refreshed.revision >= requiredRevision) {
            setRetries(current => new Map(current).set(key, { key, label, run, clear, convergence }))
          } else {
            setRefreshFailed(true)
          }
        }
      } else {
        setError(taskErrorMessage(cause, props.t))
      }
    } finally {
      if (mounted.current) {
        setPending(current => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    }
  }

  const retryMutation = (retry: RetryAction): void => {
    void execute(retry.key, retry.label, retry.run, retry.clear, retry.convergence)
  }

  return <div className="dsh-agent-group-body dsh-agent-group-tasks" data-mode="tasks" aria-label={props.t('task.center')}>
    <aside className="dsh-agent-group-panel">
      <div className="dsh-agent-group-section-head"><span className="dsh-agent-group-section-title">{props.t('task.assignRoot')}</span></div>
      <div className="dsh-agent-group-scroll">
        <div className="dsh-agent-group-form">
          <label className="dsh-agent-group-field"><span>{props.t('task.title')}</span><input className="dsh-agent-group-input" value={title} onChange={event => setTitle(event.target.value)} placeholder={props.t('task.titlePlaceholder')} /></label>
          <label className="dsh-agent-group-field"><span>{props.t('task.assignee')}</span><select className="dsh-agent-group-select" value={assigneeId} onChange={event => setAssigneeId(event.target.value as AgentId)}><option value="">{props.t('task.selectAssignee')}</option>{employed.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <button type="button" className="dsh-agent-group-button" disabled={pending.has('assign') || title.trim() === '' || assigneeId === ''} onClick={() => {
            const trimmed = title.trim()
            const selected = assigneeId
            if (trimmed === '' || selected === '') return
            void execute('assign', props.t('task.assign'), revision => props.api.assignTask(selected, trimmed, revision), () => { setTitle(''); setAssigneeId('') })
          }}>{props.t('task.assign')}</button>
        </div>
      </div>
    </aside>
    <main className="dsh-agent-group-panel">
      <div className="dsh-agent-group-section-head"><span className="dsh-agent-group-section-title">{props.t('task.roots')}</span><span className="dsh-agent-group-muted">{props.t('task.rootCount', { count: roots.length })}</span></div>
      {error !== undefined ? <div className="dsh-agent-group-error" role="alert">{error}</div> : null}
      {refreshFailed ? <div className="dsh-agent-group-retry" role="status">{props.t('task.refreshFailed')}</div> : null}
      {[...retries.values()].sort((left, right) => left.key.localeCompare(right.key)).map(retry => <div className="dsh-agent-group-retry" role="status" key={retry.key}><span>{props.t('workspace.staleRetry')}</span><button type="button" className="dsh-agent-group-button" aria-label={props.t('task.retryAction', { action: retry.label })} disabled={pending.has(retry.key)} onClick={() => retryMutation(retry)}>{props.t('workspace.retry')}</button></div>)}
      {notice ? <div className="dsh-agent-group-retry" role="status">{props.t(notice === 'stopping' ? 'task.stopRequested' : 'task.alreadyStopping')}</div> : null}
      <div className="dsh-agent-group-scroll dsh-agent-group-task-list">
        {roots.length === 0 ? <div className="dsh-agent-group-empty">{props.t('task.empty')}</div> : roots.map(root => <TaskRoot key={root.id} root={root} pending={pending} convergences={convergences} execute={execute} api={props.api} t={props.t} />)}
      </div>
    </main>
  </div>
}

function TaskRoot({ root, pending, convergences, execute, api, t }: {
  readonly root: TaskRootProjection
  readonly pending: ReadonlySet<string>
  readonly convergences: ReadonlyMap<string, ConvergenceMarker>
  readonly execute: (key: string, label: string, run: RevisionedAction, clear?: () => void, convergence?: ConvergenceMarker) => Promise<void>
  readonly api: WorkspaceApiClient
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const activeGrant = root.grants.find(grant => grant.status === 'active')
  const cancelLabel = t('task.cancelNamed', { task: root.title, id: root.id })
  const retryLabel = t('task.retryDeliveryNamed', { task: root.title, id: root.id })
  return <article className="dsh-agent-group-card dsh-agent-group-task-root" data-task-id={root.id}>
    <TaskHeader task={root} t={t} />
    <TaskFacts task={root} t={t} />
    <div className="dsh-agent-group-inline dsh-agent-group-task-actions">
      {root.status === 'open' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={cancelLabel} disabled={pending.has(`cancel:${root.id}`)} onClick={() => void execute(`cancel:${root.id}`, cancelLabel, revision => api.cancelTask(root.id, revision))}>{t('task.cancel')}</button> : null}
      {root.status === 'open' && root.assignment !== undefined && activeGrant === undefined ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={t('task.grantNamed', { task: root.title, grantee: root.assignment.assignee.label, id: root.id })} disabled={pending.has(`grant:${root.id}:${root.assignment.assignee.id}`)} onClick={() => void execute(`grant:${root.id}:${root.assignment!.assignee.id}`, t('task.grantNamed', { task: root.title, grantee: root.assignment!.assignee.label, id: root.id }), revision => api.grantTask(root.assignment!.assignee.id as AgentId, root.id, revision))}>{t('task.grant')}</button> : null}
      {root.delivery.retryable ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={retryLabel} disabled={pending.has(`retry:${root.id}`) || convergences.has(`retry:${root.id}`)} onClick={() => void execute(`retry:${root.id}`, retryLabel, revision => api.retryTaskDelivery(root.id, revision), undefined, { kind: 'delivery', key: `retry:${root.id}`, taskId: root.id })}>{t('task.retryDelivery')}</button> : null}
    </div>
    {root.grants.length > 0 ? <section aria-label={t('task.grants')}><h4>{t('task.grants')}</h4>{root.grants.map(grant => {
      const revokeLabel = t('task.revokeNamed', { task: root.title, grantee: grant.grantee.label, grant: grant.id })
      return <div className="dsh-agent-group-task-row" key={grant.id}><span>{grant.grantee.label}</span><span>{t('task.grantedBy', { actor: grant.grantedBy.label })}</span><TaskBadge value={t(grant.status === 'active' ? 'task.grantActive' : grant.expirationReason === 'revoked' ? 'task.grantRevoked' : grant.expirationReason === 'root-terminal' ? 'task.grantTerminalExpiry' : 'task.grantExpiryUnavailable')} />{grant.status === 'active' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={revokeLabel} disabled={pending.has(`revoke:${grant.id}`)} onClick={() => void execute(`revoke:${grant.id}`, revokeLabel, revision => api.revokeTask(grant.id, revision))}>{t('task.revoke')}</button> : null}<EventTrace sequences={grant.eventSequences} t={t} /></div>
    })}</section> : null}
    <TaskRuntime task={root} pending={pending} convergences={convergences} execute={execute} api={api} t={t} />
    {root.derivedTasks.length > 0 ? <section aria-label={t('task.derived')}><h4>{t('task.derived')}</h4>{root.derivedTasks.map(task => {
      const derivedCancelLabel = t('task.cancelNamed', { task: task.title, id: task.id })
      return <article className="dsh-agent-group-card" key={task.id} data-task-id={task.id}><TaskHeader task={task} t={t} /><TaskFacts task={task} t={t} />{task.status === 'open' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={derivedCancelLabel} disabled={pending.has(`cancel:${task.id}`)} onClick={() => void execute(`cancel:${task.id}`, derivedCancelLabel, revision => api.cancelTask(task.id, revision))}>{t('task.cancel')}</button> : null}<TaskRuntime task={task} pending={pending} convergences={convergences} execute={execute} api={api} t={t} /></article>
    })}</section> : null}
  </article>
}

function TaskHeader({ task, t }: { readonly task: TaskProjection; readonly t: TranslateNS<'agentWorkspace'> }) {
  return <div className="dsh-agent-group-card-head"><strong>{task.title}</strong><TaskBadge value={t(`task.status.${task.status}`)} /><span className="dsh-agent-group-muted">{task.id}</span></div>
}

function TaskFacts({ task, t }: { readonly task: TaskProjection; readonly t: TranslateNS<'agentWorkspace'> }) {
  return <div className="dsh-agent-group-task-facts">
    {task.assignment ? <span>{t('task.assignedBy', { actor: task.assignment.assigningActor?.label ?? t('actor.unavailable'), assignee: task.assignment.assignee.label })}</span> : null}
    {task.cancellation ? <span>{t(cancellationLocaleKey(task.cancellation.scope), { sequence: task.cancellation.eventSequence })}</span> : null}
    <span>{t(`task.delivery.${task.delivery.phase}`)}</span>
    {task.delivery.failure ? <span>{task.delivery.failure.summary}</span> : null}
    {task.delivery.result ? <details><summary aria-label={t('task.resultNamed', { task: task.title, id: task.id })}>{t('task.result')}</summary><p>{task.delivery.result}</p></details> : null}
    <EventTrace sequences={task.eventSequences} t={t} />
  </div>
}

function TaskRuntime({ task, pending, convergences, execute, api, t }: {
  readonly task: TaskProjection
  readonly pending: ReadonlySet<string>
  readonly convergences: ReadonlyMap<string, ConvergenceMarker>
  readonly execute: (key: string, label: string, run: RevisionedAction, clear?: () => void, convergence?: ConvergenceMarker) => Promise<void>
  readonly api: WorkspaceApiClient
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  return <>
    {task.activities.map(item => {
      const key = `stop-activity:${item.activityId}`
      const label = t('task.stopTurnNamed', { task: task.title, agent: item.agentLabel, activity: item.activityId })
      return <div className="dsh-agent-group-task-row" key={item.activityId}><span>{item.agentLabel}</span><TaskBadge value={t(`task.activity.${item.status}`)} />{item.stopIdentity !== undefined && item.status !== 'settled' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={label} disabled={item.status === 'stopping' || pending.has(key) || convergences.has(key)} onClick={() => void execute(key, label, revision => api.stopActivity(item.stopIdentity!, revision), undefined, { kind: 'activity', key, activityId: item.activityId })}>{t('task.stopTurn')}</button> : null}</div>
    })}
    {task.children.map(child => {
      const key = `stop-child:${child.id}`
      const label = t('task.stopChildNamed', { task: task.title, child: child.id })
      return <details className="dsh-agent-group-task-child" key={child.id}><summary>{t('task.childNamed', { id: child.id })} <TaskBadge value={t(`task.child.${child.status}`)} /></summary><p>{t('task.childParent', { parent: child.parent.label })}</p>{child.result !== undefined ? <p>{child.result}</p> : null}{child.status === 'running' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={label} disabled={pending.has(key) || convergences.has(key)} onClick={() => void execute(key, label, revision => api.stopChildRun(child.id, revision), undefined, { kind: 'child', key, childId: child.id })}>{t('task.stopChild')}</button> : null}<EventTrace sequences={child.eventSequences} t={t} /></details>
    })}
  </>
}

function cancellationLocaleKey(scope: NonNullable<TaskProjection['cancellation']>['scope']): 'task.cancellation.rootCascade' | 'task.cancellation.derivedOnly' | 'task.cancellation.unknown' {
  switch (scope) {
    case 'root-cascade': return 'task.cancellation.rootCascade'
    case 'derived-only': return 'task.cancellation.derivedOnly'
    case 'unknown': return 'task.cancellation.unknown'
  }
}

function EventTrace({ sequences, t }: { readonly sequences: readonly number[]; readonly t: TranslateNS<'agentWorkspace'> }) {
  return sequences.length === 0 ? null : <span className="dsh-agent-group-muted">{t('task.events', { sequences: sequences.join(', ') })}</span>
}

function TaskBadge({ value }: { readonly value: string }) {
  return <span className="dsh-agent-group-task-badge">{value}</span>
}

function withoutRetry(current: ReadonlyMap<string, RetryAction>, key: string): ReadonlyMap<string, RetryAction> {
  if (!current.has(key)) return current
  const next = new Map(current)
  next.delete(key)
  return next
}

function reconcileConvergences(
  current: ReadonlyMap<string, ConvergenceMarker>,
  roots: readonly TaskRootProjection[],
): ReadonlyMap<string, ConvergenceMarker> {
  let changed = false
  const next = new Map(current)
  for (const [key, marker] of current) {
    if (isConvergenceApplicable(marker, roots)) continue
    next.delete(key)
    changed = true
  }
  return changed ? next : current
}

function isConvergenceApplicable(marker: ConvergenceMarker, roots: readonly TaskRootProjection[]): boolean {
  const tasks = roots.flatMap(root => [root, ...root.derivedTasks])
  switch (marker.kind) {
    case 'delivery': return tasks.some(task => task.id === marker.taskId && task.delivery.retryable)
    case 'activity': return tasks.some(task => task.activities.some(activity => (
      activity.activityId === marker.activityId
      && activity.stopIdentity !== undefined
      && activity.status !== 'stopping'
      && activity.status !== 'settled'
    )))
    case 'child': return tasks.some(task => task.children.some(child => child.id === marker.childId && child.status === 'running'))
  }
}

function committedSnapshot(value: unknown): WorkspaceSnapshot | undefined {
  if (isWorkspaceSnapshot(value)) return value
  if (typeof value !== 'object' || value === null || !('value' in value)) return undefined
  const result = value.value
  if (typeof result !== 'object' || result === null || !('state' in result)) return undefined
  return isWorkspaceSnapshot(result.state) ? result.state : undefined
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  return typeof value === 'object' && value !== null
    && 'revision' in value && typeof value.revision === 'number'
    && 'tasks' in value && typeof value.tasks === 'object' && value.tasks !== null
    && 'events' in value && Array.isArray(value.events)
}

function isStopMutation(value: unknown): value is { readonly value: { readonly status: 'stopping' | 'already-stopping' | 'not-active' } } {
  if (typeof value !== 'object' || value === null || !('value' in value)) return false
  const result = value.value
  return typeof result === 'object' && result !== null && 'status' in result
    && (result.status === 'stopping' || result.status === 'already-stopping' || result.status === 'not-active')
}

function taskErrorMessage(error: unknown, t: TranslateNS<'agentWorkspace'>): string {
  if (!(error instanceof WorkspaceApiError) || error.error.kind !== 'business') return t('workspace.requestFailed')
  const failure = error.error
  switch (failure.code) {
    case 'agent-departed': return t('error.agentDeparted', failure.details)
    case 'invalid-task-authority': return t('error.invalidTaskAuthority', failure.details)
    case 'task-not-open': return t('error.taskNotOpen', failure.details)
    case 'task-not-assigned': return t('error.taskNotAssigned', failure.details)
    case 'delegation-grant-missing': return failure.details.lookup === 'id'
      ? t('error.delegationGrantMissingById', failure.details)
      : t('error.delegationGrantMissingByTask', failure.details)
    case 'delegation-grant-inactive': return t('error.delegationGrantInactive', failure.details)
    case 'agent-missing': return t('error.agentMissing', failure.details)
    case 'stale-revision': return t('workspace.staleRetry')
    case 'duplicate-membership':
    case 'reserved-direct-routing': return t('workspace.requestFailed')
  }
}
