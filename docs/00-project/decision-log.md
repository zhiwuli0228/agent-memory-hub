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
| 2026-11-15 | **V2 设计定稿**：吸收/摒弃清单（五条不抄）+ 管线投资重心移向抽取与遗忘 + journal 情景层 + day-zero transcript 索引 + 分级审批 | 调查目录两套最新分析：`E:\009workspace\design-doc\长程记忆技术分析_2026.11.15.md` + 《外部记忆管理中心原理对比与演进蓝图》（19 项目/6 路线） |
| 2026-11-15 | **ADR-0002**：workspace 零配置自动登记（git remote > 规范目录）；global 默认；domain 层降级可选（用户质疑"金字塔只有 DSH 支持"触发） | [ADR-0002](../01-architecture/decisions/ADR-0002-workspace-zero-config.md) |
| 2026-11-15 | **ADR-0010**：独立 Web 控制台（memhub serve）为一等公民（CLI 批准不可用，用户实测反馈） | [ADR-0010](../01-architecture/decisions/ADR-0010-web-console-first.md) |
| 2026-11-15 | **ADR-0011**：git-first 同步 + 触发器无关萃取协议（extract material/done；用户"不是所有人都用 dsh"） | [ADR-0011](../01-architecture/decisions/ADR-0011-git-first-sync.md) |
| 2026-11-15 | **ADR-0012**：中心枢纽 HTTP 同步（hub push/pull；用户质疑 git 协作形态后诞生，后降级为可选路径） | [ADR-0012](../01-architecture/decisions/ADR-0012-central-hub-sync.md) |
| 2026-11-15 | **ADR-0013**：无独立服务器——本地 hub 各自电脑、serve 仅本地控制台、git 服务为汇聚点 | [ADR-0013](../01-architecture/decisions/ADR-0013-no-dedicated-server.md) |
| 2026-11-15 | **ADR-0014**：闭环定案——git 中心仓=审核流水线+权威文本（MR 人审+validate 机审），腾讯风格记忆库=运行时检索（复用），memhub=本地工作站+双闸门 | [ADR-0014](../01-architecture/decisions/ADR-0014-closed-loop-review-pipeline.md) |
| 2026-11-16 | **ADR-0015**：可定义出口——memhub publish（http/exec/none），API 团队自定义；随后用户定调"接口由项目定义"→ 规范 v1（docs/02-spec）+ 参考服务端落地 | [ADR-0015](../01-architecture/decisions/ADR-0015-definable-outbound-api.md)、[规范](../02-spec/memory-hub-api-v1.md) |
| 2026-11-16 | **路径 A 定案**：部署参考服务端（examples/memory-hub-server.mjs）作为记忆库；对接文档发布 | [对接指南](../03-usage/memory-hub-deployment.md) |
