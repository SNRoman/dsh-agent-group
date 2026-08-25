/** DSH-native rendering for durable assistant Markdown and transient live turns. */

import { useState } from 'react'
import { DisclosureRow, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceTurnProjection,
  WorkspaceTurnReasoningBlock,
  WorkspaceTurnToolBlock,
  WorkspaceTurnUnknownBlock,
} from './contracts.ts'

/** Render final room-message text through DSH's public Markdown renderer. */
export function WorkspaceMarkdownMessage({ text }: { readonly text: string }) {
  return <MarkdownText text={text} />
}

/** Render one authoritative, transient DSH employee turn while it is in flight. */
export function WorkspaceLiveTurn({ turn, agentName }: {
  readonly turn: WorkspaceTurnProjection
  readonly agentName: string
}) {
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
          <span>{streaming ? '正在回复…' : '正在保存…'}</span>
        </div>
        <div className="dsh-agent-group-live-blocks">
          {turn.blocks.map(block => {
            if (block.kind === 'text') {
              return <MarkdownText key={`text:${block.index}`} text={block.text} streaming={streaming} />
            }
            if (block.kind === 'reasoning') {
              return <ReasoningDisclosure key={`reasoning:${block.index}`} block={block} streaming={streaming} />
            }
            if (block.kind === 'tool') {
              return <ToolDisclosure key={`tool:${block.callId}:${block.index}`} block={block} />
            }
            return <UnknownDisclosure key={`unknown:${block.index}`} block={block} />
          })}
          {turn.blocks.length === 0 && streaming
            ? <div className="dsh-agent-group-muted">正在思考…</div>
            : null}
          {turn.error !== undefined
            ? <div className="dsh-agent-group-error dsh-agent-group-turn-error">{turn.error}</div>
            : null}
        </div>
      </div>
    </article>
  )
}

function ReasoningDisclosure({ block, streaming }: {
  readonly block: WorkspaceTurnReasoningBlock
  readonly streaming: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow
      icon={<span aria-hidden="true">✦</span>}
      title="思考过程"
      open={open}
      expandable={block.text.trim() !== ''}
      onToggle={() => setOpen(value => !value)}
      expandOnRowClick
      collapsedContent={<span className="dsh-agent-group-disclosure-status">{streaming ? '生成中' : '已完成'}</span>}
    >
      <div className="dsh-agent-group-disclosure-content">
        <MarkdownText text={block.text} streaming={streaming} />
      </div>
    </DisclosureRow>
  )
}

function ToolDisclosure({ block }: { readonly block: WorkspaceTurnToolBlock }) {
  const [open, setOpen] = useState(false)
  const title = block.name.trim() === '' ? '工具调用' : `工具：${block.name}`
  const status = block.status === 'running' ? '执行中' : block.status === 'failed' ? '失败' : '已完成'
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
          ? <Detail label="参数" value={block.arguments} />
          : null}
        {block.resultText !== undefined
          ? <Detail label="结果" value={block.resultText} />
          : null}
        {block.error !== undefined
          ? <Detail label="错误" value={block.error} />
          : null}
      </div>
    </DisclosureRow>
  )
}

function UnknownDisclosure({ block }: { readonly block: WorkspaceTurnUnknownBlock }) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow
      icon={<span aria-hidden="true">…</span>}
      title={block.label || '扩展输出'}
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
