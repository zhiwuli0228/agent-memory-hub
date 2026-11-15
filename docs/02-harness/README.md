# 02-harness — 跨宿主接入标准

本目录回答一个问题：**"把 agent-memory-hub 接到某个 agent 运行时上"这件事，最少需要什么、最多允许要什么、缺东西时怎么退化**。

| 文件 | 职责 |
| --- | --- |
| [harness-standard.md](harness-standard.md) | 双层边界、四条接入路径、T 档判据、降级阶梯（**入口**） |
| [host-capability-matrix.md](host-capability-matrix.md) | 逐宿主能力与验证状态（三档标注，不混用） |
| [interception-modes.md](interception-modes.md) | 四条接入方式详述：代理 / 钩子 / MCP / CLI |
| [context-policy.md](context-policy.md) | 检索 vs 注入、注入预算、变化检测 |
| [tool-surface.md](tool-surface.md) | `memory_*` 工具面契约（名称冻结 + 错误语义） |

与旧仓的关系：标准从旧仓 `docs/02-harness/harness-standard.md` 演进而来（三层 → 双层）。旧仓的实测数据（V30–V33 四宿主接入）是本仓的起点基线，新仓复验后逐条升档。
