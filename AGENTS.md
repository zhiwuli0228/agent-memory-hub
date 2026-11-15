# AGENTS.md — agent-memory-hub

> 本文件是给在本仓库工作的 AI agent 的操作手册。奠基日：2026-11-15。
> 设计来源：dsh-memory-hub 仓 `docs/03-openspec/proposal-fresh-restart.md`（day-0 八原则从第一天生效，不是事后补丁）。

## 角色

你是 agent-memory-hub 的协作者。它是一个**本地优先、人批准、文件原生**的跨宿主长期记忆系统：MCP stdio / CLI / 面板为一等入口，DSH 只是"又一个宿主"（未来以独立薄包接入）。

## 不变量（不能动，动之前必须先讨论）

1. **文件是权威，不是缓存**。`knowledge/` 下的 Markdown 是事实源；任何索引、数据库、远端服务都只能是派生或通道。删掉索引要能重建，删掉远端要能照常工作。
2. **人批准才能进 `knowledge/`**。模型可以创建 `pending/` 候选，**永远不能自批**。任何入口（MCP、CLI、端口面板）都必须保持"人做最终决定"；无审批能力时写入**失败关闭**，不降级。
3. **纯文本可读可迁移**。Markdown / YAML / JSONL；用户能打开、能 diff、能 git 管理。不引入必须靠专有工具才能读的格式。
4. **默认零网络**。所有远端连接默认关闭；关闭时进程不发请求、不初始化 client、不注册定时器。

## Day-0 架构原则（每条对应旧仓被实现推翻过的假设，见 ADR-0001）

1. **多宿主 day 0**：`core`（存储/检索/审批/账本）→ `transport`（MCP stdio / HTTP router / CLI）双入口同源；不存在 `host-glue` 目录，DSH 接入 = 未来独立薄包。
2. **作用域零配置 day 0（ADR-0002）**：workspace 身份 = git origin remote > 规范目录，首次使用自动登记；global 天然存在；**domain 层可选**（无配置 = project ∪ global 两层）。旧 hub 的 `core_workspaces`/`parentCoreIds` 照读兼容。MCP/CLI 与未来 DSH 包走**同一份**解析；回退必须如实标注（`workspace.exact=false`），绝不静默隐藏 project 知识。
3. **身份宿主所有 day 0**：workspace 身份由入口进程的执行上下文决定（cwd/显式参数）；模型只能选"查什么"，永远不能选"以谁的身份查"。
4. **审批门禁进 transport day 0**：写操作在 MCP/CLI 层失败关闭，不依赖宿主钩子；审批落点 = 面板/CLI inbox。
5. **注入器与萃取器一等公民**：`memhub pack` / `memhub hook` / `memhub extract` 与 MCP 同级命令。
6. **零依赖纪律**：Node 内建 + 最小依赖（yaml/zod 级），无 peer 依赖、无 native 模块；`npm i -g` 单包全功能。
7. **工具面从 MCP 规范出发**：工具名、schema、错误语义按 MCP 目录标准设计。
8. **测试即契约**：四入口共享同一套集成测试；一个行为一个测试。

## 工作流

1. 读 `docs/00-project/current-state.md`（**改动后必须更新**）。
2. 新功能 / 大改动 → 先在 `docs/01-architecture/decisions/` 写 ADR 或在 `docs/03-openspec/` 写提案。
3. 核心逻辑改动必须补/改测试；改完跑 `npm run check`（typecheck + build + test）。
4. 中文为主；技术名词、API 名、工具名、文件路径保留原样。

## 红线

- 不要给模型伪造审批的路径；不要把"自动 commit"做成可配置项。
- 不要删除用户 Hub 目录下的记忆文件，除非用户明确授权。
- 不要把整份文件或大量历史会话塞进上下文；用摘要索引 + 按需 `get`。

## 与 dsh-memory-hub（旧仓）的关系

- 旧仓 = DSH 专属插件，独立维护，**不迁移、不删除**。
- 数据兼容：本仓直接读现有 hub 目录（格式不变，零迁移）；格式漂移由两仓互引的格式契约测试防。
- 本仓吸取旧仓全部踩坑教训（edit 截断、vitest 收集期求值、npm 发布机制）——见旧仓 docs/04-development/。
