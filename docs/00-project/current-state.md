# Current State

## 当前阶段

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
