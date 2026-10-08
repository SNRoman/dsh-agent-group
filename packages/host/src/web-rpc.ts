/** Authenticated Browser RPC route adapter for the Agent Workspace domain. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AgentWorkspaceDomainService } from './index.ts'
import { AGENT_WORKSPACE_RPC_CHANNEL, createWorkspaceRpcHandler } from './rpc.ts'

const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Browser adapter request limits. */
export interface Config {
  /** Maximum buffered JSON request body in bytes. */
  maxRequestBodyBytes?: number
}

/** Services required to expose the workspace domain to the Browser. */
export const inject = ['agentWorkspace', 'connection', 'webServer']

/** Browser adapter configuration schema. */
export const Config: z<Config> = z.object({
  maxRequestBodyBytes: z.natural().min(1).default(1024 * 1024),
})

/** Register the authenticated Agent Workspace RPC route in a Web profile. */
export function apply(ctx: Context, config?: Config): void {
  const handler = createWorkspaceRpcHandler(ctx.agentWorkspace as AgentWorkspaceDomainService)
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? 1024 * 1024
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: AGENT_WORKSPACE_RPC_CHANNEL,
    handler: async (request, response) => {
      const admission = ctx.connection.admit(request)
      if ('rejection' in admission) {
        response.writeHead(admission.rejection)
        response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await dispatch(request, response, handler, maxRequestBodyBytes)
    },
  }))
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: ReturnType<typeof createWorkspaceRpcHandler>,
  maxRequestBodyBytes: number,
): Promise<void> {
  const endpoint = endpointFromRequest(request)
  if (request.method !== 'POST' || endpoint === undefined) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    response.writeHead(415)
    response.end('content type must be application/json')
    return
  }
  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
    rejectOversized(request, response)
    return
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > maxRequestBodyBytes) {
      rejectOversized(request, response)
      return
    }
    chunks.push(buffer)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    response.writeHead(400)
    response.end('body is not JSON')
    return
  }
  const envelope = clientRequestSchema.safeParse(body)
  if (!envelope.success || envelope.data.method !== endpoint) {
    response.writeHead(400)
    response.end('invalid client-request message')
    return
  }
  const abort = new AbortController()
  response.on('close', () => {
    if (!response.writableEnded) abort.abort()
  })
  const result = await handler(endpoint, envelope.data.payload, abort.signal)
  const encoded = JSON.stringify({ type: 'server-response', rpcId: envelope.data.rpcId, result })
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(encoded)
}

function endpointFromRequest(request: IncomingMessage): string | undefined {
  const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
  if (!pathname.startsWith(`${AGENT_WORKSPACE_RPC_CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(AGENT_WORKSPACE_RPC_CHANNEL.length + 1)
  const segments = endpoint.split('/')
  return segments.some(segment => segment === '' || segment === '.' || segment === '..'
    || !ENDPOINT_SEGMENT_PATTERN.test(segment))
    ? undefined
    : endpoint
}

function rejectOversized(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(413, { connection: 'close' })
  response.end()
  request.destroy()
}
