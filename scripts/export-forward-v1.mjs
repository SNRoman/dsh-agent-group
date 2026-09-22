#!/usr/bin/env node

import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createForwardWorkspaceExportV1 } from '../packages/host/lib/index.js'

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!['--input', '--output', '--exported-at'].includes(name) || value === undefined || value.startsWith('--')) {
      throw new Error('usage: export-forward-v1 --input <path> --output <path> --exported-at <UTC timestamp>')
    }
    if (values.has(name)) throw new Error(`duplicate argument '${name}'`)
    values.set(name, value)
  }
  for (const name of ['--input', '--output', '--exported-at']) {
    if (!values.has(name)) throw new Error(`missing required argument '${name}'`)
  }
  return {
    input: resolve(values.get('--input')),
    output: resolve(values.get('--output')),
    exportedAt: values.get('--exported-at'),
  }
}

function readLocalWorkspace(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('input must be a JSON object')
  if (!hasExactKeys(document, ['global', 'tables', 'unit'])) throw new Error('input must be one complete storage-domain document')
  if (!hasExactKeys(document.unit, ['name', 'version']) || document.unit.name !== 'agent_workspace' || document.unit.version !== 0) {
    throw new Error("input must use agent_workspace domain version 0")
  }
  if (document.global !== null) throw new Error('agent_workspace storage global value must be null')
  if (!hasExactKeys(document.tables, ['workspaces'])) throw new Error("input must contain only the 'workspaces' table")
  const records = document.tables?.workspaces
  if (records === null || typeof records !== 'object' || Array.isArray(records) || Object.keys(records).length !== 1 || !Object.hasOwn(records, 'local')) {
    throw new Error("input must contain exactly one 'local' workspace record")
  }
  return records.local
}

function hasExactKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const source = await readFile(args.input, 'utf8')
  const state = readLocalWorkspace(JSON.parse(source))
  const { json } = createForwardWorkspaceExportV1(state, { exportedAt: args.exportedAt })
  const output = await open(args.output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await output.writeFile(`${json}\n`, 'utf8')
  } finally {
    await output.close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
