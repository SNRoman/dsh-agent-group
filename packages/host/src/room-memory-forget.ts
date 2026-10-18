/** Atomic room departure and personal source removal; shared history and independently authorized task memory remain stored. */
import type { ContextResetId, RoomMemoryForgetOperation } from './communication-contract.ts'
import type { HumanId, MembershipId, WorkspaceEventId } from './ids.ts'
import { mutateWorkspace } from './state.ts'
import type { WorkspaceRecordV3 } from './workspace-record.ts'

/**
 * End one group membership and fence only that colleague's old Session before runtime cleanup.
 * Task and child-result acquisitions retain their independent work authorization. Raw events and other colleagues' memory are preserved.
 * @param record Raw active organization record.
 * @param membershipId Active membership, or the same ended membership on retry.
 * @param operationId Stable identity reused for cleanup retries.
 * @param requestedByHumanId Human requesting the departure and memory removal.
 * @param now Canonical UTC request time used only on the first commit.
 * @returns Detached pending reset and removed personal acquisitions; retries return the existing record without another generation change.
 */
export function prepareRoomMemoryForget(record: WorkspaceRecordV3, membershipId: MembershipId, operationId: ContextResetId, requestedByHumanId: HumanId, now: string): WorkspaceRecordV3 {
  if (record.descriptor.lifecycle !== 'active') throw new Error('Room memory removal requires an active organization.')
  const membership = record.aggregate.memberships[membershipId]
  if (membership === undefined || record.aggregate.rooms[membership.roomId]?.kind !== 'group') throw new Error('Room memory removal requires a group membership.')
  const existing = record.communication.resets[operationId]
  if (existing !== undefined) {
    if (existing.kind !== 'room-memory-forget' || existing.membershipId !== membershipId || existing.source.roomId !== membership.roomId
      || existing.affectedAgentIds.length !== 1 || existing.affectedAgentIds[0] !== membership.agentId || existing.requestedByHumanId !== requestedByHumanId) throw new Error('Room memory removal retry differs from its original request.')
    return record
  }
  if (Object.values(record.communication.resets).some(reset => reset.status !== 'completed')) throw new Error('An unfinished context reset must be retried first.')
  const aggregate = mutateWorkspace(record.aggregate, { type: 'room/leave', membershipId }).state
  const eventId = aggregate.memberships[membershipId]!.leftEventId!
  const sourceEvent = aggregate.events.find(event => event.id === eventId)!
  const forgotten = new Set<WorkspaceEventId>()
  const events = new Map(record.aggregate.events.map(event => [event.id, event]))
  const owned = new Set(record.aggregate.memoryEntries.filter(entry => entry.agentId === membership.agentId
    && (entry.acquiredBy === 'room-membership' || entry.acquiredBy === 'history-sync')).map(entry => entry.eventId))
  for (const id of owned) if (events.get(id)?.subjectId === membership.roomId) forgotten.add(id)
  let previousSize = -1
  while (previousSize !== forgotten.size) {
    previousSize = forgotten.size
    for (const input of Object.values(record.communication.inputs)) {
      if (input.agentId !== membership.agentId || input.target.kind !== 'event' || !owned.has(input.target.eventId)) continue
      const event = events.get(input.target.eventId)
      if (event?.type === 'room/message' && event.actor?.type === 'agent' && event.actor.id === membership.agentId
        && [...input.directEventIds, ...input.recalledEventIds, ...input.sessionEventIds].some(id => forgotten.has(id))) forgotten.add(event.id)
    }
  }
  const generation = record.communication.contexts[membership.agentId]?.generation ?? 0
  const operation: RoomMemoryForgetOperation = {
    kind: 'room-memory-forget', id: operationId, membershipId, source: { roomId: membership.roomId, eventId }, requestedByHumanId,
    fromSequence: sourceEvent.sequence, throughSequence: aggregate.nextSequence - 1,
    affectedAgentIds: [membership.agentId], previousGenerations: { [membership.agentId]: generation }, forgottenEventIds: [...forgotten],
    invalidatedEventIds: [], invalidatedTaskIds: [], invalidatedDraftIds: [], invalidatedTemplateRevisionIds: [], invalidatedArtifactIds: [],
    requestedAt: now, fileRestoreRequested: false, status: 'pending',
  }
  return { ...record, aggregate: { ...aggregate,
    memoryEntries: aggregate.memoryEntries.filter(entry => entry.agentId !== membership.agentId || !forgotten.has(entry.eventId)
      || (entry.acquiredBy !== 'room-membership' && entry.acquiredBy !== 'history-sync')),
    sessionBindings: Object.fromEntries(Object.entries(aggregate.sessionBindings).filter(([agentId]) => agentId !== membership.agentId)),
  }, communication: { ...record.communication, revision: record.communication.revision + 1,
    contexts: { ...record.communication.contexts, [membership.agentId]: { generation: generation + 1, blockedBy: operationId } },
    resets: { ...record.communication.resets, [operationId]: operation },
  } }
}
