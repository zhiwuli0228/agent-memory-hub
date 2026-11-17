# MEMORY-HUB — 目录说明书

本目录是 agent-memory-hub 的事实源。所有内容都是纯文本，可用 git 管理。

| 目录 | 内容 | 谁写 | 可改性 | 删除后果 |
| --- | --- | --- | --- | --- |
| knowledge/ | 已批准的知识（按类型分目录） | 只有"人批准"路径（commit） | 条目正文可由人直接编辑；元数据改动请走工具 | 该类知识消失；索引可重建，文件不可恢复 |
| pending/ | 模型创建的候选（PRO-*.md） | 模型（propose）与萃取器 | 人可编辑后批准；可整体删除 | 候选丢失，可重新生成 |
| history/ | 每次版本变更的原文快照 | commit/update 自动写 | **只追加**，请勿改写 | 版本追溯能力丢失 |
| records/ | ledger.jsonl（审批账本）+ sequences.json（ID 序列） | 工具自动 | **只追加**（ledger） | 审计链断裂，批准历史不可证 |
| journal/ | 情景层：自动捕获的会话流水 | 工具自动 | 可整体丢弃 | 无影响（可再生成），不影响 knowledge |
| .writer.lock | 写锁租约（心跳文件） | 写锁自动 | 勿手改 | 租约超龄自动回收 |

规则：模型永远不能自批；knowledge/ 的每一次写入都在 records/ledger.jsonl 有对应记录。
