# 场景感知个人记忆实施计划

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox tracking. 用户已授权实现并委托开发者组织团队、选择技术细节；不在任务之间重复请求继续授权。

**Goal:** 让每位同事的下一轮回复可靠获得新经历、适用约定和相关历史，并依照当前场景回应，保持个人可见性与撤回一致性。

**Architecture:** DSH 继续拥有 Agent、Session、持久化、压缩和模型组合；插件统一准备场景与个人记忆。源事件及 memoryEntries 决定资格；事实和检索是可重建投影，模型输入和覆盖凭据随普通 DSH 消息落日志，不新增全组织共享权威。

**Tech Stack:** TypeScript strict ESM、Cordis、DSH 0.2.0-rc.2、Vitest、现有 Workspace/Communication 数据和 DSH MessageSource 扩展。检索候选独立实测后决定，不默认增加外部服务或云端数据传输。

**Spec:** [已确认设计](../specs/2026-10-14-scene-aware-personal-memory-design.md)。

## Global Constraints

- 在现有隔离工作树与 `codex/organization-memory-stage1` 上工作；保留所有此前修改。原始提交为 `f88540ba3128500361c364b8732f8b0cb798dd0e`。所有修改用 apply_patch，中文文本使用 UTF-8。
- 支持 DSH `>=0.2.0-rc.2 <0.2.1-0`，不改 DSH 核心，不更换智能体框架，不改变发言/交办/委派授权规则。
- 不 commit、push、tag、发布或创建新云账户；本轮没有 Git 操作授权。将任务差异与报告保留为文件，审核基于任务开始时的自有文件快照。
- 用户组织数据只用于此前已授权的只读诊断；新验收使用合成数据及独立临时目录，不向用户群聊发测试消息。
- 撤回有效投影先于所有读取；源事件有资格不代表组织其他资料也可读，任意派生项必须有有效且本人已获得的支持来源。
- 不编辑已冻结/已提交的历史记录定义或强行覆盖代际。新增 Source 元数据保持旧 DSH 消息可读，派生缓存有独立版本；如需要改变权威持久类型，先新增后继读写与迁移测试。
- 不增加 unknown 强制断言；注册走 effect/on，异步清理达到停稳；未配置可选模型渠道不能宣传为语义能力。
- 只跑覆盖本轮改变的测试与真实构建路径；不因技能默认指引而重复全仓库套件。不绕过已拒绝的用户本机浏览器访问。

## Review Focus

- 排队期间出现新无 @ 消息：实际轮次准入用最新有效状态，而非排队前回忆。
- 历史同步新取得旧事件：资格/覆盖以个人 memoryEntry 身份及代际判断，不只看 event.sequence。
- 摘要或截断：依赖登记不等于整条原文覆盖；必须保留未覆盖部分或明确的摘要覆盖类别。
- 临时要求与旧项目：同群切话题、换群与任务结束后不能继续沿用局部要求或复活执行授权。
- 迟到抽取与工具读取：撤回后事实、搜索结果、原文读取和旧输出不能恢复失效内容，且实际输入来源可追溯。

## Task 1: 可独立测试的场景与分层记忆内核

**Files:** Create `packages/host/src/scene-memory-contract.ts`, `scene-memory.ts`, `memory-facts.ts`, `scene-memory-retrieval.ts`; create `tests/scene-memory.spec.ts`, `tests/memory-facts.spec.ts`。本任务不改 runtime、schema 或旧 memory.ts。

**Interfaces:**

- `MemoryScene`：真实 `WorkspaceActivitySource`、实际 actor、触发事件、查询文本；组织和同事来自调用参数。事实只作为有来源数据，不作为高优先权限指令。
- `MemoryCoverage`：按 AgentMemoryEntryId 的原文范围/摘要类别与当前 contextGeneration 记录；不使用单一事件序号作个人获得游标。
- `MemoryFact`：品牌 id、类别、主体、key/value、组织/群/任务 scope、sourceEventIds、来源引述、有效/替代信息；分类区分人类明示与推断。事实候选来自已验证模型/人工输出，内核不通过一个称呼正则假装通用语义提取。
- `MemoryLimits`：scene/new/core/history/item 的字符预算、近期对话/事实/历史数量界限；所有部署变动值由 Config 解析后传入，不在算法里加隐藏默认值。
- `prepareSceneMemory(state: WorkspaceState, request: SceneMemoryRequest): PreparedSceneMemory`：输入为已做撤回过滤的不可变快照、个人资格、当次场景、覆盖和事实；输出 rendered、实际 eventIds、覆盖收据、omitted 数与分层诊断。
- `projectMemoryFacts(state, agentId, scene, facts)`：只保留本人有效来源、适用 scope 和时间的事实；同主体/key/scope 的已确认新约定替代旧约定，推断不覆盖人类明示。

- [ ] 先写纯行为回归：长旧文档占满旧检索预算，新无 @ 称呼仍在 new 层；不可见成员不取得该称呼；原文仅截取一段不确认整条覆盖；history-sync 的旧事件仍视作新获得；场景与 actor 不沿用上一群；字段预算分别有效。
- [ ] 先看失败，再实现来源过滤、局部场景及分层渲染，保持旧 memory API 的行为不变。
- [ ] 事实测试包含任意中文/英文称呼值、语言/交流偏好、任务限定英文邮件、群限定称呼、事实 A/B 更新与 B 失效、同名跨组织、推断不覆盖明示、含恶意指令的资料不升格。
- [ ] 运行 `pnpm exec vitest run tests/scene-memory.spec.ts tests/memory-facts.spec.ts --maxWorkers=2`，期望所有用例通过；记录 RED 与 GREEN。
- [ ] 自查并写报告，不提交。输出接口与实际来源/覆盖含义必须足够让 Task 2 直接消费。

## Task 2: 串行准入、覆盖恢复与工具依赖闭环

**Files:** Modify `packages/host/src/workspace-runtime.ts`, `dispatcher.ts`, `delivery-memory.ts`, `communication-contract.ts`, `memory-tools.ts`, `index.ts`; create `packages/host/src/memory-session.ts`；修改/新增 `tests/scene-memory-runtime.spec.ts`, `tests/message-recall-runtime.spec.ts`, `tests/room-input.spec.ts`, `tests/task-tools.spec.ts` 中实际涉及用例。

**Interfaces:**

- 消费 Task 1 的 `prepareSceneMemory`；仅在实际进入同事串行 turn 并核对上下文 generation 后准备本轮消息。
- `readMemoryCoverage(session, agentId, generation)` 从已经落入 DSH user/message 的插件 Source 收据恢复。普通 CommunicationInput 继续记录事件依赖；Source 可携带版本化 memoryReceipt，旧 Source 无收据时保守视为未覆盖，不伪造已读。
- `recordMemoryToolRead(agent, eventIds, rendered)` 在 managed turn 中把实际工具返回来源纳入 CommunicationInput；更新当前 Session 的上下文源归因，以便后续输出和撤回均覆盖读到的资料。
- Host Config 明确解析各层预算与限额，沿用现有 memoryCharacterBudget 为历史/工具的兼容入口；语义渠道未配置时明确基础模式，不改变原 model/tools/skills 能力。

- [ ] 用真实 WorkspaceRuntime、目录、工具注册与模拟外部模型写 RED：排队等待期间新增事实、读取旧历史后撤回、工具只预览/只分页也登记来源、恢复 Session 收据及 generation 重置、撤回与准入竞态。
- [ ] Runtime 改为准入时取最新快照准备场景，群与正式任务共用入口；Dispatcher 不冻结关键词榜单作为最终回忆，已有持久化重试输入保留原记录而非重新改写。
- [ ] 收据只随实际模型输入记录而生效，未启动/失败准入/未记录输入不能推进；新旧记录与部分覆盖均能恢复。旧 Communication schema 若无需修改则保留，不能为收据省事把“依赖”字段当全量覆盖。
- [ ] 搜索和读取逐次校验来源有效性，记录实际返回事件；命中敏感失效项不只做展示隐藏。关闭后不能有迟到 mutation。
- [ ] 运行 Task 1 测试及 Runtime/recall/room-input/memory-tools 受影响回归、`pnpm typecheck`，记录实际命令与结果。
- [ ] 自查并写报告，不提交；由独立审核确认准入、恢复和撤回语义后进入后端阶段。

## Task 3: 源驱动事实形成与可维护检索后端

**Files:** Create `packages/host/src/memory-processor.ts`, `memory-projection.ts`；修改 Task 1 检索接入与 Task 2 runtime 配置、`memory-tools.ts`，使自动召回与工具搜索使用同一候选后端；具体第三方依赖只有经过独立报告后才修改 package/lock。新增 `tests/memory-processor.spec.ts`, `tests/memory-retrieval.spec.ts`。

**Interfaces:**

- `MemoryFactExtractor.extract(request)` 接收有效、具名、有 scope 的源事件，返回严格解析的事实候选；抽取请求、提供方参数、原始模型输出与结算通过独立版本的 DSH storage-domain 审计记录保存，避免每次抽取新增用户可见 Session。员工模型输入与覆盖收据仍随普通 DSH 消息记录。使用明确选定的已配置 DSH 模型，不注册新提供方或上传到新目的地。实际依赖接口在 Task 2 报告后锁定，不能用正文正则代替通用语义抽取。
- 派生投影独立版本，按源事件集合/抽取版本复用，同一消息不是每位同事重复抽取。提交前及读取时再次验证来源；缓存不是记忆权威，可以安全重建。
- 默认仅处理已经实际进入同事当前模型请求的源片段，复用该请求选定的提供方和模型；启动插件或无 @ 消息不自动批量上传沉睡历史。处理进度区分片段、完整源及失败，抽取辅助调用不能递归触发自己。
- 后端只返回带 sourceEventIds 的候选，个人可见性和撤回由内核再过滤。关键词模式、配置的语义模式、渠道故障明确区分，不把低质量 fallback 说成完成语义检索。

- [ ] RED：同一事件只抽取一次、来源引述不匹配被拒绝、后台等待时撤回导致结果不能提交、摘要依赖全部可见、抽取错误不阻断 new 原文同步、明示约定和同事猜测区分。
- [ ] 依据 `output/memory-evaluation/20261014/backend-report.md` 选择合格可维护候选；若组件不满足个人来源过滤/失效，不能直接启用它的全局注入。评估可以独立并行，但不与当前实现者争用生产文件。
- [ ] 落地事实形成、复用与当前语境检索；未配置 embedding 时不暗中发请求。模糊指代结合最近话题，不捏造唯一指代。
- [ ] 新增合成中文 benchmark，比较旧关键词回忆、分层基础及接入候选的命中/误泄漏/输入大小/延迟；至少包含当前模糊称呼、范围更新、变更撤回、大量旧文和陌生同事。
- [ ] 运行 processor/retrieval/core/runtime 受影响测试并保存可重现回执，自查及独立审核，不提交。

## Task 4: 真实组合验收、解释入口与本机开发交付

**Files:** 更新 `packages/host/README.md`, `packages/web/README.md` 与本方案状态；新增 `tests/fixtures/browser/scene-memory-llm.ts`、对应受支持 profile 测试和 keyless 记录（路径以现有 harness 所属位置为准）；新增 `docs/verification/2026-10-14-scene-aware-personal-memory.md`。必要时在现有个人记忆详情增加折叠解释入口，文案走 locale，不改日常聊天主体布局。

- [ ] 启动支持的 dsh profile，用独立 DSH_HOME 与合成组织；只替换外部模型，保存实际 GenerateOptions/Session、来源和状态，验证无 @、跨群泛指、英文邮件后中文闲聊、旧任务停止、变更撤回、重启与工具读取后级联。
- [ ] 用当前已配置真实模型进行少量同样案例验收，密钥不进输出；如果环境没有可用凭据，明确记录未执行项，不以 scripted model 代替真实模型通过。
- [ ] 解释入口/日志给出来源、适用范围、更新时间依据、各层使用/遗漏信息；旧事件不能伪造日期。浏览器验收遵守此前安全限制，可使用独立离线真实组件，不重试访问已被拒绝的用户 localhost 页面。
- [ ] 运行受影响 Host/Browser/类型/文案/构建/打包路径检查，保存新任务差异包及独立最终审核；修复 Important/Critical 后再交付，不反复重复已通过且未受修改的测试。
- [ ] 验证并备份用户当前组织及 profile，使用稳定的新本地 tarball 目录经支持的 DSH 安装入口更新，逐字节验证包与配置身份，再启动本机 DSH；不发送测试消息，不降级新格式，不发布或 Git 写入。若本轮需要额外数据迁移，在交付前准确说明并保留前置备份。

## Task 5: 真实验收发现的核心事实规范化修正

2026-10-17 的真实输出表明：自由 key 使同一称呼的 A/B 无法同槽更新，旧值也会被保存为 active；来源群位置被误当成适用范围。辅助 effort 的纠正只解决无 JSON 的预算耗尽，不解决这些语义字段错误。此任务兑现原有核心约定目标，不缩减为仅能答对当前样例。

当前状态：v2 实现和受影响 keyless 检查完成；实现修复后的一次 provider run 观察到 B 替换 A、实际问答区分当前/历史、撤回后 A 恢复。但原始 Session cwd 与运行时 workspace-write 根目录都指向 DSH 源码 checkout，而非合成员工目录，故该运行不是隔离安全验收。已定位 CLI 以 `process.cwd()` 设置 profile cwd；绝对 tsx ESM loader 加 `TSX_TSCONFIG_PATH` 可在合成员工目录成功执行 `--dump-config`，并在 evaluation driver 增加早期 cwd 断言。另修复 Web communication metadata schema 漏字段，隔离 profile 重新打包后浏览器 UI 读回撤回状态和消息正文正常；5 个测试文件 184 项通过，`pnpm typecheck`、`pnpm build` 通过。测试 driver 在 UI-only overlay 中禁用，未创建 Session 或请求模型。新的请求级隔离验收仍待获准，独立审核仍未完成。Task5 scoped diff 与 manifest 已生成；用户本机未安装。

- [ ] 按计划工作区 normalization-implementation-brief.md 与 normalization-design-proposal.md 实现 v2：受控常见属性、原文锚定的其他核心偏好/持续约定、独立适用范围、当前/历史/否定和未解决关系。
- [ ] 全部同槽更新、局部例外、条件、来源顺序和撤回由有效个人来源重算；原文、旧审计和 Session 不改写，不扩大资格或执行授权。
- [ ] 所有缓存复用/进度/读取点共同换代，v1 保留可审计但不冒充当前 v2；仅现有 on-use 重建，不批量重发历史。
- [ ] 更新真实模型输入、折叠诊断、严格 wire/locale 和 scripted fixtures；以实际失败原文、确定性回归和少量真实后续轮次核对当前核心，而非只看回答正确。
- [ ] 先找出并修正受支持 profile 启动时 Session cwd 与 workspace policy 根目录不一致的原因；在获准且范围受限的新验收中确认真实请求、Session 和 workspace-write 根均为合成员工目录，不复用或重复旧场景来追求偶然通过。
- [ ] 完成受影响检查和独立任务审核后，再执行原 Task4 的本机交付；旧 stable01 包不作为本修复的交付产物。

## 执行记录

进度、任务快照、RED/GREEN、审核和裁定保存在本计划专属 `.superpowers/sdd/2026-10-14-scene-aware-personal-memory/`。由于现有未提交工作很多，任务快照和基于快照的差异比整个分支 diff 更准确；不将此前变更冒充本轮工作。
