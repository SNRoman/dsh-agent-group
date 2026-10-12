/** Identity-aware message bubbles over durable room messages. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MouseEvent } from 'react'
import type { AgentId, WorkspaceEventView, WorkspaceSnapshot } from './contracts.ts'
import { actorLabel, linkRoomMessageMentions, roomMessageMentionSpans } from './view-model.ts'
import { WorkspaceMarkdownMessage } from './WorkspaceTurn.tsx'

/** @param props Durable message, current labels and a shared profile opener. @returns A message bubble with keyboard-accessible identity and admitted mentions. */
export function WorkspaceChatMessage({ snapshot, event, onOpenColleague, t }: {
  readonly snapshot: WorkspaceSnapshot
  readonly event: WorkspaceEventView
  readonly onOpenColleague: (agentId: AgentId) => void
  readonly t: TranslateNS<'agentWorkspace'>
}) {
  const name = actorLabel(snapshot, event.actor, t)
  const agentId = event.actor?.type === 'agent' ? event.actor.id : undefined
  const raw = event.text ?? ''
  const spans = roomMessageMentionSpans(snapshot, raw, event.mentions ?? [])
  const segments = []
  let previous = 0
  for (const span of spans) {
    segments.push(raw.slice(previous, span.start))
    segments.push(<button type="button" key={`${span.start}:${span.agentId}`} className="dsh-agent-group-mention" data-agent-id={span.agentId} onClick={() => onOpenColleague(span.agentId)}>{span.label}</button>)
    previous = span.end
  }
  segments.push(raw.slice(previous))
  const openLink = (click: MouseEvent<HTMLDivElement>): void => {
    if (!(click.target instanceof Element)) return
    const link = click.target.closest<HTMLAnchorElement>('a[href^="#dsh-agent-group-person/"]')
    if (link === null) return
    const href = link.getAttribute('href')
    const id = (event.mentions ?? []).find(candidate => href === `#dsh-agent-group-person/${encodeURIComponent(candidate)}`)
    if (!click.currentTarget.contains(link) || id === undefined || !snapshot.agents[id]) return
    click.preventDefault()
    onOpenColleague(id)
  }
  return <article className="dsh-agent-group-message" data-author={event.actor?.type ?? 'system'} data-message-id={event.id}>
    {agentId !== undefined ? <button type="button" className="dsh-agent-group-avatar" data-agent-id={agentId} aria-label={t('people.openNamed', { name })} onClick={() => onOpenColleague(agentId)}>{name.slice(0, 1)}</button>
      : <div className="dsh-agent-group-avatar" aria-hidden="true">{name.slice(0, 1)}</div>}
    <div className="dsh-agent-group-message-body">
      <div className="dsh-agent-group-message-meta">{agentId !== undefined ? <button type="button" className="dsh-agent-group-identity" data-agent-id={agentId} onClick={() => onOpenColleague(agentId)}>{name}</button> : <strong>{name}</strong>}</div>
      <div className="dsh-agent-group-message-text" onClick={openLink}>
        {agentId !== undefined ? <WorkspaceMarkdownMessage text={linkRoomMessageMentions(snapshot, raw, event.mentions ?? [])} t={t} /> : segments}
      </div>
    </div>
  </article>
}
