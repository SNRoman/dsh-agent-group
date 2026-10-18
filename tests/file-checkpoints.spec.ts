import { afterEach, expect, test, vi } from 'vitest'
import { constants } from 'node:fs'
import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AgentId, WorkspaceId } from '../packages/host/src/ids.ts'
import type { CommunicationInputId, FileCheckpointId, FileCheckpointMetadata } from '../packages/host/src/communication-contract.ts'
import { FileCheckpointJournal, type ManagedFileInput, type FileCheckpointPersistence, type FileCheckpointUnavailable } from '../packages/host/src/file-checkpoints.ts'
import { observeWorkspaceFileTool } from '../packages/host/src/file-checkpoint-tools.ts'

const fileRace = vi.hoisted(() => ({ beforeOpen: undefined as (() => Promise<void>) | undefined, afterOpen: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const writable = typeof args[1] === 'number' && (args[1] & constants.O_RDWR) !== 0
    if (writable) await fileRace.beforeOpen?.()
    const handle = await actual.open(...args)
    try { if (writable) await fileRace.afterOpen?.(); return handle }
    catch (error) { await handle.close(); throw error }
  } }
})

const roots: string[] = []
afterEach(async () => { fileRace.beforeOpen = undefined; fileRace.afterOpen = undefined; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(limits = { maxFileBytes: 1024, maxFiles: 20, maxTotalBytes: 4096 }) {
  const root = await mkdtemp(join(tmpdir(), 'colleague-checkpoint-')); roots.push(root)
  const cwd = join(root, 'work'); await mkdir(cwd)
  const records = new Map<FileCheckpointId, FileCheckpointMetadata>(); const unavailable: FileCheckpointUnavailable[] = []
  const persistence: FileCheckpointPersistence = {
    snapshot: () => [...records.values()],
    append: async value => { const checkpoint = { ...value, order: records.size + 1 }; records.set(checkpoint.id, checkpoint); return checkpoint },
    update: async (id, update) => { records.set(id, { ...records.get(id)!, ...update }) },
    unavailable: async value => { unavailable.push(value) },
  }
  const input: ManagedFileInput = { inputId: 'input-one' as CommunicationInputId, agentId: AgentId('one'), generation: 0, cwd, workspaceId: WorkspaceId('org'), hostLocal: true }
  const options = { cwd, workspaceId: input.workspaceId, blobDirectory: join(root, 'blobs'), ...limits, persistence }
  const journal = new FileCheckpointJournal(options)
  const mutate = (path: string, content: Uint8Array | string, managed = input) => journal.observe(managed, ToolCallId(`call-${records.size}`), path, async () => { await writeFile(join(cwd, path), content); return 'written' })
  return { root, cwd, records, unavailable, persistence, input, journal, mutate, options }
}

test('restores the exact existing binary and CRLF bytes and retains recovery bytes across restart', async () => {
  const f = await fixture(); const before = Buffer.from([0, 255, 13, 10, 97, 13, 10]); const after = Buffer.from('new\r\n')
  await writeFile(join(f.cwd, 'data.bin'), before)
  await f.mutate('data.bin', after)
  const checkpoint = [...f.records.values()][0]!
  expect(checkpoint.before).toMatchObject({ existed: true, size: 7 }); expect(checkpoint.after).toMatchObject({ existed: true, size: 5 })
  const restarted = new FileCheckpointJournal(f.options)
  expect(await restarted.preview(f.input, new Set([f.input.inputId]))).toMatchObject([{ id: checkpoint.id, status: 'restorable' }])
  const results = await restarted.restore(f.input, new Set([f.input.inputId]))
  expect(results).toMatchObject([{ status: 'restored' }]); expect(await readFile(join(f.cwd, 'data.bin'))).toEqual(before)
  const stored = f.records.get(checkpoint.id)!
  expect(stored.restore.status).toBe('restored')
  if (stored.restore.status !== 'restored' || !stored.restore.recovery.existed) throw new Error('missing recovery')
  expect(await readFile(join(f.options.blobDirectory, stored.restore.recovery.blobId))).toEqual(after)
})

test('previews trusted UTF-8 before and after content without copying text into durable metadata', async () => {
  const f = await fixture()
  await writeFile(join(f.cwd, 'report.txt'), '用户原稿\r\n', 'utf8')
  await f.mutate('report.txt', '同事修订\n')
  const preview = await f.journal.preview(f.input, new Set([f.input.inputId]))
  expect(preview[0]).toMatchObject({ text: { before: '用户原稿\r\n', after: '同事修订\n' } })
  expect([...f.records.values()][0]).not.toHaveProperty('text')
  await writeFile(join(f.cwd, 'binary.bin'), Buffer.from([0, 255]))
  await f.mutate('binary.bin', 'new')
  expect((await f.journal.preview(f.input, new Set([f.input.inputId]))).find(file => file.path === 'binary.bin')).not.toHaveProperty('text')
})

test('cannot reinterpret persisted relative checkpoints after launching from a different working directory', async () => {
  const f = await fixture()
  await f.mutate('same.txt', 'agent')
  const other = join(f.root, 'different'); await mkdir(other); await writeFile(join(other, 'same.txt'), 'agent')
  const different = new FileCheckpointJournal({ ...f.options, cwd: other })
  expect(await different.restore({ ...f.input, cwd: other }, new Set([f.input.inputId]))).toMatchObject([{ status: 'unavailable' }])
  expect(await readFile(join(other, 'same.txt'), 'utf8')).toBe('agent')
})

test('retains newly created files because deletion cannot atomically verify their identity', async () => {
  const f = await fixture(); await f.mutate('new.txt', 'first')
  expect(await f.journal.preview(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'unavailable', reason: expect.stringContaining('deletion') }])
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'unavailable' }])
  expect(await readFile(join(f.cwd, 'new.txt'), 'utf8')).toBe('first')
})

test('restores successive existing-file writes in reverse order', async () => {
  const f = await fixture(); await writeFile(join(f.cwd, 'new.txt'), 'original')
  await f.mutate('new.txt', 'first'); await f.mutate('new.txt', 'second')
  expect(await f.journal.preview(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'restorable' }, { status: 'restorable' }])
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'restored' }, { status: 'restored' }])
  expect(await readFile(join(f.cwd, 'new.txt'), 'utf8')).toBe('original')
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'restored' }, { status: 'restored' }])
})

test('keeps later manual writes while restoring an independent file', async () => {
  const f = await fixture(); await writeFile(join(f.cwd, 'manual.txt'), 'old'); await writeFile(join(f.cwd, 'other.txt'), 'old'); await f.mutate('manual.txt', 'agent'); await f.mutate('other.txt', 'agent')
  await writeFile(join(f.cwd, 'manual.txt'), 'human')
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'restored' }, { status: 'conflict' }])
  expect(await readFile(join(f.cwd, 'manual.txt'), 'utf8')).toBe('human')
})

test('skips the whole earlier chain when a conflicting manual write matches an older snapshot', async () => {
  const f = await fixture(); await writeFile(join(f.cwd, 'chain.txt'), 'old'); await f.mutate('chain.txt', 'first'); await f.mutate('chain.txt', 'second'); await writeFile(join(f.cwd, 'chain.txt'), 'first')
  expect(await f.journal.preview(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'conflict' }, { status: 'conflict' }])
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'conflict' }, { status: 'conflict' }])
  expect(await readFile(join(f.cwd, 'chain.txt'), 'utf8')).toBe('first')
})

test('keeps a later colleague write even when its bytes match the affected after snapshot', async () => {
  const f = await fixture(); await writeFile(join(f.cwd, 'shared.txt'), 'old'); await f.mutate('shared.txt', 'same')
  await f.mutate('shared.txt', 'same', { ...f.input, inputId: 'input-two' as CommunicationInputId, agentId: AgentId('two') })
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'conflict' }])
  expect(await readFile(join(f.cwd, 'shared.txt'), 'utf8')).toBe('same')
})

test('captures partial writes when the actual tool rejects without replacing its error', async () => {
  const f = await fixture(); await writeFile(join(f.cwd, 'partial.txt'), 'old'); const error = new Error('cancelled after write')
  await expect(f.journal.observe(f.input, ToolCallId('cancel'), 'partial.txt', async () => { await writeFile(join(f.cwd, 'partial.txt'), 'partial'); throw error })).rejects.toBe(error)
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'restored' }])
  expect(await readFile(join(f.cwd, 'partial.txt'), 'utf8')).toBe('old')
})

test('persists incomplete capture before dispatch and does not claim success if after capture fails', async () => {
  const f = await fixture({ maxFileBytes: 4, maxFiles: 20, maxTotalBytes: 4096 })
  await f.journal.observe(f.input, ToolCallId('large-after'), 'large.txt', async () => {
    expect([...f.records.values()][0]!.restore.status).toBe('unavailable')
    await writeFile(join(f.cwd, 'large.txt'), 'too large')
  })
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'unavailable' }])
  expect(await readFile(join(f.cwd, 'large.txt'), 'utf8')).toBe('too large')
})

test('reports unsafe paths, directories and providers unavailable while still delegating the tool', async () => {
  const f = await fixture(); await mkdir(join(f.cwd, 'folder')); let calls = 0
  for (const path of ['../outside.txt', 'folder', 'file:///remote.txt', 'ssh://host/data', 'CON', 'trail.']) await f.journal.observe(f.input, ToolCallId(path), path, async () => { calls++ })
  await f.journal.observe({ ...f.input, hostLocal: false }, ToolCallId('provider'), 'remote.txt', async () => { calls++ })
  expect(calls).toBe(7); expect(f.records.size).toBe(0); expect(f.unavailable).toHaveLength(7)
})

test('does not follow a junction or a replaced parent directory during restoration', async () => {
  const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(outside)
  await symlink(outside, join(f.cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await f.journal.observe(f.input, ToolCallId('link'), 'link/data.txt', async () => {})
  expect(f.records.size).toBe(0)
  await mkdir(join(f.cwd, 'safe')); await f.mutate('safe/data.txt', 'agent')
  await rm(join(f.cwd, 'safe'), { recursive: true }); await writeFile(join(outside, 'data.txt'), 'agent')
  await symlink(outside, join(f.cwd, 'safe'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'unavailable' }])
  expect(await readFile(join(outside, 'data.txt'), 'utf8')).toBe('agent')
})

async function parentReplacement(phase: 'before-open' | 'after-open') {
  const f = await fixture(); const parent = join(f.cwd, 'safe'); const outside = join(f.root, 'outside'); const moved = join(f.root, 'moved')
  await mkdir(parent); await mkdir(outside); await writeFile(join(parent, 'data.txt'), 'old')
  await f.mutate('safe/data.txt', 'agent'); await writeFile(join(outside, 'data.txt'), 'agent')
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
  const pause = async () => { started.resolve(); await release.promise }
  if (phase === 'before-open') fileRace.beforeOpen = pause; else fileRace.afterOpen = pause
  const restoring = f.journal.restore(f.input, new Set([f.input.inputId]))
  try {
    await started.promise
    await rename(parent, moved)
    await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
    release.resolve()
    expect(await restoring).toMatchObject([{ status: 'unavailable' }])
    expect(await readFile(join(outside, 'data.txt'), 'utf8')).toBe('agent')
    expect(await readFile(join(moved, 'data.txt'), 'utf8')).toBe('agent')
  } finally { release.resolve(); await restoring }
}
test('rejects a parent junction replacement before-open during existing-file restoration', async () => { await parentReplacement('before-open') })
// Windows refuses to rename a parent directory while a descendant file handle is open.
test.skipIf(process.platform === 'win32')('rejects a parent junction replacement after-open during existing-file restoration', async () => { await parentReplacement('after-open') })

test.each(['before-open', 'after-open'] as const)('rejects a multiply linked target replacement %s during existing-file restoration', async phase => {
  const f = await fixture(); const target = join(f.cwd, 'data.txt'); const outside = join(f.root, 'outside.txt'); const moved = join(f.root, 'moved.txt')
  await writeFile(target, 'old'); await f.mutate('data.txt', 'agent'); await writeFile(outside, 'agent')
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
  const pause = async () => { started.resolve(); await release.promise }
  if (phase === 'before-open') fileRace.beforeOpen = pause; else fileRace.afterOpen = pause
  const restoring = f.journal.restore(f.input, new Set([f.input.inputId]))
  try {
    await started.promise
    await rename(target, moved)
    await link(outside, target)
    release.resolve()
    expect(await restoring).toMatchObject([{ status: 'unavailable' }])
    expect(await readFile(outside, 'utf8')).toBe('agent')
    expect(await readFile(moved, 'utf8')).toBe('agent')
  } finally { release.resolve(); await restoring }
})

test('keeps both files when a singly linked replacement takes the opened file’s path', async () => {
  const f = await fixture(); const target = join(f.cwd, 'data.txt'); const moved = join(f.root, 'moved.txt')
  await writeFile(target, 'old'); await f.mutate('data.txt', 'agent')
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
  fileRace.afterOpen = async () => { started.resolve(); await release.promise }
  const restoring = f.journal.restore(f.input, new Set([f.input.inputId]))
  try {
    await started.promise
    await rename(target, moved); await writeFile(target, 'agent')
    release.resolve()
    expect(await restoring).toMatchObject([{ status: 'conflict', reason: expect.stringContaining('identity') }])
    expect(await readFile(target, 'utf8')).toBe('agent')
    expect(await readFile(moved, 'utf8')).toBe('agent')
  } finally { release.resolve(); await restoring }
})

test('respects bounded raw file, checkpoint count and private blob byte limits', async () => {
  const f = await fixture({ maxFileBytes: 4, maxFiles: 1, maxTotalBytes: 4 })
  await writeFile(join(f.cwd, 'big.txt'), '12345'); await f.mutate('big.txt', 'small')
  expect(f.records.size).toBe(0)
  await f.mutate('one.txt', '1234'); await f.mutate('two.txt', 'x')
  expect(f.records.size).toBe(1); expect(f.unavailable).toHaveLength(2)
  const bytes = await fixture({ maxFileBytes: 10, maxFiles: 10, maxTotalBytes: 3 })
  await bytes.mutate('data.txt', 'four')
  expect(await bytes.journal.restore(bytes.input, new Set([bytes.input.inputId]))).toMatchObject([{ status: 'unavailable' }])
})

test('never treats missing historical checkpoints as an available file restore', async () => {
  const f = await fixture()
  expect(await f.journal.preview(f.input, new Set([f.input.inputId]))).toEqual([])
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toEqual([])
})

test('wraps only real write and edit calls using their file_path and delegates shell effects as unavailable', async () => {
  const f = await fixture(); let called = 0
  const execute = (name: string, args: object) => observeWorkspaceFileTool(f.journal, f.input, { name, arguments: args, callId: ToolCallId(name) }, async () => { called++; await writeFile(join(f.cwd, 'tool.txt'), String(called)); return { value: called, content: [] } })
  await execute('write', { file_path: 'tool.txt', content: '1' }); await execute('edit', { file_path: 'tool.txt', old_string: '1', new_string: '2' })
  await execute('bash', { command: 'write tool.txt' })
  expect(f.records.size).toBe(2); expect(f.unavailable).toMatchObject([{ path: '', reason: expect.stringContaining('unattributed') }])
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'unavailable' }, { status: 'unavailable' }])
})

test('conservatively fences earlier checkpoints after an unattributed pwsh effect even if bytes match', async () => {
  const f = await fixture(); await f.mutate('tool.txt', 'same')
  await observeWorkspaceFileTool(f.journal, f.input, { name: 'pwsh', arguments: { command: 'unknown effects' }, callId: ToolCallId('pwsh') }, async () => 'done')
  expect(await f.journal.restore(f.input, new Set([f.input.inputId]))).toMatchObject([{ status: 'unavailable' }])
  expect(await readFile(join(f.cwd, 'tool.txt'), 'utf8')).toBe('same')
})

test('excludes multiply linked regular files whose other names can be outside the workspace', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'outside.txt'), 'original')
  await link(join(f.root, 'outside.txt'), join(f.cwd, 'linked.txt'))
  await f.journal.observe(f.input, ToolCallId('hardlink'), 'linked.txt', async () => {})
  expect(f.records.size).toBe(0); expect(f.unavailable).toMatchObject([{ reason: expect.stringContaining('linked') }])
})

test('preserves the original thrown value when capture persistence also fails', async () => {
  const f = await fixture(); const error = new Error('actual tool failed')
  const journal = new FileCheckpointJournal({ ...f.options, persistence: { ...f.persistence, update: async () => { throw new Error('storage offline') } } })
  await expect(journal.observe(f.input, ToolCallId('error'), 'error.txt', async () => { await writeFile(join(f.cwd, 'error.txt'), 'new'); throw error })).rejects.toBe(error)
  expect(f.records.size).toBe(1); expect([...f.records.values()][0]!.restore.status).toBe('unavailable')
})

test('excludes captures and restoration under a different working directory or organization', async () => {
  const f = await fixture(); await f.mutate('same.txt', 'here'); const elsewhere = join(f.root, 'elsewhere'); await mkdir(elsewhere); await writeFile(join(elsewhere, 'same.txt'), 'here')
  await f.journal.observe({ ...f.input, cwd: elsewhere }, ToolCallId('elsewhere'), 'same.txt', async () => {})
  expect(f.records.size).toBe(1)
  expect(await f.journal.restore({ ...f.input, workspaceId: WorkspaceId('other-org') }, new Set([f.input.inputId]))).toMatchObject([{ status: 'unavailable' }])
  expect(await readFile(join(f.cwd, 'same.txt'), 'utf8')).toBe('here')
})
