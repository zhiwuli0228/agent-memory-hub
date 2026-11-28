# 记忆定时蒸馏萃取：设计提案（待确认）

> 状态：**待用户确认**，确认后才进入实现。
> 依据：`research-distill-frameworks.md`（架构，496 行/113 源）+ `research-distill-practice.md`（实践，906 行/94 源）。
> 现有基础：`extract material|done` 水位协议、`curate` 治理分析、pending→人工批准→knowledge 唯一写路径。

---

## 0. 用户需求 → 设计映射

用户原话：「界面配置不仅仅是 skill，还有定时时间，我们要做到定时触发，然后将执行结果交给使用者审核，审核以后方可入库，所以，我们的界面又要增加蒸馏审核，这个和日常的审核要分开」

| # | 需求 | 设计落点 |
| --- | --- | --- |
| 1 | 定时**时间**界面可配 | 面板「蒸馏」页签 → 调度配置表单，落盘 `config/distill.json`（结构化对象，**不生成 cron 字符串**） |
| 2 | 定时**触发** | 宿主定时器（DSH schedule）读 `config/distill.json` 决定何时跑；hub 提供 `distill due` 判断「该不该跑」 |
| 3 | 执行交给使用者审核 | skill 驱动 agent 蒸馏 → 提案带 `run_id`/`queue:distill` 落 pending → **不自动入库** |
| 4 | 审核通过方可入库 | 复用现有 `approve` 原语（禁止第二套审批代码） |
| 5 | **蒸馏审核独立入口** | 一级页签「蒸馏审核」，按 run 批次分组，与「收件箱」物理分开 |
| 6 | 提供 skill | 新增 `memory-distill` skill（SKILL.md + 资源） |

---

## 1. 三个一级入口的最终信息架构

```
一级菜单
├─ 记忆库      全部 / 待审核 / 已审核 / 已废弃  （现有：状态二级菜单 + 类型三级筛选）
├─ 蒸馏        ★新增：调度配置 + 运行历史 + 水位 + 立即试运行
└─ 审计        （现有）
     ↑
     └─ 收件箱（即时审核）  仍在「记忆库 / 待审核」下
     └─ 蒸馏审核（第二入口）★新增：独立一级页签
```

**为什么「蒸馏审核」要独立一级而不是塞进待审核**（调研实证）：
- 审核上下文不同：即时审核是「刚才这会话提的 1 条」；蒸馏审核是「一批 10–30 条，无会话上下文，必须靠批次摘要 + 证据引文判断」
- 规模不同：单次 1–5 条 vs 单批 10–30 条
- 混在一起的代价有量化案例：800 条同质请求塞一个队列 → 审核员 1 小时后整批盲批 → 340 条自动过期、200 条未审即批、15 条问题内容上线
- 经验阈值：**60% 审核员在 20+ 条后开始盖章式通过；队列约 50 条时质量开始劣化**

**数据上如何分开**（复用现有字段，不新建存储）：
- proposal frontmatter 已有 `origin` / `origin_id` → 蒸馏写 `origin: distill`，`origin_id: RUN-xxxx`
- `/api/inbox` 需**新增返回** `origin`、`origin_id`、`queue`（当前未暴露 → 第一个实现改动点）
- 蒸馏审核 = `origin=distill` 的切片；收件箱 = `origin≠distill` 的切片。**同一条 approve 代码路径**（调研建议 21：禁止为蒸馏队列另写审批逻辑）

---

## 2. 调度配置（界面对应的数据结构）

落盘 `config/distill.json`，面板表单直接映射：

```json
{
  "enabled": true,
  "schedule": {
    "mode": "weekly",              // daily | weekly | interval
    "days": ["MO"],
    "at": "09:00",
    "timezone": "Asia/Shanghai",
    "intervalHours": null
  },
  "window":  { "maxHours": 72, "maxEvents": 500 },
  "batch":   { "maxCandidates": 30, "shardEvents": 200 },
  "missed":  { "policy": "merge", "maxCatchupDays": 7, "concurrency": "forbid" },
  "trust":   { "autoPromote": false, "dailyAutoCap": 5, "autoTtlDays": 90 },
  "notify":  { "onFailure": true, "zeroOutputAlertAfter": 2 }
}
```

界面必须显示三样东西才算"可配置"（调研硬要求）：
1. **下次触发时间**（本地时区，人可读）
2. **上次运行结果**（成功/失败/零产出/耗时/提案数）
3. **立即试运行**（dry-run，不提交提案）

默认值刻意保守：
- `trust.autoPromote: false` —— **默认全部走人工审核**（符合你「审核以后方可入库」的要求）
- `missed.concurrency: "forbid"` —— 禁止并发，避免两份提案 + 水位互相覆盖
- `maxCandidates: 30` —— 单批上限，控制在审核疲劳阈值（20–50）以内

---

## 3. 蒸馏审核界面（批次卡片 + 条目决策单元）

```
┌─ RUN-20261129-0900  ✅成功 · 3m12s · prompt distill-v1 · 水位 11-22→11-29
│  窗口 72h · 事件 213 · 候选 18（冲突 2 条已置顶）
│  拒绝原因统计：重复×3 / 可推导×2 / 一次性×1
│  [回滚本批]  [整批导出]
├─ ⚠ 冲突（必须逐条，不可批量）   2 条
├─ 需逐条（decision/constraint）  5 条
├─ 可批量（knowledge/playbooks）  9 条   [全批准] [全驳回] [抽样复核]
└─ 已处置                         2 条（只读）
```

每条至少显示：`title` / `summary` / **证据引文（≤200 字原文）** / 与既有条目关系（new·extends·conflicts）/ 提出理由。

关键机制（来自调研，防橡皮章）：
- **风险置顶**：涉及 conflict / decision / constraint 的强制逐条，不允许整批
- **强制抽样**：可批量组批准时强制抽 10% 人工过目
- **队列健康指标**：显示拒绝率、最老条目年龄、盲批率（批准停留 <8s 计数）
- **backpressure**：队列 >50 条时提示「先减少下次生成量」，而不是催人审

---

## 4. 萃取 skill 设计

`memory-distill` skill，放置位置待定（仓库 `skills/memory-distill/` + 同步到 hub/DSH 可用位置）。

```
skills/memory-distill/
├─ SKILL.md              # 何时用/何时不用、五步流程、校验点
├─ prompt/
│  ├─ extract-l1.md      # 事件 → 原子条目（含负向清单、证据要求）
│  └─ merge-l2.md        # 条目 → 洞察（≥2 条证据）
├─ schema/
│  └─ proposal.schema.json
└─ checklists/
   └─ self-check.md      # 抽取后自检（去重/证据/粒度/类型）
```

SKILL.md 骨架要点：
1. `memhub distill due` 判断该不该跑
2. `memhub extract material` 取窗口材料（**校验：同一窗口两次取样必须一致，除 captured_at**）
3. 按 L1 prompt 蒸馏 → 每条必须带 `evidence` quote；跑自检清单
4. `memhub propose --origin distill --origin-id <RUN>` 提交
5. `memhub distill done` 推进水位（**仅在提交成功后**）

**核心质量门禁**（调研结论）：
- 负向清单比正向清单重要（不抽：可推导的/一次性的/敏感的/无证据的/已存在的）
- 一条一结论、句句自含、`summary` 按 contextual prefix 写
- 证据必须带原文 quote 且机器可校验
- 失效优于删除（`supersedes` / `expires_at` / `last_verified`）
- **自评置信度不可信**（模型稳定输出 0.9+）→ 分级只看外部可验证信号

---

## 5. 实现分期（确认后按此推进）

**P1 数据与 API 地基**
- `/api/inbox` 暴露 `origin` / `origin_id` / `queue`
- 新增 `/api/distill/config`（GET/POST）、`/api/distill/runs`、`/api/distill/due`
- run 记录落盘 `runs/RUN-*.json`（含窗口、模型、prompt_version、计数、状态机）

**P2 面板**
- 「蒸馏」一级页签：调度表单 + 下次触发 + 上次结果 + 试运行 + 运行历史
- 「蒸馏审核」一级页签：批次卡片 + 分级条目 + 三个健康指标

**P3 skill**
- `memory-distill` SKILL.md + prompts + schema + 自检清单
- 用真实 hub 跑一次端到端（临时 hub 验证后，再由用户决定是否上真实 hub）

**P4 调度贯通**
- 把现有写死 prompt 的 DSH 定时任务，改为「读 hub 配置 + 调用 skill」
- 幂等、错过补偿、单实例锁、零产出告警

**P5 验证发布**
- 全量测试（含 run 状态机、幂等三键、批准乐观锁）
- 发版 + 桌面/web/服务器三端部署

---

## 6. 需要你确认的决策点

1. **调度触发方式**：用 DSH 内置定时任务读 hub 配置？还是 hub 自己带一个常驻调度进程？（前者零新增进程、依赖宿主；后者跨宿主可用但要常驻）
2. **`trust.autoPromote` 默认**：我建议**默认全人工**（符合你原话）。是否保留「低风险类型自动入库（带 TTL + 日配额）」作为可选开关？
3. **skill 放哪**：只放仓库 `skills/`？还是同时注册到 DSH/hub 让其他会话也能用？
4. **L2 洞察层**（条目→更高层洞察）是否 P1 就要，还是先只做 L1（事件→原子条目）？
5. **蒸馏审核是否也做「整批批准」**：我建议低风险组可整批、高风险强制逐条，你认可吗？
