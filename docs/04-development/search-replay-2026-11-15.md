# Search Replay Calibration — 2026-11-15

> P0 实验（蓝图"一天级"清单第 1 项）：用**真实引用对**定标检索降噪机制。
> 可复现：`npx vitest run tests/replay.test.ts`（数据源 = 旧仓 ledger.jsonl，环境变量 `MEMHUB_OLD_HUB_ROOT` 可换 root）。

## 数据

- 数据源：`E:\009workspace\dsh\dsh-plugin-dev\records\ledger.jsonl`（旧仓生产账本，1117 行事件流）
- 回放对：`citation.added` 事件 117 条——`purpose`（真实查询意图句）→ `knowledgeId`（真实被引用条目）
- 索引：本仓 `buildIndex` 对旧 hub 全量 45 条（零迁移兼容同时实测通过）
- 判据（蓝图 P0）：命中数 ≤ 3.2 且引用保持 ≥ 90%

## 结果一：绝对 min_score 阈值无区分度（复现旧仓 P0-1）

| min_score | retention | avgHits | hit@1 | hit@3 |
| --- | --- | --- | --- | --- |
| 0.0 | 99.1% | 64.31 | 76.9% | 93.2% |
| 0.5 | 99.1% | 62.61 | 76.9% | 93.2% |
| 1.0 | 99.1% | 58.57 | 76.9% | 93.2% |
| 1.5 | 99.1% | 54.44 | 76.9% | 93.2% |
| 2.0 | 99.1% | 48.93 | 76.9% | 93.2% |
| 2.5 | 99.1% | 43.88 | 76.9% | 93.2% |
| 3.0 | 99.1% | 38.98 | 76.9% | 93.2% |
| 3.5 | 99.1% | 34.38 | 76.9% | 93.2% |
| 4.0 | 98.3% | 30.16 | 76.9% | 93.2% |

分数分布连续、无自然断点：阈值从 0 拉到 4.0，命中数只从 64 缓降到 30，引用保持几乎不掉——**绝对阈值（与相对阈值）都不能同时满足"命中少"和"引用保持"**。这与旧仓 [P0-1 阈值校准回放](../../../dsh-memory-hub/docs/04-development/replay-thresholds-2026-11-15.md) 的结论完全一致，在本仓独立复现。

## 结果二：top-k 截断达标

| 机制 | retention | avgHits |
| --- | --- | --- |
| **limit=3（top-3 截断）** | **93.2%** | **3.00** |

top-3 同时满足蓝图双目标（3.00 ≤ 3.2；93.2% ≥ 90%）。排序质量：hit@1=76.9%——第一名即正确引用的比例已近八成。

## 设计结论（写入实现）

1. **降噪主机制 = top-k 截断（k≤3~5）+ local_boost**，不是 min_score。
2. `min_score` 保留为参数但定位降级：仅做极低值兜底（过滤零相关），默认 0。
3. 注入场景（预检/静态包）用 limit=3 起步；主动工具调用可放宽 limit 并靠模型自己选。
4. 时间衰减/MMR/语义层等增强（蓝图 V1.0）在 top-k 之上叠加，本实验提供它们的对照基线。

## 附：格式契约发现

旧仓 `records/ledger.jsonl` 是**事件流**（`type: task.created / preflight.recorded / citation.added / proposal.* …`，1117 行），不是扁平审批行。本仓 ledger 当前为简化形状（ts/actor/action）——**契约修正**：ledger 的跨仓兼容承诺限于"knowledge 文件格式"，ledger 事件流格式不承诺跨版本兼容（新 hub 用新格式，旧 hub 只读盘点不受影响）。已同步 [storage-contract](../01-architecture/storage-contract.md)。
