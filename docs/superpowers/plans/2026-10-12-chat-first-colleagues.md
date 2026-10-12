# 聊天与同事中心交互修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复用户列出的九项问题，让聊天产生工作、具体同事拥有工作与记忆，并提供真实的撤回遗忘和可选安全文件恢复。

**Architecture:** 保持 Cordis Host 与 React Browser 现有连接。身份展示修改沿用现有 aggregate 字段；新增通信、来源、失效和文件检查点数据放入版本化后继记录，不修改已发布持久化类型的含义。Browser 共用身份入口与选择状态；遗忘通过组织操作屏障、运行结束和全新会话完成。

**Tech Stack:** TypeScript、Cordis、DSH 0.2.0-rc.2、React 18、Zod、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-12-chat-first-colleagues-design.md`

## Global Constraints

- 支持范围保持 `>=0.2.0-rc.2 <0.2.1-0`，不修改 DSH 核心或另起服务器。
- 任务只能通过聊天消息产生；普通 @ 不产生工作分配权限，正式交办只投递一次。
- 在职、离职两种任职状态；运行状态独立；具名同事使用统一个人记忆。
- 旧格式、旧导出器及 fixture 保留；后继格式不伪造历史来源，不导出或恢复旧 Session 内容。
- UI 文案通过中文、英文 typed dictionaries；被撤回内容不得重新进入插件控制的模型输入。
- 用户负责效果验收，开发者负责技术方案与执行分工；直接在现有隔离分支内联实施，配额允许时加入独立审查。
- 保留前轮未提交 UI 调整和本机资料；不发布、不 push、不打 tag、不在用户数据中发起测试模型任务。

## Review Focus

- 改名后旧消息的 @ 仍绑定原同事，不把相同显示名解释成另一个人。
- 窄屏、长中文姓名、长消息及 Markdown 代码块不造成操作溢出或误识别提及。
- 重试、刷新和双击交办不重复建立任务或投递。
- 撤回与旧工具提交、子结果、停止失败并发时，失效内容不能进入新会话。
- 文件已有人工改动、并行同事改动或链接时，不被恢复操作静默覆盖。

---

### Task 1: 群聊与同事重命名

**Files:** Modify `packages/host/src/types.ts`, `state.ts`, `rpc.ts`, `runtime.ts`, `workspace-runtime.ts`, Host README; `packages/web/src/client/contracts.ts`, `api.ts`; test `tests/state.spec.ts`, `workspace-rpc.spec.ts`, `workspace-organizations-api.spec.ts`, `runtime.spec.ts`。

**Interfaces:** Produces aggregate commands `{type:'room/rename', roomId, name}`、`{type:'agent/rename', agentId, name}` and Browser `renameRoom(roomId, name, expectedRevision, signal?)`, `renameAgent(agentId, name, expectedRevision, signal?)`, each returns `Promise<WorkspaceSnapshot>`; no new historical event discriminator.

- [x] 写测试：群名、姓名更新且身份、成员、记忆、角色版本不变；空名、姓名碰撞、私聊独立重命名拒绝；状态严格读取通过，持久化沿用通用 CAS 路径。
- [x] 运行 `pnpm test tests/state.spec.ts tests/workspace-rpc.spec.ts tests/workspace-organizations-api.spec.ts --maxWorkers=4`，新增七项行为 FAIL；同岗位版本提示词刷新单测 FAIL。
- [x] 实现命令、严格 RPC 解析和 Browser 返回验证，名称 trim，姓名按现有碰撞规则比较；常驻身份提示词在 idle 后刷新。
- [x] focused 四文件 203/203 PASS；`pnpm typecheck` PASS；全套 1171/1171 PASS；文档写明身份不变。
- [x] 精确提交本任务改动并记录验证，不包含前轮无关 UI 改动。

### Task 2: 聊天气泡、成员操作和统一身份详情

**Files:** Modify `WorkspaceUi.tsx`, `store.ts`, `styles.ts`, `locales.ts`, `view-model.ts`; create `WorkspaceColleagueProfile.tsx`, `WorkspaceChatMessage.tsx`; test `workspace-view.spec.ts`, `workspace-organizations-dom.spec.ts`, `workspace-layout.spec.ts`, new `workspace-chat-dom.spec.ts`。

**Interfaces:** Shared UI `selectedAgentId?: AgentId` and `selectAgent(agentId)`; `WorkspaceColleagueProfile` consumes snapshot, agentId, API, t and navigation callbacks. `WorkspaceChatMessage` consumes persisted event and an identity-opening callback; recognized mentions remain tied to event.mentions.

- [x] DOM 测试点击作者、头像、@ 与成员身份打开同一人；群标题能保存名称；姓名修改不改岗位；长姓名按钮可达；代码块、邮箱不变为提及；名称冲突不改变路由。
- [x] 运行新增 DOM 测试，预期 FAIL；将它加入 browser-source Vitest project。
- [x] 拆出身份详情与消息组件，保留 Markdown renderer；职责优先、历史折叠；岗位管理作为辅助入口；输入操作支持键盘和窄屏。
- [x] 同一 DOM 测试 PASS；`pnpm verify:client-copy`、`pnpm typecheck` PASS。
- [ ] 更新 web README、提交与记录验证。

### Task 3: 后继通信数据、来源与失效读取

**Files:** Create `communication-contract.ts`, `communication-schema.ts`, `communication.ts`; modify `workspace-record.ts`, `workspace-directory.ts`, `workspace-portable.ts`, `workspace-runtime.ts`, Browser `contracts.ts`, `api.ts`; create focused record/import tests。

**Interfaces:** `CommunicationState` contains message metadata, task/draft chat sources, input dependencies, context-reset operations and file checkpoint metadata. `ChatSource` is `{roomId:RoomId,eventId:WorkspaceEventId}`; new record version 3 and portable version 4 preserve predecessor producers. `effectiveWorkspaceState(state, communication): WorkspaceState` excludes withdrawn/invalidated inputs without deleting raw audit history.

- [ ] 写读写与恢复测试：旧记录空元数据升级，新记录往返；旧导出器输出不变；撤回及未完成重建保留；导入无旧 Session 绑定、无任务执行。
- [ ] 运行 focused record/import tests，预期 FAIL。
- [ ] 实现严格后继读写及 communication relationship validation；原始 aggregate 与有效读取分开，任何模型输入或工作应用共用失效规则。
- [ ] 同一测试 PASS；`pnpm typecheck` PASS；记录数据变更约束与升级说明。
- [ ] 提交与记录验证。

### Task 4: 聊天交办、待确认工作卡和个人工作总览

**Files:** Modify Host `workflow.ts`, `workflow-tools.ts`, `workflow-rpc.ts`, `task-tools.ts`, `workspace-runtime.ts`; Browser `WorkspaceUi.tsx`, `WorkspaceTasks.tsx`, `WorkspaceWorkflow.tsx`, `workflow-api.ts`, `workflow-view-model.ts`, `locales.ts`; focused workflow/delivery/DOM tests。

**Interfaces:** Human chat assignment accepts room, full brief, named assignee and explicit default-off delegation permission; atomically records source message and confirmed work before one delivery. All new tasks and drafts require persisted ChatSource; historical records remain source-missing. Work navigation callback selects source room/event, not a new creation form.

- [ ] 行为测试普通发送不分配、交办一次投递、明确负责人、重试不重复；提议确认才执行；同事委派检查 grant 并记录真实聊天来源；本人待办不再执行一轮；模板带入聊天。
- [ ] 运行 focused workflow/delivery tests，预期 FAIL。
- [ ] 实现统一来源条件及聊天待确认卡，工作页按同事只读汇总、来源跳转与状态操作；移除独立创建表单但保留历史资料。
- [ ] focused workflow tests 和 DOM tests PASS；keyless composed model input fixture 包含完整聊天指令。
- [ ] 更新 README、提交与记录验证。

### Task 5: 撤回、停止与全新上下文重建

**Files:** Create `message-recall.ts`; modify `workspace-runtime.ts`, `runtime.ts`, `memory.ts`, `memory-query.ts`, `memory-tools.ts`, `delivery-memory.ts`, `dispatcher.ts`, task delivery paths, communication RPC and Browser recall dialog; focused race/restart/model-input tests。

**Interfaces:** Preview returns named affected colleagues, invalidated replies/work and reset status. Confirm records revocation and admission/output fencing atomically, awaits disposal/children/queued work, binds unseeded sessions, then marks completion. Retry same operation is idempotent; failures retain blocked old input. Historical unknown dependencies use the spec's conservative organization-wide reset.

- [ ] 测试已读唯一标记从下一次真实模型请求、memory tool、工作重试和旧结果确认中消失；未读、处理中、工具待提交、子结果和停止失败用 barrier 放置竞态。
- [ ] focused recall tests FAIL。
- [ ] 实现共享失效读取、代次与原子提交检查、持久重建恢复；UI 可撤回自身消息，显示真实影响、进行中和失败重试。
- [ ] focused tests PASS；keyless profile fixture 验证真实模型输入与新 Session；重启/导入不恢复旧内容。
- [ ] 更新 README、提交与记录验证。

### Task 6: 可选文件恢复检查点

**Files:** Create Host `file-checkpoints.ts`, `file-checkpoint-tools.ts`; wire plugin effects and communication metadata; add Browser file preview to recall dialog; test `file-checkpoints.spec.ts` with private temporary roots。

**Interfaces:** Checkpoint journal observes first-party file mutations, associates managed runs and captures before/after bytes. Preview classifies restorable/conflict/unavailable; restore compares current bytes before each mutation, keeps recovery copy, returns per-file result independently of memory-reset result. Deployment file/byte limits are validated config, not hidden tunables.

- [ ] 测试恢复已有未提交内容、删除未被再改的新文件；人工和其他同事改动保留；越界、链接、超限、不明 shell 改动、历史无检查点不可自动恢复；部分成功正确显示。
- [ ] 运行 `pnpm test tests/file-checkpoints.spec.ts --maxWorkers=4`，预期 FAIL。
- [ ] 实现 managed tool hooks 和安全 journal，任意未跟踪 shell 效果不冒充可信检查点；确认界面默认不勾选文件恢复。
- [ ] 同一测试 PASS，真实临时工作区 composed tool fixture 检查文件字节与冲突；类型与文案检查 PASS。
- [ ] 更新 README、提交与记录验证。

### Task 7: 个人记忆交互与整体验收

**Files:** Modify `WorkspaceMemory.tsx`, `memory-view-model.ts`, `locales.ts`, navigation wiring, `tests/e2e/workspace-browser.mjs`, `tests/fixtures/browser/*`; add verification report。

**Interfaces:** Shared selectedAgentId feeds profile/work/memory; keyword, human categories and named sources use complete effective-memory query with stable pagination. Summary is a true text excerpt, technical history expands separately.

- [ ] DOM 测试 owner 保持、中文事件名、搜索超过首屏、分页去重、来源短名、全文展开；运行预期 FAIL。
- [ ] 实现 owner-first 记忆，统一跨页入口和空态，不虚构知识摘要。
- [ ] focused tests PASS；`pnpm test --maxWorkers=4`、`pnpm typecheck`、`pnpm verify:client-copy`、`pnpm build` PASS；packed keyless browser smoke PASS。
- [ ] 独立审查配额允许时执行；否则单独自审并明确限制。浏览器检查九项、深浅色、窄屏和键盘；测试数据使用隔离组织与临时工作区。
- [ ] 先备份本机插件与组织资料，安装未发布产物、启动本机 DSH；不向用户已有同事投递测试任务。验收报告逐项记录证据，用户检查前不宣称其主观体验已获认可。
