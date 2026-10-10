# 第二阶段：可恢复组织验收

日期：2026-10-11。分支：`codex/organization-memory-stage1`。本次基线：第二阶段 A 提交 `3d9181b`。

## 实现结果

组织目录支持创建、改名、切换、归档（停止或等待）、重新打开以及导入导出。每个组织的同事、房间、任务、统一个人记忆、运行状态和 DSH Session 独立；所有 RPC 显式选定组织，工具以实际 Agent 对象识别员工。切换取消旧请求和订阅，归档后页面只读。

旧裸 local 数据升级为包含描述和聚合的 version-1 record，不改既有事件、记忆、实体 ID 或 Session 绑定。portable format 2 支持任意组织；预览不写入，人类确认仅创建新组织，重复确认不会复制。恢复保留历史、清除 Session 绑定并重建任务投递消息 ID，不自动执行任务。

归档和卸载等待任务终态、员工 Session 保存以及子运行完整清理。根服务最后关闭存储；动态 agents 重新注入先收敛旧代次。真实清理失败保留在 Cordis 日志中，不能以 `fiber.dispose()` 返回作为没有清理错误的证据。

## 最终执行的检查

- `pnpm release:pack`：通过，包含三包构建、Host/Client/type/Browser fixture 类型检查、文案检查和完整插件测试；55 个测试文件、1,012 项测试全部通过。
- `node scripts/release-smoke.mjs --mode packed --dsh E:/003code/deepseek-harness-plugins/.tmp/dsh-source-020 --scratch-root E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-stage2-smoke --skip-dsh-prepare --keep`：通过，使用已构建且无 tracked 修改的 DSH `0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。
- `git diff --check`：通过；提交前另执行暂存差异检查。

真实 Browser 验收包含既有四视图、任务工具、子运行、停止、岗位修订和记忆路径，以及创建/改名、归档、格式 2 下载、导入预览、明确确认、恢复后新回复、Host 重启后继续工作和卸载后核心会话恢复。恢复产生独立 Session；重启沿用恢复组织的 Session；源聚合不变。旧发布 fixtures、冻结聚合/schema、forward-v1 生产器和兼容范围未修改。

本次证据目录：`E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-stage2-smoke/evidence/packed-0.4.0-2026-10-10T22-52-32-443Z-ef8cfe27`。`organization-recovery.json`、`organization-recovery-after-restart.json`、各阶段 ARIA/console、持久化快照及 `host-lifecycle.json` 保存实际结果；`release-smoke-receipt.json` 绑定包字节、源码、驱动、恢复观察 helper 和 pinned DSH。四个独立 Host 均已停止。

## 审核和修复证据

基础、组织 runtime、RPC 和 Browser 已分别审核。最终 scoped teardown 复审无 Critical/Important/Minor；真实 barrier 回归覆盖根关闭遇到 child dispose、晚到组织创建、多个子运行清理失败，以及再注入终态重试期间根关闭，包含失败的 RED 和修复后的 GREEN。

浏览器恢复曾失败：旧观察器把导入的历史回复当成新回复，过早读取持久文件；同一失败运行还记录了 Windows 文件替换 `EPERM`。修复先等待新增回复和空闲，再读取持久状态，没有重发、重试、加睡眠或修改上游。真实 DOM 负控为 RED→GREEN，同一诊断 installed 流程随后通过，本次完整 packed 流程也通过。该结果不声称查明或消除所有 Windows 文件替换竞争。

## 范围与限制

这是开发分支的阶段验收，不是 npm 发布。包版本仍为 `0.4.0`；现有 registry 包不包含本次开发功能。未 push、tag、publish，未修改用户本机运行数据或 DSH 源码。模型提供器为本地确定性 fixture，未进行付费实模型测试、跨平台 CI 或全 DSH 版本矩阵；发布前仍须按发布流程完成独立重复验收。
