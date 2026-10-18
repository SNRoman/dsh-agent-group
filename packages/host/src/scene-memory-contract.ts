/** Inputs and receipts for one source-grounded personal-memory preparation. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceActivitySource } from './activity-stream.ts'
import type { AgentId, AgentMemoryEntryId, RoomId, TaskId, WorkspaceEventId, WorkspaceId } from './ids.ts'
import type { WorkspaceActor } from './types.ts'

/** Identity of one validated, source-grounded fact candidate. */
export type MemoryFactId = Branded<'AgentWorkspaceMemoryFactId'>
/** Brand a fact-candidate identity. */
export function MemoryFactId(value: string): MemoryFactId { return value as MemoryFactId }

/** The current delivery and organization context, provided afresh for every turn. */
export interface MemoryScene {
  readonly source: WorkspaceActivitySource
  readonly actor: WorkspaceActor
  readonly triggerEventId: WorkspaceEventId
  /** Last workspace sequence in the snapshot when this turn is admitted. */
  readonly admissionSequence: number
  /** UTC clock reading captured for this delivery; not the date of any source event. */
  readonly currentTimeUtc?: string
  /** Host-local reading of the same instant; use its zone for otherwise unqualified dates and times in local sessions. */
  readonly currentTimeLocal?: { readonly timeZone: string; readonly dateTime: string }
  readonly query: string
  readonly organization: { readonly id: WorkspaceId; readonly name: string }
  readonly colleagues: readonly { readonly id: AgentId; readonly name: string; readonly role?: string }[]
  /** Personally assigned durable work, independent of recalled chat excerpts. */
  readonly work?: readonly { readonly taskId: TaskId; readonly title: string; readonly status: 'open' | 'completed' | 'cancelled' }[]
}

/** Text received from one durable memory entry in one context generation. End is exclusive. */
export type MemoryCoverage =
  | { readonly entryId: AgentMemoryEntryId; readonly contextGeneration: number; readonly kind: 'original'; readonly start: number; readonly end: number }
  | { readonly entryId: AgentMemoryEntryId; readonly contextGeneration: number; readonly kind: 'summary'; readonly category: string }

/** Independent character and item limits resolved by the caller's Config. */
export interface MemoryLimits {
  readonly sceneCharacters: number
  readonly newCharacters: number
  readonly coreCharacters: number
  readonly historyCharacters: number
  readonly itemCharacters: number
  readonly recentConversationLimit: number
  readonly factLimit: number
  readonly historyLimit: number
}

/** A source-verified v2 candidate; status distinguishes operations from effective scene values. */
interface MemoryFactBase {
  readonly id: MemoryFactId
  readonly category: 'address' | 'communication' | 'preference' | 'agreement' | 'task' | 'other'
  readonly subject: string
  readonly key: string
  readonly value: string
  readonly scope: { readonly organizationId: WorkspaceId; readonly roomId?: RoomId; readonly taskId?: TaskId }
  readonly application: 'organization' | 'source-room' | 'source-task' | 'unresolved'
  readonly temporal: 'current' | 'historical' | 'unresolved'
  readonly operation: 'set' | 'remove' | 'clear'
  readonly sourceEventIds: readonly WorkspaceEventId[]
  readonly sourceQuote: string
  readonly assertionKind: 'human-explicit' | 'inferred'
  readonly validFromSequence: number
  readonly validThroughSequence?: number
  readonly status: 'candidate' | 'current' | 'default' | 'conditional' | 'historical' | 'removed' | 'unresolved'
  readonly supersedesFactIds: readonly MemoryFactId[]
}

/** Controlled properties have server-owned slots and optional quoted language conditions. */
export interface ControlledMemoryFact extends MemoryFactBase {
  readonly kind: 'controlled'
  readonly property: 'person.address' | 'communication.language'
  readonly qualifier?: { readonly kind: 'use-language'; readonly tag: string; readonly sourceQuote: string }
}

/** Other lasting preferences use exact source text as their topic, facet and conditions. */
export interface AnchoredMemoryFact extends MemoryFactBase {
  readonly kind: 'anchored'
  readonly anchoredKind: 'preference' | 'standing-agreement'
  readonly topic?: string
  readonly facet?: string
  readonly conditions: readonly string[]
  readonly alignment: 'exact' | 'unresolved'
}

/** Non-standing history remains inspectable but cannot update current core slots. */
export interface ContextMemoryFact extends MemoryFactBase { readonly kind: 'context' }

export type MemoryFact = ControlledMemoryFact | AnchoredMemoryFact | ContextMemoryFact

/** A rendered layer and its actual durable sources. */
export interface PreparedMemoryLayer {
  readonly rendered: string
  readonly eventIds: readonly WorkspaceEventId[]
  readonly omitted: number
}

/** Source-owned context placed in a lower-priority model message by the caller. */
export interface PreparedSceneMemory {
  readonly rendered: string
  readonly eventIds: readonly WorkspaceEventId[]
  readonly coverage: readonly MemoryCoverage[]
  readonly omitted: number
  readonly layers: {
    readonly scene: PreparedMemoryLayer
    readonly new: PreparedMemoryLayer
    readonly core: PreparedMemoryLayer
    readonly history: PreparedMemoryLayer
  }
}

/** Inputs for a pure projection over an already withdrawal-filtered aggregate snapshot. */
export interface SceneMemoryRequest {
  readonly agentId: AgentId
  readonly contextGeneration: number
  readonly scene: MemoryScene
  readonly coverage: readonly MemoryCoverage[]
  readonly facts: readonly MemoryFact[]
  readonly limits: MemoryLimits
  readonly historyContext?: string
}
