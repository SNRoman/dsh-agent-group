# 智能体组织第一阶段验收

2026-10-10 完成开发和验收。代码位于 `codex/organization-memory-stage1`；验收时尚未提交、push、打 tag 或发布。本次开发包仍沿用 `0.4.0`，不代表已替换 npm 上的同版本包。

## 实现效果

- 产品展示为“智能体组织 / Agent Organization”；npm 包名、服务及 RPC 标识不变。
- 群聊和新正式任务使用同一份个人事件记忆；旁听获得记忆，不获得唤醒权限。
- `workspace_search_memory` 按关键词返回有来源和事件 ID 的片段；`workspace_read_memory` 读取个人已获得事件的原文，可按 `nextOffset` 分页。
- 自动召回及工具文本受正整数字符预算控制，默认 4000；搜索默认最多 10 条。不新增数据库、向量服务或依赖。
- 工具验证真实员工对象、当前运行代际和在职状态；他人事件与不存在事件返回同一错误。恢复中的合法员工可调用工具，失败或销毁立即撤销身份。
- 任职、加入时历史范围、@ 路由、人类任务授权、既有持久数据及冻结恢复消息规则保持不变。

## 本地检查

构建、`pnpm typecheck`、`pnpm verify:client-copy`、相关记忆/任务/运行/locale 回归均通过。新增行为及审核发现按 RED→GREEN 验证；恢复期间工具身份授权和英文展示遗漏已修复。

`pnpm exec vitest run --maxWorkers=4` 为 804/805 通过，唯一失败是既有 source-compatibility 临时 Git 目录测试在并发运行中超时并遇到 EBUSY；随后独立执行 `tests/compatibility.spec.ts`，12/12 通过。因此不是“一次全量全绿”。最终修改后的 `tests/release-contract.spec.ts` 为 19/19 通过，两个 Browser 驱动语法检查和 `git diff --check` 通过。

最终三份 tarball 用 `node scripts/release.mjs pack` 打包。记忆验收读取器和预期 JSON 已纳入烟测凭据哈希；改变任一文件会使原凭据失效。

## 连续两轮真实 DSH 与 Browser 验收

使用已安装、已构建的精确 DSH `0.2.0-rc.2` 源码 `639ed015397290b3745d163aafe02ffee4aa3f84`，命令如下：

```powershell
pnpm smoke:packed -- --dsh E:/003code/deepseek-harness-plugins/.tmp/dsh-source-020 --scratch-root E:/003code/deepseek-harness-plugins/.tmp/organization-stage1-smoke --skip-dsh-prepare
```

两次均退出 0，证据保存在 `E:/003code/deepseek-harness-plugins/.tmp/organization-stage1-smoke/evidence/`：

1. `packed-0.4.0-2026-10-10T04-16-57-242Z-1fa9bdb0`
2. `packed-0.4.0-2026-10-10T04-19-31-938Z-5af20aa8`

每轮验证安装本地 tarball、旧数据加载、正常核心会话、组织页面、加入历史范围、三位同事的指定 @ 与 @all、私聊、旁听、任务授权拒绝后委派、子智能体、精确停止与后续排队任务、离职/复职、修订同步、中文重启及卸载。

正式任务实际召回先前未被 @ 时获得的 UTF-8 导出要求，执行搜索和原文读取；Session 记录中的事件 `event-7`、序号、来源和原文一致，任务完成。不是仅检查工具 schema 存在。

两份验收凭据相同且通过当前文件校验；每轮重启前后持久组织数据完全一致，卸载前后 7 个 Session 文件的数量与哈希一致，三个 Browser 阶段控制台记录均为空。测试服务器已停止，成功临时配置已回收，证据保留；未改动用户日常服务与配置。

## 验证范围

本次使用本地确定性脚本模型，验证真实 DSH、工具执行、会话日志及渲染链路；没有付费真实模型调用，不据此声称开放式任务质量或长期记忆质量已验证。检索仍是关键词检索，不是语义检索。
