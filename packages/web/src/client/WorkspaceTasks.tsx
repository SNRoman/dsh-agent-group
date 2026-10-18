/** Human task-management surface for the Agent Workspace Browser. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspaceApiError } from './api.ts'
import type { WorkspaceApiClient } from './api.ts'
import type { AgentId, RoomId, WorkspaceEventId, WorkspaceActivitySnapshot, WorkspaceSnapshot } from './contracts.ts'
import { WorkspaceCommunicationApi } from './communication-api.ts'
import type { CommunicationState, ChatSource } from './communication-api.ts'
import { roomLabel, roomMessageMentionSpans } from './view-model.ts'
import { projectTaskRoots } from './task-view-model.ts'
import { WorkspaceRuntimeBadge } from './WorkspaceActivityDrawer.tsx'
import type { TaskProjection, TaskRootProjection } from './task-view-model.ts'
import { workspaceRuntimeErrorText } from './runtime-copy.ts'
import { WorkspaceWorkflow } from './WorkspaceWorkflow.tsx'
import { WorkspacePendingWork } from './WorkspacePendingWork.tsx'
import type { BringWorkToChat } from './WorkspacePendingWork.tsx'

export interface WorkspaceTasksProps {
  readonly snapshot: WorkspaceSnapshot
  readonly activity: WorkspaceActivitySnapshot
  readonly api: WorkspaceApiClient
  readonly onSnapshot: (snapshot: WorkspaceSnapshot) => void
  readonly onActivity: (activity: WorkspaceActivitySnapshot) => void
  readonly selectedAgentId?: AgentId | undefined
  readonly onSelectAgent?: ((id: AgentId) => void) | undefined
  readonly onOpenSource?: ((roomId: RoomId, eventId: WorkspaceEventId) => void) | undefined
  readonly onBringToChat?: BringWorkToChat | undefined
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
  const { api } = props
  const allRoots = useMemo(() => projectTaskRoots(props.snapshot, props.activity), [props.snapshot, props.activity])
  const [status, setStatus] = useState('all')
  const personalRoots = props.selectedAgentId === undefined ? allRoots : allRoots.flatMap(root => {
    const related = root.derivedTasks.filter(task => task.assignment?.assignee.id === props.selectedAgentId || task.children.some(child => child.parent.id === props.selectedAgentId))
    if (root.assignment?.assignee.id === props.selectedAgentId || root.children.some(child => child.parent.id === props.selectedAgentId)) return [{ ...root, derivedTasks: related }]
    return related.map(task => ({ ...task, grants: [], derivedTasks: [] }))
  })
  const roots = personalRoots.filter(root => status === 'all' || root.status === status || (status === 'attention' && (root.delivery.phase === 'failed' || root.delivery.phase === 'interrupted')))
  const [communication, setCommunication] = useState<CommunicationState>()
  const invalidatedTaskIds = new Set(Object.values(communication?.resets ?? {}).flatMap(reset => reset.invalidatedTaskIds))
  const [sourceLoadState, setSourceState] = useState<'loading' | 'ready' | 'error'>(typeof api.callCommunication === 'function' ? 'loading' : 'ready')
  const [sourceRevision, setSourceRevision] = useState<number>()
  const sourceState = sourceLoadState === 'ready' && typeof api.callCommunication === 'function' && (sourceRevision === undefined || sourceRevision < props.snapshot.revision) ? 'loading' : sourceLoadState
  const [sourceRetry, setSourceRetry] = useState(0)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  useEffect(() => {
    if (typeof api.callCommunication !== 'function') return
    const controller = new AbortController()
    setSourceState('loading')
    void new WorkspaceCommunicationApi(api).snapshot(controller.signal).then(value => {
      if (controller.signal.aborted) return
      setCommunication(value.communication); setSourceRevision(value.aggregateRevision); setSourceState('ready')
    }).catch(() => { if (!controller.signal.aborted) setSourceState('error') })
    return () => controller.abort()
  }, [api, props.snapshot.revision, sourceRetry])
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | undefined>()
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [notice, setNotice] = useState<'stopping' | 'already-stopping' | undefined>()
  const [retries, setRetries] = useState<ReadonlyMap<string, RetryAction>>(() => new Map())
  const [convergences, setConvergences] = useState<ReadonlyMap<string, ConvergenceMarker>>(() => new Map())
  const mounted = useRef(true)
  const refreshControllers = useRef(new Set<AbortController>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of refreshControllers.current) controller.abort()
      refreshControllers.current.clear()
    }
  }, [])

  useEffect(() => {
    setConvergences(current => reconcileConvergences(current, roots))
  }, [roots])

  const refresh = (): RefreshLegs => {
    const controller = new AbortController()
    refreshControllers.current.add(controller)
    const live = (): boolean => mounted.current && !controller.signal.aborted
    const markFailed = (): void => { if (live()) setRefreshFailed(true) }
    const legs = {
      snapshot: Promise.resolve().then(() => props.api.snapshot(controller.signal)).then(value => {
        if (!live()) return undefined
        props.onSnapshot(value)
        return value
      }, () => { markFailed(); return undefined }),
      activity: Promise.resolve().then(() => props.api.activitySnapshot(controller.signal)).then(value => {
        if (!live()) return false
        props.onActivity(value)
        return true
      }, () => { markFailed(); return false }),
    }
    void Promise.allSettled([legs.snapshot, legs.activity]).then(() => refreshControllers.current.delete(controller))
    return legs
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

  const renderSource = (taskId: string) => <WorkSource source={communication?.taskSources[taskId]} withdrawn={invalidatedTaskIds.has(taskId) || communication?.messages[communication?.taskSources[taskId]?.eventId ?? '']?.withdrawnBy !== undefined} state={sourceState} snapshot={props.snapshot} onOpen={props.onOpenSource} t={props.t} />
  return <div className="dsh-agent-group-body dsh-agent-group-tasks" data-mode="tasks" aria-label={props.t('task.center')}>
    <aside className="dsh-agent-group-panel dsh-agent-group-filter-panel">
      <div className="dsh-agent-group-section-head"><span className="dsh-agent-group-section-title">{props.t('work.people')}</span></div>
      <div className="dsh-agent-group-scroll">
        <div className="dsh-agent-group-form">
          <label className="dsh-agent-group-field"><span>{props.t('work.owner')}</span><select className="dsh-agent-group-select" aria-label={props.t('work.owner')} value={props.selectedAgentId ?? ''} onChange={event => props.onSelectAgent?.(event.target.value)}>{props.selectedAgentId === undefined ? <option value="">{props.t('people.all')}</option> : null}{Object.values(props.snapshot.agents).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <label className="dsh-agent-group-field"><span>{props.t('work.status')}</span><select className="dsh-agent-group-select" aria-label={props.t('work.status')} value={status} onChange={event => setStatus(event.target.value)}><option value="all">{props.t('memory.any')}</option>{(['open', 'completed', 'cancelled'] as const).map(value => <option key={value} value={value}>{props.t(`task.status.${value}`)}</option>)}<option value="attention">{props.t('work.attention')}</option></select></label>
        </div>
      </div>
    </aside>
    <main className="dsh-agent-group-panel">
      <header className="dsh-agent-group-page-heading"><div><h2 className="dsh-agent-group-page-title">{props.selectedAgentId === undefined ? props.t('work.people') : props.t('work.ownerTitle', { name: props.snapshot.agents[props.selectedAgentId]?.name ?? '' })}</h2><p className="dsh-agent-group-page-subtitle">{props.t('work.chatHint')}</p></div><span className="dsh-agent-group-count">{props.t('work.count', { count: roots.length })}</span></header>
      {error !== undefined ? <div className="dsh-agent-group-error" role="alert">{error}</div> : null}
      {refreshFailed ? <div className="dsh-agent-group-retry" role="status">{props.t('task.refreshFailed')}</div> : null}
      {[...retries.values()].sort((left, right) => left.key.localeCompare(right.key)).map(retry => <div className="dsh-agent-group-retry" role="status" key={retry.key}><span>{props.t('workspace.staleRetry')}</span><button type="button" className="dsh-agent-group-button" aria-label={props.t('task.retryAction', { action: retry.label })} disabled={api.readOnly || pending.has(retry.key)} onClick={() => retryMutation(retry)}>{props.t('workspace.retry')}</button></div>)}
      {notice ? <div className="dsh-agent-group-retry" role="status">{props.t(notice === 'stopping' ? 'task.stopRequested' : 'task.alreadyStopping')}</div> : null}
      {sourceState === 'error' ? <div role="alert" className="dsh-agent-group-error">{props.t('work.sourceFailed')}<button type="button" className="dsh-agent-group-button" onClick={() => setSourceRetry(value => value + 1)}>{props.t('workspace.retry')}</button></div> : null}
      <div className="dsh-agent-group-scroll dsh-agent-group-task-list">
        <WorkspacePendingWork api={api} snapshot={props.snapshot} communication={communication} sourceState={sourceState} selectedAgentId={props.selectedAgentId} onSnapshot={props.onSnapshot} onOpenSource={props.onOpenSource} onBringToChat={props.onBringToChat} t={props.t} />
        {roots.length === 0 ? <div className="dsh-agent-group-empty dsh-agent-group-empty-state">{props.t('work.empty')}</div> : roots.map(root => <div key={root.id} className="dsh-agent-group-work-card">{sourceState === 'ready' ? <TaskRoot root={root} renderSource={renderSource} invalidatedTaskIds={invalidatedTaskIds} pending={pending} convergences={convergences} execute={execute} api={props.api} t={props.t} /> : renderSource(root.id)}</div>)}
        {api.workspaceId === props.snapshot.workspaceId ? <details className="dsh-agent-group-filter-section dsh-agent-group-work-settings" onToggle={event => setAdvancedOpen(event.currentTarget.open)}><summary>{props.t('work.advanced')}</summary>{advancedOpen ? <WorkspaceWorkflow api={api} snapshot={props.snapshot} onSnapshot={props.onSnapshot} onBringToChat={props.onBringToChat} t={props.t} /> : null}</details> : null}
      </div>
    </main>
  </div>
}

function WorkSource({ source, withdrawn, state, snapshot, onOpen, t }: { readonly source: ChatSource | undefined; readonly withdrawn: boolean; readonly state: 'loading' | 'ready' | 'error'; readonly snapshot: WorkspaceSnapshot; readonly onOpen: WorkspaceTasksProps['onOpenSource']; readonly t: TranslateNS<'agentWorkspace'> }) {
  if (state !== 'ready') return <p className="dsh-agent-group-muted dsh-agent-group-work-source-unavailable">{t(state === 'loading' ? 'work.sourceLoading' : 'work.sourceFailed')}</p>
  if (source === undefined) return <p className="dsh-agent-group-muted dsh-agent-group-work-source-unavailable">{t('work.sourceMissing')}</p>
  const event = snapshot.events.find(item => item.id === source.eventId && item.type === 'room/message' && item.subjectId === source.roomId)
  if (event === undefined) return <p className="dsh-agent-group-muted dsh-agent-group-work-source-unavailable">{t('work.sourceMissing')}</p>
  let text = event.text ?? ''
  for (const span of roomMessageMentionSpans(snapshot, text, event.mentions ?? []).reverse()) text = `${text.slice(0, span.start)}${span.label}${text.slice(span.end)}`
  return <div className="dsh-agent-group-work-source"><button type="button" className="dsh-agent-group-identity" disabled={onOpen === undefined} onClick={() => onOpen?.(source.roomId, source.eventId)}>{t('work.source', { room: roomLabel(snapshot, source.roomId, t) })}</button><p className="dsh-agent-group-work-source-text">{withdrawn ? t('recall.workInvalid') : text}</p></div>
}

function TaskRoot({ root, renderSource, invalidatedTaskIds, pending, convergences, execute, api, t }: {
  readonly root: TaskRootProjection
  readonly renderSource: (taskId: string) => React.ReactNode
  readonly invalidatedTaskIds: ReadonlySet<string>
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
    {invalidatedTaskIds.has(root.id) ? <><InvalidatedTaskFacts task={root} t={t} />{renderSource(root.id)}</> : <>
    <TaskHeader task={root} t={t} />
    <TaskFacts task={root} t={t} />
    {renderSource(root.id)}
    <div className="dsh-agent-group-inline dsh-agent-group-task-actions">
      {root.status === 'open' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={cancelLabel} disabled={api.readOnly || pending.has(`cancel:${root.id}`)} onClick={() => void execute(`cancel:${root.id}`, cancelLabel, revision => api.cancelTask(root.id, revision))}>{t('task.cancel')}</button> : null}
      {root.id === root.rootTaskId && root.status === 'open' && root.assignment !== undefined && activeGrant === undefined ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={t('task.grantNamed', { task: root.title, grantee: root.assignment.assignee.label, id: root.id })} disabled={api.readOnly || pending.has(`grant:${root.id}:${root.assignment.assignee.id}`)} onClick={() => void execute(`grant:${root.id}:${root.assignment!.assignee.id}`, t('task.grantNamed', { task: root.title, grantee: root.assignment!.assignee.label, id: root.id }), revision => api.grantTask(root.assignment!.assignee.id as AgentId, root.id, revision))}>{t('task.grant')}</button> : null}
      {root.delivery.retryable ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={retryLabel} disabled={api.readOnly || pending.has(`retry:${root.id}`) || convergences.has(`retry:${root.id}`)} onClick={() => void execute(`retry:${root.id}`, retryLabel, revision => api.retryTaskDelivery(root.id, revision), undefined, { kind: 'delivery', key: `retry:${root.id}`, taskId: root.id })}>{t('task.retryDelivery')}</button> : null}
    </div>
    {root.grants.length > 0 ? <section aria-label={t('task.grants')}><h4>{t('task.grants')}</h4>{root.grants.map(grant => {
      const revokeLabel = t('task.revokeNamed', { task: root.title, grantee: grant.grantee.label, grant: grant.id })
      return <div className="dsh-agent-group-task-row" key={grant.id}><span>{grant.grantee.label}</span><span>{t('task.grantedBy', { actor: grant.grantedBy.label })}</span><TaskBadge value={t(grant.status === 'active' ? 'task.grantActive' : grant.expirationReason === 'revoked' ? 'task.grantRevoked' : grant.expirationReason === 'root-terminal' ? 'task.grantTerminalExpiry' : 'task.grantExpiryUnavailable')} />{grant.status === 'active' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={revokeLabel} disabled={api.readOnly || pending.has(`revoke:${grant.id}`)} onClick={() => void execute(`revoke:${grant.id}`, revokeLabel, revision => api.revokeTask(grant.id, revision))}>{t('task.revoke')}</button> : null}<EventTrace sequences={grant.eventSequences} t={t} /></div>
    })}</section> : null}
    <TaskRuntime task={root} pending={pending} convergences={convergences} execute={execute} api={api} t={t} />
    </>}
    {root.derivedTasks.length > 0 ? <section aria-label={t('task.derived')}><h4>{t('task.derived')}</h4>{root.derivedTasks.map(task => {
      if (invalidatedTaskIds.has(task.id) || invalidatedTaskIds.has(root.id)) return <article className="dsh-agent-group-card" key={task.id} data-task-id={task.id}>{renderSource(task.id)}<InvalidatedTaskFacts task={task} t={t} /></article>
      const derivedCancelLabel = t('task.cancelNamed', { task: task.title, id: task.id })
      return <article className="dsh-agent-group-card" key={task.id} data-task-id={task.id}><TaskHeader task={task} t={t} /><TaskFacts task={task} t={t} />{renderSource(task.id)}{task.status === 'open' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={derivedCancelLabel} disabled={api.readOnly || pending.has(`cancel:${task.id}`)} onClick={() => void execute(`cancel:${task.id}`, derivedCancelLabel, revision => api.cancelTask(task.id, revision))}>{t('task.cancel')}</button> : null}<TaskRuntime task={task} pending={pending} convergences={convergences} execute={execute} api={api} t={t} /></article>
    })}</section> : null}
  </article>
}

function InvalidatedTaskFacts({ task, t }: { readonly task: TaskProjection; readonly t: TranslateNS<'agentWorkspace'> }) {
  return <><p role="status" className="dsh-agent-group-muted">{t('recall.workInvalid')}</p>{task.assignment ? <p>{task.assignment.assignee.label}</p> : null}<details data-work-details><summary>{t('pending.details')}</summary><p>{task.id}</p><EventTrace sequences={task.eventSequences} t={t} /></details></>
}

function TaskHeader({ task, t }: { readonly task: TaskProjection; readonly t: TranslateNS<'agentWorkspace'> }) {
  return <div className="dsh-agent-group-card-head dsh-agent-group-task-heading"><h3 className="dsh-agent-group-task-title">{task.title}</h3><TaskBadge value={t(`task.status.${task.status}`)} /></div>
}

function TaskFacts({ task, t }: { readonly task: TaskProjection; readonly t: TranslateNS<'agentWorkspace'> }) {
  return <div className="dsh-agent-group-task-facts">
    {task.assignment ? <span>{t('task.assignedBy', { actor: task.assignment.assigningActor?.label ?? t('actor.unavailable'), assignee: task.assignment.assignee.label })}</span> : null}
    {task.cancellation ? <span>{t(cancellationLocaleKey(task.cancellation.scope), { sequence: task.cancellation.eventSequence })}</span> : null}
    <span>{t(`task.delivery.${task.delivery.phase}`)}</span>
    {task.delivery.failure ? <span>{workspaceRuntimeErrorText(task.delivery.failure, t)}</span> : null}
    {task.delivery.result ? <details className="dsh-agent-group-task-result"><summary aria-label={t('task.resultNamed', { task: task.title, id: task.id })}>{t('task.result')}</summary><p>{task.delivery.result}</p></details> : null}
    <details data-work-details><summary>{t('pending.details')}</summary><p>{task.id}</p><EventTrace sequences={task.eventSequences} t={t} /></details>
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
      return <div className="dsh-agent-group-task-row" key={item.activityId}><span>{item.agentLabel}</span><WorkspaceRuntimeBadge value={t(`activity.status.${item.status}`)} />{item.usingTool ? <WorkspaceRuntimeBadge value={t('activity.usingTool')} /> : null}{item.stopIdentity !== undefined ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={label} disabled={api.readOnly || pending.has(key) || convergences.has(key)} onClick={() => void execute(key, label, revision => api.stopActivity(item.stopIdentity!, revision), undefined, { kind: 'activity', key, activityId: item.activityId })}>{t('task.stopTurn')}</button> : item.status === 'stopping' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled>{t('activity.status.stopping')}</button> : null}</div>
    })}
    {task.children.map(child => {
      const key = `stop-child:${child.id}`
      const label = t('task.stopChildNamed', { task: task.title, child: child.id })
      return <details className="dsh-agent-group-task-child" key={child.id}><summary>{t('task.childNamed', { id: child.id })} <TaskBadge value={t(`task.child.${child.status}`)} /></summary><p>{t('task.childParent', { parent: child.parent.label })}</p>{child.result !== undefined ? <p>{child.result}</p> : null}{child.status === 'running' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={label} disabled={api.readOnly || pending.has(key) || convergences.has(key)} onClick={() => void execute(key, label, revision => api.stopChildRun(child.id, revision), undefined, { kind: 'child', key, childId: child.id })}>{t('task.stopChild')}</button> : null}<EventTrace sequences={child.eventSequences} t={t} /></details>
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
