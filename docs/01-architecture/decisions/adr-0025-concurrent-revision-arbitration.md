# ADR-0025: 并发修订的争议隔离仲裁（D06）

## 状态
已采纳（2026-11-22，S1 试点后；随 v0.1.40 落地）

## 背景

S1 试点（`docs/04-development/s1-pilot-2026-11-22.md`）复现了决策分析文档 §9/D06
的冲突场景：两名成员对同一条目各自提交分歧修订（B 带现场证据、A 为观点修订），
后提交方经版本升级**静默覆盖**先提交方——`history/` 保留了快照（不丢数据），
但"当前真值"是 last-writer-wins，且覆盖发生时无任何告警。

分析文档 §9 的规则：**同条件且相反、证据不足 → 争议隔离，阻止自动采用相关操作结论**；
写入/晋升阶段检查同主题及相同对象；不按个人/团队/部门固定覆盖。

## 决策：结构化版本基线仲裁，不做语义裁决

仲裁不判断"谁的修订对"（那需要 LLM 或人工），只检测**并发分歧**这一个确定条件，
把它隔离出来交人工复审：

1. **提案记录基线**：`memory_propose {supersedes:[id]}` 创建提案时，自动在
   frontmatter 记录 `supersedes_base: <目标当前版本>`（propose 时本地所见）。
   目标不在本地则省略（向后兼容旧提案，不仲裁）。
2. **审批时检测**：审批（`commitProposal`，CLI/面板/MCP 三面唯一实现）发现
   `目标当前版本 > supersedes_base` → 说明提案写完后、审批前，目标已被别人推进 →
   **分歧成立**：
   - **不写入**：目标保持现状，提案保留在 inbox；
   - **可解释**：ledger 记录 `dispute.raised`（proposalId/targetId/baseVersion/currentVersion）；
   - **可人工复审**：拒绝提案，或 `--override` 显式覆盖（ledger 记录
     `dispute.overridden`，覆盖是审计过的显式决策，不是静默）。
3. **不覆盖的情形**：propose 时已基于最新版（base == current）→ 正常版本升级
   （知情修订）；跨 hub origin upsert（中心仓应用远端推送）走中心自己的评审，
   不套用本地基线仲裁。

## 为什么不是别的

| 候选 | 放弃原因 |
| --- | --- |
| 内容相似度/语义冲突判定 | 需要稳定阈值或 LLM，违背 §9.3 "先用规则"；误判比漏判危害更大 |
| 一律拒绝并发修订 | 合理的新证据修订（如补充现场）会被无谓阻塞 |
| 自动合并双方内容 | 无法确定合并顺序与取舍，产生新的错误记忆 |
| 让版本号覆盖（现状） | S1 实证：静默覆盖、无告警、当前真值不确定 |

## 联动修复（S1 收尾时同批发现）

- `.gitignore` 模板补齐 `pending/` `history/` `journal/`：这些是 per-hub 本地状态
  （待审候选、版本快照、会话流水）。S1 实证：一旦被提交进共享历史，reject/approve
  造成的增删都会变成 tracked 变更，直接卡死下一次 sync 的 pre-pull rebase。
- CLI `inbox reject` 原来只写 ledger 不删 pending 文件（队列永不排空）——补删文件。

## 验证

- 单测：`s0-correctness.test.ts`（分歧隔离 / override 审计）、`transport/cli.test.ts`
  （CLI approve 争议 exit 1、`--override` 成功、reject 删文件）、`hub.test.ts`
  （gitignore 含 pending/history/journal）。
- 真实回放（S1 成员 hub，v0.1.40）：B 基于 v4 提交修订 → A 并发推进 v5 →
  B 审批被隔离（目标保持 v5、提案保留、ledger `dispute.raised`）→
  `--override` 后 v6 落地并记录 `dispute.overridden` → A pull 收敛到 v6。
- 回归：根仓 164 passed、插件 10 passed。
