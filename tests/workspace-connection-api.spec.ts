import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { WorkspaceApi, assertWorkspaceRpcError } from '../packages/web/src/client/api.ts'
import { WorkspaceWorkflowApi, assertWorkflowRpcError } from '../packages/web/src/client/workflow-api.ts'

type InstallConnection = (ctx: Context, options: { readonly transport: { readonly fetch: (input: string | URL, init: RequestInit) => Promise<Response> } }) => void
const requireWeb = createRequire(new URL('../packages/web/package.json', import.meta.url))
const source = readFileSync(requireWeb.resolve('@deepseek-ai/dsh-client-connection/client'), 'utf8')
let installConnection: InstallConnection | undefined
// The published Client entry is a Browser module factory, not a Node ESM entry.
new Function('window', source)({ __ModuleLoader__: { load(bundle: { readonly factory: (require: (id: string) => never) => Record<string, unknown> }) {
  const exported = bundle.factory(id => { throw new Error(`Unexpected Connection runtime import: ${id}`) })
  if (typeof exported['installConnection'] !== 'function') throw new Error('Missing public Connection installer')
  installConnection = exported['installConnection'] as InstallConnection
} } })

async function connectionFailure(error: object) {
  const ctx = new Context()
  const requests: { route: string; body: Record<string, unknown> }[] = []
  const fiber = ctx.plugin({ apply(ctx: Context) {
    if (!installConnection) throw new Error('Connection bundle was not loaded')
    installConnection(ctx, { transport: { fetch: async (input, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      requests.push({ route: String(input), body })
      return Response.json({ type: 'server-response', rpcId: body['rpcId'], result: { ok: false, error } })
    } } })
  } })
  await fiber.await()
  const connection = ctx.get('connection')!
  return { api: new WorkspaceApi(connection).forWorkspace('local'), connection, requests, dispose: () => fiber.dispose() }
}

it.each([
  ['aggregate', 'stale-revision', { expectedRevision: 41, actualRevision: 42 }],
  ['workflow', 'stale-workflow-revision', { expectedWorkflowRevision: 41, actualWorkflowRevision: 42 }],
  ['workflow', 'stale-draft-revision', { draftId: 'draft', expectedDraftRevision: 41, actualDraftRevision: 42 }],
  ['workflow', 'stale-revision', { expectedRevision: 41, actualRevision: 42 }],
] as const)('retains %s %s classification through the published Connection parser', async (client, code, details) => {
  const f = await connectionFailure({ kind: 'business', code, message: 'revision changed', details })
  try {
    const decoded = await f.connection.rpc.call('/agent-workspace', 'snapshot', { workspaceId: 'local' })
    expect(decoded).toEqual({ ok: false, error: { code, message: 'revision changed', details } })
    const operation = client === 'aggregate' ? f.api.openDirect('agent-19', 41) : new WorkspaceWorkflowApi(f.api).snapshot()
    await expect(operation).rejects.toMatchObject({ name: client === 'aggregate' ? 'WorkspaceApiError' : 'WorkflowApiError', kind: 'business', code, details })
    expect(f.requests[1]).toMatchObject(client === 'aggregate'
      ? { route: 'agent-workspace/room/direct/open', body: { method: 'room/direct/open', payload: { workspaceId: 'local', expectedRevision: 41, agentId: 'agent-19' } } }
      : { route: 'agent-workspace/workflow/snapshot', body: { method: 'workflow/snapshot', payload: { workspaceId: 'local' } } })
  } finally { await f.dispose() }
})

const safe = { kind: 'internal', code: 'internal', message: 'Agent Workspace request failed', details: {} }
it.each([
  { code: 'invented', message: 'private diagnostic', details: {} },
  { code: 'stale-revision', message: 'private diagnostic', details: { expectedRevision: 41, actualRevision: 42 }, secret: true },
  { code: 'stale-revision', message: 'private diagnostic', details: { expectedRevision: 41, actualRevision: 42, secret: true } },
  { code: 'stale-revision', message: 'private diagnostic', details: { expectedRevision: -1, actualRevision: 42 } },
  { code: 'stale-workflow-revision', message: 'private diagnostic', details: { expectedWorkflowRevision: 41, actualWorkflowRevision: 42, secret: true } },
  { code: 'stale-draft-revision', message: 'private diagnostic', details: { draftId: 'draft', expectedDraftRevision: '41', actualDraftRevision: 42 } },
  { kind: 'internal', code: 'stale-revision', message: 'private diagnostic', details: { expectedRevision: 41, actualRevision: 42 } },
  { kind: 'cancelled', code: 'stale-workflow-revision', message: 'private diagnostic', details: { expectedWorkflowRevision: 41, actualWorkflowRevision: 42 } },
  { kind: undefined, code: 'stale-revision', message: 'private diagnostic', details: { expectedRevision: 41, actualRevision: 42 } },
])('rejects malformed or inconsistent decoded errors %#', error => {
  expect(assertWorkspaceRpcError(error)).toEqual(safe)
  expect(assertWorkflowRpcError(error)).toEqual(safe)
})

it.each([
  { code: 'agent-missing', message: 'missing', details: { agentId: 'agent-19' }, kind: 'business' },
  { code: 'bad-request', message: 'bad', details: { issues: [] }, kind: 'bad-request' },
  { code: 'cancelled', message: 'cancelled', details: {}, kind: 'cancelled' },
  { code: 'internal', message: 'safe', details: {}, kind: 'internal' },
  { code: 'workflow-read-only', message: 'archived', details: { workspaceId: 'local' }, kind: 'business' },
])('accepts exact decoded and Host envelopes for known $code', error => {
  const { kind, ...decoded } = error
  expect(assertWorkflowRpcError(decoded)).toEqual(error)
  expect(assertWorkflowRpcError(error)).toEqual(error)
  if (error.code !== 'workflow-read-only') {
    expect(assertWorkspaceRpcError(decoded)).toEqual(error)
    expect(assertWorkspaceRpcError(error)).toEqual(error)
  }
})
