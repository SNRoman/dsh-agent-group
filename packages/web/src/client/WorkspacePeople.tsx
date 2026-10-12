/** Person-first colleague directory with auxiliary shared-role management. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDefinitionId, AgentId, WorkspaceSnapshot } from './contracts.ts'

/** @param props Durable people, shared selection and the role editor. @returns A colleague directory that keeps templates secondary. */
export function WorkspacePeople(props: {
  readonly snapshot: WorkspaceSnapshot
  readonly selectedAgentId: AgentId | undefined
  readonly busy: boolean
  readonly roleManagementOpen: boolean
  readonly onRoleManagementOpen: (value: boolean) => void
  readonly onSelect: (id: AgentId) => void
  readonly onCreate: (definitionId: AgentDefinitionId, name: string) => Promise<boolean>
  readonly profile: ReactNode
  readonly roleManagement: ReactNode
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [definitionId, setDefinitionId] = useState('')
  const definitions = Object.values(props.snapshot.definitions)
  const selectedRole = definitionId || definitions[0]?.id || ''
  const people = Object.values(props.snapshot.agents).filter(agent => `${agent.name} ${props.snapshot.definitions[agent.definitionId]?.name ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <div className="dsh-agent-group-people-body" data-mode="colleagues">
    <aside className="dsh-agent-group-panel">
      <div className="dsh-agent-group-section-head"><strong>{props.t('workspace.colleagues')}</strong><button type="button" className="dsh-agent-group-button dsh-agent-group-right" disabled={props.busy} onClick={() => { setAdding(value => !value); if (!definitions.length) props.onRoleManagementOpen(true) }}>{props.t('people.add')}</button></div>
      <label className="dsh-agent-group-field"><input className="dsh-agent-group-input" type="search" value={query} aria-label={props.t('people.search')} placeholder={props.t('people.search')} onChange={event => setQuery(event.target.value)} /></label>
      {adding && definitions.length > 0 ? <form className="dsh-agent-group-form dsh-agent-group-card" onSubmit={event => { event.preventDefault(); void props.onCreate(selectedRole, name.trim()).then(saved => { if (saved) { setName(''); setAdding(false) } }) }}>
        <label className="dsh-agent-group-field"><span>{props.t('people.name')}</span><input className="dsh-agent-group-input" value={name} aria-label={props.t('people.name')} onChange={event => setName(event.target.value)} autoFocus /></label>
        <label className="dsh-agent-group-field"><span>{props.t('people.selectRole')}</span><select className="dsh-agent-group-select" value={selectedRole} onChange={event => setDefinitionId(event.target.value)}>{definitions.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
        <button type="submit" className="dsh-agent-group-button" disabled={props.busy || !name.trim() || !selectedRole}>{props.t('people.add')}</button>
      </form> : null}
      <div className="dsh-agent-group-scroll dsh-agent-group-list" data-colleague-list>
        {people.map(agent => <button type="button" key={agent.id} className="dsh-agent-group-list-button" data-active={props.selectedAgentId === agent.id} data-agent-id={agent.id} onClick={() => props.onSelect(agent.id)}><span className="dsh-agent-group-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</span><span className="dsh-agent-group-person-label"><strong>{agent.name}</strong><small>{props.snapshot.definitions[agent.definitionId]?.name}</small></span><small>{props.t(agent.employmentStatus === 'employed' ? 'agent.employed' : 'agent.departed')}</small></button>)}
        {people.length === 0 ? <p className="dsh-agent-group-empty">{props.t('people.empty')}</p> : null}
      </div>
    </aside>
    <main className="dsh-agent-group-panel dsh-agent-group-people-main"><div className="dsh-agent-group-scroll">
      {props.profile}
      <details className="dsh-agent-group-role-management" data-role-management open={props.roleManagementOpen} onToggle={event => props.onRoleManagementOpen(event.currentTarget.open)}><summary>{props.t('people.roleManagement')}</summary><p className="dsh-agent-group-muted">{props.t('people.sharedRoleHint')}</p>{props.roleManagement}</details>
    </div></main>
  </div>
}
