# Roadmap

五步走（对齐 README 表格）。每步有明确验收标准；完成一项在 [current-state.md](current-state.md) 登记。

## Step 1 ✅ 奠基（2026-11-15）

- [x] GitHub 仓库 + AGENTS.md + ADR-0001 + docs 骨架
- [x] 零依赖 frontmatter 契约解析器 + 7 格式契约测试
- [x] npm/GitHub 定名；npm 占位包待发布

## Step 2 core：存储 + 检索 + 注册表

- [ ] Hub 目录初始化与管理（含目录说明书生成，继承旧仓 PRC-000009 标准）
- [ ] 知识文件 CRUD + 原子写 + history 快照
- [ ] **冲突独立写路径**：同 topic 冲突 `[待裁决]` 冻结 + 双值展示（LTM §4.4）
- [ ] JSONL 账本（审批记录 + sequences）+ **tombstone / expires 降权 / hard-delete 通道**
- [ ] 倒排索引 + BM25-lite 检索（CJK 分词，继承旧仓 search 设计）+ **L0/L1/L2 渐进加载** + 目录限定优先
- [ ] **min_score 回放定标**（P0 实验：1.0→2.5/4.0，目标命中≤3.2、引用保持≥90%——用账本回放，不拍脑袋）
- [ ] `memory_status.metrics` 六项埋点（ready 率/平均命中/注入 token/引用来自预检/注入精度/评估分布）
- [ ] **作用域注册表（ADR-0002）**：workspace 零配置自动登记（git remote > 规范目录）+ domain 可选 + 旧 hub core_workspaces 兼容读
- [ ] 写锁租约（心跳 + 超龄回收 + fencing token，继承旧仓 ADR-0009）

验收：对真实旧 hub 目录（`E:\009workspace\dsh\dsh-plugin-dev`，45 条 accepted）只读盘点测试全绿；检索质量不低于旧仓基线。

## Step 3 transport：MCP stdio + CLI

- [ ] MCP stdio server（`memhub` 命令直接可跑；工具面见 tool-surface.md）
- [ ] CLI：search / get / status / propose / inbox / serve
- [ ] 写操作失败关闭门禁（transport 层）+ **`APPROVAL_REQUIRED` 错误码 + `approval.missing` 记录**（ApprovalPort 下沉）
- [ ] **四宿主复验**：Claude Code / Codex / opencode / gemini（旧仓 V30–V33 流程重跑，结果记入 COMPATIBILITY.md）

验收：四宿主端到端真实调用记录；无 DSH 依赖符号（静态测试守住）。

## Step 4 审批 + 面板

- [ ] `memhub serve`（loopback + Host 白名单 + 写令牌；HTTP router 与 CLI 同源）
- [ ] 面板：inbox 审批 / 知识浏览 / 检索
- [ ] **分级审批**：低风险类型批量（50 条一批）、decision/constraint 逐条——审批负担是采用杀手
- [ ] 审批 → commit → ledger 完整链路（含跨宿主：MCP propose → 面板审批）

验收：旧仓 V30 后遗留的"跨宿主写入链路未实测"在本仓闭环。

## Step 5 注入器 / 萃取器 + 冷启动

- [ ] `memhub pack`（SessionStart 静态包，~250 tokens）
- [ ] `memhub hook`（UserPromptSubmit 变化检测注入；Stable Prefix Contract）
- [ ] `memhub extract`（SessionEnd 离线萃取；红线：只写 project:<本工作区>）
- [ ] **journal 情景层**：`journal/` 可自动写、可丢弃、超期归档——与 knowledge 语义层彻底分离
- [ ] **day-zero transcript 索引**（deja-vu/cass 路线）：读磁盘已有会话记录，装上第一天就有全部历史
- [ ] **TranscriptSource + HostSpec 抽象**（memU 路线）：宿主差异 = 数据源描述，不逐宿主写适配层

验收：Claude Code 真机 hooks 配置端到端；萃取产物进 pending 且 scope 正确；新装用户 day-one 可检索历史。
