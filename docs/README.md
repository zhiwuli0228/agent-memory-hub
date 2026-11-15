# docs — agent-memory-hub

阅读策略：新会话先读 [current-state](00-project/current-state.md)，再按目录职责定位。

| 路径 | 职责 |
| --- | --- |
| `00-project/` | 项目简介（project-brief）、当前状态（current-state，每轮必更） |
| `01-architecture/` | ADR（ADR-0001 = day-0 八原则）；后续：存储契约、检索设计 |
| `02-harness/` | 宿主接入标准（奠基期空，从旧仓继承设计资产：host-capability-matrix、interception-modes、cross-host-memory-flow） |
| `03-openspec/` | 提案 |

## 继承资产（在旧仓 dsh-memory-hub，按需引用不复制）

- 设计：`docs/02-harness/`（宿主能力矩阵、接入方式、跨宿主记忆流）、`docs/00-project/positioning-2026-11-15.md`（生态位研判）
- 格式契约：`docs/KNOWLEDGE-FORMAT.md`
- 踩坑：`docs/04-development/`

格式漂移防线：两仓互引的格式契约测试（本仓 `tests/format.test.ts` ↔ 旧仓格式测试）。
