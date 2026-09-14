/** Immutable definition-revision history and selective synchronization. */

import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspaceApiError } from './api.ts'
import type { WorkspaceApiClient } from './api.ts'
import type { AgentDefinitionId, AgentId, DefinitionHistoryItem, DefinitionRevisionId, WorkspaceSnapshot } from './contracts.ts'

type SynchronizationMode = 'none' | 'all' | 'subset'
type RequestState = 'idle' | 'pending' | 'stale' | 'error'

export interface WorkspaceDefinitionHistoryProps {
  readonly snapshot: WorkspaceSnapshot
  readonly definitionId: AgentDefinitionId
  readonly description: string
  readonly instructions: string
  readonly api: WorkspaceApiClient
  readonly onDescriptionChange: (value: string) => void
  readonly onInstructionsChange: (value: string) => void
  readonly onSnapshot: (snapshot: WorkspaceSnapshot) => void
  readonly onSaveSuccess: () => void
  readonly onEditorCancel: () => void
  readonly onDraftReservationChange: (reserved: boolean) => void
  readonly t: TranslateNS<'agentWorkspace'>
}

/** Render revision editing, history and explicit synchronization workflows. */
export function WorkspaceDefinitionHistory(props: WorkspaceDefinitionHistoryProps) {
  const [history, setHistory] = useState<readonly DefinitionHistoryItem[]>([])
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [historyVersion, setHistoryVersion] = useState(0)
  const historyGeneration = useRef(0)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveMode, setSaveMode] = useState<SynchronizationMode>('none')
  const [saveAgentIds, setSaveAgentIds] = useState<readonly AgentId[]>([])
  const [saveState, setSaveState] = useState<RequestState>('idle')
  const [laterRevisionId, setLaterRevisionId] = useState<DefinitionRevisionId | undefined>()
  const [laterAgentIds, setLaterAgentIds] = useState<readonly AgentId[]>([])
  const [laterState, setLaterState] = useState<RequestState>('idle')
  const activeSelection = useRef({ definitionId: props.definitionId, generation: 0 })
  const saveTrigger = useRef<HTMLButtonElement | null>(null)
  const laterTrigger = useRef<HTMLButtonElement | null>(null)
  if (activeSelection.current.definitionId !== props.definitionId) {
    activeSelection.current = { definitionId: props.definitionId, generation: activeSelection.current.generation + 1 }
  }
  const agents = Object.values(props.snapshot.agents)
    .filter(agent => agent.definitionId === props.definitionId)
    .toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))

  useEffect(() => {
    const controller = new AbortController()
    const requestGeneration = ++historyGeneration.current
    setHistoryState('loading')
    void props.api.definitionHistory(props.definitionId, controller.signal).then(result => {
      if (controller.signal.aborted || historyGeneration.current !== requestGeneration) return
      setHistory([...result].toSorted((left, right) => right.number - left.number || left.id.localeCompare(right.id)))
      setHistoryState('ready')
    }).catch(() => {
      if (!controller.signal.aborted && historyGeneration.current === requestGeneration) setHistoryState('error')
    })
    return () => controller.abort()
  }, [props.api, props.definitionId, props.snapshot.revision, historyVersion])

  useEffect(() => {
    setSaveOpen(false)
    setSaveMode('none')
    setSaveAgentIds([])
    setSaveState('idle')
    setLaterRevisionId(undefined)
    setLaterAgentIds([])
    setLaterState('idle')
    props.onDraftReservationChange(false)
  }, [props.definitionId])

  const refreshAfterStale = async (kind: 'save' | 'later', selectionGeneration: number): Promise<void> => {
    try {
      const refreshed = await props.api.snapshot()
      const selectionIsCurrent = activeSelection.current.generation === selectionGeneration
      if (refreshed.revision <= props.snapshot.revision) {
        if (!selectionIsCurrent) return
        if (kind === 'save') setSaveState('error')
        else setLaterState('error')
        return
      }
      props.onSnapshot(refreshed)
      if (!selectionIsCurrent) return
      if (kind === 'save') setSaveState('stale')
      else setLaterState('stale')
    } catch {
      if (activeSelection.current.generation !== selectionGeneration) return
      if (kind === 'save') setSaveState('error')
      else setLaterState('error')
    }
  }

  const selectedForSave = (mode: SynchronizationMode): readonly AgentId[] => mode === 'all'
    ? agents.map(agent => agent.id)
    : mode === 'subset' ? saveAgentIds : []

  const save = async (mode = saveMode): Promise<void> => {
    const selected = selectedForSave(mode)
    if (mode === 'subset' && selected.length === 0) return
    const selectionGeneration = activeSelection.current.generation
    setSaveState('pending')
    try {
      const committed = await props.api.reviseDefinition({
        definitionId: props.definitionId,
        description: props.description,
        instructions: props.instructions,
        ...(selected.length === 0 ? {} : { synchronizeAgentIds: selected }),
      }, props.snapshot.revision)
      props.onSnapshot(committed)
      if (activeSelection.current.generation !== selectionGeneration) {
        return
      }
      setSaveOpen(false)
      setSaveMode('none')
      setSaveAgentIds([])
      setSaveState('idle')
      props.onDraftReservationChange(false)
      props.onSaveSuccess()
      restoreFocus(saveTrigger)
    } catch (error) {
      if (isStale(error)) await refreshAfterStale('save', selectionGeneration)
      else if (activeSelection.current.generation === selectionGeneration) setSaveState('error')
    }
  }

  const synchronize = async (): Promise<void> => {
    if (laterRevisionId === undefined || laterAgentIds.length === 0) return
    const selectionGeneration = activeSelection.current.generation
    setLaterState('pending')
    try {
      const committed = await props.api.synchronizeDefinition(props.definitionId, laterRevisionId, laterAgentIds, props.snapshot.revision)
      props.onSnapshot(committed)
      if (activeSelection.current.generation !== selectionGeneration) return
      setLaterRevisionId(undefined)
      setLaterAgentIds([])
      setLaterState('idle')
      restoreFocus(laterTrigger)
    } catch (error) {
      if (isStale(error)) await refreshAfterStale('later', selectionGeneration)
      else if (activeSelection.current.generation === selectionGeneration) setLaterState('error')
    }
  }

  return <>
    <section className="dsh-agent-group-card">
      <div className="dsh-agent-group-form">
        <HistoryField label={props.t('agent.description')}><textarea className="dsh-agent-group-textarea" aria-label={props.t('agent.description')} value={props.description} onChange={event => props.onDescriptionChange(event.target.value)} /></HistoryField>
        <HistoryField label={props.t('agent.instructions')}><textarea className="dsh-agent-group-textarea" aria-label={props.t('agent.instructions')} value={props.instructions} onChange={event => props.onInstructionsChange(event.target.value)} /></HistoryField>
        <div className="dsh-agent-group-inline">
          <button type="button" className="dsh-agent-group-button" disabled={saveState === 'pending'} onClick={event => { saveTrigger.current = event.currentTarget; props.onDraftReservationChange(true); setSaveOpen(true); setSaveState('idle') }}>{props.t('agent.saveRevision')}</button>
          <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={saveState === 'pending'} onClick={() => { props.onDraftReservationChange(false); props.onEditorCancel() }}>{props.t('room.cancel')}</button>
        </div>
        {saveState === 'stale' ? <div role="status" className="dsh-agent-group-retry"><span>{props.t('history.saveStale')}</span><button type="button" className="dsh-agent-group-button" aria-label={props.t('history.retrySave')} onClick={() => void save()}>{props.t('workspace.retry')}</button></div> : null}
        {saveState === 'error' ? <div role="alert" className="dsh-agent-group-error">{props.t('history.saveError')}</div> : null}
      </div>
    </section>

    <section className="dsh-agent-group-card">
      <div className="dsh-agent-group-card-head"><strong>{props.t('history.title')}</strong></div>
      {historyState === 'loading' ? <div role="status" className="dsh-agent-group-empty">{props.t('history.loading')}</div> : null}
      {historyState === 'error' ? <div role="alert" className="dsh-agent-group-error">{props.t('history.error')} <button type="button" className="dsh-agent-group-button" onClick={() => setHistoryVersion(value => value + 1)}>{props.t('workspace.retry')}</button></div> : null}
      {historyState === 'ready' && history.length === 0 ? <div className="dsh-agent-group-empty">{props.t('history.empty')}</div> : null}
      <div className="dsh-agent-group-history-list">{history.map(item => <article key={item.id} className="dsh-agent-group-history-item" aria-label={props.t('history.revisionNamed', { number: item.number })}>
        <div className="dsh-agent-group-card-head"><strong>{props.t('agent.revision', { number: item.number })}</strong><span>{item.status === 'current' ? props.t('history.current') : props.t('history.previous')}</span></div>
        <p>{item.description}</p><p>{item.instructions}</p>
        <p className="dsh-agent-group-muted">{item.creationEvent.status === 'unresolved' ? props.t('history.creationUnresolved') : props.t(item.creationEvent.status === 'exact' ? 'history.creationExact' : 'history.creationDerived', { sequence: item.creationEvent.sequence })}</p>
        <div>{props.t('history.pinnedList', { agents: item.agentIds.length === 0 ? props.t('history.nonePinned') : item.agentIds.map(id => {
          const agent = props.snapshot.agents[id]
          return agent === undefined
            ? props.t('history.unknownPinned', { id })
            : props.t('history.agentPinned', { name: agent.name, id, status: agent.employmentStatus === 'employed' ? props.t('agent.employed') : props.t('agent.departed') })
        }).join(props.t('history.listSeparator')) })}</div>
        <button type="button" className="dsh-agent-group-button" aria-label={props.t('history.synchronizeNamed', { number: item.number })} onClick={event => { laterTrigger.current = event.currentTarget; setLaterRevisionId(item.id); setLaterAgentIds([]); setLaterState('idle') }}>{props.t('history.synchronize')}</button>
      </article>)}</div>
    </section>

    {saveOpen ? <div role="dialog" aria-modal="true" aria-label={props.t('history.saveDialog')} className="dsh-agent-group-modal" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void save('none') } }}>
      <div className="dsh-agent-group-modal-card">
        <button type="button" autoFocus className="dsh-agent-group-icon-button dsh-agent-group-right" aria-label={props.t('history.closeSaveDialog')} disabled={saveState === 'pending'} onClick={() => void save('none')}>{props.t('workspace.close')}</button>
        <h2>{props.t('history.saveDialog')}</h2>
        {(['none', 'all', 'subset'] as const).map(mode => <label key={mode} className="dsh-agent-group-check"><input type="radio" name="revision-sync" aria-label={props.t(`history.mode.${mode}`)} checked={saveMode === mode} onChange={() => setSaveMode(mode)} />{props.t(`history.mode.${mode}`)}</label>)}
        {saveMode === 'subset' ? <AgentChoices agents={agents} selected={saveAgentIds} onChange={setSaveAgentIds} label={(name, id) => props.t('history.selectAgent', { name, id })} /> : null}
        {saveMode === 'subset' && saveAgentIds.length === 0 ? <div role="status" className="dsh-agent-group-muted">{props.t('history.selectAtLeastOne')}</div> : null}
        <button type="button" className="dsh-agent-group-button" aria-label={props.t('history.saveConfirm')} disabled={saveState === 'pending' || saveState === 'stale' || (saveMode === 'subset' && saveAgentIds.length === 0)} onClick={() => void save()}>{props.t('history.saveConfirm')}</button>
      </div>
    </div> : null}

    {laterRevisionId !== undefined ? <div role="dialog" aria-modal="true" aria-label={props.t('history.laterDialog')} className="dsh-agent-group-modal" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setLaterRevisionId(undefined); setLaterAgentIds([]); setLaterState('idle'); restoreFocus(laterTrigger) } }}>
      <div className="dsh-agent-group-modal-card">
        <h2>{props.t('history.laterDialog')}</h2>
        <p>{props.t('history.preservation')}</p>
        <AgentChoices agents={agents} selected={laterAgentIds} onChange={setLaterAgentIds} label={(name, id) => props.t('history.selectAgent', { name, id })} />
        {laterAgentIds.length === 0 ? <div role="status" className="dsh-agent-group-muted">{props.t('history.selectAtLeastOne')}</div> : null}
        {laterState === 'stale' ? <div role="status" className="dsh-agent-group-retry"><span>{props.t('history.syncStale')}</span><button type="button" className="dsh-agent-group-button" aria-label={props.t('history.retrySync')} onClick={() => void synchronize()}>{props.t('workspace.retry')}</button></div> : null}
        {laterState === 'error' ? <div role="alert" className="dsh-agent-group-error">{props.t('history.syncError')}</div> : null}
        <div className="dsh-agent-group-inline">
          <button type="button" className="dsh-agent-group-button" aria-label={props.t('history.confirmSynchronization')} disabled={laterState === 'pending' || laterState === 'stale' || laterAgentIds.length === 0} onClick={() => void synchronize()}>{props.t('history.confirmSynchronization')}</button>
          <button type="button" className="dsh-agent-group-button" data-variant="ghost" aria-label={props.t('history.cancelSynchronization')} disabled={laterState === 'pending'} onClick={() => { setLaterRevisionId(undefined); setLaterAgentIds([]); setLaterState('idle'); restoreFocus(laterTrigger) }}>{props.t('history.cancelSynchronization')}</button>
        </div>
      </div>
    </div> : null}
  </>
}

function AgentChoices({ agents, selected, onChange, label }: {
  readonly agents: readonly { readonly id: AgentId; readonly name: string }[]
  readonly selected: readonly AgentId[]
  readonly onChange: (ids: readonly AgentId[]) => void
  readonly label: (name: string, id: AgentId) => string
}) {
  return <fieldset className="dsh-agent-group-fieldset">{agents.map(agent => <label key={agent.id} className="dsh-agent-group-check"><input type="checkbox" aria-label={label(agent.name, agent.id)} checked={selected.includes(agent.id)} onChange={event => onChange(event.target.checked ? [...selected, agent.id] : selected.filter(id => id !== agent.id))} />{label(agent.name, agent.id)}</label>)}</fieldset>
}

function HistoryField({ label, children }: { readonly label: string; readonly children: React.ReactNode }) { return <label className="dsh-agent-group-field"><span>{label}</span>{children}</label> }
function isStale(error: unknown): boolean { return error instanceof WorkspaceApiError && error.code === 'stale-revision' }
function restoreFocus(trigger: { readonly current: HTMLButtonElement | null }): void { queueMicrotask(() => trigger.current?.focus()) }
