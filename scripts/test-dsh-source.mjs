import { spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { prepareSourceCompatibility } from './source-compatibility.mjs'

const argumentsAfterSeparator = process.argv.slice(2)
const dshFlag = argumentsAfterSeparator.indexOf('--dsh')
const dshDirectory = dshFlag === -1 ? undefined : argumentsAfterSeparator[dshFlag + 1]

if (!dshDirectory || !isAbsolute(dshDirectory) || dshFlag !== argumentsAfterSeparator.length - 2) {
  console.error('Usage: pnpm test:dsh-source -- --dsh <absolute-path>')
  process.exit(2)
}

const prepared = await prepareSourceCompatibility({
  pluginDirectory: resolve('.'),
  dshDirectory,
})

try {
  runPnpm(prepared.pluginDirectory, ['install', '--lockfile-only'])
  runPnpm(prepared.pluginDirectory, ['install', '--frozen-lockfile'])
  runPnpm(prepared.pluginDirectory, ['build'])
  runPnpm(prepared.pluginDirectory, ['typecheck'])
  runPnpm(prepared.pluginDirectory, ['test'])
} finally {
  await rm(prepared.temporaryDirectory, { recursive: true, force: true })
}

function runPnpm(cwd, args) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(pnpm, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} exited with status ${String(result.status)}`)
}
