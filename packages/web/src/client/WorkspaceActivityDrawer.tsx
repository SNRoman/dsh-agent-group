/** Compact runtime detail and exact Host-owned controls. */

import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspaceApiError } from './api.ts'
import type { WorkspaceApiClient } from './api.ts'
import type { AgentId, WorkspaceActivitySnapshot, WorkspaceSnapshot } from './contracts.ts'
import type { ActivityProjection, AgentActivityProjection, WorkspaceActivityProjection } from './activity-view-model.ts'
import { WorkspaceActivityDetails } from './WorkspaceTurn.tsx'

type RetryAction =
  | { readonly kind: 'stop'; readonly key: string; readonly item: ActivityProjection; readonly revision: number }
  | { readonly kind: 'acknowledge'; readonly key: string; readonly agentId: AgentId; readonly agentLabel: string; readonly revision: number }

export interface WorkspaceActivityDrawerProps extends PropsLocale<'agentWorkspace'> {
  readonly projection: WorkspaceActivityProjection
  readonly snapshot: WorkspaceSnapshot
  readonly api: WorkspaceApiClient
  readonly selectedActivityId: string | undefined
  readonly onSelectActivity: (activityId: string | undefined) => void
  readonly onSnapshot: (snapshot: WorkspaceSnapshot) => void
  readonly onActivity: (snapshot: WorkspaceActivitySnapshot) => void
  readonly onClose: () => void
  readonly returnFocusRef: RefObject<HTMLButtonElement>
}

/** Render every retained activity and mutate only exact Host-provided identities. */
export function WorkspaceActivityDrawer(props: WorkspaceActivityDrawerProps) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [converged, setConverged] = useState<ReadonlySet<string>>(() => new Set())
  const [retries, setRetries] = useState<ReadonlyMap<string, RetryAction>>(() => new Map())
  const [error, setError] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [notice, setNotice] = useState<'stopping' | 'already-stopping' | undefined>()
  const mounted = useRef(true)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    mounted.current = true
    closeButtonRef.current?.focus()
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    setConverged(current => {
      const next = new Set([...current].filter(key => convergenceApplies(key, props.projection)))
      return next.size === current.size ? current : next
    })
  }, [props.projection])

  useEffect(() => {
    setRetries(current => {
      const next = new Map([...current].filter(([, retry]) => retryApplies(retry, props.projection)))
      return next.size === current.size ? current : next
    })
  }, [props.projection])

  const close = (): void => {
    props.onClose()
    props.returnFocusRef.current?.focus()
  }

  const refreshActivity = async (): Promise<boolean> => {
    try {
      const next = await props.api.activitySnapshot()
      if (mounted.current) props.onActivity(next)
      return true
    } catch {
      if (mounted.current) setRefreshFailed(true)
      return false
    }
  }

  const refreshAfterStale = async (requiredRevision: number): Promise<number | undefined> => {
    const durable = Promise.resolve().then(() => props.api.snapshot()).then(value => {
      if (mounted.current) props.onSnapshot(value)
      return value
    }, () => undefined)
    void refreshActivity()
    const state = await durable
    if (!mounted.current || state === undefined || state.revision < requiredRevision) {
      if (mounted.current) setRefreshFailed(true)
      return undefined
    }
    return state.revision
  }

  const begin = (key: string): void => {
    setPending(current => new Set(current).add(key))
    setError(false)
    setRefreshFailed(false)
    setNotice(undefined)
  }

  const finish = (key: string): void => {
    if (!mounted.current) return
    setPending(current => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  const stop = async (item: ActivityProjection, revision: number): Promise<void> => {
    if (item.stopIdentity === undefined) return
    const key = `stop:${item.activityId}`
    begin(key)
    try {
      const result = await props.api.stopActivity(item.stopIdentity, revision)
      if (!mounted.current) return
      setConverged(current => new Set(current).add(key))
      setRetries(current => without(current, key))
      if (result.value.status !== 'not-active') setNotice(result.value.status)
      await refreshActivity()
    } catch (cause) {
      if (!mounted.current) return
      const nextRevision = await staleRevision(cause, refreshAfterStale)
      if (!mounted.current) return
      if (nextRevision === undefined) setError(!(cause instanceof WorkspaceApiError && cause.code === 'stale-revision'))
      else setRetries(current => new Map(current).set(key, { kind: 'stop', key, item, revision: nextRevision }))
    } finally {
      finish(key)
    }
  }

  const acknowledge = async (agentId: AgentId, agentLabel: string, revision: number): Promise<void> => {
    const key = `acknowledge:${agentId}`
    begin(key)
    try {
      await props.api.acknowledgeAgentFailure(agentId, revision)
      if (!mounted.current) return
      setConverged(current => new Set(current).add(key))
      setRetries(current => without(current, key))
      await refreshActivity()
    } catch (cause) {
      if (!mounted.current) return
      const nextRevision = await staleRevision(cause, refreshAfterStale)
      if (!mounted.current) return
      if (nextRevision === undefined) setError(!(cause instanceof WorkspaceApiError && cause.code === 'stale-revision'))
      else setRetries(current => new Map(current).set(key, { kind: 'acknowledge', key, agentId, agentLabel, revision: nextRevision }))
    } finally {
      finish(key)
    }
  }

  const selected = props.projection.activities.find(item => item.activityId === props.selectedActivityId)
    ?? props.projection.activities[0]
  const failures = Object.values(props.projection.agents).filter(agent => agent.status === 'failed')

  return <aside className="dsh-agent-group-activity-drawer" role="dialog" aria-modal="false" aria-label={props.t('activity.title')}>
    <div className="dsh-agent-group-section-head">
      <strong>{props.t('activity.title')}</strong>
      <span className="dsh-agent-group-muted">{props.t('activity.count', { count: props.projection.activities.length })}</span>
      <button ref={closeButtonRef} type="button" className="dsh-agent-group-icon-button dsh-agent-group-right" onClick={close} aria-label={props.t('activity.close')}>{props.t('workspace.close')}</button>
    </div>
    {error ? <div className="dsh-agent-group-error" role="alert">{props.t('activity.requestFailed')}</div> : null}
    {refreshFailed ? <div className="dsh-agent-group-retry" role="status">{props.t('activity.refreshFailed')}</div> : null}
    {notice ? <div className="dsh-agent-group-retry" role="status">{props.t(notice === 'stopping' ? 'activity.stopRequested' : 'activity.alreadyStopping')}</div> : null}
    {[...retries.values()].map(retry => <button
      type="button" className="dsh-agent-group-button" key={retry.key} disabled={pending.has(retry.key)}
      aria-label={retry.kind === 'stop' ? props.t('activity.retryStop', { agent: retry.item.agent.label }) : props.t('activity.retryAcknowledge', { agent: retry.agentLabel })}
      onClick={() => void (retry.kind === 'stop' ? stop(retry.item, retry.revision) : acknowledge(retry.agentId, retry.agentLabel, retry.revision))}
    >{props.t('workspace.retry')}</button>)}
    {failures.map(agent => {
      const key = `acknowledge:${agent.id}`
      const blocked = pending.has(key) || converged.has(key) || retries.has(key)
      return <div className="dsh-agent-group-card" key={key} data-agent-id={agent.id}>
        <div className="dsh-agent-group-card-head"><strong>{agent.label}</strong><WorkspaceRuntimeBadge value={props.t('activity.status.failed')} /></div>
        {agent.error ? <p>{agent.error.summary}</p> : null}
        <button type="button" className="dsh-agent-group-button" disabled={blocked} aria-label={props.t('activity.acknowledgeNamed', { agent: agent.label })} onClick={() => void acknowledge(agent.id as AgentId, agent.label, props.snapshot.revision)}>{props.t('activity.acknowledge')}</button>
      </div>
    })}
    <div className="dsh-agent-group-activity-layout">
      <div className="dsh-agent-group-list" aria-label={props.t('activity.title')}>
        {props.projection.activities.map(item => <button type="button" className="dsh-agent-group-list-button" aria-pressed={item.activityId === selected?.activityId} data-active={item.activityId === selected?.activityId} key={item.activityId} onClick={() => props.onSelectActivity(item.activityId)}>
          <span>{subjectLabel(item, props)}</span><WorkspaceRuntimeBadge value={props.t(`activity.status.${item.status}`)} />
        </button>)}
        {props.projection.activities.length === 0 ? <div className="dsh-agent-group-empty">{props.t('activity.empty')}</div> : null}
      </div>
      {selected ? <article className="dsh-agent-group-card dsh-agent-group-activity-detail" data-activity-id={selected.activityId}>
        <div className="dsh-agent-group-card-head"><strong>{selected.agent.known ? selected.agent.label : props.t('activity.sourceUnavailable', { id: selected.agent.id })}</strong><WorkspaceRuntimeBadge value={props.t(`activity.status.${selected.status}`)} />{selected.usingTool ? <WorkspaceRuntimeBadge value={props.t('activity.usingTool')} /> : null}</div>
        <p>{props.t('activity.sourceOrder', { source: subjectLabel(selected, props), order: selected.startOrder })}</p>
        <p className="dsh-agent-group-muted">{props.t('activity.identities', { activity: selected.activityId, message: selected.messageId })}</p>
        {selected.source.kind === 'task' ? <p className="dsh-agent-group-muted">{props.t('activity.attemptId', { id: selected.source.attemptId })}</p> : null}
        <WorkspaceActivityDetails blocks={selected.blocks} streaming={selected.status === 'responding' || selected.status === 'stopping'} t={props.t} />
        {selected.terminalReason ? <p>{props.t('activity.terminalReason', { reason: selected.terminalReason })}</p> : null}
        {selected.error ? <div className="dsh-agent-group-error">{selected.error.summary}</div> : null}
        <StopControl item={selected} pending={pending} converged={converged} retries={retries} revision={props.snapshot.revision} stop={stop} t={props.t} />
      </article> : null}
    </div>
  </aside>
}

function StopControl({ item, pending, converged, retries, revision, stop, t }: {
  readonly item: ActivityProjection
  readonly pending: ReadonlySet<string>
  readonly converged: ReadonlySet<string>
  readonly retries: ReadonlyMap<string, RetryAction>
  readonly revision: number
  readonly stop: (item: ActivityProjection, revision: number) => Promise<void>
} & PropsLocale<'agentWorkspace'>) {
  const key = `stop:${item.activityId}`
  const stopping = (item.status === 'stopping' && item.owned) || converged.has(key)
  if (item.stopIdentity === undefined && !stopping) return null
  return <button type="button" className="dsh-agent-group-button" disabled={stopping || pending.has(key) || retries.has(key)} aria-label={t('activity.stopNamed', { agent: item.agent.label, activity: item.activityId })} onClick={() => void stop(item, revision)}>{stopping ? t('activity.status.stopping') : t('activity.stop')}</button>
}

function subjectLabel(item: ActivityProjection, props: PropsLocale<'agentWorkspace'>): string {
  const label = item.source.known ? item.source.label : props.t('activity.sourceUnavailable', { id: item.source.kind === 'room' ? item.source.roomId : item.source.taskId })
  return props.t('activity.sourceLabel', { kind: props.t(item.source.kind === 'room' ? 'activity.source.room' : 'activity.source.task'), label })
}

/** Shared status badge used by every workspace runtime surface. */
export function WorkspaceRuntimeBadge({ value }: { readonly value: string }) {
  return <span className="dsh-agent-group-task-badge">{value}</span>
}

/** Render canonical lifecycle badges without deriving a second status rule. */
export function WorkspaceActivityBadges({ activities, t }: {
  readonly activities: readonly ActivityProjection[]
} & PropsLocale<'agentWorkspace'>) {
  return <>{activities.map(item => <span className="dsh-agent-group-runtime-badges" key={item.activityId} data-activity-id={item.activityId}><WorkspaceRuntimeBadge value={t(`activity.status.${item.status}`)} />{item.usingTool ? <WorkspaceRuntimeBadge value={t('activity.usingTool')} /> : null}</span>)}</>
}

/** Render one Host-provided agent summary without inferring it from activities. */
export function WorkspaceAgentRuntimeBadges({ agent, t }: {
  readonly agent: AgentActivityProjection | undefined
} & PropsLocale<'agentWorkspace'>) {
  if (agent === undefined) return null
  return <span className="dsh-agent-group-runtime-badges" data-agent-id={agent.id}><WorkspaceRuntimeBadge value={t(`activity.status.${agent.status}`)} />{agent.usingTool ? <WorkspaceRuntimeBadge value={t('activity.usingTool')} /> : null}</span>
}

function without(current: ReadonlyMap<string, RetryAction>, key: string): ReadonlyMap<string, RetryAction> {
  const next = new Map(current)
  next.delete(key)
  return next
}

async function staleRevision(cause: unknown, refresh: (requiredRevision: number) => Promise<number | undefined>): Promise<number | undefined> {
  if (!(cause instanceof WorkspaceApiError) || cause.code !== 'stale-revision' || !('actualRevision' in cause.details)) return undefined
  return refresh(cause.details.actualRevision)
}

function convergenceApplies(key: string, projection: WorkspaceActivityProjection): boolean {
  if (key.startsWith('stop:')) {
    const id = key.slice('stop:'.length)
    const activity = projection.activities.find(item => item.activityId === id)
    return activity?.status === 'responding' && activity.stopIdentity !== undefined
  }
  if (key.startsWith('acknowledge:')) return projection.agents[key.slice('acknowledge:'.length)]?.status === 'failed'
  return false
}

function retryApplies(retry: RetryAction, projection: WorkspaceActivityProjection): boolean {
  if (retry.kind === 'acknowledge') return projection.agents[retry.agentId]?.status === 'failed'
  const current = projection.activities.find(item => item.activityId === retry.item.activityId)
  return current?.stopIdentity !== undefined
    && retry.item.stopIdentity !== undefined
    && current.stopIdentity.activityId === retry.item.stopIdentity.activityId
    && current.stopIdentity.agentId === retry.item.stopIdentity.agentId
    && current.stopIdentity.messageId === retry.item.stopIdentity.messageId
    && current.stopIdentity.sessionId === retry.item.stopIdentity.sessionId
    && current.stopIdentity.turn === retry.item.stopIdentity.turn
}
