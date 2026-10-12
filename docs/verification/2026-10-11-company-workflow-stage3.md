# 第三阶段：公司工作流验收

执行日期：2026-10-11 至 2026-10-12。分支：`codex/organization-memory-stage1`。基线为第二阶段本地提交 `530f534`；第二阶段证据见[可恢复组织验收](2026-10-11-recoverable-organizations-stage2.md)。本记录说明本地开发分支的已执行验收，不是 npm 发布声明。

## 实现范围

工作流区域支持草案创建、编辑、丢弃及明确负责人确认，任务模板不可变修订及旧修订套用，公司配置模板预览与明确 new-events 确认，精确结果的产物登记、人类接受或需修改、显式返工和选中产物交接。员工只能从真实在职 Agent 的已唤醒回合提出草案，不能通过该工具确认或授予任务权限。草案、模板和交接不会自动开工。

确认在一次原子记录更新中保存任务及完整 brief，提交后才进入既有投递；重复操作不再次指派或投递。不可用运行时及恢复后未投递任务仍需显式 retry。模型实际收到的完整 brief、验收列表、修改意见及选中交接引用写入既有 DSH Session user/message，保留 task、attempt 和 message 身份。产物引用惰性且未验证，不读、执行或访问它。

后继 version-2 record 同时保存冻结聚合和独立 workflow。全目录先验证再一次升级旧裸聚合或 version-1 record，补空 workflow，不修改既有历史或 Session。portable format 3 携带完整 workflow，旧格式 1/2 仍能导入并补空 workflow；导出和预览剥离源 Session 与创建元数据，新本地导入提交产生本次 imported 创建回执。导入保留业务身份和事实，重建新组织的消息身份，不恢复员工 Session 或启动任务。

## 已执行检查

- 最新 `pnpm release:pack`：exit 0；三包构建、文案检查、Host/Client/共享类型及 Browser fixtures 检查通过，66 个测试文件、1,151 项测试全部通过，三个实际 tarball 已生成。首次完整运行仅有两个旧工具清单/模型 schema 期望未包含 `workspace_propose_task`；保留全部旧 schema、执行结果和精确反序卸载断言后定向 RED→GREEN，先前完整检查为 65 文件、1,130 项通过。新增 Connection 修复及诊断负控后再执行上述最新完整检查。
- Foundation、Host、Browser 和集成均有独立或聚焦审核证据。页面审核发现的旧草案基准覆盖、多行输入、公司改名成员关系、旧 Retry 和迟到成功清空新输入已完成确定性 RED→GREEN，并由原审核者定向复核关闭。导入证据使用真实 Directory.import 两代正例及复制源回执、错误摘要、Session 和消息身份的负控。
- 冻结聚合/schema、发布的 v0.1/v0.2 聚合 fixtures、forward-v1 生产器、包版本及兼容范围相对基线未改。工具的 owner-local 模型可见快照只新增 proposal schema，不是重写旧发布的聚合 fixtures。

## 实际 packed Browser

命令：`node scripts/release-smoke.mjs --mode packed --dsh E:/003code/deepseek-harness-plugins/.tmp/dsh-source-020 --scratch-root E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-stage3-smoke --skip-dsh-prepare --keep`。使用已冻结安装并构建且 tracked 状态干净的 pinned DSH `0.2.0-rc.2`（`639ed015397290b3745d163aafe02ffee4aa3f84`），只安装本次实际打包的 tarball 到独立临时 profile。

首次运行的 installed 阶段已通过四视图、既有任务工具/子运行/停止/记忆以及完整草案、三次明确人类确认、精确审核、返工、选中引用交接、两类模板、真实员工提议工具、归档、V3 下载导入和恢复新独立 Session。整个运行在重启阶段失败，不能记为完整通过：全 Session 严格相等检查遇到核心页面新增空 Session。

失败证据：`E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-stage3-smoke/evidence/packed-0.4.0-2026-10-11T15-19-38-777Z-b67834e0`。实际 JSONL 比对证明原 7 个 Session 的头信息及全部事件不变；新增第 8 个属于独立 core-workspace，只含 permission/preset、sandbox/mode、approval/policy 初始化事件。源和恢复组织完整记录不变。此次失败保留现场；三个记录的 Host PID 经实际进程查询均已停止，失败路径的 lifecycle 文件缺最后 stop 行，不能单凭该文件声称完整清理。

重启验收已按 pinned DSH 的 Workspace restoreSelection→reuseOrCreateBlank 和 permission 初始化路径修正：全部旧 Session、所有完整组织记录与员工绑定仍须相等，只允许一个本 profile 核心空 Session 的精确初始化记录；27 项受影响测试和语法检查通过，实际新运行仍须验证。

第二次独立运行在 installed 首屏失败，证据为 `E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-stage3-smoke/evidence/packed-0.4.0-2026-10-11T23-53-25-018Z-b3e346a6`。实际 ARIA 是合法的 Loading Agent Organization 状态、组织选择尚禁用，旧观察器只等对话框可见即要求 Conversations。该结果不能当作通过，也不是已观察到插件业务失败；首屏就绪观察需修正后再完整验收。

首屏观察修正后，28 项受影响测试、两个 MJS 语法检查和聚焦复核通过；等待导航和目录同时就绪，明确错误和永久加载仍失败。第三次完整运行仍为 exit 1，证据为 `E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-stage3-smoke/evidence/packed-0.4.0-2026-10-12T00-01-32-122Z-9f269b8a`。既有点名和全员交流通过后，Alice 私聊请求提示 Organization request failed，私聊输入框超时，尚未进入新增工作流。浏览器控制台及 HTTP 错误记录为空，不能据此判断具体原因；其原始 RPC 回执缺失。两个 Host PID 经实际查询均已停止。

追踪发现并独立复现一项真实 Connection 适配缺陷：DSH 将 Host 错误投影为 code/message/details，插件原来要求额外 kind，合法版本冲突因而退化为内部失败。两个 Browser decoder 现从已知 code 和严格 details 恢复分类，额外字段、矛盾 kind 和未知错误仍拒绝为安全内部错误；没有修改 Host、DSH、组织身份或 CAS。通过已安装公开 Connection factory、真实 Cordis installer 和实例 fetch 的永久回归为 RED 9 失败、9 通过 → GREEN 18 通过，受影响六文件共 194 项通过。该复现不证明第三次历史运行的实际错误码；其原始 RPC 回执没有被保存。

新增只读 Direct HTTP 诊断记录 HTTP 200 的业务拒绝及允许的成功摘要，在保存证据前停止监听并等待读取结束。真实 Chromium 负控包括额外字段、嵌套敏感对象、URL/Bearer、畸形 ok、非 JSON 和停止后零新增记录；审核发现的成功分支泄漏已按 RED→GREEN 修正，仅保留布尔 ok、经过滤的标量及脱敏文本。受影响两文件 29 项通过，聚焦复核关闭；不增加场景重试或隐藏失败。上述最新完整检查包含两项修复。

最新完整独立运行为 exit 0，未使用 installation-only 等绕过选项或场景重试。证据目录为 `E:/003code/deepseek-harness-plugins/.tmp/dsh-agent-group-stage3-smoke/evidence/packed-0.4.0-2026-10-12T05-27-02-165Z-f5bf767e`，保留的独立 profile 为 `dsh-agent-group-packed-UzmBhG`。同一轮通过旧数据加载、四视图、既有交流/任务/子运行/停止/记忆、新公司工作流、归档/V3 导出导入、独立恢复 Session、Host 重启及卸载后重新打开核心会话与原回复；不能以先前失败运行的局部结果替代本轮回执。

`workflow-record-final.json` 为 version-2 record，源组织 aggregate revision 83、workflow revision 21；包含 3 个已确认完整 brief、4 个产物、精确的 changes-requested 与 accepted 审核、已丢弃及待确认草案、任务和公司模板修订、交接及真实员工提议事实。`workflow-evidence.json`、实际 Session rows、V3 备份和恢复记录对应同一 task/result/attempt/message 身份，后继输入只含选中的交接引用。`installed-direct-rpc-responses.json` 中三次真实 Direct 请求均为 HTTP 200、ok true、rpcId 一致；首次以 expectedRevision 42 成功提交到 44，没有重试。

`workflow-restart-quiescence.json` 保全全部 7 个既有 Session，仅记录那个精确允许的核心空 Session；所有组织完整记录及员工绑定不变。三个 Browser 阶段的 console 证据均为空。卸载后的 `sessions-comparison.json` 为 preserved true，保留前后 8 个会话文件；脚本自身的通用文件树断言只检查原路径未删除，不证明文件大小和摘要相等。root 的完整摘要相等检查失败后逐项检查实际日志，证明 8 个文件的全部原字节前缀摘要均相同，仅两个核心日志各追加一条 session/end-seed，员工日志未变。`core-session-after-uninstall.json` 和对应 ARIA 记录插件入口消失及原核心会话与回复重新打开，没有在卸载后新发核心任务。`host-lifecycle.json` 中 293812、295956、298928、291864 全部停止，root 另用 Get-Process 验证四个 PID 均不存在。

root 执行 `verifyReleaseArtifacts` 和 `verifyReleaseSmokeReceipt` 均 exit 0；回执与当前源码、验收输入和三个 tarball 的身份一致。sourceSha256 为 `dec88518d84be323d5b2cf534717553300c5f06420239989110a56803e70d554`，smokeInputSha256 为 `3f96f38000fdf62b3c9d9d9f7db703bc7478f00a585e541130196db9f7c0b3aa`，releaseManifestSha256 为 `0df821c89ccf0ed0ca7b4d6e6e7cfaa769373f64d68707bdc867d37416347d17`。独立代码审核的发现均已关闭，最终证据核对没有新增发现；未重复运行已通过检查来替代审阅。

## 范围与限制

这是本地开发分支验收，不是 npm 发布。包版本仍为 `0.4.0`，不能把 registry 既有包称作包含本次开发功能。未 push、打 tag 或 publish；未修改用户运行数据、本机 3080 服务或上游 DSH 源码。运行系统和浏览器是真实的，模型提供器为本地确定性 fixture；未进行付费实模型测试、跨平台 CI 或完整 DSH 版本矩阵。发布前仍需独立重复验收。
