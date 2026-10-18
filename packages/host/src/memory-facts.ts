/** Snapshot-derived, source-owned current operations and unresolved memory candidates. */
import type { AgentId } from './ids.ts'
import type { WorkspaceState } from './types.ts'
import type { MemoryFact, MemoryScene } from './scene-memory-contract.ts'

/** Recompute applicable values from valid personally acquired sources, never from stored tombstones. */
export function projectMemoryFacts(state: WorkspaceState, agentId: AgentId, scene: MemoryScene, facts: readonly MemoryFact[]): readonly MemoryFact[] {
  if (scene.organization.id !== state.workspaceId) return []
  const owned = new Set(state.memoryEntries.filter(entry => entry.agentId === agentId).map(entry => entry.eventId))
  const events = new Map(state.events.map(event => [event.id, event] as const))
  const trigger = events.get(scene.triggerEventId)
  if (trigger === undefined) throw new Error('memory trigger event is absent')
  if (!Number.isSafeInteger(scene.admissionSequence) || scene.admissionSequence !== state.nextSequence - 1
    || scene.admissionSequence < trigger.sequence) throw new Error('memory admission sequence does not match snapshot')
  const valid = facts.filter(fact => fact.kind !== 'context' && fact.assertionKind === 'human-explicit'
    && fact.temporal !== 'historical' && fact.validFromSequence <= scene.admissionSequence
    && (fact.validThroughSequence === undefined || scene.admissionSequence <= fact.validThroughSequence)
    && applies(fact, scene, state)
    && fact.sourceEventIds.length > 0 && fact.sourceEventIds.every(id => {
      const event = events.get(id)
      return owned.has(id) && event?.text?.includes(fact.sourceQuote) === true && event.sequence <= scene.admissionSequence
    }))
  const slots = new Map<string, MemoryFact[]>()
  for (const fact of valid) {
    const key = scopedSlot(fact)
    const group = slots.get(key) ?? []
    group.push(fact); slots.set(key, group)
  }
  const effective = [...slots.values()].flatMap(evaluateSlot)
  const uncertainAnchors = new Map<string, Set<string>>()
  for (const fact of effective) if (fact.kind === 'anchored' && fact.status === 'candidate') {
    const key = JSON.stringify([fact.subject, fact.anchoredKind, fact.facet, fact.conditions, fact.scope])
    const topics = uncertainAnchors.get(key) ?? new Set<string>()
    topics.add(fact.topic ?? '')
    uncertainAnchors.set(key, topics)
  }
  const candidates = effective.map(fact => {
    if (fact.kind === 'anchored' && fact.status === 'candidate'
      && (uncertainAnchors.get(JSON.stringify([fact.subject, fact.anchoredKind, fact.facet, fact.conditions, fact.scope]))?.size ?? 0) > 1) {
      return { ...fact, status: 'unresolved' as const }
    }
    return fact
  })
  const baseGroups = new Map<string, MemoryFact[]>()
  for (const fact of candidates) {
    const key = baseSlot(fact)
    const group = baseGroups.get(key) ?? []
    group.push(fact); baseGroups.set(key, group)
  }
  return [...baseGroups.values()].flatMap(group => {
    const local = group.filter(fact => fact.scope.roomId !== undefined || fact.scope.taskId !== undefined)
    const localCurrent = local.find(fact => fact.status === 'candidate')
    const localBlock = local.find(fact => fact.status === 'unresolved' || fact.operation === 'clear')
    const localRemoved = local.filter(fact => fact.status === 'removed' && fact.operation === 'remove')
    return group.map(fact => {
      if (fact.status !== 'candidate') return fact
      if (conditioned(fact)) return { ...fact, status: 'conditional' as const }
      if (fact.scope.roomId !== undefined || fact.scope.taskId !== undefined) return { ...fact, status: 'current' as const }
      const blocked = localCurrent !== undefined || localBlock !== undefined || localRemoved.some(candidate => candidate.value.normalize('NFC') === fact.value.normalize('NFC'))
      return { ...fact, status: blocked ? 'default' as const : 'current' as const }
    })
  }).sort((left, right) => statusOrder(left.status) - statusOrder(right.status)
    || right.validFromSequence - left.validFromSequence || left.id.localeCompare(right.id))
}

function evaluateSlot(facts: readonly MemoryFact[]): MemoryFact[] {
  const bySource = new Map<string, MemoryFact[]>()
  for (const fact of facts) {
    const key = JSON.stringify([fact.validFromSequence, fact.sourceEventIds])
    const group = bySource.get(key) ?? []
    group.push(fact); bySource.set(key, group)
  }
  let current: MemoryFact | undefined
  let unresolved: MemoryFact | undefined
  const negatives: MemoryFact[] = []
  const batches = [...bySource.values()].sort((left, right) => left[0]!.validFromSequence - right[0]!.validFromSequence
    || left[0]!.sourceEventIds.join(',').localeCompare(right[0]!.sourceEventIds.join(',')))
  for (const batch of batches) {
    const ordered = [...batch].sort((left, right) => left.id.localeCompare(right.id))
    const sets = ordered.filter(fact => fact.operation === 'set')
    const removes = ordered.filter(fact => fact.operation === 'remove')
    const clears = ordered.filter(fact => fact.operation === 'clear')
    const setValues = new Set(sets.map(fact => fact.value.normalize('NFC')))
    const conflicting = setValues.size > 1 || clears.length > 0 && (sets.length > 0 || removes.length > 0)
      || sets.some(fact => removes.some(removed => removed.value.normalize('NFC') === fact.value.normalize('NFC')))
    const uncertain = ordered.some(fact => fact.temporal === 'unresolved' || fact.application === 'unresolved'
      || fact.kind === 'anchored' && fact.alignment === 'unresolved')
    if (conflicting || uncertain) {
      const representative = ordered[0]!
      current = undefined
      unresolved = { ...representative, status: 'unresolved', value: '',
        sourceEventIds: [...new Set(ordered.flatMap(fact => fact.sourceEventIds))] }
      continue
    }
    unresolved = undefined
    if (clears.length > 0) {
      const clear = clears[0]!
      negatives.push({ ...clear, status: 'removed', supersedesFactIds: current === undefined ? [] : [current.id] })
      current = undefined
    }
    for (const removed of removes) {
      const matches = current?.value.normalize('NFC') === removed.value.normalize('NFC')
      negatives.push({ ...removed, status: 'removed', supersedesFactIds: matches && current !== undefined ? [current.id] : [] })
      if (matches) current = undefined
    }
    if (sets.length > 0) {
      const set = sets[0]!
      current = { ...set, status: 'candidate', supersedesFactIds: current === undefined ? [] : [current.id] }
    }
  }
  return [...(current === undefined ? [] : [current]), ...negatives, ...(unresolved === undefined ? [] : [unresolved])]
}

function scopedSlot(fact: MemoryFact): string {
  return JSON.stringify([baseSlot(fact), fact.scope.organizationId, fact.scope.roomId, fact.scope.taskId])
}

function baseSlot(fact: MemoryFact): string {
  switch (fact.kind) {
    case 'controlled': return JSON.stringify([fact.subject, fact.property, fact.qualifier?.tag.normalize('NFC')])
    case 'anchored': return JSON.stringify([fact.subject, fact.anchoredKind, normalize(fact.topic), normalize(fact.facet), fact.conditions.map(normalize)])
    case 'context': return JSON.stringify([fact.subject, 'context'])
  }
}

function normalize(text: string | undefined): string { return text?.normalize('NFC').trim().replace(/\s+/gu, ' ') ?? '' }
function conditioned(fact: MemoryFact): boolean {
  return fact.kind === 'controlled' && fact.qualifier !== undefined || fact.kind === 'anchored' && fact.conditions.length > 0
}
function statusOrder(status: MemoryFact['status']): number {
  switch (status) {
    case 'current': return 0
    case 'conditional': return 1
    case 'default': return 2
    case 'removed': return 3
    case 'unresolved': return 4
    case 'candidate': return 5
    case 'historical': return 6
  }
}
function applies(fact: MemoryFact, scene: MemoryScene, state: WorkspaceState): boolean {
  if (fact.application === 'unresolved' || fact.scope.organizationId !== scene.organization.id) return false
  if (fact.scope.roomId !== undefined && (scene.source.kind !== 'room' || fact.scope.roomId !== scene.source.roomId)) return false
  if (fact.scope.taskId !== undefined && (scene.source.kind !== 'task' || fact.scope.taskId !== scene.source.taskId
    || state.tasks[fact.scope.taskId]?.status !== 'open')) return false
  return true
}
