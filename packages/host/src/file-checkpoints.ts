/** Raw byte checkpoint capture and conservative restoration for attributed local file tools. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { AgentId, WorkspaceId } from './ids.ts'
import type { CommunicationInputId, FileBlobId, FileByteSnapshot, FileCheckpointId, FileCheckpointMetadata, FileCheckpointRestore } from './communication-contract.ts'

/** Exact input admitted at the managed turn's origin. */
export interface ManagedFileInput {
  readonly inputId: CommunicationInputId
  readonly agentId: AgentId
  readonly generation: number
  readonly cwd: string
  readonly workspaceId: WorkspaceId
  /** True only when the executing filesystem provider is the local host filesystem. */
  readonly hostLocal: boolean
}

/** An observed tool effect for which complete trusted snapshots could not be retained. */
export interface FileCheckpointUnavailable extends ManagedFileInput {
  readonly callId: ToolCallId
  readonly path: string
  readonly reason: string
}

/** Durable metadata owner allocates write order and records incomplete capture before dispatch. */
export interface FileCheckpointPersistence {
  /** @returns All checkpoints belonging to this journal's organization. */
  snapshot(): readonly FileCheckpointMetadata[]
  /** @param value Provisional checkpoint. @returns The checkpoint with its atomically allocated order. */
  append(value: Omit<FileCheckpointMetadata, 'order'>): Promise<FileCheckpointMetadata>
  /** @param id Existing checkpoint. @param update Captured after bytes or restore outcome. @returns Completion after durable persistence. */
  update(id: FileCheckpointId, update: { readonly after?: FileByteSnapshot; readonly restore?: FileCheckpointRestore }): Promise<void>
  /** @param value Attributed effect without a complete checkpoint. @returns Completion after durable persistence. */
  unavailable(value: FileCheckpointUnavailable): Promise<void>
}

/** Deployment limits for one organization's private journal. */
export interface FileCheckpointJournalOptions {
  readonly cwd: string
  readonly workspaceId: WorkspaceId
  readonly blobDirectory: string
  readonly maxFileBytes: number
  readonly maxFiles: number
  readonly maxTotalBytes: number
  readonly persistence: FileCheckpointPersistence
}

/** Per-checkpoint UI projection; unavailable is distinct from a byte conflict. */
export interface FileCheckpointPreview {
  readonly id: FileCheckpointId
  readonly path: string
  readonly status: 'restorable' | 'restored' | 'conflict' | 'unavailable'
  readonly reason?: string
  readonly before: FileByteSnapshot
  readonly after: FileByteSnapshot
  /** Human-only preview of valid UTF-8 checkpoints, bounded by journal byte limits; never persisted. */
  readonly text?: { readonly before: string; readonly after: string }
}

/** Capture and restore owner; byte blobs never derive from rendered tool results. */
export class FileCheckpointJournal {
  private tail: Promise<void> = Promise.resolve()
  private readonly cwd: string
  private readonly blobDirectory: string

  /** @param options Fixed local workspace owner, byte storage and validated deployment limits. */
  constructor(private readonly options: FileCheckpointJournalOptions) {
    this.cwd = resolve(options.cwd)
    this.blobDirectory = resolve(options.blobDirectory)
    if (contains(this.cwd, this.blobDirectory)) throw new Error('checkpoint blobs must be private storage outside the managed workspace')
  }

  /** @param input Actual admitted input. @param callId Actual mutation call. @param path Tool file path. @param next Actual mutation. @returns The original result, preserving the original thrown error. */
  async observe<T>(input: ManagedFileInput, callId: ToolCallId, path: string, next: () => Promise<T>): Promise<T> {
    return await this.serial(async () => {
      let checkpoint: FileCheckpointMetadata | undefined
      let target: string | undefined
      try {
        this.assertScope(input)
        await this.assertStorageOwner()
        target = await this.safePath(path)
        if (this.options.persistence.snapshot().length >= this.options.maxFiles) throw new Error('checkpoint file count limit reached')
        const before = await this.capture(target)
        checkpoint = await this.options.persistence.append({
          id: randomUUID() as FileCheckpointId, inputId: input.inputId, agentId: input.agentId, contextGeneration: input.generation,
          callId, path: relative(this.cwd, target).split(sep).join('/'), before, after: before,
          restore: { status: 'unavailable', reason: 'after bytes have not been captured' },
        })
      } catch (error) {
        await this.unavailable({ ...input, callId, path, reason: message(error) })
      }
      try {
        return await next()
      } finally {
        if (checkpoint !== undefined && target !== undefined) {
          try {
            await this.safePath(checkpoint.path)
            const after = await this.capture(target)
            await this.options.persistence.update(checkpoint.id, { after, restore: { status: 'pending' } })
          } catch (error) {
            await this.markUnavailable(checkpoint.id, message(error))
          }
        }
      }
    })
  }

  /** @param scope Fixed local workspace. @param inputIds Inputs whose effects are affected. @returns Reverse ordered classifications, simulating successful restoration of later writes. */
  async preview(scope: Pick<ManagedFileInput, 'cwd' | 'workspaceId' | 'hostLocal'>, inputIds: ReadonlySet<CommunicationInputId>): Promise<FileCheckpointPreview[]> {
    return await this.serial(async () => {
      const results: FileCheckpointPreview[] = []
      const simulated = new Map<string, FileByteSnapshot>()
      const blocked = new Map<string, FileCheckpointPreview>()
      const all = this.options.persistence.snapshot()
      for (const checkpoint of selected(all, inputIds)) {
        const key = pathKey(checkpoint.path)
        const later = blocked.get(key)
        const result = later === undefined ? await this.classify(scope, checkpoint, all, inputIds, simulated.get(key)) : projection(checkpoint, later.status, later.reason)
        results.push({ ...result, ...await this.previewText(scope, checkpoint) })
        if (result.status === 'restorable') simulated.set(key, checkpoint.before)
        else if (result.status !== 'restored') blocked.set(key, result)
      }
      return results
    })
  }

  /** @param scope Fixed local workspace. @param inputIds Inputs whose effects are affected. @returns Per-file outcomes; byte copies are durable before overwriting an existing regular file. Automatic deletion and missing-file recreation are unavailable. */
  async restore(scope: Pick<ManagedFileInput, 'cwd' | 'workspaceId' | 'hostLocal'>, inputIds: ReadonlySet<CommunicationInputId>): Promise<FileCheckpointPreview[]> {
    return await this.serial(async () => {
      const results: FileCheckpointPreview[] = []
      const blocked = new Map<string, FileCheckpointPreview>()
      const all = this.options.persistence.snapshot()
      for (const checkpoint of selected(all, inputIds)) {
        const key = pathKey(checkpoint.path)
        const later = blocked.get(key)
        let result = later === undefined ? await this.classify(scope, checkpoint, all, inputIds) : projection(checkpoint, later.status, later.reason)
        if (result.status === 'restorable') {
          try {
            const target = await this.safePath(checkpoint.path)
            const recovery = await this.capture(target)
            if (!sameBytes(recovery, checkpoint.after)) throw new Conflict('file changed before restoration')
            const before = await this.load(checkpoint.before)
            await this.replace(target, checkpoint.after, before)
            await this.options.persistence.update(checkpoint.id, { restore: { status: 'restored', recovery } })
            result = projection(checkpoint, 'restored')
          } catch (error) {
            const status = error instanceof Conflict ? 'conflict' : 'unavailable'
            const reason = message(error)
            await this.markRestore(checkpoint.id, { status, reason })
            result = projection(checkpoint, status, reason)
          }
        } else if (result.status !== 'restored') {
          await this.markRestore(checkpoint.id, { status: result.status, reason: result.reason ?? 'checkpoint is unavailable' })
        }
        if (result.status !== 'restored') blocked.set(key, result)
        results.push(result)
      }
      return results
    })
  }

  /** @param value Attributed unsupported effect. @returns Completion after reporting; reporting failure does not replace the actual tool error. */
  async unavailable(value: FileCheckpointUnavailable): Promise<void> {
    try { await this.options.persistence.unavailable(value) }
    catch (error) { console.error('file checkpoint unavailable report failed', error) }
  }

  /** @param value Effect with no per-file attribution. @param next Actual effect. @returns Original result after fencing earlier captures for this workspace. */
  async unattributed<T>(value: FileCheckpointUnavailable, next: () => Promise<T>): Promise<T> {
    return await this.serial(async () => {
      await this.unavailable(value)
      try {
        this.assertScope(value)
        for (const checkpoint of this.options.persistence.snapshot()) {
          if (checkpoint.restore.status !== 'restored') await this.markUnavailable(checkpoint.id, value.reason)
        }
      } catch (error) { await this.unavailable({ ...value, reason: message(error) }) }
      return await next()
    })
  }

  private assertScope(scope: Pick<ManagedFileInput, 'cwd' | 'workspaceId' | 'hostLocal'>): void {
    if (!scope.hostLocal) throw new Error('filesystem provider is not the local host')
    if (scope.workspaceId !== this.options.workspaceId || pathKey(resolve(scope.cwd)) !== pathKey(this.cwd)) throw new Error('managed file input belongs to a different workspace or working directory')
  }

  private async previewText(scope: Pick<ManagedFileInput, 'cwd' | 'workspaceId' | 'hostLocal'>, checkpoint: FileCheckpointMetadata): Promise<Pick<FileCheckpointPreview, 'text'>> {
    try {
      this.assertScope(scope)
      await this.assertStorageOwner()
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const before = decoder.decode(await this.load(checkpoint.before))
      const after = decoder.decode(await this.load(checkpoint.after))
      if (before.includes('\0') || after.includes('\0')) return {}
      return { text: { before, after } }
    } catch (_error) { return {} /* Missing, changed or binary checkpoints have no text preview. */ }
  }

  private async classify(scope: Pick<ManagedFileInput, 'cwd' | 'workspaceId' | 'hostLocal'>, checkpoint: FileCheckpointMetadata, all: readonly FileCheckpointMetadata[], inputIds: ReadonlySet<CommunicationInputId>, simulated?: FileByteSnapshot): Promise<FileCheckpointPreview> {
    if (checkpoint.restore.status === 'restored') return projection(checkpoint, 'restored')
    if (checkpoint.restore.status === 'unavailable' || checkpoint.restore.status === 'failed' || checkpoint.restore.status === 'skipped') return projection(checkpoint, 'unavailable', 'reason' in checkpoint.restore ? checkpoint.restore.reason : 'checkpoint was skipped')
    try {
      this.assertScope(scope)
      await this.assertStorageOwner()
      const target = await this.safePath(checkpoint.path)
      if (all.some(later => later.order > checkpoint.order && pathKey(later.path) === pathKey(checkpoint.path) && !inputIds.has(later.inputId) && later.restore.status !== 'restored')) return projection(checkpoint, 'conflict', 'a later managed input wrote this file')
      await this.load(checkpoint.before)
      await this.load(checkpoint.after)
      const current = simulated ?? await this.readSnapshot(target)
      if (!sameBytes(current, checkpoint.after)) return projection(checkpoint, 'conflict', 'current file bytes differ from the captured after bytes')
      if (!checkpoint.before.existed) return projection(checkpoint, 'unavailable', 'automatic file deletion cannot atomically verify file identity')
      if (!checkpoint.after.existed) return projection(checkpoint, 'unavailable', 'missing file recreation cannot atomically verify its parent directory')
      return projection(checkpoint, 'restorable')
    } catch (error) { return projection(checkpoint, 'unavailable', message(error)) }
  }

  private async safePath(path: string): Promise<string> {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) throw new Error('file URLs and provider paths are unavailable')
    const target = resolve(this.cwd, path)
    const rel = relative(this.cwd, target)
    if (rel === '' || !contains(this.cwd, target)) throw new Error('file path is outside the managed working directory')
    const parts = rel.split(sep)
    if (parts.some(part => part === '..' || part.trim() !== part || part.endsWith('.') || /[<>:"|?*\u0000-\u001f\u007f-\u009f]/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error('file path cannot be represented by checkpoint metadata')
    await noLinks(this.cwd)
    const root = await realpath(this.cwd)
    let cursor = this.cwd
    for (let index = 0; index < parts.length; index++) {
      cursor = join(cursor, parts[index]!)
      let info
      try { info = await lstat(cursor) }
      catch (error) { if (isMissing(error)) continue; throw error }
      if (info.isSymbolicLink()) throw new Error('symbolic links and junctions are unavailable')
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error('file parent is not a directory')
      if (index === parts.length - 1 && !info.isFile()) throw new Error('only regular files are checkpointed')
      if (info.isFile() && info.nlink !== 1) throw new Error('multiply linked files are unavailable')
      if (!contains(root, await realpath(cursor))) throw new Error('resolved file path is outside the managed working directory')
    }
    return target
  }

  private async raw(target: string): Promise<Buffer | undefined> {
    let handle
    try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
    catch (error) { if (isMissing(error)) return undefined; throw error }
    try { return await this.rawHandle(handle) }
    finally { await handle.close() }
  }

  private async rawHandle(handle: FileHandle): Promise<Buffer> {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('only regular files are checkpointed')
    if (before.nlink !== 1) throw new Error('multiply linked files are unavailable')
    if (before.size > this.options.maxFileBytes) throw new Error('raw file byte limit reached')
    const data = Buffer.alloc(before.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (bytesRead === 0) throw new Error('file changed during raw byte capture')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error('file changed during raw byte capture')
    return data
  }

  private async readSnapshot(target: string): Promise<FileByteSnapshot> {
    const bytes = await this.raw(target)
    return bytes === undefined ? { existed: false } : snapshot(bytes)
  }

  private async capture(target: string): Promise<FileByteSnapshot> {
    const bytes = await this.raw(target)
    if (bytes === undefined) return { existed: false }
    const value = snapshot(bytes)
    await this.store(value.blobId, bytes)
    return value
  }

  private async store(blobId: FileBlobId, bytes: Buffer): Promise<void> {
    await noLinks(this.blobDirectory)
    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 })
    const target = join(this.blobDirectory, blobId)
    try {
      const existing = await this.readBlob(target)
      if (!existing.equals(bytes)) throw new Error('checkpoint blob bytes differ from their identifier')
      return
    } catch (error) { if (!isMissing(error)) throw error }
    let total = 0
    for (const entry of await readdir(this.blobDirectory, { withFileTypes: true })) {
      if (entry.name === 'owner.json') continue
      if (!entry.isFile() || !/^[0-9a-f]{64}$/u.test(entry.name)) throw new Error('private checkpoint storage contains an unsupported entry')
      total += (await lstat(join(this.blobDirectory, entry.name))).size
    }
    if (total + bytes.length > this.options.maxTotalBytes) throw new Error('private checkpoint byte limit reached')
    const handle = await open(target, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() }
    finally { await handle.close() }
  }

  private async assertStorageOwner(): Promise<void> {
    await noLinks(this.blobDirectory)
    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 })
    const path = join(this.blobDirectory, 'owner.json')
    const expected = JSON.stringify({ version: 1, workspaceId: this.options.workspaceId, cwd: pathKey(this.cwd) })
    let handle
    try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
    catch (error) {
      if (!isMissing(error)) throw error
      if (this.options.persistence.snapshot().length !== 0) throw new Error('checkpoint storage has no recorded working directory owner')
      try {
        const created = await open(path, 'wx', 0o600)
        try { await created.writeFile(expected, 'utf8'); await created.sync() }
        finally { await created.close() }
      } catch (creationError) {
        if (!(creationError instanceof Error && 'code' in creationError && creationError.code === 'EEXIST')) throw creationError
      }
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192 || await handle.readFile('utf8') !== expected) throw new Error('checkpoint storage belongs to a different working directory')
    } finally { await handle.close() }
  }

  private async readBlob(target: string): Promise<Buffer> {
    const bytes = await this.raw(target)
    if (bytes === undefined) { const error = new Error('checkpoint blob is missing'); Object.assign(error, { code: 'ENOENT' }); throw error }
    return bytes
  }

  private async load(value: FileByteSnapshot): Promise<Buffer | undefined> {
    if (!value.existed) return undefined
    if (!/^[0-9a-f]{64}$/u.test(value.blobId) || value.blobId !== value.sha256) throw new Error('checkpoint blob identifier is invalid')
    await noLinks(this.blobDirectory)
    const bytes = await this.readBlob(join(this.blobDirectory, value.blobId))
    if (bytes.length !== value.size || digest(bytes) !== value.sha256) throw new Error('checkpoint blob bytes are incomplete or corrupt')
    return bytes
  }

  private async replace(target: string, expected: FileByteSnapshot, before: Buffer | undefined): Promise<void> {
    if (before === undefined) throw new Error('automatic file deletion cannot atomically verify file identity')
    if (!expected.existed) throw new Error('missing file recreation cannot atomically verify its parent directory')
    await this.safePath(relative(this.cwd, target))
    const handle = await open(target, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1) throw new Error('restoration requires a singly linked regular file')
      await this.safePath(relative(this.cwd, target))
      const named = await lstat(target)
      if (!named.isFile() || named.nlink !== 1) throw new Error('restoration requires a singly linked regular file')
      if (opened.dev !== named.dev || opened.ino !== named.ino) throw new Conflict('file identity changed before restoration')
      const current = await this.rawHandle(handle)
      if (!sameBytes(snapshot(current), expected)) throw new Conflict('file changed before restoration')
      let offset = 0
      while (offset < before.length) {
        const { bytesWritten } = await handle.write(before, offset, before.length - offset, offset)
        if (bytesWritten === 0) throw new Error('file restoration stopped before all bytes were written')
        offset += bytesWritten
      }
      await handle.truncate(before.length)
      await handle.sync()
    } finally { await handle.close() }
  }

  private async markUnavailable(id: FileCheckpointId, reason: string): Promise<void> {
    await this.markRestore(id, { status: 'unavailable', reason })
  }

  private async markRestore(id: FileCheckpointId, restore: FileCheckpointRestore): Promise<void> {
    try { await this.options.persistence.update(id, { restore }) }
    catch (error) { console.error('file checkpoint outcome persistence failed', error) }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolveTail => { release = resolveTail })
    await previous
    try { return await operation() }
    finally { release() }
  }
}

class Conflict extends Error {}
function selected(all: readonly FileCheckpointMetadata[], inputs: ReadonlySet<CommunicationInputId>): FileCheckpointMetadata[] { return all.filter(checkpoint => inputs.has(checkpoint.inputId)).sort((left, right) => right.order - left.order) }
function projection(checkpoint: FileCheckpointMetadata, status: FileCheckpointPreview['status'], reason?: string): FileCheckpointPreview { return { id: checkpoint.id, path: checkpoint.path, before: checkpoint.before, after: checkpoint.after, status, ...(reason === undefined ? {} : { reason }) } }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function snapshot(bytes: Uint8Array): Extract<FileByteSnapshot, { existed: true }> { const sha256 = digest(bytes); return { existed: true, blobId: sha256 as FileBlobId, sha256, size: bytes.length } }
function sameBytes(left: FileByteSnapshot, right: FileByteSnapshot): boolean { return left.existed === right.existed && (!left.existed || (right.existed && left.sha256 === right.sha256 && left.size === right.size)) }
function pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path }
function contains(root: string, target: string): boolean { const rel = relative(root, target); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
async function noLinks(path: string): Promise<void> {
  const absolute = resolve(path); const root = parse(absolute).root
  let cursor = root
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('symbolic links and junctions are unavailable') }
    catch (error) { if (!isMissing(error)) throw error }
  }
}
