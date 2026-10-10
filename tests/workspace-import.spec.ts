import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import canonicalize from 'canonicalize'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { beforeAll, describe, expect, test } from 'vitest'
import { createForwardWorkspaceExportV1 } from '../packages/host/src/forward-export.ts'
import { HumanId, WorkspaceId } from '../packages/host/src/ids.ts'
import { assertWorkspaceInvariants } from '../packages/host/src/invariant.ts'
import { prepareWorkspaceImportV1 } from '../packages/host/src/workspace-import.ts'
import type { WorkspaceImportLimits } from '../packages/host/src/workspace-import.ts'
import { workspaceStateSchema } from '../packages/host/src/workspace-state-schema.ts'
import type { WorkspaceState } from '../packages/host/src/types.ts'
import { acceptTaskDelivery, failTaskDelivery, startTaskDelivery } from '../packages/host/src/task-delivery.ts'
import { assignHumanTask, cancelTask, recordChildRunStarted } from '../packages/host/src/tasks.ts'

const exportedAt = '2026-10-10T00:00:00.000Z'
const workspaceId = WorkspaceId('imported-中文')
const limits: WorkspaceImportLimits = {
  maxBytes: 1_000_000, maxEntities: 10_000, maxEvents: 10_000, maxStringBytes: 100_000, maxDepth: 32,
}
let source: WorkspaceState

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected test object')
  return value as Record<string, unknown>
}

async function fixture(version: string): Promise<WorkspaceState> {
  const stored: unknown = JSON.parse(await readFile(new URL(`./fixtures/${version}/agent-workspace.json`, import.meta.url), 'utf8'))
  return workspaceStateSchema.parse(record(record(record(stored).tables).workspaces).local)
}

function portable(state = source): Record<string, unknown> {
  return record(JSON.parse(createForwardWorkspaceExportV1(state, { exportedAt }).json))
}

function aggregate(document: Record<string, unknown>): Record<string, unknown> {
  return record(record(document.workspace).aggregate)
}

function signed(document: Record<string, unknown>): string {
  const { digest: _digest, ...envelope } = document
  return JSON.stringify({ ...envelope, digest: {
    algorithm: 'sha-256', canonicalization: 'RFC8785',
    hex: createHash('sha256').update(canonicalize(envelope)!).digest('hex'),
  } })
}

function prepare(json: string, overrides: Partial<WorkspaceImportLimits> = {}) {
  return prepareWorkspaceImportV1(json, { workspaceId, limits: { ...limits, ...overrides } })
}

function assigned() {
  const agent = Object.values(source.agents).find(candidate => candidate.employmentStatus === 'employed')!
  return assignHumanTask(source, { humanId: HumanId('owner'), assigneeAgentId: agent.id, title: '可恢复任务' })
}

beforeAll(async () => { source = await fixture('v0.2.0') })

describe('portable workspace import v1', () => {
  test.each(['v0.1.0', 'v0.2.0'])('imports the %s fixture through the frozen producer and detaches all state', async version => {
    const state = await fixture(version)
    const before = structuredClone(state)
    const exported = createForwardWorkspaceExportV1(state, { exportedAt })
    const result = prepare(exported.json)
    expect(result).toMatchObject({ descriptor: { id: workspaceId, label: 'Local workspace', lifecycle: 'active' }, sourceWorkspaceId: 'local', sourcePluginVersion: exported.document.pluginVersion, exportedAt })
    expect(result.state).toEqual({ ...state, workspaceId, sessionBindings: {}, events: state.events.map(event => 'messageId' in event
      ? { ...event, messageId: MessageId(`agent-workspace-task:${workspaceId}:${event.taskDeliveryAttemptId}`) } : event) })
    assertWorkspaceInvariants(result.state, workspaceId)
    record(Object.values(result.state.definitions)[0]).name = 'changed after import'
    record(result.state.events[0]).text = 'changed after import'
    expect(state).toEqual(before)
    expect(exported.json).toBe(createForwardWorkspaceExportV1(state, { exportedAt }).json)
    expect(prepare(exported.json).state.definitions).toEqual(before.definitions)
  })

  test('preserves source labels, archived lifecycle, diagnostics and arbitrary compatibility metadata', () => {
    const document = portable()
    const descriptor = record(record(document.workspace).descriptor)
    descriptor.label = '归档组织'
    descriptor.lifecycle = 'archived'
    document.compatibleImportRange = 'metadata, not a permission rule'
    document.pluginVersion = 'old custom producer'
    document.diagnostics = { sessionBindingCount: 3 }
    expect(prepare(signed(document))).toMatchObject({ descriptor: { label: '归档组织', lifecycle: 'archived' }, sourcePluginVersion: 'old custom producer' })
  })

  test.each(['', ' ', 'target:bad', 'target\nline', 'target\u0000id', 'local'])('rejects target identity %j', target => {
    expect(() => prepareWorkspaceImportV1(signed(portable()), { workspaceId: WorkspaceId(target), limits })).toThrow(/target|workspace identity/i)
  })

  const mutations: [string, (document: Record<string, unknown>) => void][] = [
    ['extra envelope key', document => { document.extra = 'private-secret' }],
    ['extra workspace key', document => { record(document.workspace).extra = true }],
    ['extra descriptor key', document => { record(record(document.workspace).descriptor).extra = true }],
    ['extra aggregate key', document => { aggregate(document).extra = true }],
    ['workspaceId in aggregate', document => { aggregate(document).workspaceId = 'local' }],
    ['session bindings in aggregate', document => { aggregate(document).sessionBindings = {} }],
    ['unsupported format', document => { document.format = 'other' }],
    ['unsupported version', document => { document.formatVersion = 2 }],
    ['non-local source', document => { record(record(document.workspace).descriptor).id = 'other' }],
    ['noncanonical timestamp', document => { document.exportedAt = '2026-10-10' }],
    ['bad diagnostics', document => { document.diagnostics = { sessionBindingCount: -1 } }],
    ['unknown diagnostics field', document => { document.diagnostics = { sessionBindingCount: 0, extra: true } }],
    ['bad counter', document => { aggregate(document).nextId = 1 }],
    ['bad sequence counter', document => { aggregate(document).nextSequence = 1 }],
    ['broken relation', document => { record(Object.values(record(aggregate(document).definitionRevisions))[0]).definitionId = 'private-secret' }],
    ['missing current template revision', document => { record(Object.values(record(aggregate(document).definitions))[0]).currentRevisionId = 'private-secret' }],
    ['invalid complete schema', document => { record(Object.values(record(aggregate(document).agents))[0]).employmentStatus = 'private-secret' }],
    ['unknown entity field', document => { record(Object.values(record(aggregate(document).definitions))[0]).instructions = 'private-secret' }],
    ['invalid source message identity', document => {
      const events = aggregate(document).events
      if (!Array.isArray(events)) throw new Error('expected test events')
      const event = events.map(record).find(candidate => 'messageId' in candidate)!
      event.messageId = 'private-secret'
    }],
  ]
  test.each(mutations)('rejects re-signed %s without exposing content', (_name, change) => {
    const document = portable()
    change(document)
    expect(() => prepare(signed(document))).toThrow()
    try { prepare(signed(document)) } catch (error) { expect(String(error)).not.toContain('private-secret') }
  })

  test.each([
    { algorithm: 'sha256', canonicalization: 'RFC8785', hex: '0'.repeat(64) },
    { algorithm: 'sha-256', canonicalization: 'other', hex: '0'.repeat(64) },
    { algorithm: 'sha-256', canonicalization: 'RFC8785', hex: 'A'.repeat(64) },
    { algorithm: 'sha-256', canonicalization: 'RFC8785', hex: '0'.repeat(64), extra: true },
  ])('rejects unsupported or corrupt digest metadata %#', digest => {
    expect(() => prepare(JSON.stringify({ ...portable(), digest }))).toThrow(/digest|document/i)
  })

  test('rejects a modified payload with its original digest', () => {
    const document = portable()
    record(record(document.workspace).descriptor).label = 'private-secret'
    expect(() => prepare(JSON.stringify(document))).toThrow(/digest/i)
  })

  test.each([
    ['original digest', false, false], ['re-signed digest', true, false], ['escaped object key', true, true],
  ] as const)('rejects an enumerable prototype key with %s before schema filtering', (_name, resign, escaped) => {
    const document = portable()
    const definitions = record(aggregate(document).definitions)
    Object.defineProperty(definitions, '__proto__', {
      value: structuredClone(Object.values(definitions)[0]), enumerable: true, writable: true, configurable: true,
    })
    const json = resign ? signed(document) : JSON.stringify(document)
    const input = escaped ? json.replace('"__proto__":', '"__pro\\u0074o__":') : json
    expect(() => prepare(input)).toThrow(/object key/i)
  })

  test('preserves prototype-like strings in labels and source text', () => {
    const document = portable()
    record(record(document.workspace).descriptor).label = '__proto__'
    record(Object.values(record(aggregate(document).definitionRevisions))[0]).instructions = '__proto__'
    const result = prepare(signed(document))
    expect(result.descriptor.label).toBe('__proto__')
    expect(Object.values(result.state.definitionRevisions)[0]!.instructions).toBe('__proto__')
  })

  test.each(['\ud800', '\udfff'])('rejects an isolated Unicode surrogate in source strings %j', surrogate => {
    const document = portable()
    record(Object.values(record(aggregate(document).definitions))[0]).name = surrogate
    expect(() => prepare(signed(document))).toThrow(/unicode/i)
  })

  test.each(['\ud800', '\udfff'])('rejects an isolated Unicode surrogate in object keys %j', surrogate => {
    const document = portable()
    const definitions = record(aggregate(document).definitions)
    const [originalKey, originalDefinition] = Object.entries(definitions)[0]!
    const key = `definition-${surrogate}-1`
    definitions[key] = originalDefinition
    Reflect.deleteProperty(definitions, originalKey)
    expect(() => prepare(signed(document))).toThrow(/unicode/i)
  })

  test.each([
    ['repeated root field', (json: string) => json.replace('"formatVersion":1', '"formatVersion":2,"formatVersion":1')],
    ['escaped repeated root field', (json: string) => json.replace('"formatVersion":1', '"formatVersion":2,"format\\u0056ersion":1')],
    ['repeated nested field', (json: string) => json.replace('"label":"Local workspace"', '"label":"ignored","label":"Local workspace"')],
    ['escaped repeated nested field', (json: string) => json.replace('"label":"Local workspace"', '"label":"ignored","\\u006cabel":"Local workspace"')],
    ['repeated field in an array object', (json: string) => json.replace('"sequence":1', '"sequence":0,"sequence":1')],
  ])('rejects %s before canonicalization', (_name, change) => {
    expect(() => prepare(change(signed(portable())))).toThrow(/duplicate/i)
  })

  test('accepts valid emoji, escaped values, repeated keys in distinct objects and reordered pretty JSON', () => {
    const document = portable()
    record(record(document.workspace).descriptor).label = '😀 escaped \\" label : { , ['
    const signedDocument = record(JSON.parse(signed(document)))
    const reordered = Object.fromEntries(Object.entries(signedDocument).reverse())
    const result = prepare(JSON.stringify(reordered, null, 2))
    expect(result.descriptor.label).toBe('😀 escaped \\" label : { , [')
    expect(result.state.events).toHaveLength(source.events.length)
  })

  test('limits nesting in a discarded duplicate value before allocating its scan stack', () => {
    const json = signed(portable())
    const nested = `${'['.repeat(33)}null${']'.repeat(33)}`
    const overwritten = `{ "discarded":${nested}, "discarded":null, ${json.slice(1)}`
    expect(() => prepare(overwritten)).toThrow(/depth/i)
  })

  test('reports malformed JSON safely and applies bytes before JSON parsing', () => {
    expect(() => prepare('{"private-secret":')).toThrow(/JSON/i)
    expect(() => prepare('{"private-secret":', { maxBytes: 1 })).toThrow(/bytes/i)
    try { prepare('{"private-secret":') } catch (error) { expect(String(error)).not.toContain('private-secret') }
  })

  test.each(Object.keys(limits) as (keyof WorkspaceImportLimits)[])('requires an explicit positive safe integer for %s', field => {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => prepare(signed(portable()), { [field]: value })).toThrow(/limit/i)
    }
    const missing = { ...limits }
    Reflect.deleteProperty(missing, field)
    expect(() => prepareWorkspaceImportV1(signed(portable()), { workspaceId, limits: missing })).toThrow(/limit/i)
  })

  test('accepts exact byte, entity, event, depth and UTF-8 string limits', () => {
    const document = portable()
    record(record(document.workspace).descriptor).label = '中文'.repeat(100)
    const json = signed(document)
    const value = aggregate(document)
    const maxEntities = ['definitions', 'definitionRevisions', 'agents', 'rooms', 'memberships', 'tasks', 'taskAssignments', 'delegationGrants', 'childRuns']
      .reduce((total, key) => total + Object.keys(record(value[key])).length, source.memoryEntries.length)
    const pending: { value: unknown; depth: number }[] = [{ value: document, depth: 1 }]
    let maxDepth = 0
    let maxStringBytes = 0
    while (pending.length > 0) {
      const item = pending.pop()!
      if (typeof item.value === 'string') maxStringBytes = Math.max(maxStringBytes, Buffer.byteLength(item.value))
      if (item.value !== null && typeof item.value === 'object') {
        maxDepth = Math.max(maxDepth, item.depth)
        for (const [key, child] of Object.entries(item.value)) {
          if (!Array.isArray(item.value)) maxStringBytes = Math.max(maxStringBytes, Buffer.byteLength(key))
          pending.push({ value: child, depth: item.depth + 1 })
        }
      }
    }
    const exact = { maxBytes: Buffer.byteLength(json), maxEntities, maxEvents: source.events.length, maxStringBytes, maxDepth }
    expect(prepare(json, exact).state.workspaceId).toBe(workspaceId)
    for (const field of Object.keys(exact) as (keyof WorkspaceImportLimits)[]) {
      expect(() => prepare(json, { ...exact, [field]: exact[field] - 1 })).toThrow(new RegExp(field.slice(3), 'i'))
    }
  })

  test('enforces string keys and depth before schema and digest processing', () => {
    expect(() => prepare(JSON.stringify({ ['密'.repeat(20)]: true }), { maxStringBytes: 59 })).toThrow(/string/i)
    let nested: unknown = null
    for (let index = 0; index < 1000; index++) nested = [nested]
    expect(() => prepare(JSON.stringify(nested), { maxDepth: 32 })).toThrow(/depth/i)
    const document = portable()
    aggregate(document).memoryEntries = Array.from({ length: 10_001 }, () => null)
    expect(() => prepare(JSON.stringify(document))).toThrow(/entities/i)
    aggregate(document).events = Array.from({ length: 10_001 }, () => null)
    expect(() => prepare(JSON.stringify(document))).toThrow(/events/i)
  })

  test.each([
    ['started', false], ['accepted', false], ['started', true], ['accepted', true],
  ] as const)('rejects %s task delivery with cancelled=%s', (phase, cancelled) => {
    const task = assigned()
    const started = startTaskDelivery(task.state, { taskId: task.taskId })
    const identity = { taskId: task.taskId, attemptId: started.attemptId, messageId: started.message.id }
    const delivered = phase === 'accepted' ? acceptTaskDelivery(started.state, identity).state : started.state
    const state = cancelled ? cancelTask(delivered, { humanId: HumanId('owner'), taskId: task.taskId }).state : delivered
    expect(() => prepare(createForwardWorkspaceExportV1(state, { exportedAt }).json)).toThrow(/unfinished|delivery/i)
  })

  test('rejects a running child without repairing the exported history', () => {
    const task = assigned()
    const agent = Object.values(task.state.taskAssignments).find(assignment => assignment.taskId === task.taskId)!.assigneeAgentId
    const started = recordChildRunStarted(task.state, { parentAgentId: agent, taskId: task.taskId })
    const before = structuredClone(started.state)
    expect(() => prepare(createForwardWorkspaceExportV1(started.state, { exportedAt }).json)).toThrow(/unfinished|child/i)
    expect(started.state).toEqual(before)
  })

  test('permits tasks never delivered and failed retryable or settled deliveries', () => {
    const task = assigned()
    expect(prepare(createForwardWorkspaceExportV1(task.state, { exportedAt }).json).state.tasks).toEqual(task.state.tasks)
    for (const accepted of [false, true]) {
      const started = startTaskDelivery(task.state, { taskId: task.taskId })
      const identity = { taskId: task.taskId, attemptId: started.attemptId, messageId: started.message.id }
      const state = accepted ? acceptTaskDelivery(started.state, identity).state : started.state
      const failed = failTaskDelivery(state, { ...identity, failureCode: 'interrupted', failureSummary: '保留完整失败记录' })
      expect(prepare(createForwardWorkspaceExportV1(failed.state, { exportedAt }).json).state.tasks).toEqual(failed.state.tasks)
    }
  })
})
