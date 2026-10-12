/** Storage-domain declaration for the Workspace aggregate. */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from './ids.ts'
import type { StoredWorkspace } from './workspace-record.ts'
import { storedWorkspaceSchema } from './workspace-record.ts'

export { workspaceStateSchema } from './workspace-state-schema.ts'

/** One-table storage declaration: successor records commit aggregate and workflow atomically. */
export const agentWorkspaceSpec = defineDomain({
  name: 'agent_workspace',
  version: 0,
  tables: { workspaces: domainTable<WorkspaceId, StoredWorkspace>(storedWorkspaceSchema) },
})
