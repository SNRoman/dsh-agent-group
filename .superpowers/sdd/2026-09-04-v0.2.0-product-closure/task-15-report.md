# Task 15 修复记录

## 第二切片：I6–I9（2026-09-21）

状态：DONE_WITH_CONCERNS。本切片只修改 Browser fixture、Browser driver、纯验收函数及 focused tests。保留已存在的 I1–I5 改动、HOLD_WAKE/LIVE_PARTIAL/reload/HOLD_REPLY 流程及卸载/core Session 检查。未提交、未创建子智能体、未 push/tag/publish/merge、未 bump version，未运行长完整 Browser E2E。

### RED / GREEN

- `pnpm exec vitest run tests/browser-product-evidence.spec.ts`：初次新 API 未实现失败；补最小空函数后得到有效 RED，16 tests 中 15 failed / 1 passed，错误为损坏的 pin、业务记录、重复记忆、停止顺序和任务关联未被拒绝；实现验收后 16/16 GREEN。
- `pnpm exec vitest run tests/browser-scripted-protocol.spec.ts`：stop 协议测试有效 RED，abort 后 `settled` 实际为 true、期望 false（1 failed / 10 passed）。改为等待 Browser 的同一 delivery Stopping 收据和 release 后，27/27（连同 product evidence）GREEN。首次实现暴露文件创建先于完整 payload 可读的间隙，已让观察 gate 等待完整匹配的 receipt。
- `pnpm exec vitest run tests/browser-product-evidence.spec.ts`：新增重复 tool/result 与错误 child tool taskId 负例有效 RED（1 failed / 16 passed），补精确调用与结果关联后 GREEN。
- `pnpm exec vitest run tests/browser-scripted-protocol.spec.ts`：held turn 缺少工具 schema 时必须在进入 stop hold 前失败，新增用例 RED（1 failed / 11 passed）；加入可见的安全拒绝工具步骤后 GREEN。
- `pnpm exec vitest run tests/browser-product-evidence.spec.ts tests/browser-scripted-protocol.spec.ts tests/browser-denial-evidence.spec.ts tests/release-contract.spec.ts tests/workspace-activity-dom.spec.ts tests/workspace-task-dom.spec.ts tests/workspace-memory-view.spec.ts tests/workspace-definition-view.spec.ts`：8 files / 124 tests GREEN，20.64s。之后新增 held-tool case，四个 fixture/evidence/release 文件再次运行 49/49 GREEN。
- `pnpm typecheck`：GREEN，涵盖 Host、Web client、公共类型与 Browser fixture。
- `node --check tests/e2e/workspace-browser.mjs`、`node --check scripts/release-smoke-contract.mjs`、`git diff --check`：GREEN。
- 聚合 focused 回归曾因 release-contract 仍要求旧 Tasks stop 按钮词串 `Stop Alice current turn for` 出现 1 failed / 46 passed；该期待已更新为本切片实际使用的 runtime drawer 精确按钮名称，随后 GREEN。

### I6：exact stop

Provider 先执行安全拒绝工具并停在 `stop.tool-ready`；Browser 打开 runtime drawer、展开工具错误详情并写入 `stop.tool-observed` 后才产生 partial。独立 stop 协议为 held → responding-observed → queued-observed → stop-clicked → abort-received → stopping-observed → released → settled-observed。abort listener 只记录精确 task/attempt/session/message identity；收到 Browser 同一 identity 的 Stopping 收据并释放 gate 后，provider 才抛出 abort。Browser 从可见抽屉文本提取 activity/message/attempt，使用包含 exact activity ID 的 Stop 按钮，等待该 activity Settled，并检查该 attempt 的唯一 terminal failure、没有 task/result、没有持久化的 partial assistant message、Alice Session 不变、同一 Alice 的无关排队任务完成且结果唯一。证据写入 `v020-stop-protocol.json` 和对应 ARIA captures。

### I7：Tasks / child / tool / result

新增 `child-observed` 与 `child-result-observed` gates，分别保持 child 执行中与 child 工具结果可见的步骤；Browser 从 runtime 控件展开工具参数，从 Tasks 展开 child/parent，再返回 runtime 展开工具结果，最后展开 root/derived 的任务结果。纯验收检查唯一 root/derived、rootTaskId、assignment/delegator/assignee、grant/grantee/human actor、attempt start/accept/result/completion 次序与 ID、工具参数及 tool/result 恰好一次、child parent/task/start/finish/result，以及 child Session 的 parentSession、descriptor label 和完整 assistant result。Session 文件按 header 分组，避免把别的 Session 事件当成当前任务证据。输出 `v020-task-causality.json` 和分阶段 ARIA captures。

### I8：Memory

每位 Alice/Bob/Charlie 都实际操作 source kind、source、first provenance、event type checkbox 和 search，分别验证 silent room message、historical room event、root task result、derived task result、child result。期望拥有者独立指定：silent message 三人、history Bob、root result Alice、derived/child result Bob；其他同事应显示空结果。可见 article 的 event sequence/type 回连 durable event ID，拒绝重复可见行与重复 durable acquisitions。Alice Depart 后先通过 Memory UI 以 Departed 选项检查，再返回 Colleagues Re-employ。每个参与者/来源保存 ARIA capture。

### I9：revision pins 与保留数据

保存 `v020-before-revision.json`，只选择 Alice 保存 rev2；验收要求精确 rev1/rev2 IDs、Alice→rev2、Bob/Charlie→rev1，逐字段比较三人的名称/任期/状态，并保持 rooms、memberships、sessionBindings、memoryEntries、tasks、assignments、grants、childRuns 和原 events 前缀。history UI 对 Revision 1/2 的 Previous/Current 与包含精确 agent IDs 的完整 pins 文本进行验证，输出 `v020-revision-pins.json`。移除对本来已固定 rev1 的 Bob 重复同步的无效证明。

### 剩余问题与验证限制

I10–I13 仍待后续切片：重启 seed 幂等与精确身份/活动收敛；中文真实控件流程；已有 durable/ARIA 任意 sleep 与旧 watcher 间隙；运行/阶段独立证据目录和两次 clean run。M1 的 I6–I9 数据负例已增强，但重启、seed、清理失败等剩余协议负例仍未完成；M2 操作指南仍需补齐安全清理与双份收据保存操作。

本切片没有真实 Chromium E2E 收据，不能宣告 Task 15 完成或声称新可见流程已经实际 Browser GREEN。完整两次 clean run、build/full checks、提交均按本轮约束未执行。brief 指定的 `C:\Users\ysxayh\AppData\Local\Temp\dsh-agent-group-compat-a169a312e60f41d9baf242e62db683dc\deepseek-harness-0.1.1-rc.2` 本轮定点源码读取返回路径不存在；未修改或重新创建该 checkout。后续 E2E 必须重新确认可用的 pinned checkout 与 artifacts freshness。

## 最终整合与真实浏览器验收（2026-09-21）

状态：实现与两次连续本地发布级验收已完成，等待独立代码审查与提交。实际使用的只读 DSH checkout 为 `C:\dshv20-9fc477bf`，HEAD 精确为 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。没有 push、publish、tag、merge 或版本号变更。

### 整合阶段发现与修复

- 授权拒绝的 Browser gate 必须等待结构化 `tool/result` 收据，而不能只看 provider 已发出调用；记录匹配固定 `toolCallId`，并接受 DSH 归一化的 `Error:` 前缀。
- Host 子智能体 provider 改为显式 `childProvider` 配置，默认使用已注册的 `spawn`，不再引用不存在的 `spawn-in-process`。
- 直接会话打开时，Web 只在新 durable snapshot 已采用后选择房间，消除选择先于提交状态的竞态。
- 任务 delivery lane 建立前即发布 queued activity；终态写入首次拒绝时，外层 flight 负责继续收敛，新增单元测试覆盖首个 terminal write rejection。
- provider gate 的 120 秒预算大于 Browser 单步的 30 秒预算，页面 reload 不再与 fixture 自身超时竞争；仍以文件收据和可见状态为条件，没有固定 sleep 或 retry。
- exact stop 保留 DSH Session 中唯一、带 `data.interrupted: true` 的 partial assistant 证据，同时严格要求 Workspace 不产生该 task 的 `task/result`；这区分了底层中断审计记录和产品任务结果。
- Memory 文本检查限定到事件 article 的 paragraph；拒绝证据按结构化 tool call 关联；中文任务中心使用真实 aria label；卸载后总是重新打开原 core Session，而不是把侧栏标题误当作会话内容。
- 重启后的中文修订历史先等待 `修订 1`、`修订 2` 两个 article 可见，再抓 ARIA 快照；对应发布契约先 RED（1/15 failed），实现后 GREEN（15/15）。

### 验收证据

- 迭代打包烟测：`node scripts/release-smoke.mjs --mode packed --dsh "C:\dshv20-9fc477bf" --skip-dsh-prepare` 通过；证据 `.release-smoke/packed-0.1.1-2026-09-21T12-43-33-361Z-d4586af8`。`host-lifecycle.json` 包含安装态、重启态、卸载态三组 start/stop 时间。
- 第一次完整命令：`pnpm test:e2e:browser -- --dsh "C:\dshv20-9fc477bf"` 通过；39 files / 744 tests；证据 `.release-smoke/packed-0.1.1-2026-09-21T12-46-46-729Z-7dd4aad1`。
- 第二次连续完整命令：同一命令在未修改代码的情况下再次通过；39 files / 744 tests；证据 `.release-smoke/packed-0.1.1-2026-09-21T12-51-06-088Z-674042a8`。
- 两次完整命令均重新执行 client-copy、Host/Web/bundle build、typecheck、全量 Vitest、三包 pack、固定 DSH checkout 的 Host/client/Web 构建、干净 profile 安装、真实 Chromium 安装态/Host 重启/卸载态流程和 finally 清理；均未使用 `--skip-dsh-prepare`。
- 两份独立 `release-smoke-receipt.json` 都固定 DSH `0.1.1-rc.2` / `b150a551...`，各自保留 durable、ARIA、console、Host log、lifecycle、任务因果、停止协议、修订 pin 和卸载 core Session 证据。

### 计划偏差与风险

- brief 中原临时兼容 checkout 已不存在；改用相同精确 commit 的 `C:\dshv20-9fc477bf`，并由两次完整命令重新准备构建产物，而非假定缓存新鲜。
- 包版本仍为 `0.1.1`，这是发布授权边界，不影响当前 v0.2.0 产品闭环代码和打包验收；Task 17 才处理候选版本与发布说明，仍不得擅自发布。
- Browser smoke 覆盖的是 Windows 本机与固定 DSH commit；跨平台矩阵继续由 CI workflow 承担。

## 独立审查修复与最终复验（2026-09-22）

独立审查报告 3 个 Important 和 2 个 Minor。3 个 Important 均已通过先补负例、再修改实现的方式关闭：修订验收现在验证唯一且连续的 `definition/revised` 与 `agent/definition-revision-assigned` 事件；停止/重启验收现在验证 held 与 queued 两条任务生命周期的精确事件集合、顺序、错误码和最终状态；中文界面不再透传已知的英文运行错误、终止原因或修订界面文案。2 个 Minor 已登记为后续事项，不影响本任务的产品路径真实性或发布级验收结论。

### 审查 RED / GREEN

- 新增审查负例后，`tests/browser-product-evidence.spec.ts`、`tests/workspace-task-dom.spec.ts`、`tests/workspace-activity-dom.spec.ts` 得到预期 RED：3 files / 80 tests 中 5 failed，分别证明缺少修订事件校验、停止证据过宽和中文界面泄露原始英文摘要。
- 完成最小修复后，同一组 3 files / 80 tests GREEN；扩大到 8 files / 142 tests GREEN。
- `pnpm typecheck`、`pnpm verify:client-copy`、`pnpm build:web`、`git diff --check` 均 GREEN。
- 第一次修订后完整命令 `pnpm test:e2e:browser -- --dsh "C:\dshv20-9fc477bf"` 通过；39 files / 748 tests；证据 `.release-smoke/packed-0.1.1-2026-09-22T05-18-51-225Z-9f431f34`。
- 第二次在无代码改动下重复同一完整命令通过；39 files / 748 tests；证据 `.release-smoke/packed-0.1.1-2026-09-22T05-24-04-064Z-2fcf68d5`。
- 两次新证据均重新构建插件与固定 DSH checkout、打包三个 npm 包、安装到全新 profile、完成真实 Chromium 安装态/重启态/卸载态流程并执行清理。Task 15 实现提交为 `36232e8`；实现、审查修复和两次独立发布级复验均已完成；仍未 push、publish、tag、merge 或修改版本号。
