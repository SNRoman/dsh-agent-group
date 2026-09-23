import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import canonicalize from 'canonicalize'
import { execa } from 'execa'
import { describe, expect, test } from 'vitest'
import {
  AGENT_WORKSPACE_PLUGIN_VERSION,
  createForwardWorkspaceExportV1,
  WORKSPACE_EXPORT_COMPATIBLE_IMPORT_RANGE,
  WORKSPACE_EXPORT_FORMAT,
  WORKSPACE_EXPORT_FORMAT_VERSION,
} from '../packages/host/src/forward-export.ts'
import { workspaceStateSchema } from '../packages/host/src/spec.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const rawFixture = join(root, 'tests', 'fixtures', 'v0.2.0', 'agent-workspace.json')
const exportedAt = '2026-09-04T00:00:00.000Z'

interface StoredWorkspaceDocument {
  readonly unit: Readonly<Record<string, unknown>>
  readonly global: null
  readonly tables: Readonly<Record<string, unknown>>
}

function parseStoredWorkspace(text: string): unknown {
  const stored = JSON.parse(text) as {
    unit?: unknown
    global?: unknown
    tables?: { workspaces?: Record<string, unknown> }
  }
  expect(stored.unit).toEqual({ name: 'agent_workspace', version: 0 })
  expect(stored.global).toBeNull()
  expect(Object.keys(stored.tables?.workspaces ?? {})).toEqual(['local'])
  return stored.tables?.workspaces?.local
}

function withoutDigest(document: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { digest: _digest, ...envelope } = document
  return envelope
}

function walkKeys(value: unknown, keys: string[] = [], strings: string[] = []): { keys: string[]; strings: string[] } {
  if (typeof value === 'string') strings.push(value)
  if (Array.isArray(value)) for (const item of value) walkKeys(item, keys, strings)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key)
      walkKeys(child, keys, strings)
    }
  }
  return { keys, strings }
}

describe('forward workspace export v1', () => {
  test('matches the checked-in RFC 8785 canonicalization vector', async () => {
    const input = JSON.parse(await readFile(join(root, 'tests', 'fixtures', 'rfc8785', 'vector.json'), 'utf8'))
    const expected = (await readFile(join(root, 'tests', 'fixtures', 'rfc8785', 'canonical.txt'), 'utf8')).replace(/\n$/u, '')
    const actual = canonicalize(input)
    expect(actual).toBe(expected)
    expect(createHash('sha256').update(actual!).digest('hex')).toBe('6d77565c0fe51d7346bd5debb08f2eebbe9bde01eade30b34e2011f360f91b0e')
  })

  test('creates the frozen deterministic portable document without mutating its input', async () => {
    const sourceText = await readFile(rawFixture, 'utf8')
    const state = workspaceStateSchema.parse(parseStoredWorkspace(sourceText))
    const before = structuredClone(state)

    expect(Object.keys(state.definitions).length).toBeGreaterThan(0)
    expect(Object.keys(state.agents).length).toBeGreaterThan(0)
    expect(Object.keys(state.rooms).length).toBeGreaterThan(0)
    expect(Object.keys(state.tasks).length).toBeGreaterThan(0)
    expect(Object.keys(state.childRuns).length).toBeGreaterThan(0)
    expect(state.memoryEntries.length).toBeGreaterThan(0)
    expect(state.events.some(event => event.type === 'task/delivery-started')).toBe(true)
    expect(state.events.some(event => event.type === 'task/result')).toBe(true)
    expect(state.events.some(event => event.type === 'task/cancelled')).toBe(true)
    expect(state.events.some(event => event.type === 'child/run-finished')).toBe(true)

    const result = createForwardWorkspaceExportV1(state, { exportedAt })
    const repeated = createForwardWorkspaceExportV1(state, { exportedAt })

    expect(state).toEqual(before)
    expect(result.document).toMatchObject({
      format: WORKSPACE_EXPORT_FORMAT,
      formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
      pluginVersion: AGENT_WORKSPACE_PLUGIN_VERSION,
      compatibleImportRange: WORKSPACE_EXPORT_COMPATIBLE_IMPORT_RANGE,
      exportedAt,
      workspace: { descriptor: { id: 'local', label: 'Local workspace', lifecycle: 'active' } },
      digest: { algorithm: 'sha-256', canonicalization: 'RFC8785' },
    })
    expect(result.document).not.toHaveProperty('diagnostics')
    expect(result.document.workspace.aggregate).toEqual(
      Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'workspaceId' && key !== 'sessionBindings')),
    )
    const expectedDigest = createHash('sha256').update(canonicalize(withoutDigest(result.document))!).digest('hex')
    expect(result.document.digest.hex).toBe(expectedDigest)
    expect(result.json).toBe(canonicalize(result.document))
    expect(repeated.json).toBe(result.json)
    expect(JSON.parse(result.json)).toEqual(result.document)

    const walked = walkKeys(result.document)
    expect(walked.keys).not.toContain('sessionBindings')
    for (const sessionId of Object.values(state.sessionBindings)) expect(walked.strings).not.toContain(sessionId)
  })

  test('rejects malformed states and non-canonical timestamps', async () => {
    const sourceText = await readFile(rawFixture, 'utf8')
    const state = workspaceStateSchema.parse(parseStoredWorkspace(sourceText))
    expect(() => createForwardWorkspaceExportV1({ ...state, workspaceId: 'other' } as typeof state, { exportedAt })).toThrow(/local/i)
    expect(() => createForwardWorkspaceExportV1({ ...state, nextId: 1 } as typeof state, { exportedAt })).toThrow()
    expect(() => createForwardWorkspaceExportV1(state, { exportedAt: '2026-09-04' })).toThrow(/timestamp/i)
  })

  test('the public CLI preserves its source, refuses overwrite, and matches the public helper', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-group-forward-export-'))
    const input = join(temporary, 'agent-workspace.json')
    const output = join(temporary, 'portable.json')
    try {
      await copyFile(rawFixture, input)
      const sourceBefore = await readFile(input)
      const state = workspaceStateSchema.parse(parseStoredWorkspace(sourceBefore.toString('utf8')))
      const expected = createForwardWorkspaceExportV1(state, { exportedAt }).json
      await execa(process.execPath, [join(root, 'scripts', 'export-forward-v1.mjs'), '--input', input, '--output', output, '--exported-at', exportedAt], { cwd: root })
      expect(await readFile(input)).toEqual(sourceBefore)
      const outputText = await readFile(output, 'utf8')
      expect(outputText.endsWith('\n')).toBe(true)
      expect(outputText.slice(0, -1)).toBe(expected)
      await expect(execa(process.execPath, [join(root, 'scripts', 'export-forward-v1.mjs'), '--input', input, '--output', output, '--exported-at', exportedAt], { cwd: root })).rejects.toMatchObject({ exitCode: 1 })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test.each([
    ['wrong domain', { name: 'other', version: 0 }],
    ['wrong version', { name: 'agent_workspace', version: 1 }],
  ])('the public CLI rejects a %s input', async (_name, unit) => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-group-forward-export-invalid-'))
    const input = join(temporary, 'input.json')
    const output = join(temporary, 'output.json')
    try {
      const document = JSON.parse(await readFile(rawFixture, 'utf8')) as Record<string, unknown>
      await writeFile(input, `${JSON.stringify({ ...document, unit })}\n`, 'utf8')
      await expect(execa(process.execPath, [join(root, 'scripts', 'export-forward-v1.mjs'), '--input', input, '--output', output, '--exported-at', exportedAt], { cwd: root })).rejects.toMatchObject({ exitCode: 1 })
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test.each([
    ['extra domain metadata', (document: StoredWorkspaceDocument) => ({ ...document, unit: { ...document.unit, extra: true } })],
    ['an extra table', (document: StoredWorkspaceDocument) => ({ ...document, tables: { ...document.tables, extra: {} } })],
    ['an extra top-level field', (document: StoredWorkspaceDocument) => ({ ...document, extra: true })],
  ])('the public CLI rejects %s', async (_name, change) => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-group-forward-export-structure-'))
    const input = join(temporary, 'input.json')
    const output = join(temporary, 'output.json')
    try {
      const document = JSON.parse(await readFile(rawFixture, 'utf8')) as StoredWorkspaceDocument
      await writeFile(input, `${JSON.stringify(change(document))}\n`, 'utf8')
      await expect(execa(process.execPath, [join(root, 'scripts', 'export-forward-v1.mjs'), '--input', input, '--output', output, '--exported-at', exportedAt], { cwd: root })).rejects.toMatchObject({ exitCode: 1 })
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test.each([
    ['an extra workspace', (local: unknown) => ({ local, extra: local })],
    ['no local workspace', (local: unknown) => ({ other: local })],
    ['no workspace records', () => ({})],
  ])('the public CLI rejects %s', async (_name, workspaces) => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-group-forward-export-cardinality-'))
    const input = join(temporary, 'input.json')
    const output = join(temporary, 'output.json')
    try {
      const document = JSON.parse(await readFile(rawFixture, 'utf8')) as {
        tables: { workspaces: { local: unknown } }
      }
      document.tables.workspaces = workspaces(document.tables.workspaces.local) as { local: unknown }
      await writeFile(input, `${JSON.stringify(document)}\n`, 'utf8')
      await expect(execa(process.execPath, [join(root, 'scripts', 'export-forward-v1.mjs'), '--input', input, '--output', output, '--exported-at', exportedAt], { cwd: root })).rejects.toMatchObject({ exitCode: 1 })
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
