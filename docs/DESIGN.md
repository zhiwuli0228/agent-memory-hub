# agent-memory-hub — V0.1 设计总览

一句话：**一个本地服务，所有 agent 共享**——本地优先、人批准、文件原生的跨宿主长期记忆系统。

设计入口：

1. [AGENTS.md](../AGENTS.md) — 不变量四条 + day-0 八原则（产品身份与架构边界）。
2. [01-architecture/ADR-0001-day-zero-principles.md](01-architecture/decisions/ADR-0001-day-zero-principles.md) — 八原则正式化（每条注明旧仓教训）。
3. [01-architecture/design.md](01-architecture/design.md) — 双层架构、数据面、检索设计、身份规则。
4. [01-architecture/storage-contract.md](01-architecture/storage-contract.md) — hub 目录契约（与旧仓零迁移共享）。
5. [02-harness/harness-standard.md](02-harness/harness-standard.md) — 跨宿主接入标准。

出生证明：旧仓 `docs/03-openspec/proposal-fresh-restart.md`（双仓策略、day-0 动机、命名六轮收敛、数据兼容契约）。
