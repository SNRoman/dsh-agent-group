import { WorkspaceEventId } from '../../packages/host/src/ids.ts'
import type { WorkspaceEvent, WorkspaceEventType } from '../../packages/host/src/types.ts'

const eventId = WorkspaceEventId('event-1')

const terminal: WorkspaceEvent = {
  id: eventId,
  sequence: 1,
  type: 'child/run-finished',
  childRunStatus: 'completed',
}

// @ts-expect-error Terminal child events require their durable terminal status.
const missingTerminalStatus: WorkspaceEvent = { id: eventId, sequence: 1, type: 'child/run-finished' }

// @ts-expect-error Non-terminal child events cannot carry a terminal status.
const statusOnOtherEvent: WorkspaceEvent = { id: eventId, sequence: 1, type: 'child/run-started', childRunStatus: 'completed' }

const knownType: WorkspaceEventType = 'room/message'

// @ts-expect-error Durable event discriminants are closed to Host-produced facts.
const unknownType: WorkspaceEventType = 'workspace/unknown'

void [terminal, missingTerminalStatus, statusOnOtherEvent, knownType, unknownType]
