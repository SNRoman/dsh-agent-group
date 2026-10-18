/** Identity-aware message bubbles over durable room messages. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MouseEvent } from 'react'
import type { AgentId, WorkspaceEventView, WorkspaceSnapshot } from './contracts.ts'
import { actorLabel, linkRoomMessageMentions, roomMessageMentionSpans } from './view-model.ts'
import { WorkspaceMarkdownMessage } from './WorkspaceTurn.tsx'

/** @param props Durable message, current labels and a shared profile opener. @returns A message bubble with keyboard-accessible identity and admitted mentions. */
export function WorkspaceChatMessage({ snapshot, event, highlighted, withdrawn, invalidated, onRecall, recallStatus, onOpenColleague, t }: {
  readonly snapshot: WorkspaceSnapshot
  readonly event: WorkspaceEventView
  readonly highlighted?: boolean | undefined
  readonly withdrawn?: boolean | undefined
  readonly invalidated?: boolean | undefined
  readonly recallStatus?: 'pending' | 'failed' | 'completed' | undefined
  readonly onRecall?: (() => void) | undefined
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
    const link = click.target.closest<HTMLAnchorElement>('a[href^="https://dsh-agent-group.invalid/people/"]')
    if (link === null) return
    const href = link.getAttribute('href')
    const id = (event.mentions ?? []).find(candidate => href === `https://dsh-agent-group.invalid/people/${encodeURIComponent(candidate)}`)
    if (!click.currentTarget.contains(link) || id === undefined || !snapshot.agents[id]) return
    click.preventDefault()
    click.stopPropagation()
    onOpenColleague(id)
  }
  return <article className="dsh-agent-group-message" tabIndex={-1} data-highlighted={highlighted} data-author={event.actor?.type ?? 'system'} data-message-id={event.id}>
    {agentId !== undefined ? <button type="button" className="dsh-agent-group-avatar" data-agent-id={agentId} aria-label={t('people.openNamed', { name })} onClick={() => onOpenColleague(agentId)}>{name.slice(0, 1)}</button>
      : <div className="dsh-agent-group-avatar" aria-hidden="true">{name.slice(0, 1)}</div>}
    <div className="dsh-agent-group-message-body">
      <div className="dsh-agent-group-message-meta">{agentId !== undefined ? <button type="button" className="dsh-agent-group-identity" data-agent-id={agentId} onClick={() => onOpenColleague(agentId)}>{name}</button> : <strong>{name}</strong>}{onRecall ? <button className="dsh-agent-group-button" data-variant="ghost" type="button" onClick={onRecall}>{t(recallStatus === 'completed' ? 'recall.result' : withdrawn ? 'workspace.retry' : 'recall.action')}</button> : null}</div>
      <div className="dsh-agent-group-message-text" onClickCapture={openLink} onAuxClickCapture={openLink}>
        {withdrawn ? <p className="dsh-agent-group-muted">{t(recallStatus === 'completed' ? 'recall.withdrawn' : 'recall.blocked')}</p> : invalidated ? <p className="dsh-agent-group-muted">{t('recall.outputInvalid')}</p> : agentId !== undefined ? <WorkspaceMarkdownMessage text={linkRoomMessageMentions(snapshot, raw, event.mentions ?? [])} t={t} /> : segments}
      </div>
    </div>
  </article>
}
