# 03-openspec — 提案产物规则

> 重大改动先提案、人批准再实施。提案放 `pending/`（hub 数据面）或本目录（工程面）。

## Proposal Rule（必要章节）

一个提案必须说明**为什么**与**改什么**：

1. **Problem** — 用户可见的问题或工程问题。
2. **Goal** — 预期结果。
3. **Scope** — 包含什么。
4. **Out of Scope** — 明确排除什么。
5. **Affected Modules** — 从 src/ 模块清单选（见 module-boundaries）。
6. **Storage Impact** — 是否影响 `hub.yaml` / `knowledge/` / `pending/` / `records/ledger.jsonl` / `records/sequences.json` / `history/`。
7. **Acceptance** — 可验证的验收标准。

## Design / Spec / Tasks

- **Design**：方案对比（至少两案）、选型理由、风险与回滚。
- **Spec**：行为规格——每个行为一条可测试陈述。
- **Tasks**：任务拆解，每项有完成定义。

## 流程

```text
提案（pending/ 或 03-openspec/）→ 人批准 → 实现（补测试）→ check 绿 → ADR 归档（若架构级）→ current-state 登记
```

设计资产的继承索引：旧仓 `docs/03-openspec/proposal-fresh-restart.md`（本仓的出生证明）、`proposal-remote-providers.md`（provider 角色模型）、`cross-host-memory-flow.md`（注入/萃取设计）。
