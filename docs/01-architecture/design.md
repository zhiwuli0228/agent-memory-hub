# V0.1 Design

> 状态：**V2 设计（2026-11-15，基于调查目录两套最新分析综合）**——`E:\009workspace\design-doc\长程记忆技术分析_2026.11.15.md`（LTM-ANALYSIS-2026.11.15 v1.0 验收稿）与《外部记忆管理中心原理对比与演进蓝图》（19 项目/6 路线/43 页）。逐项标注状态：**已实现 / 设计 / 待核**。

## 总览

```text
┌────────────────────────────────────────────────────┐
│ transport                                           │
│  mcp-stdio (memhub) · http-router (serve) · cli     │
│  审批失败关闭门禁 · 参数校验 · 错误翻译               │
└───────────────▲────────────────────────────────────┘
                │ 同一份 core API
┌───────────────┴────────────────────────────────────┐
│ core                                                │
│  五段管线（下节）· scope/registry(ADR-0002)          │
│  lock(lease+fencing) · ledger · hub-init            │
│  零宿主依赖 · 零网络（远端由注入的 client 承担）      │
└───────────────▲────────────────────────────────────┘
                │ 读/写文件（文件是权威）
        knowledge/ pending/ history/ records/ journal/
```

## 设计立场：五段管线，投资重心放在全行业的短板

调查核心发现（LTM 报告 §3.2）：**绝大多数开源方案只把 ④检索注入做精致，社区当前最严重的故障集中在 ②抽取 和 ⑤遗忘**（HaluMem：幻觉主要在抽取与更新阶段产生并累积再传播到问答；MemoryAgentBench：selective forgetting 是四核心能力之一，现有方法全部不及格）。检索是红海，写路径治理是无人区——而写路径治理正是"人批准"治理的天然位置。

| 管线段 | 业界现状 | 本仓设计 |
| --- | --- | --- |
| ① 捕获 | 源分层（真实用户输入/工具成功结果），敏感模式拦截，幂等去重 | 📐 借鉴（captureMode off/conservative/balanced/aggressive 四档） |
| ② 抽取 | **重灾区**：自由发挥产生幻觉 | 📐 **模板化受约束抽取**：只产候选、证据强制（source_refs 强证据才可入 decision/constraint）、ADD/UPDATE/DELETE/NOOP 显式操作 |
| ③ 存储 | 分裂：向量/图谱/文件 | ✅ 文件原生（权威）+ 派生索引可重建 |
| ④ 检索注入 | 全行业最精致的一段 | 📐 够用即可：BM25-lite + CJK + scope 过滤；**注入守 Stable Prefix Contract** |
| ⑤ 遗忘审计 | **重灾区**：记得太好、错了不删 | 📐 **一等公民**：expires_at/supersede/tombstone + ledger 审计 + hard-delete 通道 |

## 吸收清单（优点全收，各归 Step）

| 来源 | 采纳 | 落点 |
| --- | --- | --- |
| 蓝图 P0 | min_score 阈值回放实验（1.0→2.5/4.0：命中≤3.2、引用保持≥90%）；`memory_status.metrics` 六项（ready 率/平均命中/注入 token/引用来自预检/注入精度/评估分布） | Step 2 search 落地后立即做（一天级实验） |
| 蓝图 V0.8 | ApprovalPort 下沉：无审批实现时 commit 抛 `APPROVAL_REQUIRED` 并记 `approval.missing` | Step 3 transport 门禁（失败关闭的具体形态） |
| 蓝图 V0.8 | **TranscriptSource + HostSpec 抽象**（memU 路线）：宿主差异建模为数据源描述，不逐宿主写适配层 | Step 5 注入/萃取器 |
| 蓝图 V0.8 | keyless 默认路径（agentmemory）：无 API key 全功能 | 全程纪律（零网络+零依赖的自然结果） |
| LTM §4.6 | **Stable Prefix Contract**：注入位置稳定、字节级一致、token 硬顶（Router 前缀缓存经济性；Chroma Context Rot 反证聚焦优于全量） | context-policy.md（已写入） |
| OpenViking | L0 Abstract→L1 Overview→L2 Details 渐进加载；"Search a directory, not the whole index" | Step 2 检索分级 + scope 目录限定 |
| [C02] 冲突冻结 | 同 topic 冲突结论标 `[待裁决]` 冻结 + 双值展示，**冲突处理是独立写路径不是检索子功能**（[P09] [P11]） | Step 2 store 冲突语义 |
| LTM §4.7 | **git origin remote 作 workspace 身份**（回退规范目录）；作用域=权限边界显式存储 | ✅ ADR-0002 |
| Hindsight | retain / recall / **reflect** 三操作分离：检索与"基于记忆形成观点"是两个工具 | V1.0（reflection 蒸馏的通用化） |
| 蓝图 V0.9 | **漏斗**：自动捕获 → 离线萃取候选 → 人批准（2026 收敛：主循环只做检索+注入，抽取异步化） | Step 5 extract（红线：只进不升） |
| 蓝图 V0.9 | **分级审批**：低风险类 50 条一批、decision/constraint 逐条——解决"审批负担"这个采用杀手 | Step 4 面板 inbox |
| 蓝图 V0.9 | journal 情景层：可丢弃、超期归档（区别于 knowledge 语义层——情景可以烂，语义必须人批） | Step 5（`journal/` 目录） |
| 蓝图 V0.9 | **day-zero transcript 索引**（deja-vu/cass 路线）：读磁盘已有会话记录，装上第一天就有全部历史，不装 hook | Step 5（最便宜的冷启动解法） |
| 蓝图 V1.0 | team-server authority provider（组织记忆）；playbooks → 可安装 skill（前置：真实 playbooks 样本>0——旧仓 64 条里 playbooks=0） | 远期 |
| 蓝图 V1.0 | 可选本地语义层（向量）——前置：阈值调到极限后仍有缺口才做；MMR/键扩展/时间感知查询扩展/深召回 escalation | 远期（可选派生层） |

## 摒弃清单（五条不抄，全部有 benchmark 或不变量背书）

1. **自动 commit / 自动改写正文**——违反不变量 2；Mem0 ADD-only 的知识更新弱项已被 benchmark 证实。
2. **向量成为必需依赖**——违反可离线零强制；只能做可选派生层（可删可重建）。
3. **每轮同步抽取**——写入成本是隐形税，业界已收敛到离线巩固（2026 收敛：同步只留原始事件）。
4. **硬编码写入规则**（如"只记失败"）——Anthropic 实验 Opus 5 收益 −0.234；给判据 + 反例，不给窄指令。
5. **无上限全量注入**——MemoryAgentBench：6K→32K，GPT-4o 28%→10%。

## 与旧仓差异（本仓新增的设计决定）

| 主题 | 旧仓 | 本仓 V2 | 依据 |
| --- | --- | --- | --- |
| workspace 身份 | 注册表先登记才能用 | **零配置自动**（git remote > 规范目录） | ADR-0002 |
| domain 层 | 常设管理概念 | **可选**（无配置 = project ∪ global 两层） | ADR-0002 |
| 冲突处理 | 无独立语义（检索时新值覆盖） | **独立写路径**：冻结 + 双值展示 | LTM §4.4 [C02][P09] |
| 遗忘 | aging 90 天 + expires 降权 | + tombstone、hard-delete 通道（GDPR）、级联传播孤儿台账 | LTM §4.5 |
| 抽取 | 蒸馏提案（人驱动） | + 受约束模板抽取（候选漏斗），仍人批 | LTM §4.2 HaluMem |
| 冷启动 | 装上第一天为零 | day-zero transcript 索引 | 蓝图 V0.9 |

## 数据面（修订）

- **写路径**：capture（事件/显式调用）→ extract（离线、受约束、模板化）→ `pending/` 候选 → **人批准**（分级：低风险批量 / decision·constraint 逐条）→ commit → `knowledge/` + `history/` + `records/ledger.jsonl`。
- **journal 旁路**：`journal/` 情景层可自动写（可丢弃、超期归档），**不进 knowledge**——把"自动捕获"与"自动写入知识"彻底分离（自动捕获 ≠ 自动写入）。
- **读路径**：`search`（scope 目录限定 + BM25-lite + 渐进加载）→ `get`（L0/L1/L2）→ 引用即 ID。
- **遗忘路径**：expires 到期降权 → supersede/merge → tombstone →（授权后）物理删除 + 级联传播 + 孤儿台账。

## 检索设计（Step 2 落地）

- 分词：CJK bigram + ASCII 词干（继承旧仓实现思路）。
- 索引：内存倒排 + 启动重建；规模预案见旧仓 scale-plan。
- 过滤：scope 祖先链（ADR-0002 两层起步）+ status=accepted；**目录限定优先于全局扫**（TrieHI 方向）。
- 排序：BM25-lite + local_boost + 时间感知；**min_score 以回放实验定标**（P0：目标命中≤3.2、引用保持≥90%），不用拍脑袋阈值。
- 可观测：`memory_status.metrics` 六项从一开始就埋。

## 身份与作用域

- workspace = git origin remote → 规范目录回退 → 合成（`exact=false` 如实标注）。首次使用自动登记，名字可改。
- 祖先链：无 domains 配置 = project ∪ global；配置后 = project ∪ 上游 domains ∪ global。
- 作用域是权限边界：写落身份工作区；萃取只进不升；模型不能选身份。
