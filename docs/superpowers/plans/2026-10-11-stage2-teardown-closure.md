# 第二阶段最终收尾

**Goal:** 修复已复现的组织 Host 卸载竞态，完成真实浏览器恢复验收，并本地提交第二阶段；之后执行第三阶段，不缩小既定目标。

**Spec:** [第二阶段计划](2026-10-10-recoverable-organizations-stage2.md)，尤其完整终态、Session 保存和子运行清理先于存储关闭。

## Global Constraints

- 不修改冻结 WorkspaceState、旧持久化 fixtures、forward-v1 生产器或用户运行数据。
- 保留动态 agents 服务的代次撤销和重新注入，真实 Agent 认证不降级。
- 不 push、tag、publish；本地阶段提交由 root 统一执行。
- 使用 apply_patch 与显式 UTF-8；仅运行相关定向检查，root 汇总运行完整插件测试。

## Task 1: 统一组织根服务卸载

**Files:** `packages/host/src/index.ts`、`workspace-runtime.ts`、必要的 `runtime.ts`、`child-controller.ts` 和 `tests/workspace-organizations.integration.spec.ts`；不编辑其他实现或 Browser fixture。子运行代次收尾须尝试全部同组织子运行，不能因一个终态写入失败而跳过其余运行。

已经复现：Cordis 并行卸载多个 effects，domain.close 早于子智能体 dispose 和结果落盘；host.dispose 已返回，但 admission.pending 为 1、持久 child.status 为 running。

- [x] 先写真实 root + storage + runtime/dispatcher 回归，使用受控 child dispose barrier，观察存储关闭/Host disposal 必须等待；先运行 RED。
- [x] 根服务关闭目录新入场和所有容器的新任务入场，停止 exact 工作，等待 reservations、delivery flights、子运行完整 dispose 和员工 pool 收尾，最后关闭 domain。
- [x] 收尾对重复调用幂等；任何持久化异常不得伪装成成功，所有容器仍被尝试清理。
- [x] 动态 agents 服务卸载仍撤销旧代次，不提前清空 coordinator/tracker 而漏掉进行中的终态工作；重新注入不得继承旧 live handle。
- [x] 新增多组织异步目录变更与 service disposal 相遇的回归，避免晚到容器绕过根关闭屏障。
- [x] GREEN 定向 Host tests、Host tsc、diff check，写实现报告，不自行 commit。

## Task 2: 验收与阶段提交

- [x] 任务审核确认 spec 与质量；仅复核 Task 1 变更及已报告缺陷，不重复审核已通过的基础/Browser 功能。
- [x] root 构建并 typecheck、文案检查、完整插件测试及 packed Browser smoke：创建→切换→归档→导出→确认恢复→重启后继续，新 Session、旧历史与源不变都有持久化证据。
- [x] 更新架构/使用说明、阶段验证记录和原计划清单；本地提交第二阶段。
- [ ] 制定并执行第三阶段公司工作流方案和计划，验收后再次本地提交。
