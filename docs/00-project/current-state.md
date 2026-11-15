# Current State

## 当前阶段

**Step 6c 调用级端到端完成（2026-11-15，desktop profile）——发现并修复宿主工具契约两连**：`plugin_manager` 重载 + 子 agent 真调用（指向真 hub）。**第一连**：激活失败暴露 0.2.x 工具契约——`output {schema, render}` 必填 + `isConcurrencySafe()` 方法（非布尔）；对照旧插件 tool() helper 修复。修复后 **8/8 工具注册 live**（7 个撞名走 suffix → `memory_*__amh`；`memory_dejavu` 原名——旧插件 0.8.1 无此新工具，不撞名）。**第二连**：调用级 5/6 ok，`memory_get__amh` 报 "value is not lossless JSON"——宿主拒绝含显式 `undefined` 值的工具输出；新增 `assertLossless` 守护测试扫全部工具输出树，**又抓到 2 个 core 级路径**（`preflight.pack` 在 no_match 时、`lockInfo.sizeBytes` 在锁文件缺失时）→ 全部改为条件展开省略键。**95 测试全绿**（core 88 + host 7）。测试观察澄清：`acceptedCount=85` 与跨 workspace 命中**非缺陷**——旧插件写入时用相同的 cwd 推导（desktop profile 宿主 cwd），hub 内条目 scope 就是 desktop/global；`isVisible` 是硬过滤（project ∪ global）。遗留：复测 get/preflight（子 agent 进行中）；测试期 config（root=dsh-plugin-dev + suffix）通用部署时恢复 root:''。

**🎉 npm 0.1.0 首次公开发布完成（2026-11-15 20:00 +08:00）**：registry 直查确认——versions: 0.0.0-stage + **0.1.0**，dist-tags **latest=0.1.0**，shasum `3a2ef277…` 与本地构建一致，maintainer=lizhiwu。发布过程实录：用户首次 publish 误在占位目录发出 0.0.0-stage（占名成功）；真仓 0.1.0 经 EOTP 浏览器认证由用户终端完成。**临时安装验证通过**（PRC-000008 证据链：npm install 拉取成功、`memhub help` bin 工作、代码特征 grep 命中、ESM barrel 67 符号导入）。git tag `v0.1.0` 已推送。遗留可选清理：`npm unpublish agent-memory-hub@0.0.0-stage`（单版本，需用户授权）；Trusted Publisher 绑定（npmjs 网页 → Settings → 包 → 绑 zhiwuli0228/agent-memory-hub + release.yml）留待下版本配 CI 自动化。

**Step 6b DSH 真机复验完成（2026-11-15，desktop profile）**：薄包 `agent-memory-hub-dsh@file:` **已装进运行中的 desktop profile 并 active**（cordis fiber 启动、apply 执行）。补 `toolConflict` 策略（skip 默认/suffix）处理与旧插件 dsh-memory-hub 0.8.1 的 8 工具撞名——真机共存零冲突（旧插件仍 active、memory_* 工具无损、GUI 无崩溃、挂载失败不抛进宿主 loader 真机验证）。复验报告：docs/04-development/host-verification-2026-11-15.md。**92 测试全绿**（core 88 + host 6）。待重启宿主后做调用级端到端（suffix + 真 hub）；四宿主清单：desktop ✅，web/CLI/ACP 安装即验（同 bundle）。

**Step 6 DSH 宿主接入薄包完成（2026-11-15）**：`host/dsh/`（**agent-memory-hub-dsh** 薄插件，~38KB esbuild 单文件 bundle，零运行时依赖）——cordis `apply(ctx, config)` 入口 + 8 个工具壳（memory_search/get/status/preflight/propose/cite/close_task/dejavu）**全部转发 agent-memory-hub core**（一个行为一个实现）；**故意不注册 memory_commit**（失败关闭：进 knowledge/ 只走 memhub inbox/panel 人工通道）；hub 未初始化时自禁用+警告（挂载失败不抛进宿主 loader）；hubRoot 解析 config.root > $MEMHUB_ROOT > cwd。core barrel（`src/index.ts`）公开面收敛——宿主只从 barrel import。旧仓勘察结论：接入面 = cordis `ctx.tools.register` + package.json dsh manifest + cordis.patch.yml，esbuild bundle dist/index.js。

**Step 5 注入/journal/transcript 完成（2026-11-15）——core 主体全部落地**：`inject.ts`（**L0 静态包预检**：top-3 截断（回放定标）+ local_boost、`estimateTokens` 文档化估算（CJK≈1/字、ASCII 词≈1.3）、pack 渲染 `[ID] title — abstract`、`preflight.recorded` 事件与旧仓账本同构（回放脚本跨仓可用））、`journal.ts`（**情景层**：按日 JSONL 追加、可丢弃、**永不进检索**（自动捕获≠自动写入实测断言）、显式 trimJournal）、`transcript.ts`（**day-zero deja-vu 索引**：只存 token 集 + ≤160 preview + 宿主指针（正文权威在宿主，实测截断）、Jaccard 交集 ≥0.35 保守提示、rebuild 按 sessionId 去重）。MCP 工具面扩至 **11 个**（+memory_preflight / memory_journal / memory_dejavu）。**萃取设计定案**：core 不做自动规则萃取（V2 摒弃硬编码写入规则）——journal/transcript 提供原料，宿主模型读原料后走 memory_propose（人批准进 knowledge）。**88 测试全绿**；真进程冒烟：dejavu preview ✓、preflight.recorded/proposal.committed 事件落账本 ✓（PS 管线对多行 JSON 解析为工具坑）。

**Step 4 审批面板完成（2026-11-15）**：`server.ts`（**handleApi 纯函数路由**：GET /api/status·/api/inbox、POST /api/inbox/:id/approve·/api/inbox/approve(批量)·:id/reject、POST /api/search——HubError→HTTP 状态码映射，单条失败透传真实状态、批量部分失败 207）+ `panel.ts`（**零依赖单文件面板**：分级徽章（逐条审批/可批量）、批量条、只读检索，无外部 src/href）+ `http.ts`（node:http 薄适配，默认绑 127.0.0.1）+ **分级审批规则**：decision/constraint/api-catalog 逐条（批量端点 403 拒绝），其余六类可批量。CLI 新增 `serve --port --workspace`。**真进程冒烟实测**：面板 HTML ✓、MCP propose→PRO、inbox 显示 grade ✓、面板批准→DEC ✓、同 workspace 检索命中 ✓（跨 workspace 不可见=scope 正确工作；PS 5.1 Invoke-RestMethod 字符串 body ISO-8859-1 编码中文乱码是测试工具坑，用 UTF-8 字节绕过）。**70 测试全绿**。

**Step 3 transport 完成（2026-11-15）**：`mcp.ts`（**零依赖 JSON-RPC 2.0 stdio**：initialize 版本协商 / tools/list / tools/call / ping，`handleRpc` 纯函数可测 + `serveStdio` 薄壳）+ `cli.ts`（`memhub` 八子命令：init/mcp/search/get/status/inbox list·approve·reject/tools/help，`main()` 返回码化、process.exit 只在入口、KEEP_ALIVE 语义修复 stdio 循环被 exit 杀掉的 bug）+ `approval.ts`（**ApprovalPort 失败关闭门禁**：`requireApproval(channel)`——mcp-model 通道永远 E_APPROVAL_REQUIRED + approval.missing 落账本，cli-human/panel/host-prompt 通行）。八工具：memory_search/get/status/propose/commit/cite/close_task/duplicates。**端到端冒烟实测**（真进程）：MCP propose→PRO-000001、MCP commit→失败关闭+账本审计、CLI inbox approve→DEC-000001、search 命中、ledger 事件链完整（approval.missing→approve→proposal.committed）。LedgerRecord 契约事件流化（type 判别字段，回放发现落地）。

**Step 2 检索完成 + P0 回放定标实测（2026-11-15）**：`search.ts`——CJK bigram + ASCII 分词、内存倒排、BM25-lite（title×3/summary×2/tags×2 字段加权）、scope 祖先链过滤（ADR-0002 两层）、L0/L1/L2 渐进加载、type/limit/min_score 过滤、metrics 六项基础埋点。**P0 回放实验实测**：旧仓真实账本 117 条 citation.added 回放——绝对 min_score 无区分度（复现旧仓 P0-1，表落在 docs/04-development/search-replay-2026-11-15.md），**top-3 截断达标**（引用保持 93.2%、命中 3.00）→ 降噪主机制 = top-k + local_boost，min_score 降级为兜底。**旧 hub 零迁移兼容实测通过**（45 条直接索引 + 中文查询命中）。格式契约修正：旧 ledger 是事件流（type 判别），ledger 事件形状不承诺跨仓兼容（knowledge 格式承诺不变）。

**Step 2 存储基座完成（2026-11-15）**：core 五个模块落地——`hub.ts`（目录初始化 + MEMORY-HUB.md 说明书 + 扁平 hub.yaml）、`atomic.ts`（tmp+rename 原子写）、`ledger.ts`（追加式 JSONL 账本 + sequences）、`store.ts`（CRUD + history 快照 + 标题冲突冻结 + deprecate 软删 + hard-delete + pending 提案 + expires_at 软移除）、`registry.ts`（**ADR-0002 零配置身份**：git origin > 规范目录 > 合成，自动登记幂等）、`lock.ts`（**租约+心跳+超龄回收+fencing token**，继承旧仓 ADR-0009 语义）、`ids/time/errors` 基础件。设计依据 V2（design.md 吸收/摒弃清单）。

## Harness 文档框架初始化完成（2026-11-15，ff81621）：按旧仓标准同构复刻 22 个文档——docs/README（阅读策略分档+不变量+目录地图）、00-project 补齐（decision-log/glossary/roadmap 含各 Step 验收标准）、01-architecture（design/module-boundaries 含禁入符号清单/storage-contract/compatibility 策略）、02-harness 全套（harness-standard 双层化/host-capability-matrix 三档标注/interception-modes/context-policy/tool-surface 工具面冻结）、03-openspec 规则、04-development（testing-guide 契约测试纪律+旧仓五坑/dependency-policy 零依赖 allowlist）、05-domain（knowledge-types/scope-rules/source-ref-rules）、06-operations（release/security）、07-templates、根级 DESIGN/KNOWLEDGE-FORMAT/COMPATIBILITY。关键纪律：继承事实三档标注（旧仓实测=基线，本仓复验才升档）；契约测试样例只来自真实 hub。

**仓库奠基（2026-11-15）**：GitHub 仓库 `zhiwuli0228/agent-memory-hub`（public）+ 本地骨架初始化完成——AGENTS.md（不变量四条 + day-0 八原则）、README（英文门面，含 roadmap 五步）、ADR-0001（八原则正式化，每条注明旧仓教训）、project-brief（五张牌定位）、零依赖 frontmatter 契约测试（第一批种子测试）。`memory_*` 工具名沿用（四宿主实测）；CLI/MCP server 名 `memhub`。

## 命名定案

- **npm/GitHub 仓库名**：`agent-memory-hub`（用户拍板"先占领 npm"——GitHub 有同名仓库但 npm 包名当前唯一空闲，占位 0.0.1 待用户恢复 npm 登录后发布）
- **CLI bin / MCP server 名**：`memhub`
- **淘汰过程**：memorail（独占）→ memorybridge → agent-memory-bridge（npm 被逐字同赛道包占）→ agent-memory-hub（npm 空、GitHub 同名为搜索噪音，用户知情拍板）。完整验证表见旧仓 `docs/03-openspec/proposal-fresh-restart.md` §5。

## 下一步

1. `npm publish` 占名 0.0.1（等用户恢复 npm 登录——`.npmrc` 旧 token 已失效 401，凭证库无 npm 条目；账号 lizhiwu <lzw1510307303@gmail.com>）
2. Step 2：core——存储、检索（BM25-lite）、金字塔注册表（day-0 原则 2）
3. Step 3：transport——MCP stdio + CLI，四宿主复验
4. Step 4：审批 + 账本 + `memhub serve` 面板
5. Step 5：`memhub pack / hook / extract` 注入器/萃取器
