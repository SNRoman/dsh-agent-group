/** Storage-domain declaration for the Workspace aggregate. */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from './ids.ts'
import type { WorkspaceState } from './types.ts'
import { workspaceStateSchema } from './workspace-state-schema.ts'

export { workspaceStateSchema } from './workspace-state-schema.ts'

/** One-table storage declaration: every workspace mutation replaces its aggregate atomically. */
export const agentWorkspaceSpec = defineDomain({
  name: 'agent_workspace',
  version: 0,
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceState>(workspaceStateSchema) },
})
