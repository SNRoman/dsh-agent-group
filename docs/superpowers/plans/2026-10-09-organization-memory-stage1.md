# 智能体组织第一阶段实施计划

> 执行方式：复用现有工作树，小范围并行实现，定向 RED→GREEN，最终一次独立审核；用户已授权自主完成。

**目标：** 群聊与正式任务统一使用同事个人经历，模型可按需检索与读原文，展示名称为“智能体组织 / Agent Organization”。

**架构：** 复用持久事件与个人事件关联；本地多关键词排序，严格限制回忆字符数；工具从真实员工句柄解析身份。正式任务在入队执行时生成会话可记录的回忆，不改变已冻结的恢复消息。

**技术：** TypeScript、Cordis、现有 DSH tools 与 Session、Vitest、现有打包浏览器烟测。

**需求来源：** 本轮用户授权及既有 README 中的任职、旁听记忆、人类任务授权规则。

## 约束和审核重点

- 不新增数据库、向量服务或依赖；不修改持久代际、npm 包名、服务和 RPC 标识。
- 版本及兼容范围不变，开发验证不执行 push、tag 或发布。
- 非当前员工、伪造句柄及他人事件不得通过记忆工具读取。
- 预算不足或超长事件不得挡住可容纳的后续事件；片段必须携带稳定事件 ID。
- 无 @ 的旁听经历应进入后续正式任务，而不因记忆获得唤醒权限。
- 工具注册失败应回滚；卸载应幂等，不保留全局注册。
- 英中文入口、标题、错误提示及浏览器断言需一致；重启与卸载保留既有数据和核心会话。

## 任务

- [x] 检索：修改 `packages/host/src/memory.ts`、`types.ts`；`recallAgentEvents` 支持可选 `roomId`、`matchingOnly`、`resultLimit` 和查询 `hasMore`。先运行新增相关度、尾部命中、预算和权限用例，再运行 `pnpm exec vitest run tests/memory.spec.ts tests/tasks.spec.ts`，预期全通过。
- [x] 工具：新增 `memory-tools.ts`、`tests/memory-tools.spec.ts`；`registerWorkspaceMemoryTools(registry, host, {characterBudget,resultLimit})` 注册搜索/原文读取。先验证缺失工具失败，再验证真实句柄、在职状态、分页、来源和回滚用例全通过。
- [x] 正式任务：新增 `delivery-memory.ts`、`tests/delivery-memory.spec.ts`，在 Host `deliver` 中补充未提供回忆的新任务；配置默认字符预算 4000、搜索 10 条，正整数检查。新增任务召回与配置失败用例，预期定向测试全通过。
- [x] 展示：修改 locale、插件描述、四份 README 和既有浏览器断言；运行 `pnpm verify:client-copy` 与 locale/视图测试，预期全通过。
- [x] 运行验证：扩展现有脚本模型任务 fixture，要求实际收到旁听回忆、执行搜索/读原文并记录 Session；保留委派拒绝及完成任务。执行 `pnpm release:pack`，然后一次 `pnpm smoke:packed -- --dsh <已构建精确兼容源码> --scratch-root <独立目录> --skip-dsh-prepare`，预期安装、协作、重启和卸载全部通过。
- [x] 收口：独立只读审核；修复必要发现后运行受影响测试，保存实测结果，不将脚本模型验证称为真实模型测试。

## 完成记录

2026-10-10 完成。初次 `release:pack` 暴露旧工具快照和冷启动超时；修正后分别核验构建、类型、单测，再用 `node scripts/release.mjs pack` 打包，未将首次命令称为通过。最终按项目 Browser 验收规则连续执行两次干净配置烟测，安装、协作、中文重启、卸载及核心会话保留均通过；两份凭据与当前源码、产物和验收文件一致。详见 [第一阶段验收记录](../../verification/2026-10-10-organization-memory-stage1.md)。
