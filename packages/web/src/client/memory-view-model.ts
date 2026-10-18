/** Human-facing filters and exact excerpts for personal-memory records. */
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { WorkspaceEventType } from './contracts.ts'

/** Categories keep delivery mechanics outside the initial personal timeline. */
export const MEMORY_CATEGORIES = ['activity', 'messages', 'work', 'people', 'all'] as const
export type MemoryCategory = typeof MEMORY_CATEGORIES[number]

const categories: Record<MemoryCategory, readonly WorkspaceEventType[] | undefined> = {
  activity: ['room/message', 'task/assigned', 'task/delegated', 'task/completed', 'task/cancelled', 'task/result', 'task/result-after-cancel', 'child/run-finished'],
  messages: ['room/message'],
  work: ['task/assigned', 'task/delegated', 'task/completed', 'task/cancelled', 'task/result', 'task/result-after-cancel', 'child/run-started', 'child/run-finished'],
  people: ['agent/created', 'agent/departed', 'agent/employed', 'agent/definition-revision-assigned', 'room/member-joined', 'room/member-left'],
  all: undefined,
}

/** @param category Human-selected category. @returns Event filters applied by the full-history Host query, or all event types. */
export function memoryCategoryTypes(category: MemoryCategory): readonly WorkspaceEventType[] | undefined { return categories[category] }

/** @param text Recorded Markdown without synthesized knowledge. @returns Visible text with compact whitespace and a 180-character limit before its optional ellipsis. */
export function memoryExcerpt(text: string): string {
  const compact = markdownText(fromMarkdown(text)).replace(/\s+/gu, ' ').trim()
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact
}

interface MarkdownNode {
  readonly type: string
  readonly value?: string | undefined
  readonly alt?: string | null | undefined
  readonly children?: readonly MarkdownNode[] | undefined
}

function markdownText(node: MarkdownNode): string {
  switch (node.type) {
    case 'text':
    case 'code':
    case 'inlineCode': return node.value ?? ''
    case 'image':
    case 'imageReference': return node.alt ?? ''
    case 'break': return ' '
    default: return node.children?.map(markdownText).join(['root', 'blockquote', 'list', 'listItem'].includes(node.type) ? ' ' : '') ?? ''
  }
}
