/** Person-first colleague directory with auxiliary shared-role management. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDefinitionId, AgentId, WorkspaceSnapshot } from './contracts.ts'
import type { WorkspaceActivityProjection } from './activity-view-model.ts'
import { WorkspacePersonIdentity } from './WorkspacePersonIdentity.tsx'

/** @param props Durable people, shared selection and the role editor. @returns A colleague directory that keeps templates secondary. */
export function WorkspacePeople(props: {
  readonly snapshot: WorkspaceSnapshot
  readonly selectedAgentId: AgentId | undefined
  readonly busy: boolean
  readonly roleManagementOpen: boolean
  readonly onRoleManagementOpen: (value: boolean) => void
  readonly onSelect: (id: AgentId) => void
  readonly onCreate: (definitionId: AgentDefinitionId, name: string) => Promise<boolean>
  readonly onCreateRole: (name: string, description: string, instructions: string) => Promise<AgentDefinitionId | undefined>
  readonly activity: WorkspaceActivityProjection
  readonly profile: ReactNode
  readonly roleManagement: ReactNode
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [definitionId, setDefinitionId] = useState('')
  const [status, setStatus] = useState('all')
  const [creatingRole, setCreatingRole] = useState(false)
  const [roleName, setRoleName] = useState('')
  const [roleDescription, setRoleDescription] = useState('')
  const [roleInstructions, setRoleInstructions] = useState('')
  const [failed, setFailed] = useState(false)
  const definitions = Object.values(props.snapshot.definitions)
  const selectedRole = definitionId || definitions[0]?.id || ''
  const people = Object.values(props.snapshot.agents).filter(agent => (status === 'all' || agent.employmentStatus === status) && `${agent.name} ${props.snapshot.definitions[agent.definitionId]?.name ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <div className="dsh-agent-group-people-body" data-mode="colleagues">
    <aside className="dsh-agent-group-panel dsh-agent-group-people-sidebar">
      <div className="dsh-agent-group-section-head"><strong>{props.t('workspace.colleagues')}</strong><button type="button" className="dsh-agent-group-button dsh-agent-group-right" disabled={props.busy} onClick={() => { setAdding(value => !value); setCreatingRole(!definitions.length); setFailed(false) }}>{props.t('people.add')}</button></div>
      <label className="dsh-agent-group-field"><input className="dsh-agent-group-input" type="search" value={query} aria-label={props.t('people.search')} placeholder={props.t('people.search')} onChange={event => setQuery(event.target.value)} /></label>
      <label className="dsh-agent-group-field"><select className="dsh-agent-group-select" aria-label={props.t('people.employmentFilter')} value={status} onChange={event => setStatus(event.target.value)}><option value="all">{props.t('people.all')}</option><option value="employed">{props.t('agent.employed')}</option><option value="departed">{props.t('agent.departed')}</option></select></label>
      {adding ? <form className="dsh-agent-group-form dsh-agent-group-card" onSubmit={event => { event.preventDefault(); void props.onCreate(selectedRole, name.trim()).then(saved => { setFailed(!saved); if (saved) { setName(''); setAdding(false) } }) }}>
        <label className="dsh-agent-group-field"><span>{props.t('people.name')}</span><input className="dsh-agent-group-input" value={name} aria-label={props.t('people.name')} onChange={event => setName(event.target.value)} autoFocus /></label>
        <label className="dsh-agent-group-field"><span>{props.t('people.selectRole')}</span><select className="dsh-agent-group-select" aria-label={props.t('people.selectRole')} value={selectedRole} onChange={event => setDefinitionId(event.target.value)}>{definitions.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
        <button type="button" data-create-role className="dsh-agent-group-button" data-variant="ghost" disabled={props.busy} onClick={() => setCreatingRole(value => !value)}>{props.t('people.createRole')}</button>
        {creatingRole ? <section className="dsh-agent-group-form">
          <label className="dsh-agent-group-field"><span>{props.t('people.newRoleName')}</span><input className="dsh-agent-group-input" aria-label={props.t('people.newRoleName')} value={roleName} onChange={event => setRoleName(event.target.value)} /></label>
          <label className="dsh-agent-group-field"><span>{props.t('agent.description')}</span><textarea className="dsh-agent-group-textarea" value={roleDescription} onChange={event => setRoleDescription(event.target.value)} /></label>
          <label className="dsh-agent-group-field"><span>{props.t('agent.instructions')}</span><textarea className="dsh-agent-group-textarea" value={roleInstructions} onChange={event => setRoleInstructions(event.target.value)} /></label>
          <button type="button" data-save-new-role className="dsh-agent-group-button" disabled={props.busy || !roleName.trim()} onClick={() => { void props.onCreateRole(roleName.trim(), roleDescription, roleInstructions).then(id => { setFailed(id === undefined); if (id !== undefined) { setDefinitionId(id); setCreatingRole(false); setRoleName(''); setRoleDescription(''); setRoleInstructions('') } }) }}>{props.t('people.saveRole')}</button>
        </section> : null}
        {failed ? <p role="alert" className="dsh-agent-group-error">{props.t('people.saveFailed')}</p> : null}
        <button type="submit" className="dsh-agent-group-button" disabled={props.busy || !name.trim() || !selectedRole}>{props.t('people.add')}</button>
      </form> : null}
      <div className="dsh-agent-group-scroll dsh-agent-group-list" data-colleague-list>
        {people.map(agent => <button type="button" key={agent.id} className="dsh-agent-group-list-button" data-active={props.selectedAgentId === agent.id} aria-pressed={props.selectedAgentId === agent.id} data-agent-id={agent.id} onClick={() => props.onSelect(agent.id)}><WorkspacePersonIdentity agent={agent} roleName={props.snapshot.definitions[agent.definitionId]?.name} activity={props.activity.agents[agent.id]} t={props.t} /></button>)}
        {people.length === 0 ? <p className="dsh-agent-group-empty">{props.t('people.empty')}</p> : null}
      </div>
    </aside>
    <main className="dsh-agent-group-panel dsh-agent-group-people-main"><div className="dsh-agent-group-scroll">
      {props.profile}
      <details className="dsh-agent-group-role-management" data-role-management open={props.roleManagementOpen} onToggle={event => props.onRoleManagementOpen(event.currentTarget.open)}><summary>{props.t('people.roleManagement')}</summary><p className="dsh-agent-group-muted">{props.t('people.sharedRoleHint')}</p>{props.roleManagement}</details>
    </div></main>
  </div>
}
