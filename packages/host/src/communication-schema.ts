/** Strict readers for successor communication and raw byte checkpoint metadata. */
import { z } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AgentId, HumanId, RoomId, TaskId, WorkspaceEventId } from './ids.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type * as C from './communication-contract.ts'
import type { TaskArtifactId, TaskDraftId, TaskTemplateRevisionId } from './workflow-contract.ts'

const id = z.string().min(1).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value))
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = count.min(1)
const text = z.string().refine(value => value.trim() !== '')
const eventId = id.transform(WorkspaceEventId)
const agentId = id.transform(AgentId)
const taskId = id.transform(TaskId)
const draftId = id.transform(value => value as TaskDraftId)
const templateRevisionId = id.transform(value => value as TaskTemplateRevisionId)
const artifactId = id.transform(value => value as TaskArtifactId)
const inputId = id.transform(value => value as C.CommunicationInputId)
const resetId = id.transform(value => value as C.ContextResetId)
const checkpointId = id.transform(value => value as C.FileCheckpointId)
const timestamp = z.string().refine(value => { const date = new Date(value); return !Number.isNaN(date.valueOf()) && date.toISOString() === value })

/** A persisted source must additionally resolve to a room/message in relationship validation. */
export const chatSourceSchema = z.object({ roomId: id.transform(RoomId), eventId }).strict() satisfies z.ZodType<C.ChatSource>

const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), eventId }).strict(),
  z.object({ kind: z.literal('task'), taskId }).strict(),
  z.object({ kind: z.literal('draft'), draftId }).strict(),
  z.object({ kind: z.literal('template'), templateRevisionId }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId }).strict(),
])
const input = z.object({ id: inputId, target, agentId, contextGeneration: count, recordedAtSequence: positive, directEventIds: z.array(eventId), recalledEventIds: z.array(eventId), sessionEventIds: z.array(eventId) }).strict()
const resetBase = {
  id: resetId, source: chatSourceSchema, requestedByHumanId: id.transform(HumanId),
  fromSequence: positive, throughSequence: positive, affectedAgentIds: z.array(agentId), previousGenerations: z.record(agentId, count),
  invalidatedEventIds: z.array(eventId), invalidatedTaskIds: z.array(taskId), invalidatedDraftIds: z.array(draftId),
  invalidatedTemplateRevisionIds: z.array(templateRevisionId), invalidatedArtifactIds: z.array(artifactId),
  requestedAt: timestamp, fileRestoreRequested: z.boolean(),
}
const reset = z.discriminatedUnion('status', [
  z.object({ ...resetBase, status: z.enum(['pending', 'completed']), error: z.never().optional() }).strict(),
  z.object({ ...resetBase, status: z.literal('failed'), error: text }).strict(),
])

/** Raw snapshots retain bytes in journal-owned blobs, never tool result strings. */
export const fileByteSnapshotSchema = z.discriminatedUnion('existed', [
  z.object({ existed: z.literal(false) }).strict(),
  z.object({ existed: z.literal(true), blobId: id.transform(value => value as C.FileBlobId), sha256: z.string().regex(/^[0-9a-f]{64}$/u), size: count }).strict(),
]) satisfies z.ZodType<C.FileByteSnapshot>

const restore = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['pending', 'skipped']) }).strict(),
  z.object({ status: z.literal('restored'), recovery: fileByteSnapshotSchema }).strict(),
  z.object({ status: z.enum(['conflict', 'failed', 'unavailable']), reason: text }).strict(),
])
const relativePath = text.refine(value => !/[\\<>:"|?*\u0000-\u001f\u007f-\u009f]/u.test(value)
  && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && segment.trim() === segment && !segment.endsWith('.')))
const checkpoint = z.object({ id: checkpointId, order: positive, inputId, agentId, contextGeneration: count, callId: id.transform(ToolCallId), path: relativePath, before: fileByteSnapshotSchema, after: fileByteSnapshotSchema, restore }).strict()

const state = z.object({
  revision: count,
  nextCheckpointOrder: positive,
  messages: z.record(eventId, z.object({ eventId, intent: z.enum(['message', 'assignment', 'proposal', 'delegation']), contextGeneration: count.optional(), withdrawnBy: resetId.optional() }).strict()),
  taskSources: z.record(taskId, chatSourceSchema),
  draftSources: z.record(draftId, chatSourceSchema),
  inputs: z.record(inputId, input),
  contexts: z.record(agentId, z.object({ generation: count, blockedBy: resetId.optional(), sessionId: id.transform(value => value as SessionId).optional() }).strict()),
  resets: z.record(resetId, reset),
  fileCheckpoints: z.record(checkpointId, checkpoint),
}).strict() satisfies z.ZodType<C.CommunicationState>

/** Strict persistence reader; pair with assertCommunicationRelationships before use. */
export const communicationStateSchema = z.preprocess((value, ctx) => {
  if (containsPrototypeKey(value)) ctx.addIssue({ code: 'custom', message: 'invalid communication object key' })
  return value
}, state)

function containsPrototypeKey(value: unknown): boolean {
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const item = pending.pop()
    if (item === null || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    for (const [key, child] of Object.entries(item)) {
      if (key === '__proto__') return true
      pending.push(child)
    }
  }
  return false
}
