import type * as Host from '../../packages/host/src/workflow-contract.ts'
import type * as Browser from '../../packages/web/src/client/workflow-contracts.ts'
import type { WorkspaceWorkflowApi } from '../../packages/web/src/client/workflow-api.ts'
declare const snapshot: Host.WorkflowSnapshot
declare const commands: Host.WorkflowCommandMap
declare const receipts: Host.WorkflowMutationValueMap
declare const preview: Host.CompanyTemplatePreview
const browserSnapshot: Browser.WorkflowSnapshot = snapshot
const browserCommands: Browser.WorkflowCommandMap = commands
const browserReceipts: Browser.WorkflowMutationValueMap = receipts
const browserPreview: Browser.CompanyTemplatePreview = preview
declare const api: WorkspaceWorkflowApi
const expected = { expectedAggregateRevision: 1, expectedWorkflowRevision: 1 }
// @ts-expect-error Caller cannot choose unrelated payload fields.
void api.mutate('workflow/draft/confirm', { templateId: 'template' }, expected, 'op')
// @ts-expect-error Human actor belongs to the Host.
void api.mutate('workflow/draft/create', { brief: { title: 'T', instructions: 'I', expectedArtifacts: [], acceptanceCriteria: [] }, actor: 'forged' }, expected, 'op')
// @ts-expect-error Caller cannot select an arbitrary response type.
void api.mutate<{ forged: true }>('workflow/draft/discard', { draftId: 'draft', expectedDraftRevision: 0 }, expected, 'op')
// @ts-expect-error Company confirmation requires the explicit new-events memory start.
void api.mutate('workflow/company-template/confirm', { templateRevisionId: 'r', confirmed: true, memoryStart: { type: 'event-range' } }, expected, 'op')
void [browserSnapshot, browserCommands, browserReceipts, browserPreview]
