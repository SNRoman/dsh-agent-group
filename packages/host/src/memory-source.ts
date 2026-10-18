/** Recorded source location and actor labels for original excerpts and fact citations. */
import { RoomId, TaskId } from './ids.ts'
import type { WorkspaceEvent, WorkspaceState } from './types.ts'

/** Use the event's own location; absent actors or labels remain explicitly unknown. */
export function memorySourceLabel(state: WorkspaceState, event: WorkspaceEvent): string {
  const room = event.type.startsWith('room/') && event.subjectId !== undefined ? state.rooms[RoomId(event.subjectId)] : undefined
  const taskId = 'taskId' in event ? event.taskId : event.type.startsWith('task/') && event.subjectId !== undefined ? TaskId(event.subjectId) : undefined
  const location = event.type.startsWith('room/') ? `room:${event.subjectId ?? 'unknown'}${room?.name === undefined ? '' : `(${room.name})`}`
    : taskId === undefined ? `subject:${event.subjectId ?? 'unknown'}` : `task:${taskId}`
  const actor = event.actor === undefined ? 'unknown' : `${event.actor.type}:${event.actor.id}${event.actor.type === 'agent' && state.agents[event.actor.id] !== undefined ? `(${state.agents[event.actor.id]!.name})` : ''}`
  return `${location} actor:${actor} sequence:${event.sequence}`
}
