import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const packages = [
  { name: '@dsh-agent-group/host', manifest: 'packages/host/package.json' },
  { name: '@dsh-agent-group/web', manifest: 'packages/web/package.json' },
  { name: 'dsh-agent-group', manifest: 'packages/bundle/package.json' },
]

const action = process.argv[2]
const forwarded = process.argv.slice(3)
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(args) {
  const result = spawnSync(pnpm, args, { cwd: process.cwd(), stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function readVersion(path) {
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8'))
  return manifest.version
}

const versions = new Map(packages.map(pkg => [pkg.name, readVersion(pkg.manifest)]))
const uniqueVersions = new Set(versions.values())
if (uniqueVersions.size !== 1) {
  console.error('Release packages must share one version:')
  for (const [name, version] of versions) console.error(`  ${name}: ${version}`)
  process.exit(1)
}

if (action === 'pack') {
  const outDir = resolve('release')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const pkg of packages) {
    console.log(`\nPacking ${pkg.name}@${versions.get(pkg.name)}...`)
    run(['--filter', pkg.name, 'pack', '--pack-destination', outDir])
  }
  console.log(`\nPacked release artifacts in ${outDir}`)
} else if (action === 'publish') {
  console.log('Publishing in dependency order: host -> web -> bundle')
  for (const pkg of packages) {
    console.log(`\nPublishing ${pkg.name}@${versions.get(pkg.name)}...`)
    run(['--filter', pkg.name, 'publish', '--access', 'public', ...forwarded])
  }
} else {
  console.error('Usage: node scripts/release.mjs <pack|publish> [pnpm publish args...]')
  process.exit(2)
}
