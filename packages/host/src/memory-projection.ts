/** Independent versioned extraction audit and disposable fact projection. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { AgentId, HumanId, RoomId, TaskId, WorkspaceEventId, WorkspaceId } from './ids.ts'
import { MemoryFactId } from './scene-memory-contract.ts'
import type { MemoryFact } from './scene-memory-contract.ts'
import type { WorkspaceEvent } from './types.ts'

/** Derived extraction protocol; v1 audit and projection records remain readable. */
export const MEMORY_EXTRACTION_VERSION = 2
/** Stable auxiliary identity, recorded with each request and never sent as purpose. */
export const MEMORY_EXTRACTION_SYSTEM = 'Agent Workspace source fact extraction v2. Return only the requested JSON.'

/** One exact original-text fragment already present in a colleague request. */
export interface MemoryFragment {
  readonly workspaceId: WorkspaceId
  readonly event: WorkspaceEvent
  readonly start: number
  readonly end: number
  readonly text: string
}

const scopeSchema = z.object({ organizationId: z.string().transform(WorkspaceId), roomId: z.string().transform(RoomId).optional(), taskId: z.string().transform(TaskId).optional() }).strict()
const applicationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('organization'), evidence: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('source-room'), evidence: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('source-task'), evidence: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('unresolved') }).strict(),
])
const candidateBase = z.object({
  subject: z.string().min(1), temporal: z.enum(['current', 'historical', 'unresolved']),
  operation: z.enum(['set', 'remove', 'clear']), value: z.string().optional(), application: applicationSchema,
  sourceQuote: z.string().min(1), assertionKind: z.enum(['human-explicit', 'inferred']),
})
const candidateSchema = z.discriminatedUnion('kind', [
  candidateBase.extend({ kind: z.literal('controlled'), property: z.enum(['person.address', 'communication.language']),
    qualifier: z.object({ kind: z.literal('use-language'), tag: z.string().min(1), sourceQuote: z.string().min(1) }).strict().optional() }).strict(),
  candidateBase.extend({ kind: z.literal('anchored'), anchoredKind: z.enum(['preference', 'standing-agreement']),
    topicQuote: z.string().min(1).optional(), facetQuote: z.string().min(1).optional(), conditionQuotes: z.array(z.string().min(1)).max(8) }).strict(),
  candidateBase.extend({ kind: z.literal('context') }).strict(),
])
const actorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('human'), id: z.string().transform(HumanId) }).strict(),
  z.object({ type: z.literal('agent'), id: z.string().transform(AgentId) }).strict(),
])
/** Persisted input contains only the supplied fragment, never unexposed event text. */
export const memoryInputSchema = z.object({
  workspaceId: z.string().transform(WorkspaceId), eventId: z.string().transform(WorkspaceEventId),
  sequence: z.number().int().nonnegative(), actor: actorSchema.optional(), scope: scopeSchema,
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), totalCharacters: z.number().int().nonnegative(),
  text: z.string(), sourceDigest: z.string(),
}).strict()
export type MemoryExtractionInput = z.infer<typeof memoryInputSchema>

const auditBase = z.object({
  version: z.literal(1), id: z.string(), input: memoryInputSchema,
  provider: z.string(), model: z.string(), parameters: z.string(), system: z.string(), prompt: z.string(),
  status: z.enum(['pending', 'completed', 'failed', 'discarded']),
  output: z.string().optional(), stream: z.string().optional(), error: z.string().optional(),
})
const auditSchema = z.discriminatedUnion('extractionVersion', [
  auditBase.extend({ extractionVersion: z.literal(1) }).strict(),
  auditBase.extend({ extractionVersion: z.literal(2), failureKind: z.enum(['retryable', 'validation']).optional() }).strict(),
])
/** Request and terminal raw response retained independently of candidate lifetime; unclassified failures remain retryable. */
export type MemoryAudit = z.infer<typeof auditSchema>
const projectionBase = z.object({ auditId: z.string(), input: memoryInputSchema, output: z.string() })
const projectionSchema = z.discriminatedUnion('version', [
  projectionBase.extend({ version: z.literal(1) }).strict(),
  projectionBase.extend({ version: z.literal(2) }).strict(),
])
/** Rebuildable extraction output, revalidated before each fact read. */
export type MemoryProjection = z.infer<typeof projectionSchema>
/** Minimal native storage table operations used by the processor. */
export interface MemoryTable<T> {
  get(key: string): T | undefined
  entries(): IterableIterator<[string, T]>
  put(key: string, value: T): Promise<void>
}
/** Audit generations remain independent from released Workspace records. */
export const memoryAuditSpec = defineDomain({ name: 'agent_workspace_memory_audit', version: 3, compatibleVersions: [1, 2], tables: { requests: domainTable<string, MemoryAudit>(auditSchema) } })
/** Projections can be removed and reconstructed from successful audit settlements. */
export const memoryProjectionSpec = defineDomain({ name: 'agent_workspace_memory_projection', version: 2, compatibleVersions: [1], layout: 'per-record', invalidRecords: 'backup-and-skip', tables: { fragments: domainTable<string, MemoryProjection>(projectionSchema) } })

/** Validate every model field and exact quotation before assigning source identities. */
export function parseMemoryFacts(output: string, input: MemoryExtractionInput, auditId: string): MemoryFact[] {
  const parsed = z.object({ facts: z.array(candidateSchema).max(32) }).strict().parse(JSON.parse(output))
  return parsed.facts.map((fact, index) => parseCandidate(fact, input, auditId, index))
}

/** Keep independently valid siblings while returning every rejected candidate reason.
 * @param output Raw model JSON.
 * @param input Exact source fragment and recorded actor/location.
 * @param auditId Durable extraction audit identity.
 * @returns Valid facts and rejection reasons; invalid envelopes still throw.
 */
export function parseMemoryFactsIndividually(output: string, input: MemoryExtractionInput, auditId: string): { readonly facts: MemoryFact[]; readonly errors: string[] } {
  const parsed = z.object({ facts: z.array(z.unknown()).max(32) }).strict().parse(JSON.parse(output))
  const facts: MemoryFact[] = [], errors: string[] = []
  for (const [index, value] of parsed.facts.entries()) {
    try { facts.push(parseCandidate(candidateSchema.parse(value), input, auditId, index)) }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  }
  return { facts, errors }
}

function parseCandidate(fact: z.infer<typeof candidateSchema>, input: MemoryExtractionInput, auditId: string, index: number): MemoryFact {
  if (!input.text.includes(fact.sourceQuote)) throw new Error('Fact quotation is outside the supplied fragment')
  if (fact.operation === 'clear' ? fact.value !== undefined : fact.value === undefined || fact.value.length === 0) throw new Error('Fact operation has an invalid value')
  if (fact.application.kind !== 'unresolved' && !fact.sourceQuote.includes(fact.application.evidence)) throw new Error('Fact application evidence is outside its quotation')
  if (fact.application.kind === 'source-room' && input.scope.roomId === undefined) throw new Error('Fact source room is absent')
  if (fact.application.kind === 'source-task' && input.scope.taskId === undefined) throw new Error('Fact source task is absent')
  if (fact.kind === 'controlled' && fact.qualifier !== undefined && !fact.sourceQuote.includes(fact.qualifier.sourceQuote)) throw new Error('Fact language condition is outside its quotation')
  if (fact.kind === 'anchored') for (const quote of [fact.topicQuote, fact.facetQuote, ...fact.conditionQuotes]) {
    if (quote !== undefined && !fact.sourceQuote.includes(quote)) throw new Error('Fact anchor is outside its quotation')
  }
  const actorSubject = input.actor === undefined ? undefined : `${input.actor.type}:${input.actor.id}`
  const isActor = actorSubject !== undefined && (fact.subject === 'source-actor' || fact.subject === input.actor?.id || fact.subject === actorSubject)
  if (fact.kind !== 'context' && !isActor) throw new Error('Personal fact subject must identify the recorded source actor')
  if (!isActor && !input.text.includes(fact.subject)) throw new Error('Fact subject is not identified in its source')
  const scope = { organizationId: input.workspaceId,
    ...(fact.application.kind === 'source-room' ? { roomId: input.scope.roomId! } : {}),
    ...(fact.application.kind === 'source-task' ? { taskId: input.scope.taskId! } : {}) }
  const common = { id: MemoryFactId(`${auditId}:${index}`), subject: isActor ? actorSubject! : fact.subject,
    value: fact.value ?? '', scope, application: fact.application.kind, temporal: fact.temporal, operation: fact.operation,
    sourceEventIds: [input.eventId], sourceQuote: fact.sourceQuote,
    assertionKind: input.actor?.type === 'human' ? fact.assertionKind : 'inferred', validFromSequence: input.sequence,
    status: fact.temporal === 'historical' ? 'historical' as const : fact.temporal === 'unresolved' || fact.application.kind === 'unresolved'
      ? 'unresolved' as const : fact.operation === 'set' ? 'candidate' as const : 'removed' as const,
    supersedesFactIds: [] }
  switch (fact.kind) {
    case 'controlled': return { ...common, kind: 'controlled' as const, property: fact.property,
      category: fact.property === 'person.address' ? 'address' as const : 'communication' as const, key: fact.property,
      ...(fact.qualifier === undefined ? {} : { qualifier: fact.qualifier }) }
    case 'anchored': {
      const anchors = [fact.topicQuote, fact.facetQuote, ...fact.conditionQuotes].filter((quote): quote is string => quote !== undefined)
      const exact = fact.topicQuote !== undefined && anchors.every(quote => input.text.indexOf(quote) === input.text.lastIndexOf(quote))
      return { ...common, kind: 'anchored' as const, anchoredKind: fact.anchoredKind,
        category: fact.anchoredKind === 'preference' ? 'preference' as const : 'agreement' as const,
        key: [fact.topicQuote ?? 'unresolved-topic', fact.facetQuote ?? '', ...fact.conditionQuotes].join('/'),
        ...(fact.topicQuote === undefined ? {} : { topic: fact.topicQuote }),
        ...(fact.facetQuote === undefined ? {} : { facet: fact.facetQuote }), conditions: fact.conditionQuotes,
        alignment: exact ? 'exact' as const : 'unresolved' as const,
        status: exact ? common.status : 'unresolved' as const }
    }
    case 'context': return { ...common, kind: 'context' as const, category: 'other' as const, key: 'context', status: 'historical' as const }
  }
}
