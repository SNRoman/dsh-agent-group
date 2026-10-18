/** Searchable colleague selection for joining a group with its complete chat history. */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentId, WorkspaceSnapshot } from './contracts.ts'
import { WorkspacePersonIdentity } from './WorkspacePersonIdentity.tsx'

/** @param props Eligible colleagues, current roles and the explicit join action. @returns A focus-contained multi-colleague picker without memory-range controls. */
export function WorkspaceAddColleague(props: {
  readonly candidates: readonly WorkspaceSnapshot['agents'][string][]
  readonly snapshot: WorkspaceSnapshot
  readonly busy: boolean
  readonly onJoin: (agentIds: readonly AgentId[]) => Promise<boolean>
  readonly onClose: () => void
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const { t } = props
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<readonly AgentId[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement
    search.current?.focus()
    return () => { alive.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  const matches = props.candidates.filter(agent => `${agent.name} ${props.snapshot.definitions[agent.definitionId]?.name ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const selected = props.candidates.filter(agent => selectedIds.includes(agent.id))
  const busy = props.busy || submitting
  const submit = async (): Promise<void> => {
    if (busy || selected.length === 0) return
    setSubmitting(true)
    setFailed(false)
    let saved = false
    try { saved = await props.onJoin(selected.map(agent => agent.id)) }
    catch (_error) { /* Colleagues still eligible for admission remain selected for retry. */ }
    if (!alive.current) return
    setSubmitting(false)
    if (saved) close.current()
    else setFailed(true)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
    if (event.key !== 'Tab') return
    const controls = root.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])')
    if (controls === undefined || controls.length === 0) return
    const first = controls[0]!, last = controls[controls.length - 1]!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  return <div className="dsh-agent-group-modal dsh-agent-group-add-colleague-modal">
    <div ref={root} className="dsh-agent-group-modal-card dsh-agent-group-add-colleague-dialog" role="dialog" aria-modal="true" aria-label={t('room.addAgent')} data-add-colleague onKeyDown={keyDown}>
      <header><h2>{t('room.addAgent')}</h2><p className="dsh-agent-group-muted">{t('room.joinHistoryHint')}</p></header>
      <input ref={search} type="search" className="dsh-agent-group-input" aria-label={t('room.searchColleagues')} placeholder={t('room.searchColleagues')} value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setFailed(false) }} />
      <div className="dsh-agent-group-add-colleague-list" role="group" aria-label={t('room.selectColleague')}>
        {matches.map(agent => <label key={agent.id} className="dsh-agent-group-add-colleague-option" data-agent-id={agent.id} data-selected={selectedIds.includes(agent.id)}>
          <input type="checkbox" name="group-colleague" value={agent.id} checked={selectedIds.includes(agent.id)} disabled={busy} onChange={() => { setSelectedIds(current => current.includes(agent.id) ? current.filter(id => id !== agent.id) : [...current, agent.id]); setFailed(false) }} />
          <WorkspacePersonIdentity agent={agent} roleName={props.snapshot.definitions[agent.definitionId]?.name} t={t} />
        </label>)}
        {matches.length === 0 ? <p className="dsh-agent-group-muted">{props.candidates.length === 0 ? t('room.noColleaguesToAdd') : t('room.noMatchingColleagues')}</p> : null}
      </div>
      {failed ? <p className="dsh-agent-group-error" role="alert">{t('room.joinFailed')}</p> : null}
      <footer className="dsh-agent-group-add-colleague-footer">
        <span className="dsh-agent-group-muted">{selected.length === 0 ? t('room.selectColleague') : t('room.selectedColleagues', { count: selected.length })}</span>
        <div className="dsh-agent-group-inline"><button type="button" className="dsh-agent-group-button" data-variant="ghost" onClick={() => close.current()}>{t('room.cancel')}</button><button type="button" className="dsh-agent-group-button" data-confirm-join disabled={busy || selected.length === 0} onClick={() => void submit()}>{busy ? t('workspace.processing') : t('room.join')}</button></div>
      </footer>
    </div>
  </div>
}
