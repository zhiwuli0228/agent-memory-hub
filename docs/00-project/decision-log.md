# Decision Log

按日期记录已定决策。重大决策先写 ADR 或提案，再在此登记。

| 日期 | 决策 | 依据文档 |
| --- | --- | --- |
| 2026-11-15 | 新仓名 `agent-memory-hub`（用户拍板"先占领 npm"）；CLI/MCP server 名 `memhub` | 旧仓 proposal-fresh-restart §5（六轮收敛 + 全平台验证表） |
| 2026-11-15 | 双层架构：`core` → `transport`，无 host-glue；DSH 接入 = 未来独立薄包 | [ADR-0001](../01-architecture/decisions/ADR-0001-day-zero-principles.md) |
| 2026-11-15 | 数据兼容：直接读现有 hub 目录，零迁移；格式漂移由两仓互引契约测试防 | [compatibility.md](../01-architecture/compatibility.md) |
| 2026-11-15 | npm 占名 0.0.1（占位包已备好，待 npm 登录）；首个正式版 0.1.0 | [roadmap.md](roadmap.md) |
| 2026-11-15 | `memory_*` 工具名沿用（四宿主实测过 + 与名字词根一致） | [tool-surface.md](../02-harness/tool-surface.md) |
| 2026-11-15 | GitHub 仓库 public / MIT / main 分支 | 旧仓 positioning（公司内优先 + 公共发布照旧） |
