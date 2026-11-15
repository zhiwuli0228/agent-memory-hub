# Current State

## 当前阶段

**Step 2 检索完成 + P0 回放定标实测（2026-11-15）**：`search.ts`——CJK bigram + ASCII 分词、内存倒排、BM25-lite（title×3/summary×2/tags×2 字段加权）、scope 祖先链过滤（ADR-0002 两层）、L0/L1/L2 渐进加载、type/limit/min_score 过滤、metrics 六项基础埋点。**P0 回放实验实测**：旧仓真实账本 117 条 citation.added 回放——绝对 min_score 无区分度（复现旧仓 P0-1，表落在 docs/04-development/search-replay-2026-11-15.md），**top-3 截断达标**（引用保持 93.2%、命中 3.00）→ 降噪主机制 = top-k + local_boost，min_score 降级为兜底。**旧 hub 零迁移兼容实测通过**（45 条直接索引 + 中文查询命中）。格式契约修正：旧 ledger 是事件流（type 判别），ledger 事件形状不承诺跨仓兼容（knowledge 格式承诺不变）。**44 测试全绿**。

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
