# Roadmap

五步走（对齐 README 表格）。每步有明确验收标准；完成一项在 [current-state.md](current-state.md) 登记。

## Step 1 ✅ 奠基（2026-11-15）

- [x] GitHub 仓库 + AGENTS.md + ADR-0001 + docs 骨架
- [x] 零依赖 frontmatter 契约解析器 + 7 格式契约测试
- [x] npm/GitHub 定名；npm 占位包待发布

## Step 2 core：存储 + 检索 + 注册表

- [ ] Hub 目录初始化与管理（含目录说明书生成，继承旧仓 PRC-000009 标准）
- [ ] 知识文件 CRUD + 原子写 + history 快照
- [ ] JSONL 账本（审批记录 + sequences）
- [ ] 倒排索引 + BM25-lite 检索（CJK 分词，继承旧仓 search 设计）
- [ ] **金字塔注册表 day 0**：workspaces + core_workspaces + parentCoreIds 配置化，MCP/CLI 共用同一份解析
- [ ] 写锁租约（心跳 + 超龄回收 + fencing token，继承旧仓 ADR-0009）

验收：对真实旧 hub 目录（`E:\009workspace\dsh\dsh-plugin-dev`）只读盘点测试全绿；检索质量不低于旧仓基线。

## Step 3 transport：MCP stdio + CLI

- [ ] MCP stdio server（`memhub` 命令直接可跑；工具面见 tool-surface.md）
- [ ] CLI：search / get / status / propose / inbox / serve
- [ ] 写操作失败关闭门禁（transport 层）
- [ ] **四宿主复验**：Claude Code / Codex / opencode / gemini（旧仓 V30–V33 流程重跑，结果记入 COMPATIBILITY.md）

验收：四宿主端到端真实调用记录；无 DSH 依赖符号（静态测试守住）。

## Step 4 审批 + 面板

- [ ] `memhub serve`（loopback + Host 白名单 + 写令牌；HTTP router 与 CLI 同源）
- [ ] 面板：inbox 审批 / 知识浏览 / 检索
- [ ] 审批 → commit → ledger 完整链路（含跨宿主：MCP propose → 面板审批）

验收：旧仓 V30 后遗留的"跨宿主写入链路未实测"在本仓闭环。

## Step 5 注入器 / 萃取器

- [ ] `memhub pack`（SessionStart 静态包）
- [ ] `memhub hook`（UserPromptSubmit 变化检测注入）
- [ ] `memhub extract`（SessionEnd 萃取；红线：只写 project:<本工作区>）

验收：Claude Code 真机 hooks 配置端到端；萃取产物进 pending 且 scope 正确。
