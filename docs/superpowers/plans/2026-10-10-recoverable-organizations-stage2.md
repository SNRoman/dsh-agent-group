# 可恢复组织（第二阶段 B/C）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成多组织、旧数据升级、归档/重新打开及人类确认的导入导出，验证后提交第二阶段，再推进第三阶段公司工作流。

**Architecture:** 沿用已批准的 [可恢复组织设计](../specs/2026-09-02-v0.3.0-compatibility-foundation-design.md)，不实现该旧设计中的外部扩展 API。保留纯 WorkspaceState 与冻结的 forward-v1 生产器，将组织描述和聚合包在同一 versioned record 中；Host 目录派生自表，每组织一个独立运行容器，所有 Browser 请求显式选定组织。人类行为规则、平等权限、个人记忆及既有会话恢复保持不变。

**Tech Stack:** Cordis、DSH 0.2.0-rc.2 storage-domain/agents/Connection、TypeScript、Zod、React、现有 Vitest/Playwright；不新增通用工作流引擎或云服务。

## 任务 1：记录、目录与可携带新组织 ID 的格式

**Files:** 新增 `packages/host/src/workspace-record.ts`, `workspace-directory.ts`, `workspace-portable.ts` 及相应 `tests/workspace-*.spec.ts`；修改 `spec.ts`。旧 aggregate schema、旧 fixtures 和 `forward-export.ts` 保持不变。

```ts
interface WorkspaceRecordV1 {
  readonly recordVersion: 1
  readonly descriptor: WorkspaceDescriptor
  readonly aggregate: WorkspaceState
}
// descriptor: id, label, lifecycle；可选 creation 保存来源/operationId/请求摘要/真实创建时间。
// 表 key、descriptor.id、aggregate.workspaceId 必须一致。
// WorkspaceDirectory 初始化/列举/读取/原子更新聚合/创建/重命名/生命周期变更/导入。
```

- [x] 先写 RED：真实 0.1/0.2 旧文件只包装 local、幂等升级后重启不重写、不虚构创建时间；非法源不写；目录 key、operationId 与跨组织 sessionBindings 冲突拒绝。
- [x] 使用严格 legacy/new union 作为 domain version 0 的读取 schema。启动先验证全部记录，再逐记录原子迁移；目录为空才创建默认 local，不向已有其他组织补造 local。
- [x] 通过 Host 级目录串行队列创建/import；operationId 同记录保存，重复请求返回原组织，相同 operationId 改请求拒绝；写失败后队列仍可继续。重命名与 lifecycle 原子写同记录，聚合内容不丢失。
- [x] 新 formatVersion 2 支持任意合法组织 ID 与标签；导出去除 sessionBindings 和安装 operationId。不修改 v1 格式；通用导入同时接受 v1/v2，复用 A 阶段所有输入预算、RFC 校验、关系验证、unfinished-run 拒绝和消息身份重建。
- [x] 执行 `pnpm exec vitest run tests/workspace-record.spec.ts tests/workspace-directory.spec.ts tests/workspace-portable.spec.ts tests/workspace-import.spec.ts tests/forward-export.spec.ts`；需求审核通过后质量审核。

## 任务 2：独立运行容器及入场/收敛屏障

**Files:** 拆分 `index.ts` 与新增 `workspace-runtime.ts`, `workspace-admission.ts`；修改 task/memory tool 的 Host 解析及 `memory-query.ts` cursor；新增 `tests/workspace-organizations.integration.spec.ts`，扩展相关生命周期测试。

```ts
// ctx.agentWorkspace.forWorkspace(id) -> 固定组织 ID 的旧 service face。
// 每个容器独立 pool/dispatcher/taskDelivery/trackers/activity/childControllers。
// reserveOperation 必须先于首次 await；从 durable admission 到完整终态清理都受追踪。
// 目录与 runtime 不读取 Browser 的“当前组织”。
```

- [x] RED：两个组织含相同 agent/room/task ID，状态、工具 caller、Session、stream、direct-room 和 cursor 不串数据；伪造/已撤销 Agent 不被承认为员工。
- [x] 提取现有员工运行逻辑，固定组织闭包及聚合更新；工具只注册一次，以真实 Agent 对象匹配组织容器，不信任参数中的组织/员工身份。
- [x] 所有人类新 mutation/任务/房间 dispatch/子运行入场先取得 reservation；全链完成、结果落盘、Session flush/hide、child dispose 后释放。内部终态写入不受归档封锁。
- [x] 归档关闭新入场并原子落盘 archived；失败恢复入场且不 abort。stop 模式移除 exact queued messages、停止 exact turns 和 children、阻止后续房间 hop；wait 模式仅排空已入场工作。完成前等待 reservation/flight 真正收敛；不得用裸 whenIdle 代替。
- [x] 重新打开拒绝仍未收敛的归档；导出独占短期入场屏障，忙时拒绝，无新入场且无 pending/running durable work 时捕获一个 revision。启动保留既有 orphan-child 显式终态修复行为。
- [x] 跑 Host 相关定向测试与真实 storage restart；独立需求/质量审核，修复竞态。

## 任务 3：显式作用域 RPC 与可操作恢复页面

**Files:** 新增 `organization-rpc.ts` 与 Browser `WorkspaceOrganizations.tsx`；修改 `web-rpc.ts`, Browser `api.ts`, `contracts.ts`, `store.ts`, `index.ts`, locale/CSS；扩展 RPC、DOM 和 Browser smoke。

```ts
// directory/list/create/import-preview/import-confirm 不隐式选择 local。
// 其余 endpoint 的 payload 必须有 workspaceId，路由至 forWorkspace(id)。
// Browser 根 API 列目录，immutable scoped API 绑定 workspaceId。
// import-confirm 携带 operationId、文件内容、可修改标签及 confirmed:true；重新验证再写。
```

- [x] RED：省略/错误组织 ID 不操作 local，范围内实体不存在则失败；导入预览不写、确认只新增、重复确认不重复创建、坏文件不写；归档只读。
- [x] 页面提供创建、改名、切换、归档 stop/wait、重新打开；导出敏感历史警告及下载，文件导入验证预览、标签修改与明确确认。预览展示源版本、计数及已剥离绑定。
- [x] 切换时 abort 旧订阅和刷新、清除选择/stream/草稿；跨组织不同 revision 不做错误大小比较，旧异步响应不得写回新选中组织。所有文案走中英文 typed locale。
- [x] 页面沿用当前 UI 样式与 DSH 渲染；不替换 DSH 核心布局，不添加第二 HTTP server，不自动调用模型。
- [x] 跑 Browser source/DOM/locale/RPC 定向测试，构建全部包、typecheck、verify:client-copy，真实 assembled Browser 走创建→切换→归档→导出→恢复→重启→继续工作。

## 任务 4：阶段验收与提交

- [x] 更新 README/Host/Web 使用说明，区别开发源代码与已发布 0.4.0；保留旧兼容范围，不自动拓宽。
- [x] 定向验证阶段 2 新增路径及旧协作/任务/记忆回归，记录命令、数量与未覆盖项；最终独立审核无 Critical/Important。
- [x] `git diff --check`、显式 staging、`git diff --cached --check`，本地提交第二阶段；不 push/tag/publish，不修改用户运行数据。
- [ ] 再制定并执行第三阶段任务草案/模板/交接/产物/人类审核闭环，保持明确人类指派和现有 DelegationGrant 授权。
