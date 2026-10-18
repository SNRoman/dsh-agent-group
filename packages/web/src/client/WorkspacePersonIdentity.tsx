/** Shared colleague identity content for directories, group members and selection. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentInstanceView } from './contracts.ts'
import type { AgentActivityProjection } from './activity-view-model.ts'
import { WorkspaceAgentRuntimeBadges } from './WorkspaceActivityDrawer.tsx'

/** @param props Colleague identity, current role and optional runtime activity. @returns Consistent identity fields with idle activity omitted. */
export function WorkspacePersonIdentity(props: {
  readonly agent: AgentInstanceView
  readonly roleName: string | undefined
  readonly activity?: AgentActivityProjection | undefined
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const { agent, activity, t } = props
  return <>
    <span className="dsh-agent-group-avatar" aria-hidden="true">{agent.name.slice(0, 1)}</span>
    <span className="dsh-agent-group-person-label">
      <strong>{agent.name}</strong>
      <small>{props.roleName}</small>
      {activity?.status !== 'idle' ? <WorkspaceAgentRuntimeBadges agent={activity} t={t} /> : null}
    </span>
    <span className="dsh-agent-group-person-status" data-employment={agent.employmentStatus}>{t(agent.employmentStatus === 'employed' ? 'agent.employed' : 'agent.departed')}</span>
  </>
}
