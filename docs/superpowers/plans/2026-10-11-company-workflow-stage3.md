# Company Workflow Stage 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有独立组织内实现可恢复的草案、明确人类指派、完整 brief 投递、任务/公司模板、精确结果产物审核与交接闭环。

**Architecture:** 在冻结聚合旁新增 workflow，并由同一 record 的原子更新保存两者。先稳定纯类型、域函数和 record/portable，再由 Host 与 Browser 分别实现独占文件；执行与恢复复用第二阶段 admission、员工身份和投递协调器。

**Tech Stack:** 现有 TypeScript ESM、Zod、Cordis、DSH storage-domain、React、Vitest/jsdom、packed DSH Browser Playwright 场景；不新增依赖体系或服务。

**Spec:** [第三阶段设计](../specs/2026-10-11-company-workflow-stage3-design.md)。执行前同时阅读该文件、[架构](../../architecture.md)和[第二阶段收尾](2026-10-11-stage2-teardown-closure.md)。用户已委托技术方案与完整实现；本计划不增加技术审批步骤。

## Global Constraints

- 冻结 `WorkspaceState`、其 schema、已发布 fixtures 和 forward-v1 生产器；不向旧聚合添加字段或事件。
- 使用后继 `WorkspaceRecordV2 { recordVersion: 2, descriptor, aggregate, workflow }`；新增 portable `formatVersion: 3`，v1/v2 仍可导入并补空 workflow。
- 不实现通用图形工作流引擎、自动接单、自动授权、跨组织自动协作、云服务、文件上传或产物真实性扫描；不 push、tag 或 publish。
- 公司配置模板是在当前组织内建立配置，不自动创建另一个组织；不复制历史、Session、任务或授权，不唤醒员工。
- 人类确认必须明确选定仍在职的负责人；员工只能通过真实 Agent 认证提议草案。人类、可信员工身份和时间由 Host 提供，不接受 RPC/model payload 的 actor、组织替代字段或时间。
- 岗位修订、在职/离职、被 @ 才响应、平等模型/工具/技能权限与统一个人记忆规则继续生效。
- 所有操作绑定 immutable workspace API，RPC payload 显式 `workspaceId`；写请求携带 aggregate/workflow 两个 revision，归档组织只读。
- 所有产品文案属于 typed `zh-CN`/`en-US` locale；文件使用 UTF-8、apply_patch、恰好一个尾换行。
- 以第二阶段最终本地提交为基线。`index.ts`、`workspace-runtime.ts`、`runtime.ts` 和第二阶段 integration tests 在收尾提交前只读；第三阶段 Host wiring 必须等该提交，不能覆盖进行中的修复。
- 本轮计划作者只新增本计划和 `.superpowers/sdd/stage3-contract-notes.md`；实现者按下表独占文件，root 统一验收和本地提交。

## Review Focus

- 相同内部 ID 出现在两个组织、`__proto__`/继承属性及错误 result attempt：只在当前 record 自有属性和精确结果中查找，拒绝伪造关系（Task 1/2）。
- 确认提交后 crash、请求断开或旧 CAS retry：返回同一任务，重复 operation 不启动投递；未投递任务需明确 retry（Task 2/3）。
- 岗位后来修订、模板后来修订、结果后来新增：固定已经选定的 revision/brief/result，旧接受不覆盖新结果（Task 1/4）。
- 同事创建中途失败、取消发生于排队/提交前、teardown 与提交后投递相遇：无半个配置，已提交业务保持提交，完整 admission 保留到 cleanup（Task 2/3）。
- 切换/关闭后旧 snapshot、mutation、preview 晚到：取消旧请求且隔离旧 generation；当前组织不能展示其他组织的工作流（Task 4）。

## File Ownership and Dependencies

| Owner/task | Exclusive implementation files | Depends on |
| --- | --- | --- |
| Foundation / Task 1 | `packages/host/src/workflow-contract.ts`, `workflow.ts`, `workflow-schema.ts`; `tests/workflow.spec.ts` | Design and final contract below |
| Foundation / Task 2 | `workspace-record.ts`, `workspace-directory.ts`, `workspace-portable.ts`, `workspace-import.ts`, `spec.ts`, `packages/host/package.json`; `index.ts`/`organization-rpc.ts` 仅 V2 返回类型迁移及根导出切换 V3；`tests/workflow-storage.spec.ts`, existing record/directory/portable/import tests | Task 1 |
| Host / Task 3 | `workspace-runtime.ts`, `index.ts`, `rpc.ts`, `organization-rpc.ts`, new `workflow-rpc.ts`, `workflow-tools.ts`, `workflow-delivery.ts`, `task-delivery-coordinator.ts`; `tests/workflow-runtime.spec.ts`, `workflow-rpc.spec.ts`, `workflow-tools.spec.ts`, `workflow-delivery.spec.ts` | Tasks 1/2 and final stage-2 commit |
| Browser / Task 4 | `packages/web/src/client/workflow-contracts.ts`, `workflow-api.ts`, `workflow-view-model.ts`, `WorkspaceWorkflow.tsx`, `WorkspaceTasks.tsx`, `locales.ts`, `styles.ts`, `api.ts`, `packages/web/package.json`; new workflow API/view/DOM tests and `tests/types/workspace-workflow.ts`, type tsconfig | Tasks 1/2 exported contracts; runs parallel with Task 3 |
| Integration / Task 5 | 专项 worker 独占 `tests/e2e/workspace-browser.mjs`, `tests/fixtures/browser/scripted-llm.ts`, `tests/fixtures/browser/task-tools-profile.ts`, `scripts/release-smoke*.mjs`（仅必要验收接线）；root 负责 READMEs、架构、e2e README、验证记录和提交 | Tasks 3/4 |

No simultaneous edits of a file: Task 2 publishes its atomic-directory checkpoint before Task 3. Browser may implement mirrors/API/DOM after the stable Task 1 type checkpoint, but its final typecheck/build waits for Task 2 leaf exports and declarations. Host owns transport/service changes; Browser owns only its mirror/API/component files. Test fixture changes wait for integration. Root owns commits and reviews; task workers report focused verification without committing. New files are per responsibility, not a second framework; keep the pure workflow implementation together until its size requires a local split.

## Stable Exported Contracts

`packages/host/src/workflow-contract.ts` contains only types and type imports; add the `@dsh-agent-group/host/workflow-contract` leaf export pointing to `lib/types/workflow-contract.d.ts` and its ESM `.js`. It must not import Cordis, Node or Host entrypoints at runtime. Browser uses the leaf for shared ID-free `TaskBrief`/`ArtifactReference` type imports; its `workflow-contracts.ts` mirrors ID-bearing JSON types with string IDs, as current aggregate contracts do. Add a web devDependency on Host via `workspace:*` and compile the Host declarations before Client verification. Compile fixtures prove Host→Browser assignability and reject invalid endpoint/payload combinations; the client bundle check proves no Host/Node runtime import. Do not drag Host source files through the Client `rootDir`.

All new durable IDs are branded: `TaskDraftId`, `TaskTemplateId`, `TaskTemplateRevisionId`, `CompanyTemplateId`, `CompanyTemplateRevisionId`, `TaskArtifactId`, `TaskReviewId`, `WorkflowFactId`, `WorkflowOperationId`. Brand constructors live beside the pure domain/schema implementation; existing Agent/Task/Attempt/Event/DefinitionRevision IDs retain their existing brands.

```ts
interface TaskBrief {
  readonly title: string
  readonly instructions: string
  readonly expectedArtifacts: readonly string[]
  readonly acceptanceCriteria: readonly string[]
}
type ArtifactReference =
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'url'; readonly value: string }
interface TaskResultReference {
  readonly taskId: TaskId
  readonly eventId: WorkspaceEventId
  readonly attemptId: TaskDeliveryAttemptId
}
interface WorkflowExpectedRevisions {
  readonly expectedAggregateRevision: number
  readonly expectedWorkflowRevision: number
}
interface WorkflowSnapshot {
  readonly workspaceId: WorkspaceId
  readonly aggregateRevision: number
  readonly workflow: WorkflowState
}
interface WorkflowMutationResult<Value> {
  readonly workspaceId: WorkspaceId
  readonly aggregateRevision: number
  readonly workflowRevision: number
  readonly value: Value
  readonly replayed: boolean
}
```

`WorkflowState` has `revision`, `nextId`, `nextSequence`, `drafts`, `taskTemplates`, `taskTemplateRevisions`, `companyTemplates`, `companyTemplateRevisions`, `taskBriefs`, `artifacts`, `reviews`, `operations`, and `facts`. Empty revision is 0, counters start at 1, maps/arrays are empty. Own map keys must equal entity IDs; taskBriefs keys equal TaskId. `facts` is append-only, typed, ID/sequence ordered, and records Host actor and canonical `occurredAt`. Every accepted new operation advances workflow revision once; identical retries advance neither revision nor counters and append no facts. A draft edit advances its own revision once; confirmed/discarded drafts cannot be edited. Existing aggregate revision semantics remain those of reused domain functions, even when several commands share one atomic record update.

Brief title/instructions, template names, artifact label/summary and array entries are nonblank after trimming; empty expectedArtifacts/acceptanceCriteria arrays are valid. Review comment is a string and may be empty for acceptance; changes-requested requires nonblank comment. Facts use the command's exact endpoint discriminator, immutable command/receipt copies and Host actor; employee proposals use `workflow/employee/proposed` with the proposal request. Durable relationship validation does not require historical employee actors/suggested assignees to remain employed: employment is checked for a new proposal or confirmation, never used to invalidate history after departure.

- `TaskDraft`: `id`, `revision` (initial 0), `status`, immutable `source`, editable `brief`, optional `suggestedAssigneeAgentId`, optional `templateRevisionId`, copied `handoff` context, optional confirmed `taskId`. `source` is a tagged union of human/employee (`id`), handoff (`result`, selected `artifactIds`), or changes-requested (`result`, `reviewId`). No caller chooses source/actor tags.
- Task/company template roots: `id`, `name`, `revisionIds`, `currentRevisionId`; immutable revisions: `id`, `templateId`, `number` (initial 1), and `brief` or `config`. `CompanyTemplateConfig` is `colleagues: readonly {name, definitionRevisionId}[]` and `groups: readonly {name, memberNames: readonly string[]}[]`; empty groups is valid. Trim names, reject blank/duplicate colleague names and unknown/duplicate membership names before submission. Groups refer only to this template's new colleagues. Use existing role revision storage, not copied instructions.
- `ConfirmedTaskBrief`: `taskId`, `draftId`, copied `brief`, copied optional template revision and handoff context. Handoff context is exact source result text/type/reference plus selected artifact snapshots (`id`, `label`, `summary`, optional reference). No later source/template edit changes it.
- `TaskArtifact`: `id`, exact `result`, `label`, `summary`, optional `reference`. Append-only registration; path strings are inert, URL references must parse as HTTP(S). Never read, execute or fetch a reference.
- `TaskReview`: `id`, exact `result`, `decision: 'accepted' | 'changes-requested'`, `comment`, optional `draftId`. Changes-requested creates its draft in the same operation; acceptance never changes aggregate completion or a newer result's review.
- `WorkflowOperation`: `id`, SHA-256 `requestDigest`, the typed stable receipt, aggregate/workflow revisions at commitment. Hash Host actor plus normalized semantic command; exclude transport CAS revisions and signal/time. Target `expectedDraftRevision` stays part of the semantic confirmation/edit command. A changed command with the same ID rejects. Imported operations and receipts remain valid internal history.

`WorkflowCommandMap` and `WorkflowMutationValueMap` key by the endpoints in the following table; `WorkflowCommand<K>` is the endpoint payload plus `type: K`. Write transport is `{workspaceId, operationId, expectedAggregateRevision, expectedWorkflowRevision, ...payload}`; strict parsing rejects extra actor/time/source fields. Result transport is `WorkflowMutationResult<WorkflowMutationValueMap[K]>`, wrapped by the current RPC success/error envelope.

| Endpoint | Payload excluding common fields | Receipt value |
| --- | --- | --- |
| `workflow/draft/create` | `brief`, optional `suggestedAssigneeAgentId` | `{draftId}` |
| `workflow/draft/edit` | `draftId`, `expectedDraftRevision`, `brief`, optional `suggestedAssigneeAgentId` | `{draftId}` |
| `workflow/draft/discard` | `draftId`, `expectedDraftRevision` | `{draftId}` |
| `workflow/draft/confirm` | `draftId`, `expectedDraftRevision`, `assigneeAgentId` | `{draftId, taskId, taskAssignmentId}` |
| `workflow/task-template/create` | `name`, `brief` | `{templateId, templateRevisionId}` |
| `workflow/task-template/revise` | `templateId`, `brief` | `{templateId, templateRevisionId}` |
| `workflow/task-template/apply` | `templateRevisionId`, optional `suggestedAssigneeAgentId` | `{draftId}` |
| `workflow/company-template/create` | `name`, `config` | `{templateId, templateRevisionId}` |
| `workflow/company-template/revise` | `templateId`, `config` | `{templateId, templateRevisionId}` |
| `workflow/company-template/confirm` | `templateRevisionId`, `confirmed: true`, `memoryStart: {type:'new-events'}` | `{agentIds, roomIds, membershipIds}` |
| `workflow/artifact/register` | `result`, `label`, `summary`, optional `reference` | `{artifactId}` |
| `workflow/result/review` | `result`, `decision`, `comment` | `{reviewId}`, plus `draftId` only for changes-requested |
| `workflow/result/handoff` | `result`, explicit `artifactIds`, optional `suggestedAssigneeAgentId` | `{draftId}` |

Reads: `workflow/snapshot` takes only workspaceId and returns `WorkflowSnapshot`; `workflow/company-template/preview` takes workspaceId, both expected revisions and `templateRevisionId`, returns `CompanyTemplatePreview {workspaceId, aggregateRevision, workflowRevision, templateRevisionId, config}`. Preview performs the same reference checks, writes nothing, does not reserve IDs, and cannot serve as implicit confirmation. Confirm revalidates the current record. All other writes above are human-only; employee creation uses the separate internal function below.

```ts
createInitialWorkflowState(): WorkflowState
assertWorkflowInvariants(aggregate: WorkspaceState, workflow: WorkflowState): void
applyWorkflowCommand<K extends WorkflowEndpoint>(
  input: {readonly aggregate: WorkspaceState; readonly workflow: WorkflowState},
  command: WorkflowCommand<K>,
  context: {readonly humanId: HumanId; readonly occurredAt: string},
): WorkflowTransition<WorkflowMutationValueMap[K]>
proposeWorkflowDraft(
  input: {readonly aggregate: WorkspaceState; readonly workflow: WorkflowState},
  request: {readonly brief: TaskBrief; readonly suggestedAssigneeAgentId?: AgentId},
  context: {readonly agentId: AgentId; readonly occurredAt: string},
): WorkflowTransition<{readonly draftId: TaskDraftId}>
previewCompanyTemplate(
  aggregate: WorkspaceState, workflow: WorkflowState,
  templateRevisionId: CompanyTemplateRevisionId,
): CompanyTemplateConfig
renderWorkflowTaskInstructions(confirmed: ConfirmedTaskBrief): string
```

`WorkflowTransition<Value>` is `{aggregate, workflow, value, deliveryTaskId?: TaskId}`. Only a newly confirmed draft has `deliveryTaskId`; the pure function never delivers or persists. Operation digest/receipt recording and CAS belong to the directory, not the pure transition. `workflowStateSchema` validates strict durable fields; `assertWorkflowInvariants` validates all own-property references against the same record, facts/counters, immutable revision ownership, confirmed task/assignment/brief agreement, exact result and selected artifacts/reviews, and operation receipt references.

For existing tasks without third-stage metadata, a human changes-requested/handoff draft copies `{title: task.title, instructions: task.title, expectedArtifacts: [], acceptanceCriteria: []}`; existing delivered messages remain byte-for-byte title-only. Source result context and review comment accompany that copied brief; unselected artifacts never accompany it.

### Task 1: Pure Workflow and Shared Contracts

**Interfaces:** Produces all contracts/functions above and `workflowStateSchema`. Consumes existing `assignHumanTask`, `mutateWorkspace`, `joinRoomWithMemory`, branded IDs and existing aggregate/result types. No frozen files change.

- [x] Write `tests/workflow.spec.ts` tests named `drafts never assign or grant`, `confirmed brief is detached`, `template revision stays pinned`, `company configuration is atomic`, `reviews select exact result`, `handoff copies only selected artifacts`, `departed proposal is refused`, `relationships use own properties`. Assert zero new task/grant/delivery for create/edit/discard/template apply/propose; confirm yields one root task with title and immutable full brief; preview creates nothing.
- [x] Run `pnpm exec vitest run tests/workflow.spec.ts` and record RED before implementation.
- [x] Implement contracts, strict schema and pure domain with the exact signatures. Reuse task assignment, agent creation, definition synchronization to the selected immutable revision, group creation and new-events joining. Never materialize a colleague. Validate the full configuration before applying commands to a detached candidate; any failure returns no candidate. Result lookup requires matching event `id`, `taskId`, `taskDeliveryAttemptId` and result event type.
- [x] Implement deterministic rendering as title, `Instructions`, `Expected artifacts`, `Acceptance criteria`, then optional `Handoff context`, in that fixed order. Join array items with newline `- `; include exact source result text and selected artifact labels/summaries/references. Render from persisted confirmed data only, with no locale/time/network input; commit a golden expected string in the delivery test. Model-facing sections use stable English. Legacy title-only text is unchanged.
- [x] Run the focused test GREEN; self-review references/immutable snapshots and publish the stable API checkpoint to Tasks 2–4. Do not commit individually.

### Task 2: Record V2, Atomic CAS, Migration and Portable V3

**Interfaces:** Preserve `WorkspaceRecordV1`, `workspaceRecordSchema` and `createWorkspaceExportV2` as v1/v2 readers/producers. Add `WorkspaceRecordV2`, `workspaceRecordV2Schema`; widen `StoredWorkspace` to bare/v1/v2. `WorkspaceDirectory.record/create/import/rename/setLifecycle` return V2. Add:

```ts
WorkspaceDirectory.updateRecord<Value>(
  id: WorkspaceId,
  transform: (record: WorkspaceRecordV2) => {readonly record: WorkspaceRecordV2; readonly value: Value},
  signal?: AbortSignal,
): Promise<{readonly record: WorkspaceRecordV2; readonly value: Value}>
WorkspaceDirectory.executeWorkflow<K extends WorkflowEndpoint>(
  id: WorkspaceId,
  request: WorkflowExpectedRevisions & {readonly operationId: WorkflowOperationId; readonly command: WorkflowCommand<K>},
  context: {readonly humanId: HumanId; readonly occurredAt: string},
  signal?: AbortSignal,
): Promise<WorkflowMutationResult<WorkflowMutationValueMap[K]>>
createWorkspaceExportV3(record: WorkspaceRecordV2, metadata: {readonly exportedAt: string}):
  {readonly document: WorkspaceExportDocumentV3; readonly json: string}
prepareWorkspaceImport(json: string, options: {readonly workspaceId: WorkspaceId; readonly limits: WorkspaceImportLimits}):
  PreparedWorkspaceImport // existing fields plus workflow: WorkflowState
```

- [x] Add focused tests for whole-directory validation before any migration write, bare/v1→V2 single-write upgrade, retry after restart, aggregate/descriptor writes preserving workflow, failed backend CAS leaving both planes unchanged, two concurrent confirms yielding one accepted operation, operation mismatch rejection, queue/precommit abort, imported equal internal IDs and bad workflow references. Use real storage fixtures created in tests; committed release fixtures remain unchanged.
- [x] Run `pnpm exec vitest run tests/workflow-storage.spec.ts tests/workspace-record.spec.ts tests/workspace-directory.spec.ts tests/workspace-portable.spec.ts tests/workspace-import.spec.ts` RED.
- [x] Implement migration with empty workflow and no invented facts; validate every table entry and directory-wide Session/creation-operation ownership first. Execute workflow in one `table.update`: check signal, lifecycle, existing operation/digest, then both CAS revisions, transition, receipt, and complete record invariants. Existing identical operation bypasses stale CAS and returns stable receipt with current response revisions and `replayed:true`; do not reassign or reappend. Check queued signal and atomic callback signal; no abort check after durable commit masquerades as rollback.
- [x] Preserve `updateAggregate` metadata/workflow using object replacement of only aggregate, validating the resulting V2. Factor the existing directory queue/replacement validator rather than adding a second transaction queue. Proposal writes use `updateRecord` inside admitted Host operations and revalidate employment in its atomic callback.
- [x] Update existing `index.ts` and `organization-rpc.ts` record-return annotations from V1 to V2 and switch the root export call to `createWorkspaceExportV3`, before publishing the compiled checkpoint. These necessary consumer edits happen sequentially before Task 3 owns the files; do not alter their admission, teardown or RPC behavior. Preserve the frozen V2 producer accepting V1 rather than weakening it to silently omit workflow from a live V2 record.
- [x] Add V3 strict envelope with descriptor/aggregate/workflow, raw-envelope RFC8785 digest and existing input budgets. Reuse `prepareWorkspaceImportWithSchema` with a typed optional projection callback receiving the validated document/source/target state, rather than a second JSON parse or weakening v1 return types. Add workflow entity/fact/operation collection budgeting under existing explicit limits. Preserve workflow IDs, facts, internal references and operation history; replace only organization identity/messageIds, strip Session bindings and creation metadata; validate source and target relationships. V1/V2 prepare `createInitialWorkflowState()`. Keep old producer content/ranges unchanged and document their metadata omission.
- [x] Run the above GREEN and `pnpm build:host`; publish declarations and the stable checkpoint. Host must update `spec.ts` storage parsing but not the frozen aggregate schema. Do not broaden DSH compatibility/version floors or change published generations.

### Task 3: Host Admission, Human RPC, Trusted Proposal and Full Brief Delivery

**Interfaces:** `WorkflowProposalRequest` is `{readonly brief: TaskBrief; readonly suggestedAssigneeAgentId?: AgentId}` and `WorkflowProposalResult` is `{readonly draftId: TaskDraftId; readonly summary: string; readonly status:'awaiting-human-confirmation'}`. `WorkspaceRuntime.workflowSnapshot(): WorkflowSnapshot`; `executeWorkflow<K extends WorkflowEndpoint>(request: WorkflowExpectedRevisions & {readonly operationId: WorkflowOperationId}, command: WorkflowCommand<K>, signal?: AbortSignal): Promise<WorkflowMutationResult<WorkflowMutationValueMap[K]>>`; `previewCompanyTemplate(expected: WorkflowExpectedRevisions, id: CompanyTemplateRevisionId): CompanyTemplatePreview`; `proposeTask(agent: Agent, request: WorkflowProposalRequest, signal?: AbortSignal): Promise<WorkflowProposalResult>`. Add human read/write methods to `WorkspaceRpcService`; keep `proposeTask` on the tool host face only, with no Browser endpoint. Existing explicit `organization-rpc.ts` routing keeps workspaceId ownership. `createWorkflowRpcHandler(service: WorkspaceRpcService): WorkspaceWorkflowRpcHandler` handles only known workflow endpoints and shares existing error/cancellation envelopes. Do not add HTTP servers or transport channels.

- [x] Write tests for authentic live caller success, forged/stale/departed Agent denial, extra actor/workspace/time/source args denial, no proposal confirm/grant endpoints, full brief in Session user/message, commit-before-deliver order, replay-zero-delivery, confirmed-but-never-delivered restart→explicit retry, archived write denial, queue/precommit abort and teardown draining newly committed work. Run `pnpm exec vitest run tests/workflow-runtime.spec.ts tests/workflow-rpc.spec.ts tests/workflow-tools.spec.ts tests/workflow-delivery.spec.ts` RED.
- [x] After final stage-2 commit, wrap mutations/proposals in the existing runtime `runNewOperation`/operation tracking. Human identity is `WEB_WORKSPACE_HUMAN_ID`; only Host creates canonical time. Workflow reads follow stage-2 scoped read lifecycle and remain available for archived records; preview is read-only too. Reject missing/stopping/disposed runtime and archived mutations; validate live Agent ownership again inside the update. `AgentWorkspaceDomainService` resolves tools from the actual published Agent, never current Browser selection.
- [x] Confirm through directory `executeWorkflow`, sync existing activity projection after commit, and for a new confirmation retain `TaskDeliveryCoordinator.deliver(taskId)` under the existing background scope. `replayed:true` must return before any delivery access/start. Do not call runtime `assignTask()` around a separate workflow write. A postcommit delivery failure leaves confirmation durable and reports through existing task failure/retry state. Persist complete receipt before any runtime admission; restore does not silently restart never-delivered confirmations.
- [x] Add `TaskDeliveryCoordinatorHost.taskInstructions?(taskId: TaskId): string | undefined`. In `prepareTaskDelivery`, keep `startTaskDelivery` unchanged, then rebuild/freeze the exact UserMessage with rendered persisted instructions when defined; preserve messageId/sourceEventId/attempt. Root supplies `workflow-delivery.ts` lookup from the current record. Reservation retry and normal delivery therefore use the same rendering; resumed inboxes keep their frozen Session message. Do not modify `task-delivery.ts` or frozen event schemas merely to store a brief.
- [x] `registerWorkspaceWorkflowTools(registry: WorkspaceToolRegistry, hosts: (agent: Agent) => WorkspaceWorkflowToolHost | undefined): () => void` registers only `workspace_propose_task` with strict `{brief, suggestedAssigneeAgentId?}` arguments. Host interface methods are `agentIdFor(agent: Agent): AgentId | undefined`, `snapshot(): WorkspaceState`, the `proposeTask` signature above, and `runNewOperation<Value>(operation:()=>Promise<Value>): Promise<Value>`; model cannot supply actor/organization/operation/CAS/time. Reuse current task tool validation/presentation patterns, ctx.effect disposer ownership, and actual Agent ID resolver. Return only `{draftId, summary: brief.title, status:'awaiting-human-confirmation'}` and concise tool text, with no organization dump. Existing explicit-grant tools remain governed by their existing policy.
- [x] Add `WorkflowBusinessErrorDetailsMap` with `stale-workflow-revision:{expectedWorkflowRevision,actualWorkflowRevision}`, `stale-draft-revision:{draftId,expectedDraftRevision,actualDraftRevision}`, `workflow-operation-reused:{operationId}`, `workflow-reference-invalid:{entityKind,entityId}`, `draft-not-editable:{draftId,status}`, `workflow-read-only:{workspaceId}`. Counter fields are numbers, IDs are strings, status is `confirmed|discarded`. A tagged `WorkflowBusinessError` carries this union; workflow RPC catches it before generic failures. `WorkspaceWorkflowRpcResult` accepts existing errors plus this added business union; known aggregate errors remain existing `WorkspaceBusinessError` values. Extend Browser decoding for this union in `workflow-api.ts`; all details are identifiers/counters, never imported bodies.
- [x] Update Host organization export to V3 and return-type consumers to V2. Run focused tests GREEN, relevant existing coordinator/RPC/task-tool/integration tests, `pnpm build:host`, then `pnpm exec tsc -b tsconfig.host.json`. Report precise commands/results to root, no commit.

### Task 4: Complete Browser Workflow Paths

**Interfaces:** `WorkspaceWorkflowApi` is constructed from immutable scoped `WorkspaceApiClient`; add `callWorkflow(endpoint: WorkflowEndpoint | 'workflow/snapshot' | 'workflow/company-template/preview', payload: Readonly<Record<string,unknown>>, signal?: AbortSignal): Promise<unknown>` to that client. It calls existing Connection/channel with its fixed workspaceId and same cancellation rules, but workflow error decoding is owned by `workflow-api.ts` rather than the old aggregate-only `assertWorkspaceRpcError`. The workflow API owns `snapshot(signal?:AbortSignal): Promise<WorkflowSnapshot>`, `previewCompanyTemplate(id:CompanyTemplateRevisionId, expected:WorkflowExpectedRevisions, signal?:AbortSignal): Promise<CompanyTemplatePreview>`, and `mutate<K extends WorkflowEndpoint>(endpoint:K, payload:WorkflowCommandMap[K], expected:WorkflowExpectedRevisions, operationId:string, signal?:AbortSignal): Promise<WorkflowMutationResult<WorkflowMutationValueMap[K]>>`. Browser endpoints/receipts mirror the stable table, not arbitrary user-selected types. Component props: `{api: WorkspaceApiClient, snapshot: WorkspaceSnapshot, onSnapshot: (value:WorkspaceSnapshot)=>void, t:TranslateNS<'agentWorkspace'>}`. Mount inside existing Tasks and keep task tree/runtime controls. `WorkflowApiError` retains the validated workflow/aggregate error union for localized component handling.

- [x] Add API/type/view/DOM tests for every table endpoint; full draft create/edit/discard/confirm; template create/revise/apply; company template create/revise/preview/confirm with explicit new-events selection; exact result selector, artifact path/url/no reference, accepted and changes-requested, explicit selected-artifact handoff. Include archived readonly, malformed response/actor fields, stale aggregate/workflow/draft errors and operation replay. Run `pnpm exec vitest run tests/workflow-api.spec.ts tests/workflow-view.spec.ts tests/workflow-dom.spec.ts` RED.
- [x] Implement `workflow-contracts.ts` JSON mirror and type fixtures, `workflow-api.ts` strict response parsers, `projectWorkflowResults(snapshot, workflow)` selecting every exact task/result and result-after-cancel event rather than only latest task status. Show result attempt/event identity and cancellation origin; acceptance labels belong to that exact result. Show inert artifact references with localized unverified text; render user text as React text, not HTML.
- [x] Implement `WorkspaceWorkflow` with bounded sections for drafts, templates and result review. No owner auto-selection on confirmation, no permission transfer/grant, no employee wake from preview/application. All mutating controls respect `api.readOnly`, display both stale revisions and offer explicit retry after refreshing. Retain one operationId for an identical retry; changed input uses a new operationId. Do not transparently reapply an old draft confirmation to an edited draft.
- [x] Manage AbortControllers and an API/workspace generation token across snapshot, mutation, preview and aggregate refresh; abort on organization switch, component removal, overlay close and plugin unload. Before applying any result, check generation, expected workspace identity, mounted state and signal. If a write committed before disconnect, refresh to show durable metadata without displaying a false rollback. Do not pair new workflow with an older aggregate: refresh both and retry read when workflow.aggregateRevision is newer; mutation CAS always uses the displayed pair.
- [x] Add typed zh-CN/en-US copy for every label, status, validation/failure, preview, confirmation, unverified-reference and cancellation notice; extend existing styles locally. Run DOM tests GREEN plus `tests/workspace-task-dom.spec.ts`, `tests/workspace-organizations-dom.spec.ts`, locale/API tests, `pnpm verify:client-copy`, `pnpm typecheck`, `pnpm build:web` and client bundle platform regression. No Host runtime edits.

### Task 5: Packed Browser Closure, Documentation, Review and Local Commit

**Interfaces:** Reuses packed DSH profile runner and existing scripted LLM; no new server, cloud dependency or automatic workflow execution. Root owns final docs, whole-plugin verification and commits.

- [x] Extend the existing scripted Browser fixture only with deterministic replies needed for workflow tasks and one real proposal-tool call. Keyless packed flow: draft→edit→confirm→result→register selected/unselected artifacts→changes-requested→explicit assignee/confirm rework→new result→accept→handoff with one selected artifact→confirm. Assert receipt/task IDs, exact review/result attempt IDs, full brief Session input and no unselected reference in successor input. Separately exercise discard, task template immutable revisions and company preview/explicit new-events confirmation; assert no Session/task/grant until a separate human action.
- [x] Add real packed restart and V3 export/import→new organization reads for drafts, template revisions, confirmed briefs, artifacts/reviews/handoff/operations. Assert source unchanged, fresh organization/messageIds, absent Session bindings/source creation metadata, and a new local import creation receipt on commitment; no employee wakes during import. Archive readonly and organization switch isolation must work for workflow as well as stage-2 paths. Keep existing fixture/profile launch and pin-browse overlay when the DSH picker is involved.
- [x] Update root/Host/Web READMEs, architecture and `tests/e2e/README.md` with current behavior, V2 record/V3 portability, old-producer omission, explicit human confirmation and retry, and unverified inert references. Write `docs/verification/2026-10-11-company-workflow-stage3.md` with actual commands, packed evidence and limitations. Do not label old released packages as shipping development metadata.
- [x] Run once after integration: `pnpm release:pack`, which includes `pnpm build`, `pnpm typecheck` (Host/Client/type/browser fixtures), `pnpm verify:client-copy` and `pnpm test` (complete plugin suite requested by spec), then the packed smoke with an isolated profile. Retain that mandatory gate without an extra duplicate preflight or bypass flags. Do not run registry smoke/publish/source compatibility matrix without a relevant need. Preserve reports/receipts from actual packed artifacts.
- [x] Perform independent final review of third-stage diff and spec coverage after integration, resolve findings and rerun only affected checks (packed smoke again only when packed inputs changed). Root verifies frozen files/fixtures/compatibility remain unchanged, `git diff --check`, updates plan checkboxes and commits third stage locally using explicit paths. No push/tag/publish. Report the final local commit and evidence, not merely the plan.

## Plan Self-review

Every design section has an owner: persistence/portability→Task 2, drafts/confirmation/brief delivery→Tasks 1/3/4, employee proposal→Task 3 and packed fixture, immutable task/company templates→Tasks 1/4, exact artifact/review/handoff→Tasks 1/4, communication/admission/cancellation→Tasks 2/3/4, complete packed recovery/docs/review/commit→Task 5. Pure and storage tests cover the five Review Focus rows. No second workflow executor, competing role store, aggregate extension or automatic replay worker is introduced. Host and Browser signatures consume the same endpoint/value table; uncertain stage-2 private method locations are resolved only after its final commit, with public behavior and teardown obligations preserved.
