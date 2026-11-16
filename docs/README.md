# agent-memory-hub Docs Entry

本目录是 agent-memory-hub 的项目级 Harness Context Hub，供人类与 AI agent 理解项目状态、架构、约束、提案规则、开发标准与跨宿主接入标准。

配套文档：

- [DESIGN.md](DESIGN.md) — V0.1 设计总览（指向 ADR-0001 与 design.md）。
- [KNOWLEDGE-FORMAT.md](KNOWLEDGE-FORMAT.md) — 知识 Markdown/YAML 格式契约（与 dsh-memory-hub 共享，零迁移）。
- [COMPATIBILITY.md](COMPATIBILITY.md) — 宿主兼容性验证记录（继承旧仓实测数据，新仓复验状态单独标注）。
- [00-project/decision-log.md](00-project/decision-log.md) — 按日期记录已定决策与对应文档。
- [00-project/roadmap.md](00-project/roadmap.md) — 五步路线与验收标准。
- [02-harness/harness-standard.md](02-harness/harness-standard.md) — 跨宿主接入标准：双层边界、四条接入路径、T 档、降级阶梯。

## 阅读策略

不要逐篇通读。根据任务类型选择阅读。

### 任何非琐碎改动必读

1. [AGENTS.md](../AGENTS.md)
2. [00-project/project-brief.md](00-project/project-brief.md)
3. [00-project/current-state.md](00-project/current-state.md)
4. [02-harness/README.md](02-harness/README.md) → [02-harness/harness-standard.md](02-harness/harness-standard.md)
5. [04-development/development-guide.md](04-development/development-guide.md)

### 宿主接入 / 工具面 / 注入改动

额外阅读：

1. [02-harness/interception-modes.md](02-harness/interception-modes.md)
2. [02-harness/host-capability-matrix.md](02-harness/host-capability-matrix.md)
3. [02-harness/context-policy.md](02-harness/context-policy.md)
4. [02-harness/tool-surface.md](02-harness/tool-surface.md)

### 架构改动

额外阅读：

1. [01-architecture/design.md](01-architecture/design.md)
2. [01-architecture/module-boundaries.md](01-architecture/module-boundaries.md)
3. [01-architecture/storage-contract.md](01-architecture/storage-contract.md)
4. [01-architecture/compatibility.md](01-architecture/compatibility.md)（改 frontmatter / 格式 / 类型前必读）
5. [01-architecture/decisions/](01-architecture/decisions/)（相关 ADR）

### 提案 / OpenSpec 工作

额外阅读：[03-openspec/README.md](03-openspec/README.md)。

### 模型工具 / 审批 / 检索改动

额外阅读：

1. [05-domain/knowledge-types.md](05-domain/knowledge-types.md)
2. [05-domain/scope-rules.md](05-domain/scope-rules.md)
3. [05-domain/source-ref-rules.md](05-domain/source-ref-rules.md)

### 发布 / 运维改动

额外阅读：[06-operations/release.md](06-operations/release.md)、[06-operations/security-policy.md](06-operations/security-policy.md)。

## 不变量

这四条是产品身份，不是操作习惯（与 [AGENTS.md](../AGENTS.md) 保持一致）：

- **文件是权威**：`knowledge/` 下的 Markdown / YAML / JSONL 是事实源；数据库、索引、远端服务只能是派生或通道。不引入"必须靠专有工具才能读"的格式。
- **人批准才能进 `knowledge/`**：模型可以创建 `pending/` 候选，永远不能自批；写操作在 transport 层失败关闭，不依赖宿主钩子。
- **纯文本可读可迁移**：用户能打开、diff、git 管理。
- **默认零网络**：所有远端连接默认关闭，关闭时零请求、不初始化 client、不注册定时器；无网络时核心功能全部可用。

## 方向性约定（2026-11 起，非不变量）

- **双层单向依赖（与旧仓三层不同——本仓没有 host-glue）**：`core`（零宿主依赖）→ `transport`（MCP stdio / HTTP router / CLI）。DSH 接入 = 未来独立薄包，不在本仓。见 [ADR-0001](01-architecture/decisions/ADR-0001-day-zero-principles.md)。
- **多远端按角色接入**：`feed` / `mirror` / `authority` / `index`，不按厂商接入（继承旧仓 DEC-000020 设计）。
- **多入口共享一份 API**：`memhub serve` 面板、CLI、MCP 共用同一份 HTTP router 与 config 写入路径；渲染可有两套，API 契约只能有一套。
- 服务端只允许绑定 loopback + Host 头白名单 + 写操作令牌；监听 `0.0.0.0` 直接拒绝启动。
- 检索默认 CJK 分词 + 倒排索引 + BM25-lite；向量索引若要引入，必须是**可选派生层**（可删可重建），不能成为唯一检索路径。
- 每个核心逻辑改动必须包含或更新测试；每次完成改动后，更新 [current-state.md](00-project/current-state.md)。

## 目录地图

```text
docs/
├── README.md                       # 本文件
├── DESIGN.md                       # V0.1 设计总览
├── KNOWLEDGE-FORMAT.md             # 知识文件格式契约（与旧仓共享）
├── COMPATIBILITY.md                # 宿主验证记录（继承 + 复验状态）
├── 00-project/                     # 简介、当前状态、决策日志、术语、路线图
├── 01-architecture/                # 设计、模块边界、存储契约、兼容策略、ADR
├── 02-spec/                        # 对外服务规范（memory-hub-api-v1）
├── 02-harness/                     # 跨宿主接入标准、能力矩阵、工具面契约
├── 03-usage/                       # 部署对接与定时萃取接线指南
├── 03-openspec/                    # 提案规则与产物
├── 04-development/                 # 开发、编码、测试、依赖纪律
├── 05-domain/                      # 知识类型、作用域、source_ref 规则
├── 06-operations/                  # 发布、安全、部署
└── 07-templates/                   # ADR / 提案模板
```

## 团队对接入口（部署记忆库 / 接入流程时读这里）

1. [02-spec/memory-hub-api-v1.md](02-spec/memory-hub-api-v1.md) — 记忆库服务 API 规范（服务端照此实现）
2. [03-usage/memory-hub-deployment.md](03-usage/memory-hub-deployment.md) — 参考服务端部署 + memhub publish 对接 + 端到端验证
3. [03-usage/scheduled-extraction.md](03-usage/scheduled-extraction.md) — 定时萃取循环与团队协作闭环
4. [examples/](../examples/) — 参考服务端 `memory-hub-server.mjs`、参考发布脚本 `push-to-hub.mjs`
