# ADR-0017: 定时萃取治理（curation）——去重、合并与老化复审

日期：2026-11-18　状态：accepted

## 背景

萃取（ADR-0011 extraction protocol）把零散材料变成提案，但提案与既有人工批准的
知识库之间**没有任何治理关系**：孪生条目会分叉、同主题改写会并存、老决策会永远
躺着无人复审。记忆是零散产出的，没有治理机制的库必然腐化。

## 决策

新增 `src/core/curate.ts`（analyzeCurate，**纯分析**）+ CLI `memhub curate`：

- **三趟扫描**：
  1. **条目级老化**（独立于提案存在——安静的周也要复审）：`updated/created`
     距今 > agingDays（默认 90）或 expiresAt 临近（默认 30 天），且 type 属于
     需要保鲜的集合（decision/constraint/knowledge/api-catalog/process）。
  2. **提案 × 已批准条目**：CJK-bigram jaccard 相似度（复用 search tokenize，
     零依赖）分诊——
     - `duplicate`（≥0.72）：批准时**携带 supersedes**，条目版本升级而非分叉；
     - `merge`（≥0.32 且同 type）：互补改写，人工二选一或合并稿；
     - 同域语义冲突（decision/constraint 与提案重叠 ≥0.5 但非重复）：老条目
       进入"结论可能已被更新"的复审清单。
  3. **提案 × 提案**：萃取重复产出（孪生提案）在人工看到之前就点名。
- **阈值经真实库标定**：逐字孪生 ≈0.74、同主题改写 ≈0.38、无关对 <0.1。
- **纯分析铁律**：curate 永不落地、永不合并、永不废弃——一切建议进分组报告
  （reports/curate-<ts>.json 持久化，可比较可审计），落地仍是人工闸门
  （批准时携带 supersedes / 单独 deprecate）。
- **调度不在插件内**：`memhub curate` 是幂等 CLI，任何调度器都能触发
  （DSH schedule_create / Windows 计划任务 / cron）。零网络原则不变。

## 老化的两条落地路径

1. **supersede**：批准新提案时 supersedes 老条目 → 版本升级，链路完整。
2. **deprecate**：`memhub` 面板/CLI 对确认过时的条目标记废弃（reason 进 ledger）。
3. **touch**：复审无误的条目更新 `last_verified`，重置老化计时。

## 后果

- 收件箱获得治理维度：重复/合并/老化分组，批准从"逐条看"升级为"按组处理"。
- `last_verified` 成为活跃度信号——库的健康度第一次可度量。
- 未做（future）：面板按分组渲染、curate 阈值 per-hub 配置化、语义向量化
  （引入网络依赖，违背本地优先，除非出现离线 embedding 方案）。
