import { spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pnpmInvocation, prepareSourceCompatibility, sanitizeChildEnvironment } from './source-compatibility.mjs'

const options = parseArgs(process.argv.slice(2))

if (!options.dsh || !isAbsolute(options.dsh) || (options.scratchRoot !== undefined && !isAbsolute(options.scratchRoot))) {
  console.error('Usage: pnpm test:dsh-source -- --dsh <absolute-path> [--scratch-root <absolute-path>]')
  process.exit(2)
}

const prepared = await prepareSourceCompatibility({
  pluginDirectory: resolve('.'),
  dshDirectory: options.dsh,
  scratchRoot: options.scratchRoot,
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
  const environment = sanitizeChildEnvironment()
  const invocation = pnpmInvocation(process.platform, environment, args)
  const result = spawnSync(invocation.command, invocation.args, { cwd, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} exited with status ${String(result.status)}`)
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if ((name !== '--dsh' && name !== '--scratch-root') || value === undefined) return {}
    options[name === '--dsh' ? 'dsh' : 'scratchRoot'] = value
  }
  return options
}
