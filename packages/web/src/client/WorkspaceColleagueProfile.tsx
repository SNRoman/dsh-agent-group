/** Shared colleague details for chat identities and the people page. */
import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDefinitionId, AgentId, WorkspaceSnapshot } from './contracts.ts'

/** @param props Selected colleague, committed state and identity-safe mutations. @returns Current personal information with optional modal focus handling. */
export function WorkspaceColleagueProfile(props: {
  readonly snapshot: WorkspaceSnapshot
  readonly agentId: AgentId
  readonly busy: boolean
  readonly modal?: boolean
  readonly onClose?: () => void
  readonly onRename: (agentId: AgentId, name: string) => Promise<boolean>
  readonly onSetEmployment: (agentId: AgentId, employed: boolean) => Promise<void>
  readonly onOpenDirect: (agentId: AgentId) => Promise<void>
  readonly onView: (mode: 'tasks' | 'memory', agentId: AgentId) => void
  readonly onEditRole: (definitionId: AgentDefinitionId) => void
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const agent = props.snapshot.agents[props.agentId]
  const [name, setName] = useState(agent?.name ?? '')
  const [nameError, setNameError] = useState(false)
  const [departConfirm, setDepartConfirm] = useState(false)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => { setName(agent?.name ?? ''); setNameError(false); setDepartConfirm(false) }, [agent?.id, agent?.name])
  useEffect(() => {
    if (!props.modal) return
    const previous = document.activeElement
    dialog.current?.querySelector<HTMLElement>('button, input')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [props.modal])
  if (agent === undefined) return null
  const role = props.snapshot.definitions[agent.definitionId]
  const revision = props.snapshot.definitionRevisions[agent.definitionRevisionId]
  const save = async (): Promise<void> => {
    const trimmed = name.trim()
    const collision = Object.values(props.snapshot.agents).some(other => other.id !== agent.id && other.name.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase())
    if (!trimmed || collision) { setNameError(true); return }
    setNameError(false)
    await props.onRename(agent.id, trimmed)
  }
  return <section ref={dialog} role={props.modal ? 'dialog' : undefined} aria-modal={props.modal ? true : undefined} aria-label={props.t('people.profile')} data-colleague-id={agent.id} className={props.modal ? 'dsh-agent-group-modal dsh-agent-group-profile-modal' : 'dsh-agent-group-profile'} onKeyDown={event => {
    if (!props.modal) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose?.(); return }
    if (event.key !== 'Tab') return
    const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')].filter(element => !element.closest('details:not([open])') || element.tagName === 'SUMMARY')
    const first = elements[0]
    const last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <div className={props.modal ? 'dsh-agent-group-modal-card dsh-agent-group-profile' : 'dsh-agent-group-profile-content'}>
      <header className="dsh-agent-group-profile-head">
        <span className="dsh-agent-group-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <div><h2>{agent.name}</h2><span className="dsh-agent-group-muted">{props.t('people.roleStatus', { role: role?.name ?? '', status: props.t(agent.employmentStatus === 'employed' ? 'agent.employed' : 'agent.departed') })}</span></div>
        {props.modal ? <button type="button" className="dsh-agent-group-button dsh-agent-group-right" data-variant="ghost" aria-label={props.t('workspace.close')} onClick={props.onClose}>{props.t('workspace.close')}</button> : null}
      </header>
      <form className="dsh-agent-group-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <label className="dsh-agent-group-field"><span>{props.t('people.name')}</span><input className="dsh-agent-group-input" aria-label={props.t('people.name')} value={name} disabled={props.busy} onChange={event => { setName(event.target.value); setNameError(false) }} /></label>
        {nameError ? <p role="alert" className="dsh-agent-group-error">{props.t('people.nameInvalid')}</p> : null}
        <button type="submit" className="dsh-agent-group-button" disabled={props.busy || name.trim() === agent.name}>{props.t('people.saveName')}</button>
      </form>
      <div className="dsh-agent-group-profile-actions">
        <button type="button" className="dsh-agent-group-button" disabled={props.busy || agent.employmentStatus !== 'employed'} onClick={() => void props.onOpenDirect(agent.id)}>{props.t('room.direct')}</button>
        <button type="button" className="dsh-agent-group-button" data-variant="ghost" onClick={() => props.onView('tasks', agent.id)}>{props.t('people.work')}</button>
        <button type="button" className="dsh-agent-group-button" data-variant="ghost" onClick={() => props.onView('memory', agent.id)}>{props.t('people.memory')}</button>
      </div>
      <section className="dsh-agent-group-card"><div className="dsh-agent-group-card-head"><strong>{props.t('people.roleHeading', { role: role?.name ?? '' })}</strong><button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={props.busy} onClick={() => props.onEditRole(agent.definitionId)}>{props.t('people.editRole')}</button></div>
        <p className="dsh-agent-group-profile-prose">{revision?.description}</p>
        <details><summary>{props.t('agent.instructions')}</summary><p className="dsh-agent-group-profile-prose">{revision?.instructions}</p></details>
      </section>
      <details className="dsh-agent-group-card"><summary>{props.t('people.history')}</summary><p className="dsh-agent-group-muted">{props.t('agent.revision', { number: revision?.number ?? 0 })}</p><code>{agent.id}</code></details>
      {departConfirm ? <div role="alert" className="dsh-agent-group-card"><p>{props.t('people.departConfirm', { name: agent.name })}</p><div className="dsh-agent-group-inline"><button type="button" className="dsh-agent-group-button" disabled={props.busy} onClick={() => { void props.onSetEmployment(agent.id, false); setDepartConfirm(false) }}>{props.t('agent.depart')}</button><button type="button" className="dsh-agent-group-button" data-variant="ghost" onClick={() => setDepartConfirm(false)}>{props.t('room.cancel')}</button></div></div>
        : <button type="button" className="dsh-agent-group-button" data-variant="ghost" disabled={props.busy} onClick={() => agent.employmentStatus === 'employed' ? setDepartConfirm(true) : void props.onSetEmployment(agent.id, true)}>{props.t(agent.employmentStatus === 'employed' ? 'agent.depart' : 'agent.reemploy')}</button>}
    </div>
  </section>
}
