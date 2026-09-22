/** Identity manifest shared by release packing, smoke, and publishing. */

import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'

export const RELEASE_PACKAGES = [
  { key: 'host', name: '@dsh-agent-group/host', directory: 'packages/host', manifest: 'packages/host/package.json', artifactStem: 'dsh-agent-group-host' },
  { key: 'web', name: '@dsh-agent-group/web', directory: 'packages/web', manifest: 'packages/web/package.json', artifactStem: 'dsh-agent-group-web' },
  { key: 'bundle', name: 'dsh-agent-group', directory: 'packages/bundle', manifest: 'packages/bundle/package.json', artifactStem: 'dsh-agent-group' },
]

function sourceFiles(root) {
  const files = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && entry.name !== 'lib' && entry.name !== 'node_modules') visit(path)
      else if (entry.isFile() && !entry.name.endsWith('.tsbuildinfo')) files.push(path)
    }
  }
  for (const pkg of RELEASE_PACKAGES) visit(join(root, pkg.directory))
  for (const name of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'compatibility.json',
    'tsconfig.json',
    'tsconfig.host.json',
    'vitest.config.ts',
    'scripts/release.mjs',
    'scripts/release-artifacts.mjs',
  ]) {
    const path = join(root, name)
    if (existsSync(path)) files.push(path)
  }
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right), 'en'))
}

function smokeInputFiles(root) {
  const paths = [
    'scripts/release-smoke.mjs',
    'scripts/release-smoke-contract.mjs',
    'tests/e2e/README.md',
    'tests/e2e/workspace-browser.mjs',
  ].map(name => join(root, name))
  const fixtureRoot = join(root, 'tests', 'fixtures', 'browser')
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && !entry.name.endsWith('.tsbuildinfo')) paths.push(path)
    }
  }
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`release smoke input is missing: ${relative(root, path)}`)
  }
  visit(fixtureRoot)
  return paths.sort((left, right) => relative(root, left).localeCompare(relative(root, right), 'en'))
}

function digestFiles(root, paths, algorithm) {
  const hash = createHash(algorithm)
  for (const path of paths) {
    const name = relative(root, path).replaceAll('\\', '/')
    const bytes = readFileSync(path)
    hash.update(`${name.length}:${name}:${bytes.length}:`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

function digestFile(path, algorithm) {
  return createHash(algorithm).update(readFileSync(path)).digest('hex')
}

function artifactPath(root, pkg, version) {
  return join(root, 'release', `${pkg.artifactStem}-${version}.tgz`)
}

/** Write the immutable artifact/source identity produced by release:pack. */
export function writeReleaseManifest(root, version) {
  const artifacts = RELEASE_PACKAGES.map(pkg => {
    const path = artifactPath(root, pkg, version)
    const bytes = statSync(path).size
    return {
      key: pkg.key,
      name: pkg.name,
      filename: relative(join(root, 'release'), path).replaceAll('\\', '/'),
      bytes,
      sha512: digestFile(path, 'sha512'),
    }
  })
  const manifest = {
    format: 'dsh-agent-group/release-artifacts-v1',
    version,
    sourceSha256: digestFiles(root, sourceFiles(root), 'sha256'),
    artifacts,
  }
  writeFileSync(join(root, 'release', 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

/** Verify that release artifacts are byte-identical to a pack of the current source. */
export function verifyReleaseArtifacts(root, version) {
  const manifestPath = join(root, 'release', 'release-manifest.json')
  if (!existsSync(manifestPath)) throw new Error('release artifact manifest is missing; run pnpm release:pack')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.format !== 'dsh-agent-group/release-artifacts-v1' || manifest.version !== version) {
    throw new Error(`release artifact manifest does not describe version ${version}`)
  }
  const sourceSha256 = digestFiles(root, sourceFiles(root), 'sha256')
  if (manifest.sourceSha256 !== sourceSha256) {
    throw new Error('release artifact source identity is stale; run pnpm release:pack')
  }
  const paths = {}
  for (const pkg of RELEASE_PACKAGES) {
    const expectedFilename = `${pkg.artifactStem}-${version}.tgz`
    const record = manifest.artifacts?.find(entry => entry.key === pkg.key && entry.name === pkg.name)
    if (record?.filename !== expectedFilename) throw new Error(`release artifact record is missing for ${pkg.name}`)
    const path = join(root, 'release', expectedFilename)
    if (!existsSync(path)
      || statSync(path).size !== record.bytes
      || digestFile(path, 'sha512') !== record.sha512) {
      throw new Error(`release artifact identity changed for ${pkg.name}`)
    }
    paths[pkg.key] = path
  }
  return { manifest, artifacts: paths }
}

function expectedSmokeReceipt(root, version, verifiedSource) {
  const release = verifyReleaseArtifacts(root, version)
  return {
    format: 'dsh-agent-group/release-smoke-v1',
    version,
    releaseManifestSha256: digestFile(join(root, 'release', 'release-manifest.json'), 'sha256'),
    sourceSha256: release.manifest.sourceSha256,
    smokeInputSha256: digestFiles(root, smokeInputFiles(root), 'sha256'),
    artifacts: release.manifest.artifacts.map(({ key, name, filename, bytes, sha512 }) => ({ key, name, filename, bytes, sha512 })),
    verifiedDsh: { version: verifiedSource.version, commit: verifiedSource.commit },
  }
}

/** Build the only allowed publish commands from verified tarball paths. */
export function releasePublishCommands(artifacts, forwarded = []) {
  return RELEASE_PACKAGES.map(pkg => [
    'publish',
    artifacts[pkg.key],
    '--access',
    'public',
    ...forwarded,
  ])
}

/** Record that the exact current tarballs passed the full packed Browser smoke. */
export function writeReleaseSmokeReceipt(root, version, verifiedSource) {
  const receipt = expectedSmokeReceipt(root, version, verifiedSource)
  writeFileSync(join(root, 'release', 'release-smoke.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  return receipt
}

/** Reject publishing unless the exact current tarballs passed the verified DSH smoke. */
export function verifyReleaseSmokeReceipt(root, version, verifiedSource) {
  const path = join(root, 'release', 'release-smoke.json')
  if (!existsSync(path)) throw new Error('release smoke receipt is missing; run pnpm smoke:packed')
  const actual = JSON.parse(readFileSync(path, 'utf8'))
  const expected = expectedSmokeReceipt(root, version, verifiedSource)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('release smoke receipt does not match the current release artifacts and DSH point')
  }
  return actual
}
