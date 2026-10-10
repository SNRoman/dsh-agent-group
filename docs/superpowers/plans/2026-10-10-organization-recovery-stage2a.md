# 组织恢复内核实施计划（第二阶段 A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已发布的 forward-v1 文件验证为可创建新组织的完整数据，保留组织经历，剥离旧会话身份；本轮不接入持久写入或恢复页面。

**Architecture:** 复用已批准的 [可恢复组织设计](../specs/2026-09-02-v0.3.0-compatibility-foundation-design.md) 中的导入规则，只实现第一个可独立测试的组件。纯函数接收 JSON、调用方分配的新组织 ID 与显式资源限制，校验后返回脱离输入的恢复候选。既有 forward-v1 格式、生产器及 domain version 0 均不修改。

**Tech Stack:** TypeScript、Zod、现有 canonicalize、Node SHA-256、Vitest；无新依赖。

## 第二阶段路线

1. A：本计划的恢复校验内核及公开叶入口。
2. B：版本化组织记录，旧 local 记录幂等升级；每个组织独立运行容器，所有 RPC、工具身份及订阅显式指定组织。
3. C：创建、命名、切换、归档与重新打开；新增可携带任意组织 ID 的导出格式版本，旧 forward-v1 生产器保持冻结；导出/导入预览、确认、新增写入与幂等重试；干净环境恢复后继续工作。

外部扩展 API、官方 Team 接入、云同步和第三阶段工作流不纳入本轮。

## 任务 1：纯导入内核

**Files:** Create `packages/host/src/workspace-import.ts`, `tests/workspace-import.spec.ts`.

- [x] 用现有 `tests/fixtures/v0.2.0/agent-workspace.json` 和 `createForwardWorkspaceExportV1` 编写 RED 测试；源状态和文件保持不变，候选定义、成员、任职、房间、授权、任务、记忆和计数保留。
- [x] 实现 `prepareWorkspaceImportV1(json, { workspaceId, limits })`。限制为显式正整数 `maxBytes`、`maxEntities`、`maxEvents`、`maxStringBytes`、`maxDepth`，无隐含默认值；UTF-8 大小先于 JSON.parse，迭代检查深度/字符串先于 schema 与 canonicalization。
- [x] 严格校验 v1 envelope、digest 元数据、规范 UTC 时间、聚合 schema 与关系；按 [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) 拒绝重复对象字段与孤立 Unicode 代理字符，允许合法 emoji、转义键、空白与非规范化键顺序。摘要对原始解析的 envelope 计算；在 schema 之前拒绝 `__proto__` 字段，不允许转换时静默丢弃源记录。版本与兼容范围是展示信息而不是授权来源。SHA-256 校验不表示来源可信。错误不打印用户正文。
- [x] 拒绝未终结子运行及 started/accepted 的投递尝试。不修复、不继续执行未完工作。
- [x] 校验源组织后，保留内部事件/实体 ID、序号与文本，将旧 DSH 会话绑定清空。仅将含 `messageId` 的任务投递事件重新映射为 `agent-workspace-task:${workspaceId}:${attemptId}`；这是安装相关消息身份，不改写源记录。再次执行目标组织关系验证。
- [x] 返回 `{ descriptor, sourceWorkspaceId, sourcePluginVersion, exportedAt, state }`；descriptor 的 ID 是新目标 ID，名称和生命周期来自导出。候选不是持久化成功凭据。
- [x] 定向执行 `pnpm exec vitest run tests/workspace-import.spec.ts`，覆盖损坏/重签坏关系/未知字段/格式版本/所有资源限制/Unicode字节/非法目标 ID/运行中记录/任职记忆与旧生产器兼容。

调用示例：

```ts
const prepared = prepareWorkspaceImportV1(json, {
  workspaceId: WorkspaceId('organization-test'),
  limits: { maxBytes: 1_000_000, maxEntities: 10_000, maxEvents: 10_000, maxStringBytes: 100_000, maxDepth: 32 },
})
assertWorkspaceInvariants(prepared.state, prepared.descriptor.id)
```

## 任务 2：公开入口及验收

**Files:** Modify `packages/host/package.json`, `packages/host/README.md`; Create `tests/workspace-import-built.spec.ts`.

- [x] 为 `@dsh-agent-group/host/workspace-import` 添加类型和 ESM 叶入口，指向 `lib/types/workspace-import.{d.ts,js}`；不导入 Cordis Host、不注册服务、不写存储。
- [x] 对真实构建入口写 RED 测试，检查安装路径解析、读取旧文件、目标关系与旧绑定剥离；先验证入口缺失，再构建运行。
- [x] 执行 `pnpm build:host`、`pnpm typecheck`、两项导入测试及旧 forward-export 回归。只报告实际运行结果，不复跑第一阶段完整 Browser 烟测。
- [x] 依次进行只读需求审核和代码质量审核，修复重要问题，最后 `git diff --check`。
- [x] 文档明确“已具备候选验证，不是可操作恢复入口”；多组织、原子新增、归档和 Browser 接入仍待 B/C。此阶段不 bump、push、tag 或发布。

## 验收界限

完成 A 仅意味着旧导出可以安全解析并构造新的独立组织候选，不表示第二阶段已完成。完整恢复必须由 B/C 验证：不覆盖现有组织、请求重试不重复创建、跨组织不串数据、运行时屏障正确、旧数据升级后重启与新环境实际工作可用。
