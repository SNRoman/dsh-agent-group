/** DSH-native rendering for durable assistant Markdown and transient live turns. */

import { useState } from 'react'
import { DisclosureRow, MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  WorkspaceActivityBlock,
  WorkspaceActivityToolBlock,
  WorkspaceTurnProjection,
  WorkspaceTurnReasoningBlock,
  WorkspaceTurnToolBlock,
  WorkspaceTurnUnknownBlock,
} from './contracts.ts'

/** Render final room-message text through DSH's public Markdown renderer. */
export function WorkspaceMarkdownMessage({ text, t }: { readonly text: string } & PropsLocale<'agentWorkspace'>) {
  return <MarkdownText text={text} labels={workspaceMarkdownLabels(t)} />
}

function workspaceMarkdownLabels(t: PropsLocale<'agentWorkspace'>['t']): MarkdownLabels {
  return {
    code: { copyLabel: t('turn.markdown.copy'), copiedLabel: t('turn.markdown.copied') },
    footnotes: t('turn.markdown.footnotes'),
  }
}

/** Render one authoritative, transient DSH employee turn while it is in flight. */
export function WorkspaceLiveTurn({ turn, agentName, t }: {
  readonly turn: WorkspaceTurnProjection
  readonly agentName: string
} & PropsLocale<'agentWorkspace'>) {
  const streaming = turn.status === 'running'
  return (
    <article
      className="dsh-agent-group-message dsh-agent-group-live-turn"
      data-streaming={streaming ? 'true' : 'false'}
      data-turn={`${turn.sessionId}:${turn.turn}`}
    >
      <div className="dsh-agent-group-avatar">{agentName.slice(0, 1).toUpperCase()}</div>
      <div className="dsh-agent-group-message-body">
        <div className="dsh-agent-group-message-meta">
          <strong>{agentName}</strong>
          <span>{streaming ? t('turn.replying') : t('turn.saving')}</span>
        </div>
        <div className="dsh-agent-group-live-blocks">
          {turn.blocks.length === 0 && streaming
            ? <div className="dsh-agent-group-muted">{t('turn.thinking')}</div>
            : <WorkspaceActivityDetails blocks={turn.blocks} streaming={streaming} t={t} />}
          {turn.error !== undefined
            ? <div className="dsh-agent-group-error dsh-agent-group-turn-error">{turn.error}</div>
            : null}
        </div>
      </div>
    </article>
  )
}

/** Render safe text, reasoning, tool, and extension blocks for every runtime surface. */
export function WorkspaceActivityDetails({ blocks, streaming, t }: {
  readonly blocks: readonly (WorkspaceActivityBlock | WorkspaceTurnProjection['blocks'][number])[]
  readonly streaming: boolean
} & PropsLocale<'agentWorkspace'>) {
  const labels = workspaceMarkdownLabels(t)
  return <>
    {blocks.map(block => {
      if (block.kind === 'text') return <MarkdownText key={`text:${block.index}`} text={block.text} streaming={streaming} labels={labels} />
      if (block.kind === 'reasoning') return <ReasoningDisclosure key={`reasoning:${block.index}`} block={block} streaming={streaming} t={t} />
      if (block.kind === 'tool') return <ToolDisclosure key={`tool:${block.callId}:${block.index}`} block={block} t={t} />
      return <UnknownDisclosure key={`unknown:${block.index}`} block={block} t={t} />
    })}
    {blocks.length === 0 && streaming ? <div className="dsh-agent-group-muted">{t('turn.thinking')}</div> : null}
  </>
}

function ReasoningDisclosure({ block, streaming, t }: {
  readonly block: WorkspaceTurnReasoningBlock
  readonly streaming: boolean
} & PropsLocale<'agentWorkspace'>) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow
      icon={<span aria-hidden="true">✦</span>}
      title={t('turn.reasoning')}
      open={open}
      expandable={block.text.trim() !== ''}
      onToggle={() => setOpen(value => !value)}
      expandOnRowClick
      collapsedContent={<span className="dsh-agent-group-disclosure-status">{streaming ? t('turn.generating') : t('turn.completed')}</span>}
    >
      <div className="dsh-agent-group-disclosure-content">
        <MarkdownText text={block.text} streaming={streaming} labels={workspaceMarkdownLabels(t)} />
      </div>
    </DisclosureRow>
  )
}

function ToolDisclosure({ block, t }: { readonly block: WorkspaceTurnToolBlock | WorkspaceActivityToolBlock } & PropsLocale<'agentWorkspace'>) {
  const [open, setOpen] = useState(false)
  const title = block.name.trim() === '' ? t('turn.toolCall') : t('turn.toolNamed', { name: block.name })
  const status = block.status === 'running' ? t('turn.running') : block.status === 'failed' ? t('turn.failed') : t('turn.completed')
  return (
    <DisclosureRow
      icon={<span aria-hidden="true">⌘</span>}
      title={title}
      open={open}
      expandable
      onToggle={() => setOpen(value => !value)}
      expandOnRowClick
      collapsedContent={<span className="dsh-agent-group-disclosure-status">{status}</span>}
    >
      <div className="dsh-agent-group-disclosure-content dsh-agent-group-tool-detail">
        {block.arguments.trim() !== ''
          ? <Detail label={t('turn.arguments')} value={block.arguments} />
          : null}
        {block.resultText !== undefined
          ? <Detail label={t('turn.result')} value={block.resultText} />
          : null}
        {block.error !== undefined
          ? <Detail label={t('turn.error')} value={typeof block.error === 'string' ? block.error : block.error.summary} />
          : null}
      </div>
    </DisclosureRow>
  )
}

function UnknownDisclosure({ block, t }: { readonly block: WorkspaceTurnUnknownBlock } & PropsLocale<'agentWorkspace'>) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow
      icon={<span aria-hidden="true">…</span>}
      title={block.label || t('turn.extensionOutput')}
      open={open}
      expandable
      onToggle={() => setOpen(value => !value)}
      expandOnRowClick
    >
      <div className="dsh-agent-group-disclosure-content">
        <pre>{safeJson(block.value)}</pre>
      </div>
    </DisclosureRow>
  )
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="dsh-agent-group-tool-section">
      <strong>{label}</strong>
      <pre>{value}</pre>
    </div>
  )
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
