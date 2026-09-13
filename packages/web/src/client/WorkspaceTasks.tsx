/** Human task-management surface for the Agent Workspace Browser. */

import { useMemo, useState } from 'react'
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
interface RetryAction { readonly key: string; readonly run: RevisionedAction; readonly clear?: (() => void) | undefined }

/** Render canonical task trees and exact Host-owned task controls. */
export function WorkspaceTasks(props: WorkspaceTasksProps) {
  const roots = useMemo(() => projectTaskRoots(props.snapshot, props.activity), [props.snapshot, props.activity])
  const employed = useMemo(() => Object.values(props.snapshot.agents).filter(agent => agent.employmentStatus === 'employed'), [props.snapshot])
  const [title, setTitle] = useState('')
  const [assigneeId, setAssigneeId] = useState<AgentId | ''>('')
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<'stopping' | 'already-stopping' | undefined>()
  const [retry, setRetry] = useState<RetryAction | undefined>()

  const refresh = async (): Promise<void> => {
    const [snapshot, activity] = await Promise.all([props.api.snapshot(), props.api.activitySnapshot()])
    props.onSnapshot(snapshot)
    props.onActivity(activity)
  }

  const execute = async (key: string, run: RevisionedAction, clear?: () => void): Promise<void> => {
    setPending(current => new Set(current).add(key))
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await run(props.snapshot.revision)
      if (isStopMutation(result)) {
        if (result.value.status === 'stopping' || result.value.status === 'already-stopping') setNotice(result.value.status)
      }
      await refresh()
      setRetry(undefined)
      clear?.()
    } catch (cause) {
      if (cause instanceof WorkspaceApiError && cause.kind === 'business' && cause.code === 'stale-revision') {
        try {
          await refresh()
          setRetry({ key, run, clear })
        } catch {
          setError(props.t('workspace.requestFailed'))
          setRetry({ key, run, clear })
        }
      } else {
        setError(taskErrorMessage(cause, props.t))
      }
    } finally {
      setPending(current => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const retryMutation = (): void => {
    if (retry === undefined) return
    void execute(retry.key, retry.run, retry.clear)
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
            void execute('assign', revision => props.api.assignTask(selected, trimmed, revision), () => { setTitle(''); setAssigneeId('') })
          }}>{props.t('task.assign')}</button>
        </div>
      </div>
    </aside>
    <main className="dsh-agent-group-panel">
      <div className="dsh-agent-group-section-head"><span className="dsh-agent-group-section-title">{props.t('task.roots')}</span><span className="dsh-agent-group-muted">{props.t('task.rootCount', { count: roots.length })}</span></div>
      {error !== undefined ? <div className="dsh-agent-group-error" role="alert">{error}</div> : null}
      {retry ? <div className="dsh-agent-group-retry" role="status"><span>{props.t('workspace.staleRetry')}</span><button type="button" className="dsh-agent-group-button" disabled={pending.has(retry.key)} onClick={retryMutation}>{props.t('workspace.retry')}</button></div> : null}
      {notice ? <div className="dsh-agent-group-retry" role="status">{props.t(notice === 'stopping' ? 'task.stopRequested' : 'task.alreadyStopping')}</div> : null}
      <div className="dsh-agent-group-scroll dsh-agent-group-task-list">
        {roots.length === 0 ? <div className="dsh-agent-group-empty">{props.t('task.empty')}</div> : roots.map(root => <TaskRoot key={root.id} root={root} pending={pending} execute={execute} api={props.api} t={props.t} />)}
      </div>
    </main>
  </div>
}

function TaskRoot({ root, pending, execute, api, t }: {
  readonly root: TaskRootProjection
  readonly pending: ReadonlySet<string>
  readonly execute: (key: string, run: RevisionedAction) => Promise<void>
  readonly api: WorkspaceApiClient
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const activeGrant = root.grants.find(grant => grant.status === 'active')
  return <article className="dsh-agent-group-card dsh-agent-group-task-root" data-task-id={root.id}>
    <TaskHeader task={root} t={t} />
    <TaskFacts task={root} t={t} />
    <div className="dsh-agent-group-inline dsh-agent-group-task-actions">
      {root.status === 'open' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={pending.has(`cancel:${root.id}`)} onClick={() => void execute(`cancel:${root.id}`, revision => api.cancelTask(root.id, revision))}>{t('task.cancel')}</button> : null}
      {root.status === 'open' && root.assignment !== undefined && activeGrant === undefined ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={pending.has(`grant:${root.id}:${root.assignment.assignee.id}`)} onClick={() => void execute(`grant:${root.id}:${root.assignment!.assignee.id}`, revision => api.grantTask(root.assignment!.assignee.id as AgentId, root.id, revision))}>{t('task.grant')}</button> : null}
      {root.delivery.retryable ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={pending.has(`retry:${root.id}`)} onClick={() => void execute(`retry:${root.id}`, revision => api.retryTaskDelivery(root.id, revision))}>{t('task.retryDelivery')}</button> : null}
    </div>
    {root.grants.length > 0 ? <section aria-label={t('task.grants')}><h4>{t('task.grants')}</h4>{root.grants.map(grant => <div className="dsh-agent-group-task-row" key={grant.id}><span>{grant.grantee.label}</span><TaskBadge value={t(grant.status === 'active' ? 'task.grantActive' : 'task.grantExpired')} />{grant.status === 'active' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={pending.has(`revoke:${grant.id}`)} onClick={() => void execute(`revoke:${grant.id}`, revision => api.revokeTask(grant.id, revision))}>{t('task.revoke')}</button> : null}<EventTrace sequences={grant.eventSequences} t={t} /></div>)}</section> : null}
    <TaskRuntime task={root} pending={pending} execute={execute} api={api} t={t} />
    {root.derivedTasks.length > 0 ? <section aria-label={t('task.derived')}><h4>{t('task.derived')}</h4>{root.derivedTasks.map(task => <article className="dsh-agent-group-card" key={task.id} data-task-id={task.id}><TaskHeader task={task} t={t} /><TaskFacts task={task} t={t} />{task.status === 'open' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={pending.has(`cancel:${task.id}`)} onClick={() => void execute(`cancel:${task.id}`, revision => api.cancelTask(task.id, revision))}>{t('task.cancel')}</button> : null}<TaskRuntime task={task} pending={pending} execute={execute} api={api} t={t} /></article>)}</section> : null}
  </article>
}

function TaskHeader({ task, t }: { readonly task: TaskProjection; readonly t: TranslateNS<'agentWorkspace'> }) {
  return <div className="dsh-agent-group-card-head"><strong>{task.title}</strong><TaskBadge value={t(`task.status.${task.status}`)} /><span className="dsh-agent-group-muted">{task.id}</span></div>
}

function TaskFacts({ task, t }: { readonly task: TaskProjection; readonly t: TranslateNS<'agentWorkspace'> }) {
  return <div className="dsh-agent-group-task-facts">
    {task.assignment ? <span>{t('task.assignedBy', { actor: task.assignment.assigningActor?.label ?? t('actor.system'), assignee: task.assignment.assignee.label })}</span> : null}
    <span>{t(`task.delivery.${task.delivery.phase}`)}</span>
    {task.delivery.failure ? <span>{task.delivery.failure.summary}</span> : null}
    {task.delivery.result ? <details><summary>{t('task.result')}</summary><p>{task.delivery.result}</p></details> : null}
    <EventTrace sequences={task.eventSequences} t={t} />
  </div>
}

function TaskRuntime({ task, pending, execute, api, t }: {
  readonly task: TaskProjection
  readonly pending: ReadonlySet<string>
  readonly execute: (key: string, run: RevisionedAction) => Promise<void>
  readonly api: WorkspaceApiClient
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  return <>
    {task.activities.map(item => <div className="dsh-agent-group-task-row" key={item.activityId}><span>{item.agentLabel}</span><TaskBadge value={t(`task.activity.${item.status}`)} />{item.stopIdentity !== undefined && item.status !== 'settled' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={item.status === 'stopping' || pending.has(`stop-activity:${item.activityId}`)} onClick={() => void execute(`stop-activity:${item.activityId}`, revision => api.stopActivity(item.stopIdentity!, revision))}>{t('task.stopTurn')}</button> : null}</div>)}
    {task.children.map(child => <details className="dsh-agent-group-task-child" key={child.id}><summary>{t('task.childNamed', { id: child.id })} <TaskBadge value={t(`task.child.${child.status}`)} /></summary>{child.result !== undefined ? <p>{child.result}</p> : null}{child.status === 'running' ? <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={pending.has(`stop-child:${child.id}`)} onClick={() => void execute(`stop-child:${child.id}`, revision => api.stopChildRun(child.id, revision))}>{t('task.stopChild')}</button> : null}<EventTrace sequences={child.eventSequences} t={t} /></details>)}
  </>
}

function EventTrace({ sequences, t }: { readonly sequences: readonly number[]; readonly t: TranslateNS<'agentWorkspace'> }) {
  return sequences.length === 0 ? null : <span className="dsh-agent-group-muted">{t('task.events', { sequences: sequences.join(', ') })}</span>
}

function TaskBadge({ value }: { readonly value: string }) {
  return <span className="dsh-agent-group-task-badge">{value}</span>
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
