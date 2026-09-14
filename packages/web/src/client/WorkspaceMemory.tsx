/** Read-only unified personal-memory Browser view. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspaceApiError } from './api.ts'
import type { WorkspaceApiClient } from './api.ts'
import { WORKSPACE_EVENT_TYPES } from './contracts.ts'
import type {
  AgentId, MemoryItem, MemoryProvenance, MemoryQuery, MemorySource, WorkspaceEventType, WorkspaceSnapshot,
} from './contracts.ts'

const MEMORY_PAGE_SIZE = 25

export interface WorkspaceMemoryProps {
  readonly snapshot: WorkspaceSnapshot
  readonly api: WorkspaceApiClient
  readonly onSnapshot: (snapshot: WorkspaceSnapshot) => void
  readonly t: TranslateNS<'agentWorkspace'>
}

type LoadState = 'loading' | 'ready' | 'error'

/** Render one agent's canonical memory without exposing mutation controls. */
export function WorkspaceMemory({ snapshot, api, onSnapshot, t }: WorkspaceMemoryProps) {
  const agents = useMemo(() => Object.values(snapshot.agents).toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)), [snapshot.agents])
  const [agentId, setAgentId] = useState<AgentId | undefined>(() => agents[0]?.id)
  const [sourceKind, setSourceKind] = useState<MemorySource['kind'] | ''>('')
  const [sourceId, setSourceId] = useState('')
  const [provenance, setProvenance] = useState<MemoryProvenance | ''>('')
  const [eventTypes, setEventTypes] = useState<readonly WorkspaceEventType[]>([])
  const [minimumSequence, setMinimumSequence] = useState('')
  const [maximumSequence, setMaximumSequence] = useState('')
  const [text, setText] = useState('')
  const [items, setItems] = useState<readonly MemoryItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [state, setState] = useState<LoadState>('loading')
  const [retryVersion, setRetryVersion] = useState(0)
  const generation = useRef(0)

  useEffect(() => () => { generation.current += 1 }, [])

  useEffect(() => {
    if (agentId !== undefined && snapshot.agents[agentId] !== undefined) return
    setAgentId(agents[0]?.id)
  }, [agentId, agents, snapshot.agents])

  const sources = useMemo(() => {
    if (sourceKind === 'room') {
      return Object.values(snapshot.rooms).map(room => ({ id: room.id, label: room.kind === 'group' ? (room.name ?? room.id) : room.id }))
    }
    if (sourceKind === 'task') return Object.values(snapshot.tasks).map(task => ({ id: task.id, label: task.title }))
    if (sourceKind === 'child') return Object.values(snapshot.childRuns).map(child => ({ id: child.id, label: child.id }))
    return []
  }, [snapshot.rooms, snapshot.tasks, snapshot.childRuns, sourceKind])

  const baseQuery = useMemo<MemoryQuery | undefined>(() => agentId === undefined ? undefined : {
    agentId,
    ...(sourceKind === '' ? {} : { sourceKind }),
    ...(sourceId === '' ? {} : { sourceId }),
    ...(provenance === '' ? {} : { provenance }),
    ...(eventTypes.length === 0 ? {} : { eventTypes }),
    ...(positiveInteger(minimumSequence) === undefined ? {} : { minimumSequence: positiveInteger(minimumSequence) }),
    ...(positiveInteger(maximumSequence) === undefined ? {} : { maximumSequence: positiveInteger(maximumSequence) }),
    ...(text === '' ? {} : { text }),
    limit: MEMORY_PAGE_SIZE,
    snapshotRevision: snapshot.revision,
  }, [agentId, sourceKind, sourceId, provenance, eventTypes, minimumSequence, maximumSequence, text, snapshot.revision])

  const staleRestart = async (requestGeneration: number): Promise<void> => {
    try {
      const refreshed = await api.snapshot()
      if (generation.current !== requestGeneration) return
      if (refreshed.revision <= snapshot.revision) {
        setState('error')
        return
      }
      onSnapshot(refreshed)
    } catch {
      if (generation.current === requestGeneration) setState('error')
    }
  }

  useEffect(() => {
    const requestGeneration = ++generation.current
    setItems([])
    setNextCursor(undefined)
    if (baseQuery === undefined) {
      setState('ready')
      return
    }
    setState('loading')
    const controller = new AbortController()
    void api.queryMemory(baseQuery, controller.signal).then(page => {
      if (generation.current !== requestGeneration || controller.signal.aborted) return
      if (page.snapshotRevision !== baseQuery.snapshotRevision) {
        void staleRestart(requestGeneration)
        return
      }
      setItems(uniqueItems(page.items))
      setNextCursor(page.nextCursor)
      setState('ready')
    }).catch(error => {
      if (generation.current !== requestGeneration || controller.signal.aborted) return
      if (isStale(error)) void staleRestart(requestGeneration)
      else setState('error')
    })
    return () => controller.abort()
  }, [api, baseQuery, retryVersion])

  const loadMore = (): void => {
    if (baseQuery === undefined || nextCursor === undefined || state === 'loading') return
    const requestGeneration = ++generation.current
    setState('loading')
    const query = { ...baseQuery, cursor: nextCursor }
    void api.queryMemory(query).then(page => {
      if (generation.current !== requestGeneration) return
      if (page.snapshotRevision !== query.snapshotRevision) {
        void staleRestart(requestGeneration)
        return
      }
      setItems(current => uniqueItems([...current, ...page.items]))
      setNextCursor(page.nextCursor)
      setState('ready')
    }).catch(error => {
      if (generation.current !== requestGeneration) return
      if (isStale(error)) void staleRestart(requestGeneration)
      else setState('error')
    })
  }

  return <div className="dsh-agent-group-body dsh-agent-group-memory" data-mode="memory">
    <aside className="dsh-agent-group-panel dsh-agent-group-memory-filters">
      <div className="dsh-agent-group-section-head"><strong>{t('memory.title')}</strong></div>
      <div className="dsh-agent-group-scroll dsh-agent-group-form">
        <MemoryField label={t('memory.agent')}><select className="dsh-agent-group-select" aria-label={t('memory.agent')} value={agentId ?? ''} onChange={event => setAgentId(event.target.value)}>
          {agents.map(agent => <option key={agent.id} value={agent.id}>{t('memory.agentOption', { name: agent.name, status: agent.employmentStatus === 'employed' ? t('agent.employed') : t('agent.departed') })}</option>)}
        </select></MemoryField>
        <MemoryField label={t('memory.sourceKind')}><select className="dsh-agent-group-select" aria-label={t('memory.sourceKind')} value={sourceKind} onChange={event => { setSourceKind(event.target.value as MemorySource['kind'] | ''); setSourceId('') }}>
          <option value="">{t('memory.any')}</option><option value="room">{t('memory.source.room')}</option><option value="task">{t('memory.source.task')}</option><option value="child">{t('memory.source.child')}</option>
        </select></MemoryField>
        <MemoryField label={t('memory.source')}><select className="dsh-agent-group-select" aria-label={t('memory.source')} value={sourceId} disabled={sourceKind === ''} onChange={event => setSourceId(event.target.value)}>
          <option value="">{t('memory.any')}</option>{sources.toSorted((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)).map(source => <option key={source.id} value={source.id}>{t('memory.sourceOption', { label: source.label, id: source.id })}</option>)}
        </select></MemoryField>
        <MemoryField label={t('memory.provenance')}><select className="dsh-agent-group-select" aria-label={t('memory.provenance')} value={provenance} onChange={event => setProvenance(event.target.value as MemoryProvenance | '')}>
          <option value="">{t('memory.any')}</option>{(['room-membership', 'history-sync', 'task', 'child-result'] as const).map(value => <option key={value} value={value}>{t(`memory.provenance.${value}`)}</option>)}
        </select></MemoryField>
        <fieldset className="dsh-agent-group-fieldset"><legend>{t('memory.eventTypes')}</legend>{WORKSPACE_EVENT_TYPES.map(type => <label key={type} className="dsh-agent-group-check"><input type="checkbox" aria-label={t('memory.eventTypeNamed', { type })} checked={eventTypes.includes(type)} onChange={event => setEventTypes(current => event.target.checked ? [...current, type] : current.filter(value => value !== type))} />{type}</label>)}</fieldset>
        <MemoryField label={t('memory.minimumSequence')}><input className="dsh-agent-group-input" type="number" min="1" aria-label={t('memory.minimumSequence')} value={minimumSequence} onChange={event => setMinimumSequence(event.target.value)} /></MemoryField>
        <MemoryField label={t('memory.maximumSequence')}><input className="dsh-agent-group-input" type="number" min="1" aria-label={t('memory.maximumSequence')} value={maximumSequence} onChange={event => setMaximumSequence(event.target.value)} /></MemoryField>
        <MemoryField label={t('memory.search')}><input className="dsh-agent-group-input" type="search" aria-label={t('memory.search')} value={text} onChange={event => setText(event.target.value)} /></MemoryField>
      </div>
    </aside>
    <main className="dsh-agent-group-panel"><div className="dsh-agent-group-scroll dsh-agent-group-memory-list">
      {items.map(item => <MemoryRow key={item.eventId} item={item} t={t} />)}
      {state === 'loading' ? <div role="status" className="dsh-agent-group-empty">{t('memory.loading')}</div> : null}
      {state === 'error' ? <div role="alert" className="dsh-agent-group-error">{t('memory.error')} <button type="button" className="dsh-agent-group-button" onClick={() => setRetryVersion(value => value + 1)}>{t('workspace.retry')}</button></div> : null}
      {state === 'ready' && items.length === 0 ? <div className="dsh-agent-group-empty">{agents.length === 0 ? t('memory.noAgents') : t('memory.empty')}</div> : null}
      {state === 'ready' && nextCursor !== undefined ? <button type="button" className="dsh-agent-group-button" onClick={loadMore}>{t('memory.loadMore')}</button> : null}
      {state === 'ready' && items.length > 0 && nextCursor === undefined ? <div role="status" className="dsh-agent-group-muted">{t('memory.end')}</div> : null}
    </div></main>
  </div>
}

function MemoryRow({ item, t }: { readonly item: MemoryItem; readonly t: TranslateNS<'agentWorkspace'> }) {
  return <article className="dsh-agent-group-card" aria-label={t('memory.eventNamed', { sequence: item.sequence, type: item.type })}>
    <div className="dsh-agent-group-card-head"><strong>{t('memory.eventHeading', { sequence: item.sequence, type: item.type })}</strong><span>{t(`memory.provenance.${item.provenance}`)}</span></div>
    <dl className="dsh-agent-group-memory-meta">
      <dt>{t('memory.source')}</dt><dd>{item.source === undefined ? t('memory.unavailable') : t('memory.sourceDisplay', { label: item.source.label, kind: item.source.kind, id: item.source.id })}</dd>
      <dt>{t('memory.actor')}</dt><dd>{item.actor?.label ?? t('memory.unavailable')}</dd>
      <dt>{t('memory.subject')}</dt><dd>{item.subject?.label ?? t('memory.unavailable')}</dd>
      <dt>{t('memory.definition')}</dt><dd>{item.definitionRevision.status === 'active' ? t('memory.definitionRevision', { number: item.definitionRevision.number }) : t('memory.definitionUnresolved')}</dd>
      {item.childStatus === undefined ? null : <><dt>{t('memory.childStatus')}</dt><dd>{t(`memory.child.${item.childStatus}`)}</dd></>}
    </dl>
    {item.text === undefined ? null : <p>{item.text}</p>}
  </article>
}

function MemoryField({ label, children }: { readonly label: string; readonly children: React.ReactNode }) { return <label className="dsh-agent-group-field"><span>{label}</span>{children}</label> }
function uniqueItems(items: readonly MemoryItem[]): readonly MemoryItem[] { const seen = new Set<string>(); return items.filter(item => !seen.has(item.eventId) && Boolean(seen.add(item.eventId))) }
function positiveInteger(value: string): number | undefined { const parsed = Number(value); return value !== '' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined }
function isStale(error: unknown): boolean { return error instanceof WorkspaceApiError && error.code === 'stale-revision' }
