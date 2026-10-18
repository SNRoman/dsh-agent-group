/** Trusted employees may propose bounded drafts; confirmation remains human-only. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorkspaceToolRegistry } from './task-tools.ts'
import type { AgentId } from './ids.ts'
import { RoomId } from './ids.ts'
import { z } from 'zod'
import type { WorkspaceState } from './types.ts'
import type { WorkflowProposalResult } from './workflow-contract.ts'
import type { ChatProposalRequest } from './chat-work-contract.ts'
import { workflowProposalSchema } from './workflow-schema.ts'

/** Fixed organization selected from the actual published employee object. */
export interface WorkspaceWorkflowToolHost {
  /** @param agent Actual caller. @returns Its published employee identity in the current pool generation. */
  agentIdFor(agent: Agent): AgentId | undefined
  /** @returns Detached durable aggregate used to authenticate employment. */
  snapshot(): WorkspaceState
  /** @param agent Actual caller, authenticated again in the atomic update. @param request Actor-free brief proposal. @param signal Precommit cancellation. @returns Bounded pending-human draft receipt. */
  proposeTask(agent: Agent, request: ChatProposalRequest, signal?: AbortSignal): Promise<WorkflowProposalResult>
  /** @param operation Complete new proposal. @returns Its result under the existing operation reservation. */
  runNewOperation<Value>(operation: () => Promise<Value>): Promise<Value>
}

const chatProposalSchema = workflowProposalSchema.extend({ roomId: z.string().trim().min(1).transform(RoomId) }).strict()

/** @param registry Existing DSH tool registry. @param hosts Trusted per-agent organization resolver. @returns Idempotent definition disposer. */
export function registerWorkspaceWorkflowTools(registry: WorkspaceToolRegistry, hosts: (agent: Agent) => WorkspaceWorkflowToolHost | undefined): () => void {
  const definition = defineTool({
    name: 'workspace_propose_task',
    description: 'Propose work in a selected chat. A human must confirm its assignee before execution.',
    parameters: {
      roomId: { type: 'string', required: true, description: 'Chat in which the caller is an active member and the proposal will be recorded.' },
      brief: { type: 'object', required: true, additionalProperties: false, properties: {
        title: { type: 'string', required: true }, instructions: { type: 'string', required: true },
        expectedArtifacts: { type: 'array', required: true, items: { type: 'string' } },
        acceptanceCriteria: { type: 'array', required: true, items: { type: 'string' } },
      } },
      suggestedAssigneeAgentId: { type: 'string', description: 'Optional employed colleague suggestion; no assignment is made.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { draftId: { type: 'string', required: true }, summary: { type: 'string', required: true }, status: { type: 'string', const: 'awaiting-human-confirmation', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Draft ${value.draftId}: ${value.summary}\nAwaiting human confirmation.` }],
    },
    execute: async (args, exec) => {
      const parsed = chatProposalSchema.parse(args)
      const agent = exec.agent
      const host = agent === undefined ? undefined : hosts(agent)
      const id = agent === undefined ? undefined : host?.agentIdFor(agent)
      if (agent === undefined || host === undefined || id === undefined) throw new Error('Workspace proposal caller is not an active employee.')
      const employees = host.snapshot().agents
      if (!Object.hasOwn(employees, id) || employees[id]?.employmentStatus !== 'employed') throw new Error('Workspace proposal caller is not an active employee.')
      return await host.runNewOperation(() => host.proposeTask(agent, parsed, exec.signal))
    },
  })
  const remove = registry.register(definition)
  let disposed = false
  return () => { if (!disposed) { disposed = true; remove() } }
}
