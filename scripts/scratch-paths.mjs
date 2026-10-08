import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Resolve the caller-selected scratch root, falling back to the process temporary directory. */
export function resolveScratchRoot(input, environment = process.env) {
  const selected = input ?? environment['DSH_AGENT_GROUP_SCRATCH_ROOT'] ?? tmpdir()
  if (!isAbsolute(selected)) throw new Error(`scratch root must be absolute: ${selected}`)
  return resolve(selected)
}

/** Reject a cleanup or evidence target that is not a proper descendant of its owned root. */
export function assertScratchDescendant(root, target) {
  const child = relative(resolve(root), resolve(target))
  if (child === '' || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) {
    throw new Error(`scratch target must be below ${resolve(root)}: ${resolve(target)}`)
  }
}

/** Create one uniquely named directory below an owned scratch root. */
export async function createScratchDirectory(root, prefix) {
  const absoluteRoot = resolveScratchRoot(root, {})
  await mkdir(absoluteRoot, { recursive: true })
  const directory = await mkdtemp(join(absoluteRoot, prefix))
  assertScratchDescendant(absoluteRoot, directory)
  return directory
}
