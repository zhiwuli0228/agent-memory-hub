---
name: memory-distill
description: 定时/批量把会话与事件流蒸馏成可复用的长期记忆提案（进「蒸馏审核」独立队列，人工批准后入库）。当需要执行一轮记忆萃取、补跑错过的蒸馏、或调试萃取质量时使用。不用于单条即时记录的随手提交（那用 memory_propose / memhub inbox）。
---

# memory-distill — 记忆蒸馏萃取

把「一段时间里发生的事」压缩成「以后还用得上的知识」，产出**提案**交给人工审核。
本 skill 只负责推理与提交，**绝不直接写 `knowledge/`**——入库必须经过人工批准。

## 何时使用

- 定时调度到期，需要执行一轮蒸馏（`memhub distill due` 退出码 0）
- 用户要求「补跑错过的萃取」「把最近的会话整理成记忆」
- 需要排查萃取质量（连续零产出、提案全被拒、证据不足）

## 何时不要使用

- 用户只是说了一句值得记的话 → 直接 `memory_propose`，别跑整轮蒸馏
- 需要立即落库且已有明确结论 → 走即时收件箱审批
- 没有新增事件（`distill due` 退出码 1）→ 不要空跑，说明原因即可

## 核心约束（来自调研，逐条都是硬要求）

1. **一条一结论、句句自含**：每条提案只讲一件事；脱离上下文也能读懂（前提→对象→结论→代价）。
2. **必须带证据**：每条的 `sourceRefs` 至少一条，且**引用原文片段（≤200 字）**。机器能校验的只有引文，没有引文的提案视为幻觉。
3. **负向清单优先**：不抽「可从代码/文档推导的」「一次性的临时状态」「敏感信息」「没有证据的推测」「已存在的条目」。
4. **去环境细节**：具体参数→占位符，per-env 细节→单独章节。
5. **类型决定审核等级**：`decision`/`constraint`/`api-catalog` 逐条审批；其余可批量。
6. **不重复提交**：材料里给了既有条目与待审标题，先查重再提。
7. **水位只在提交成功后推进**：中途失败不要 `distill run finish`，宁可重跑。

## 执行流程

### 第 0 步：判断该不该跑

```bash
node <hub>/dist/cli.js distill due --root <hub>
# 退出码 0 = 该跑；1 = 不跑（输出里有原因，照原因回复用户即可）
```

同时看一眼状态，确认没有积压或正在进行的运行：

```bash
node <hub>/dist/cli.js distill status --root <hub> --json
```

拒绝执行的情况：`queueDepth >= 50`（审核积压）、`inflight` 非空（已有批次在跑）、`enabled=false`。

### 第 1 步：开一个 run（批次身份）

批次身份是「蒸馏审核」独立队列的锚点，先开再干活：

```bash
RUN_ID="RUN-$(date +%Y%m%d%H%M%S)-$$"
node <hub>/dist/cli.js distill run start --root <hub> \
  --run-id "$RUN_ID" --trigger schedule \
  --meta '{"model":"<你的模型名>","promptVersion":"distill-v1"}'
```

同一 `run-id` 重复 start 是幂等的（返回 `resumed: true`），不会重复建批次。

### 第 2 步：取材料

```bash
node <hub>/dist/cli.js extract material --root <hub>
```

产出 JSON：`ledgerEvents`（增量事件）、`entries`（已入库条目）、`pendingTitles`（待审标题）、`since`、`now`。
**这一步是只读的**，同一窗口重复取应当一致。

### 第 3 步：蒸馏（本 skill 的核心推理）

按 `prompt/extract-l1.md` 的规则处理材料。要点：

- 遍历 `ledgerEvents`，找出**产生了可复用结论**的事件（决策、踩坑修复、流程确立、配置约定）
- 对每条候选，先查 `entries` 与 `pendingTitles` 是否已有 → 有则跳过或走 `supersedes`
- 为每条候选收集证据：事件 id + 原文片段
- 按类型学打标（`decision` / `constraint` / `knowledge` / `process` / `api-catalog` / `playbooks` / `assets`）
- 对照 `checklists/self-check.md` 逐条自检，不合格的直接丢弃而不是硬提

单轮候选数受 `batch.maxCandidates` 限制（默认 30）。**宁少勿滥**：审核疲劳的实证阈值是 20 条后开始盲批。

### 第 4 步：提交提案

**通过 MCP `memory_propose` 提交**（本仓库 CLI 没有 propose 命令），每条一次。必须带批次标识：

```
memory_propose({
  type: "decision" | "constraint" | "knowledge" | "process" | "api-catalog" | "playbooks" | "assets",
  title: "...",            // 一句话结论
  summary: "...",          // 自包含摘要（含前提）
  body: "...",             // 展开：结论 / 依据 / 适用范围 / 代价
  sourceRefs: ["note: <原文片段 ≤200 字>"],
  origin: "distill",       // ★ 必填
  originId: "<RUN_ID>"     // ★ 必填
})
```

`origin` 与 `originId` **任一缺失，提案就会落到日常收件箱而不是蒸馏审核队列** —— 这是最常见的接线错误。

若目标是修订既有条目而非新增，加 `supersedes: ["KNO-xxxxxx"]`，批准时会升版本而不是分裂成孪生条目。

### 第 5 步：收尾

**只有全部候选处理完毕后**才 finish：

```bash
node <hub>/dist/cli.js distill run finish --root <hub> --run-id "$RUN_ID" \
  --counts '{"candidates":<扫描到的候选数>,"proposed":<实际提交数>,"rejected":<自检丢弃数>}'
```

失败则记录，不要 finish：

```bash
node <hub>/dist/cli.js distill run fail --root <hub> --run-id "$RUN_ID" --error "<失败原因>"
```

### 第 6 步：向用户汇报

固定格式，短：

```
本轮蒸馏：扫描 N 个事件 → 产出 M 条提案（逐条审批 K 条）
人工审核入口：面板「蒸馏审核」批次 <RUN_ID>
证据示例：<一条提案的引文>
```

**不要**替用户批准。批准只能由人在面板或 `memhub inbox approve` 完成。

## 质量自检（提交前必过）

见 `checklists/self-check.md`。任一条不过就丢弃该候选。

## 常见失败模式

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 连续零产出 | 窗口内没有值得记的事，或提示词把标准定太高 | 如实汇报「本轮无新增知识」，不要编造 |
| 提案全被拒 | 抽取太细碎、缺证据、与既有重复 | 看拒绝原因，调 prompt 而不是凑数 |
| 审核队列积压 | 生成速度 > 审核速度 | 降频率/缩窗口，不要催人 |
| 提案进了日常收件箱 | 漏传 `origin`/`originId` | 撤回重提，检查接线 |

## 资源

- `prompt/extract-l1.md` — L1 抽取提示词（事件 → 原子条目）
- `prompt/merge-l2.md` — L2 合并提示词（条目 → 更高层洞察，可选）
- `schema/proposal.schema.json` — 提案输出结构
- `checklists/self-check.md` — 提交前自检清单
