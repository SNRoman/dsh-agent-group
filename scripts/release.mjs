import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { execaSync } from 'execa'
import {
  RELEASE_PACKAGES,
  releasePublishCommands,
  verifyReleaseArtifacts,
  verifyReleaseSmokeReceipt,
  writeReleaseManifest,
} from './release-artifacts.mjs'

const action = process.argv[2]
const forwarded = process.argv.slice(3)
function run(args) {
  const result = execaSync('pnpm', args, { cwd: process.cwd(), stdio: 'inherit', reject: false })
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1)
}

function readVersion(path) {
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8'))
  return manifest.version
}

const versions = new Map(RELEASE_PACKAGES.map(pkg => [pkg.name, readVersion(pkg.manifest)]))
const compatibility = JSON.parse(readFileSync(resolve('compatibility.json'), 'utf8'))
const uniqueVersions = new Set(versions.values())
if (uniqueVersions.size !== 1) {
  console.error('Release packages must share one version:')
  for (const [name, version] of versions) console.error(`  ${name}: ${version}`)
  process.exit(1)
}
const releaseVersion = [...uniqueVersions][0]
assertCompatibilityDeclaration(compatibility, releaseVersion)

function assertCompatibilityDeclaration(declaration, version) {
  if (declaration.candidatePluginVersion !== version) {
    throw new Error(`compatibility candidate ${String(declaration.candidatePluginVersion)} does not match package version ${version}`)
  }
  if (declaration.forwardExport?.format !== 'dsh-agent-workspace' || declaration.forwardExport?.formatVersion !== 1) {
    throw new Error('compatibility declaration must freeze dsh-agent-workspace forward export format version 1')
  }
}

if (action === 'pack') {
  const outDir = resolve('release')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const pkg of RELEASE_PACKAGES) {
    console.log(`\nPacking ${pkg.name}@${versions.get(pkg.name)}...`)
    run(['--filter', pkg.name, 'pack', '--pack-destination', outDir])
  }
  writeReleaseManifest(process.cwd(), releaseVersion)
  console.log(`\nPacked release artifacts in ${outDir}`)
} else if (action === 'publish') {
  verifyReleaseSmokeReceipt(process.cwd(), releaseVersion, compatibility.verifiedSource)
  const release = verifyReleaseArtifacts(process.cwd(), releaseVersion)
  console.log('Publishing in dependency order: host -> web -> bundle')
  const commands = releasePublishCommands(release.artifacts, forwarded)
  for (const [index, pkg] of RELEASE_PACKAGES.entries()) {
    console.log(`\nPublishing ${pkg.name}@${versions.get(pkg.name)}...`)
    run(commands[index])
  }
} else {
  console.error('Usage: node scripts/release.mjs <pack|publish> [pnpm publish args...]')
  process.exit(2)
}
