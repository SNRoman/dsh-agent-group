# 第二阶段 A：组织恢复校验内核验收

日期：2026-10-10。分支：`codex/organization-memory-stage1`。第一阶段基线：`4766ee3`。

## 已实现

`@dsh-agent-group/host/workspace-import` 将冻结的 forward-v1 JSON 校验为调用方指定新组织 ID 的独立候选。它保留组织历史和统一个人记忆、清除旧 Session 绑定，并重建安装相关的任务投递消息 ID；不修改源文件、不写存储、不调用模型或自动恢复未完任务。

解析前后限制 UTF-8 文件大小、记录数、事件数、字符串大小和嵌套深度；严格检查字段、摘要及源/目标关系。重复键、孤立 Unicode 代理字符和 `__proto__` 字段均拒绝。摘要覆盖原始解析的 envelope，而不是校验库转换后的结果。

## 最终本地检查

- `pnpm build:host`：通过。
- `pnpm typecheck`：通过。
- `pnpm exec vitest run tests/workspace-import.spec.ts tests/workspace-import-built.spec.ts tests/forward-export.spec.ts`：3 个文件、76 项测试全部通过（15:10:44 开始）；分别为 62 项导入校验、2 项真实 ESM 构建入口、12 项旧生产器回归。
- `git diff --check`：通过。

构建入口测试在普通 Node 子进程中通过包名加载新叶入口，并用旧生产数据生成 forward-v1 文件再准备新组织候选。需求审核与代码质量审核已完成；审核发现的摘要绕过问题已加入拒绝测试并修复，独立复现确认被拒绝，无剩余 Critical/Important。

## 未覆盖与下一步

此结果不是整个第二阶段或可操作恢复功能的验收。多组织持久记录与旧数据迁移、组织运行容器与显式作用域、创建/切换/归档、导入预览及原子新增/幂等重试仍待 B/C。目标 ID 与现有组织是否冲突由后续持久化调用方检查。

本轮未复跑完整 Browser 烟测或实模型测试，未修改用户运行数据、DSH 安装或已发布版本，未 push、打 tag 或发布。既有第一阶段发布烟测凭据不能用于发布本轮变更。
