# LLM Agent 长期记忆的自动萃取/蒸馏：架构与算法调研

> 调研范围：记忆系统的**写路径**——从原始事件到持久条目的触发、取材、抽取、对账、提交与调度。
> 目标：为 agent-memory-hub 的定时蒸馏（`extract material` → agent 提案 → 人审 → 落 `knowledge/` → `extract done`）校准设计。
> 日期：2026-11-29。方法：一手论文摘要/正文 + 官方文档 + 基准数据；二手转述仅在明确标注为"批评性分析"时使用。
> 关联文档：[定时萃取接线指南](../03-usage/scheduled-extraction.md)、[DESIGN.md](../DESIGN.md)、[KNOWLEDGE-FORMAT.md](../KNOWLEDGE-FORMAT.md)。

## 结论先行

1. **写路径只有四种对账语义**：追加（ADD）、取代（supersede / temporal invalidation）、合并（merge/consolidate）、无操作（NOOP）。业界分歧不在"有没有这四种"，而在**在哪一层做**（写时 vs 读时 vs 后台）以及**由谁做**（LLM vs 代码）。
2. **Mem0 从 v2 的"写时对账"退到 v3 的"single-pass ADD-only"**，动机是延迟减半与模型容量用在理解输入而非 diff 既有状态；代价是记忆只增不减、冲突消解被推给检索。这在"本地优先 + 人审 + 文件即权威"的系统里反而是对的——前提是**我们补上显式的 supersede 提案**，而不是指望检索排序。
3. **Zep/Graphiti 是唯一把"事实失效"做成一等公民的**：四个时间戳（created/valid/invalid/expired）、矛盾时把旧边 `invalid_at` 设为新边 `valid_at`、从不删除。这是文件原生系统可以直接抄的模型（YAML frontmatter 足够表达）。
4. **Letta 已经把"文件即权威"和"后台蒸馏"走通了**：MemFS = git 仓 + Markdown + YAML frontmatter；dreaming = 后台子代理在步数阈值或上下文压缩后整理记忆，且可选"先审后写"；并发用 git worktree 而不是锁。
5. **冲突消解的关键发现是决定论优先**：MemoryAgentBench 的 FactConsolidation 上，22 个记忆系统单跳最高 60%、多跳 ≤7%；而"LLM 抽候选 + 代码 `max(serial)`"把单跳从 67.2% 提到 78.0%，说明**瓶颈在组装（assembly），不在存储**。我们的 `valid_from` + 代码比较，比让 LLM 判"哪条更新"可靠。
6. **水位不是计数器，是事务边界**：proposal 集合与水位必须一起提交/一起回滚；批准滞后于萃取时，需要 defer/rebase 语义（见 §7）。
7. **评估要自建小集**：LoCoMo/LongMemEval/MAB 评的是"答得对不对"，我们要评"抽得准不准"——用可迁移指标（提案精确率、冗余率、过期率、冲突检出率、幂等率）建 30–50 条金标集。
8. **"一批提案 + 独立闸门"这件事，记忆系统没人做好**：Mem0/LangMem/Letta 都没有持久 run 记录（LangMem 的批次甚至会被下一次消息取消掉、Letta 直接把产出写进线上记忆）；能抄的是 Zep 的 episode/saga 分组与溯源，以及数据工程界的运行账本（OpenLineage `runId` + facet、Airflow `run_id` + data interval）与通用 HITL 模式（staging + 三态决定 + 审计）。见 §9。

---

## 0. 分析框架：把"蒸馏"拆成五个决策

| 决策 | 问题 | 业界差异点 |
|---|---|---|
| **T 触发** | 何时跑一次蒸馏？ | 每次写入 / 事件数阈值 / 上下文压力 / 空闲或定时 / 手动 |
| **M 取材** | "新增内容"如何界定？ | 水位（offset/watermark）、窗口重叠、按事件 id 去重 |
| **E 抽取** | 抽成什么粒度、什么字段？ | 原子事实句（15–80 词）/ 实体-关系三元组 / 原子笔记 / 分层摘要 |
| **R 对账** | 新条目与旧条目什么关系？ | 写时对账 / 只追加 / 后台演化 |
| **C 提交** | 谁写、写哪里、失败了怎么办？ | 直接写库 / 待审队列 / 后台子代理写共享块；幂等与回滚 |

对照表（只列与本项目相关的部分）：

| 系统 | 触发 | 抽取单元 | 对账时机 | 冲突处理 | 权威存储 |
|---|---|---|---|---|---|
| Mem0 v1–v2 | 每次 `add()` | 事实句 + 滚动摘要 | 写时，第二次 LLM 调用 | ADD/UPDATE/DELETE/NOOP | 向量库 |
| Mem0 v3 | 每次 `add()` | 15–80 词自包含事实 | **不对账（ADD-only）** | 交给检索排序 + 过期/删除 API | 向量库 |
| MemGPT / Letta（旧） | 每轮对话、上下文压力（70%） | working context 文本块 | 写时，agent 自编辑 | 覆盖块内容 | 内存块 + 向量归档 |
| Letta（当前 MemFS） | 步数阈值 / 上下文压缩 / 手动 | Markdown 文件 | 后台 dreaming 子代理 | 重写、合并、retire | git 仓库 |
| Zep / Graphiti | 每个 episode | 实体 + 事实边 | 写时 | **时间失效（不删）** | 图数据库 + episode 原文 |
| A-MEM | 每次交互 | 原子笔记（含上下文/关键词/标签/链接） | 写时（链接 + 演化） | 演化覆盖邻近笔记 | 笔记库 |
| LangMem | hot path / 后台 | 事实、episode、profile | 写时 | insert / update / remove / consolidate | LangGraph store |
| MemoryBank | 每轮 | 对话 + 日摘要 + 人格画像 | 定时 | Ebbinghaus 遗忘曲线衰减 | 向量库 |
| Generative Agents | 重要性累积 > 150 | 观察 / 反思（含引用指针） | 周期（每天 2–3 次） | 追加 + 引用 | 记忆流 |

---

## 1. Mem0：从"写时对账"到"只追加"

### 1.1 v1–v2 的 ADD / UPDATE / DELETE / NOOP 机制

两阶段流水线：先由 LLM 从新消息（+ 最近若干轮摘要）抽候选事实，再由第二个 LLM 把候选事实与**检索到的相似旧记忆**逐条比较，输出四种操作之一：新事实 → `ADD`；同一主题信息量更大的替换 → `UPDATE`（保留原 id 并回填 `old_memory`）；与旧记忆矛盾 → `DELETE`；已存在或无关 → `NOOP`（实现里事件名是 `NONE`）。证据：[Mem0 论文](https://arxiv.org/abs/2504.19413)、[mem0 仓库 prompts.py 的 DEFAULT_UPDATE_MEMORY_PROMPT](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)。

判决式的要点：prompt 里明确写了"如果新事实只是换个说法（Likes cheese pizza ≈ Loves cheese pizza），不要 UPDATE"、"信息更全时才替换"——即**语义等价判定交给 LLM，且允许"保留信息量更大的一条"**。

### 1.2 v3：single-pass ADD-only 的动机与权衡

v3 把两次 LLM 调用压成一次：先检索 top-10 相关旧记忆作为"去重上下文"，然后**单次调用只抽新事实**，批量 embedding、MD5 精确去重、批量插入、再做实体抽取供检索加分。官方给的理由与收益：

- 延迟约减半（一次调用），模型容量用于"理解输入"而不是"与既有状态 diff"；
- LoCoMo 71.4 → 91.6、LongMemEval 67.8 → 93.4（+20 / +26 分）；
- `add()` 只返回 `ADD` 事件，不再有 UPDATE/DELETE。

来源：[Mem0 OSS v2→v3 迁移文档](https://docs.mem0.ai/migration/oss-v2-to-v3)。

代价官方写得很直白："ADD-only 意味着记忆会随时间累积，信息变化时新事实与旧事实并存，由检索排序把更相关、更新的信息排到前面""若需要控制记忆量，用过期时间或删除 API"。见同页与 [Memory Expiration](https://docs.mem0.ai/platform/features/memory-expiration)。

**时间感知在哪**：v3 的检索侧是语义 + BM25 + 实体匹配三路融合，**没有时间维度**；时间感知靠两处：(a) 抽取时把相对时间锚定到 `Observation Date`；(b) 元数据过滤/过期（Platform 提供 [Memory Timestamps](https://docs.mem0.ai/platform/features/timestamp)、Memory Expiration）。也就是说，"时间感知检索"在 Mem0 里是**抽取期的时间归一化 + 过滤**，不是双时态查询。

### 1.3 extraction prompt 的结构（v3，可直接对照我们的 material/instruction）

v3 的 additive 抽取 prompt 把输入切成固定小节，这个结构值得整段借用：

```
## Summary                 # 会话滚动摘要
## Last k Messages         # 紧邻的上下文（每条截断 ~300 字符）
## Recently Extracted Memories   # 上一轮已抽过的，防重复
## Existing Memories       # 既有条目（JSON 数组，供 linking 与去重）
## New Messages            # 本次新增事件
## Observation Date        # 事件发生时间：解析相对时间的唯一锚点
## Current Date            # 今天：仅用于措辞，禁止用来解析相对时间
## Custom Instructions
# Output:
{"memory":[{"id","text","attributed_to","linked_memory_ids"}]}
```

关键约束（对我们的 prompt 直接可用）：

- **粒度**：`text` 是 15–80 词、自包含、可独立检索的事实陈述；宁可多条也不要把多主题塞一条。
- **时间**：只允许相对→绝对（"上周"→具体日期），绝不允许绝对→模糊（"18 天"不许写成"一段时间"）；`Observation Date` 是唯一锚点，防止用"今天"错误解析历史对话。
- **去重**：显式禁止"回声抽取"（assistant 复述 user 已说的事实不再抽第二遍）、禁止同一响应内语义重复、禁止把既有记忆的细节污染进新抽取（新消息没提的餐厅名不许补进来）。
- **反 first-topic-dominance**：要求扫完整个窗口，多主题对话应抽 5–15 条而不是只抽开头那个主题。
- **链接**：允许输出 `linked_memory_ids`（同实体/同主题/更新/矛盾四类关系），把"关系"作为抽取的一等输出，而不是事后再算。

来源：[prompts.py（ADDITIVE_EXTRACTION_PROMPT 与 generate_additive_extraction_prompt）](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)。

### 1.4 对我们的可借鉴点

1. **ADD-only 与"文件即权威 + 人审"天然同构**：不原地改写文件、不删历史，正是 append-only 的审批流水线想要的。
2. **抽取契约可整段移植**：Observation Date / Current Date 分离、15–80 词、no-echo、no-detail-contamination、扫描全窗口，这几条直接进 instruction。
3. **"Recently Extracted" 小节**就是我们的 pending 标题清单的用途升级：不仅防重复，还能让 LLM 输出"与上轮提案 P-xx 重复 → NOOP"。
4. **实体抽取作为独立信号**（供检索加分）而不是塞进条目：我们的 `entities:` frontmatter 字段可以承担同样角色，且不依赖向量库。

### 1.5 陷阱

- **ADD-only 把冲突消解推迟到读时，而读时并不解决冲突**。MemoryAgentBench 的 FactConsolidation（人为制造"同一事实两个值、新值序号更大"）显示，Mem0 类方案只有 18.0% 单跳正确率（该评测基于 2025 年中的实现）。见 [MemoryAgentBench](https://arxiv.org/abs/2507.05257) 与 [Deterministic Recipe 论文的汇总表](https://arxiv.org/abs/2606.01435)。**结论**：追加可以，但必须同时产出 `supersede` 提案，否则"新旧并存 + 靠排序"就是已知的失败模式。
- **两次 LLM 的 v2 模式在"信息更全才 UPDATE"上极不稳定**：同一对句子，模型可能判"等价"也可能判"替换"，导致条目反复改写——这也是 v3 砍掉它的现实原因。不要在我们的人审系统里复刻这种不确定性；**改写成新提案 + 人工确认**。
- **DELETE 语义破坏可审计性**：v2 的 DELETE 是物理删除，无法回答"当时记的是什么"。我们的 `knowledge/` 只能失效、不能删。

---

## 2. Letta / MemGPT：分层记忆与"睡眠"蒸馏

### 2.1 MemGPT 的分工：core（working context）vs archival

MemGPT 把上下文当内存管理：**main context** = 只读系统指令 + 可读写 working context（固定大小，存用户/人格关键事实）+ FIFO 消息队列；**external context** = recall storage（消息库）+ archival storage（任意长度文本 + 向量检索）。控制流靠函数调用与"事件"（用户消息、系统告警、**定时事件**——后者允许 agent 无用户输入地自运行）。容量管理有明确阈值：prompt tokens 超过上下文窗口 ~70% 插入"memory pressure"告警，超过 100% 触发 flush（逐出约 50% 队列消息、生成递归摘要）。DMR 基准上 GPT-4 Turbo 从 35.3% 提到 93.4%。来源：[MemGPT 论文](https://arxiv.org/abs/2310.08560)、[HTML 正文 §2.1–2.4](https://arxiv.org/html/2310.08560v2)。

旧版 Letta 把这套产品化：memory blocks（core memory）是**常驻 prompt 的结构化片段**（label/description/value/limit，XML 形式注入，agent 通过工具自编辑），archival memory 是**按需语义检索**的向量库（agent 可 insert/search，且被设计成"agent 难以修改/删除"）。来源：[Memory blocks 文档](https://docs.letta.com/v1-sdk/memory/memory-blocks)、[Archival memory 文档](https://docs.letta.com/v1-sdk/memory/archival-memory)。

**分工原则**：需要"永远在场、可被 agent 直接改写"的少量状态 → block；量大、只按需检索的参考材料 → archival。且 archival 被刻意设为**agent 不可变**，这与我们的"knowledge 只经人批准"是同一安全直觉。

### 2.2 今天的 Letta：MemFS（文件即权威）+ dreaming（后台蒸馏）

Letta 当前架构几乎是我们设计的"平行实现"，值得逐条对照：

- **存储**：MemFS = 属于 agent 的 git 仓库，投影为真实目录；每个记忆是 **Markdown + YAML frontmatter**；根目录文件每轮注入 system prompt，带 `MEMORY.md` 索引的子目录**按需读取**（保持上下文精简）。
- **检索**：默认**没有向量索引**，靠普通文件搜索/读取；需要时安装 MemFS Search mod 才有语义/混合检索。
- **写入与并发**：每次编辑提交到 git；`dreaming` 与 `memory doctor` 这类记忆子代理**用 git worktree 并发更新**，不阻塞主 agent。
- **dreaming（原 sleep-time agents）**：后台子代理复盘近期会话、固化经验、更新记忆；触发条件是 **完成 N 个 agent step 后**或**上下文窗口被压缩时**；可选"Agent reviews before applying"——先由第二个后台会话复核修订，再落盘；`/doctor` 审计放置、重复与 system-prompt token 占用。

来源：[MemFS 文档](https://docs.letta.com/concepts/memfs)、[Memory & dreaming 文档](https://docs.letta.com/configuration/memory)。

- **sleep-time compute 的算账**：把推理挪到查询之前（预先设想用户会问什么、预计算），可在相同准确率下把测试时算力降约 5×，继续加睡眠算力还能再涨 13%（Stateful GSM-Symbolic）/18%（Stateful AIME）；同一上下文的多查询可摊销，单查询成本降 2.5×；效果与"用户查询的可预测性"强相关。来源：[Sleep-time Compute 论文](https://arxiv.org/abs/2504.13171)。

### 2.3 对我们的可借鉴点

1. **"根目录常驻 + 子目录索引按需"**：我们的 `knowledge/` 可以引入 `INDEX.md`（按 domain/scope 分组的标题+一句话摘要），让 agent 先读索引再 `get`，避免整库进上下文（与 AGENTS.md 红线一致）。
2. **dreaming 的三件套**：触发条件（步数/压缩/定时）、角色隔离（后台子代理只产候选）、复核（可选二次审）——我们可以做成 `extract run` 的两阶段：抽取 → 自检（对照 material 再核一遍证据），再进 pending。
3. **git worktree 解决并发写**：不必发明锁协议；蒸馏进程写独立 worktree/分支，人审合并。我们的 `sync push --branch` 已经是这个形状。
4. **sleep-time 的成本论证**：夜间/低峰批处理 + 批量摊销是合理的，但前提是"查询可预测"；对个人 hub，预测性来自固定主题域（domain/scope），所以**按 domain 分批跑**比一次性全量更省。

### 2.4 陷阱

- **block 覆写是 last-write-wins**：Letta 文档明确警告多进程改同一 block 会互相覆盖、且 `value` 是整体替换不是追加。任何"文件即权威"的系统都不能让人审看不到 diff 的覆写发生。
- **dreaming 无人工门**：Letta 的默认路径是后台直接更新（可选 review 但"不问你要批准"）。对个人知识库可以接受，对团队知识库不行——**我们的 pending 门不能省**。
- **过量蒸馏**：后台反复重写会引入"摘要的摘要"漂移。Letta 用 `/doctor` 审计重复与 token 超限，我们需要等价的 `memhub doctor`（重复条目、超长条目、孤儿链接、过期未失效）。

---

## 3. Zep / Graphiti：双时态图与"失效而非删除"

### 3.1 三层子图与抽取流程

Zep 的图分三层：**episode 子图**（原始消息/文本/JSON，非lossy，保留出处）→ **semantic entity 子图**（实体节点 + 事实边）→ **community 子图**（实体聚类 + 摘要）。抽取顺序：

1. **实体抽取**：处理当前消息 + 最近 n=4 条消息作为上下文（两个完整回合），speaker 自动成为实体；随后用一次"reflection"式复核降低幻觉、提高覆盖率；再抽 entity summary 供解析与检索。
2. **实体解析**：实体名 embedding（1024 维）+ 全文检索召回候选，连同 episode 上下文一起交给 LLM 判重；判重后生成新 name/summary；用预定义 Cypher 写入（不用 LLM 生成 DB 查询，避免 schema 幻觉）。
3. **事实（边）抽取**：抽带谓词的事实，同一事实可在多对实体间出现（超边）；embedding 后做边去重，**候选搜索被限制在相同实体对之间**（既防错配，也把复杂度从全图降到子集）。
4. **时间抽取与失效**：从 episode 的 `t_ref` 解析绝对/相对时间，写四个时间戳；新边可让旧边失效。

来源：[Zep 论文](https://arxiv.org/abs/2501.13956)、[HTML §2](https://arxiv.org/html/2501.13956v1)。DMR 94.8% vs MemGPT 93.4%；LongMemEval 上 GPT-4o 71.2% vs full-context 60.2%，上下文从 115k tokens 降到 1.6k，延迟 2.58s vs 28.9s（同论文 §4）。

### 3.2 双时态模型：四个时间戳

| 字段 | 含义 | 时间线 |
|---|---|---|
| `created_at` | Zep 创建该事实（边）的时刻 | 事务时间 T′ |
| `expired_at` | Zep 把该事实标记为失效的时刻 | 事务时间 T′ |
| `valid_at` | 推断该事实在世界上开始为真的时刻 | 事件时间 T |
| `invalid_at` | 推断该事实停止为真的时刻 | 事件时间 T |

论文的表述是 t′created / t′expired ∈ T′（审计用），t_valid / t_invalid ∈ T（建模世界变化用）；官方文档补充 `valid_at` 由 episode 的 `reference_time` 与内容共同推断（"Bob 一周前入职" → valid_at = reference_time − 7 天）。来源：[Zep 论文 §2.2.3](https://arxiv.org/html/2501.13956v1)、[Facts 文档](https://help.getzep.com/facts)。

**这个四元组是我们可以直接落进 YAML frontmatter 的**：`created_at`（我们写入的时间）、`valid_from`、`valid_until`（空 = 当前有效）、`invalidated_at`（我们标记失效的时间）。

### 3.3 矛盾消解：时间失效而不是删除

新边进来后，系统用 LLM 把新边与**语义相关的既有边**比较，识别矛盾；当矛盾在时间上重叠时，把旧边的 `invalid_at` 设为**新边的 `valid_at`**（而不是"现在"），并按事务时间优先新信息。原文："When the system identifies temporally overlapping contradictions, it invalidates the affected edges by setting their t_invalid to the t_valid of the invalidating edge."（[论文 §2.2.3](https://arxiv.org/html/2501.13956v1)）

官方例子：Kendra 原本爱 Adidas，后来鞋坏了、改喜欢 Puma → 系统失效"爱 Adidas"这条，并新增"Adidas 鞋坏了""喜欢 Puma"两条（[Facts 文档](https://help.getzep.com/facts)）。注意两个细节：**(a) 失效不删除；(b) 新事实可以拆成多条（事件 + 新偏好），而不是把旧条目改写。** 这正是"世界变了"与"记录变了"的分离。

### 3.4 社区摘要与"观察"（更高层蒸馏）

社区检测用 **label propagation** 而非 Leiden，理由是它支持**动态扩展**：新实体加入时归入邻居多数社区并增量更新摘要，避免每次全量重算；但增量会逐渐偏离全量结果，所以仍需**周期性全量刷新**。社区摘要是对成员节点的 map-reduce 式迭代摘要，社区名（关键词）也 embedding 以支持检索。来源：[论文 §2.3](https://arxiv.org/html/2501.13956v1)。

Zep v4 另加了一层 **observations**：从图中结构模式自动派生"跨实体的持久模式"（反复出现的偏好、承诺、状态迁移），带证据；新证据命中已有 observation 时**合并重生成**，被更新者**retire**（退役而非删除）；observations 只读、不可手改。来源：[Observations 文档](https://help.getzep.com/observations)。

对我们：这就是 **L2 蒸馏层**的现成范式——L1 是条目（事实），L2 是"洞察/模式"（例如"该用户偏好 PowerShell 而非 bash"、"这个项目每次发布前都要跑 validate"）。L2 必须有 `evidence: [KNO-xxxx]`，且被新证据取代时 retire 旧的。

### 3.5 对我们可借鉴点

1. **四时间戳 + 失效链**：`valid_from` / `valid_until` / `superseded_by` / `created_at`，旧条目不删，检索"当前视图"= `valid_until is null`。
2. **失效点取"新事实的 valid_from"，不是"处理时刻"**：否则历史查询会错（补录三个月前的变化，不该让旧条目在三个月前就失效）。
3. **矛盾候选限定在同一实体/主题**：不要全库比对；先按 `entities`/`scope` 缩小候选，再让 LLM 判矛盾。Zep 的"同实体对"限制既是正确性也是成本优化。
4. **"一次变化拆多条"**：事件（鞋坏了）+ 新状态（喜欢 Puma）分开记，避免 frankenfact。
5. **增量社区摘要 + 周期全量刷新**：我们的 `INDEX.md` 可以增量维护，但每 N 次萃取或每月做一次全量重建（`memhub reindex`）。

### 3.6 陷阱

- **LLM 判矛盾会静默丢事实**：失效是单向操作，一旦误判就再也检索不到。必须 (a) 保留原文与证据；(b) 允许人工"恢复失效"；(c) 失效提案单独一类、单独审。
- **双时态图并不自动解决冲突查询**：MAB 的 FactConsolidation 上 Zep/Graphiti 只有 7.0% 单跳（22 个系统里最低），远低于"BM25 + 代码 max(serial)"的 78.0%。作者的解释是瓶颈在**组装**，而图结构不替代组装。[Deterministic Recipe](https://arxiv.org/abs/2606.01435)、[MemoryAgentBench](https://arxiv.org/abs/2507.05257)。→ 别指望"上了图/双时态就自动对"。
- **社区摘要漂移**：增量更新后社区会逐渐偏离真实聚类，不刷新就越来越不准（论文自己承认）。任何"摘要层"都要有重建路径。
- **把图当权威**：Graphiti 的 episode 子图保留原文、语义层可重算——这才是"派生索引可重建"的正确姿势。我们更不能让图/向量成为唯一真相。

---

## 4. A-MEM / Cognee / LangMem / MemoryBank：四种组织模型

### 4.1 A-MEM：Zettelkasten 式原子笔记 + 链接 + 演化

- **模型**：每条记忆是一个结构化笔记 `m = {c 原文, t 时间, K 关键词, G 标签, X 上下文描述, e 向量, L 链接}`；新增时用 LLM 生成 `K/G/X`，用 embedding 找 top-k 邻居，再由 LLM 决定建立哪些链接；随后**记忆演化**：对新笔记的每个近邻，用 LLM 判断是否更新其 context/keywords/tags，**演化结果替换原笔记**。检索 = 向量 top-k + 同"box"（链接簇）内的邻居。
- **效果**：LoCoMo 上（GPT-4o-mini）temporal 类 F1 45.85 vs MemGPT 25.52，平均 token 2,520 vs 16,977。来源：[A-MEM 论文](https://arxiv.org/abs/2502.12110)、[HTML §3](https://arxiv.org/html/2502.12110v11)。
- **可借鉴**：把"上下文描述/关键词/标签"作为**可检索的派生字段**（我们有 frontmatter 可放），把"链接"作为抽取输出（Mem0 v3 的 `linked_memory_ids` 同理）；"演化"的思想用于 L2 洞察层。
- **陷阱**：演化是**原地替换**，没有历史、没有证据、没有人审——对文件即权威的系统是红线。正确做法：演化产出 **新版本的 pending 提案**，旧条目保留并标 `superseded_by`。

### 4.2 Cognee：ECL 流水线 + "session 蒸馏进永久记忆"

- **模型**：`remember`（文本/代码入图 + 向量）→ `recall`（路由到图/向量/代码检索）→ `improve`（富化、反馈、把 session 知识桥接进图）→ `forget`。图由实体、关系、可检索 chunk 组成；代码另建符号/依赖图。README 明确写到 **"Session distillation curates accepted lessons into permanent memory"**——即"会话里被接受的教训"才进永久记忆，这个措辞与我们的 pending→批准→knowledge 完全一致。
- **研究结论**：其论文不是架构论文，而是**超参数敏感性研究**（chunking、图构建、检索、prompt 的组合调优在 HotPotQA/TwoWikiMultiHop/MuSiQue 上有可观但非均匀的收益），并指出评估度量的局限。来源：[Cognee 仓库](https://github.com/topoteretes/cognee)、[论文](https://arxiv.org/abs/2505.24478)。
- **可借鉴**：把"抽取/分块/prompt"当**可调超参**并纳入回归评估，而不是一次写死；"improve"作为独立阶段（对应我们的 L2 归纳）。
- **陷阱**：图构建很贵且对 chunk 边界极敏感；小规模个人知识库上，图带来的收益可能抵不过复杂度（论文自己也说收益随数据集/度量漂移）。

### 4.3 LangMem：memory manager + 三种记忆类型 + 后台形成

- **模型**：`create_memory_manager` 的抽象是"输入会话 + 当前记忆状态 → LLM 决定如何扩展/合并 → 输出更新后的状态"，支持 `enable_inserts`（是否允许新增）、抽取 schema（自定义 Pydantic 模型）、以及 **profile（单文档原地更新，只保留最新状态）vs collection（不可变条目集合，按需检索）**两种形态。记忆分 semantic（事实）/ episodic（成功交互的经验）/ procedural（系统提示与规则）。写入分 **hot path（对话内，低延迟要求）**与 **background（对话后/空闲时，高召回）**。召回打分 = 相似度 + importance + strength（近期/频繁使用）。
- **可借鉴**：(a) **profile vs collection 的二分**——我们的 `knowledge/` 是 collection，但"用户偏好/项目当前状态"适合 profile 型（单文件、可被 supersede）；(b) **后台形成**明确承认"延迟换召回"，与定时蒸馏同构；(c) **importance 字段**（LLM 打分）可用于排序人审队列与决定是否值得蒸馏。
- **陷阱**：profile 型是原地覆盖，天然丢历史；`enable_inserts` 关掉就变成"只更新不新增"，容易把新事实挤进旧条目（frankenfact）。来源：[LangMem 概念文档](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)、[发布博客](https://www.langchain.com/blog/langmem-sdk-launch)。

### 4.4 MemoryBank：分层摘要 + 遗忘曲线

- **模型**：三支柱——存储（逐轮对话 + **日事件摘要 → 全局摘要** + **日人格洞察 → 全局人格画像**）、检索（双塔稠密检索 + FAISS）、更新（Ebbinghaus 遗忘曲线 `R = e^(-t/S)`：记忆强度 S 初次为 1，每次被召回 +1 且 t 归零，于是越常用越难忘）。评估用 194 条"记忆探针"问题。来源：[MemoryBank 论文](https://arxiv.org/abs/2305.10250)、[HTML §2](https://arxiv.org/html/2305.10250v3)。
- **可借鉴**：**分层摘要**（日→全局）是 L2 蒸馏最省 token 的形状；**"被召回就加强"**可以映射成"被 `memory_cite`/被引用就提升权重"，用于排序而不是删除。
- **陷阱**：遗忘=删除，且依赖"召回事件"这一我们目前没有的信号（hub 不在查询路径上）。**不要照搬衰减删除**；改成"长期未被引用 → 提示人审复核/降级"，把删除权留给人。

---

## 5. Generative Agents 的 reflection：阈值触发 + 引用式高层洞察

- **记忆流**：每个记忆对象 = 自然语言描述 + 创建时间 + 最近访问时间；检索分数 = `α_recency·recency + α_importance·importance + α_relevance·relevance`（三项 min-max 归一化，α 全为 1）；recency 是**按游戏小时指数衰减，衰减因子 0.995**；importance 在记忆创建时由 LLM 打 1–10 分；relevance 是 embedding 余弦。
- **触发**：当**最近被感知事件的重要性分数之和超过阈值 150** 时触发 reflection（实践中约每天 2–3 次）。
- **过程**：取最近 100 条记忆 → 让 LLM 生成"3 个最显著的高层问题" → 用这些问题做检索、收集相关记忆（**包括既有 reflection**）→ 让 LLM 输出"5 条高层洞察"，格式要求**逐条引用证据编号**（`insight (because of 1, 5, 3)`）→ 把洞察作为新记忆写回记忆流，并**保留被引用记忆的指针**。
- **结构**：因此反思形成**树**：叶子是观察，越往上越抽象；反思与计划都作为记忆参与后续检索。
- 来源：[Generative Agents 论文](https://arxiv.org/abs/2304.03442)、[HTML §4.1–4.2](https://ar5iv.labs.arxiv.org/html/2304.03442)。

**对我们的可借鉴点**：

1. **触发用"重要性累积"而不是单纯条数**：给每条 ledger 事件打 importance（或按事件类型默认权重：决策/纠正 > 普通操作），累计超过阈值才跑蒸馏，避免高频低价值事件淹没预算。
2. **"先提问、再检索、后归纳"**比"直接总结"质量高：L2 阶段让 LLM 先产出 3 个"这批事件里值得回答的问题"，再针对问题抽洞察。
3. **强制引用**：每条洞察必须带 `evidence` 编号（我们的 ledger event id / 既有条目 id），这与我们的 `source_refs` 规则天然一致，也能防幻觉。
4. **反思写回同一存储**：我们让 L2 洞察也进 `pending/`（type: insight），批准后进 `knowledge/`，与 L1 条目同构，可被检索、可被后续 supersede。

**陷阱**：论文自评最常见的错误是"检索失败、记忆被添油加醋（fabricated embellishments）"。反思层尤其容易"越总结越像真的"。对策：洞察必须能回溯到 ≥2 条证据、禁止引入证据外的实体/数字、人审时默认展开证据。

---

## 6. 冲突消解与去重：业界做法与坑

### 6.1 四种操作的语义边界

| 操作 | 语义 | 谁适合做 | 风险 |
|---|---|---|---|
| **ADD** | 新事实，与既有不冲突 | LLM 抽取 + 代码指纹去重 | 冗余累积 |
| **SUPERSEDE / invalidate** | 旧事实曾为真、现已不成立 | 代码比较时间 + LLM 判矛盾 | 误失效、丢历史 |
| **MERGE / consolidate** | 多条讲同一件事，合成信息更全的一条 | 仅人审（或 LLM 提案 + 人审） | frankenfact、丢细节 |
| **NOOP** | 已存在/无价值 | LLM 判等价 + 代码精确匹配 | 漏抽 |

Mem0 v2 的 prompt 把 UPDATE 定义为"信息更全时替换"、DELETE 定义为"矛盾时删除"（[prompts.py](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)）；Zep 用 SUPERSEDE（时间失效，不删）；LangMem 用 update/remove/consolidate；A-MEM 用"演化覆盖"。**没有一家把 MERGE 全自动化的**——这本身是信号。

### 6.2 决定论优先：能算的不要问 LLM

MemoryAgentBench 把"冲突消解"定义为：检测并解决既有知识与新信息之间的矛盾，其 FactConsolidation 任务里事实带序号、明确告知"新事实序号更大"。结果：22 个系统中单跳最高 60%（GPT-4o 长上下文），多跳 ≤7%；Zep/Graphiti 7.0%、Mem0 18.0%、MemGPT/Cognee 28.0%、HippoRAG-v2 54.0%。而"BM25 检索 + LLM 只抽候选 + 代码 `max(serial)`"达到 78.0%（gpt-4o-mini）/94.8%（gpt-4o），多跳 30.2%。作者归因两种 LLM 失效模式：**先验覆盖**（训练数据里的"常识"压过上下文里的新值）与**序号比较漂移**（候选一多就记错哪个最新）。跨基准检验：换成 `max(timestamp)` 在 LongMemEval knowledge-update 上只能打平 LLM 判断（57.8% vs 64.4%），说明**确定性聚合只适用于"当前值"类问题**，Yes/No、历史回溯、聚合类仍需问题类型感知。来源：[MemoryAgentBench](https://arxiv.org/abs/2507.05257)、[Deterministic Recipe](https://arxiv.org/abs/2606.01435)。

对我们的含义：
- "哪条更新"由代码按 `valid_from`/事件序号决定，LLM 只负责"这两条是否在讲同一件事/是否矛盾"。
- 冲突消解要**按问题类型分流**：当前值查询走确定性；"以前是什么"走历史视图（`valid_until` 非空）；不要用一套逻辑打天下。

### 6.3 去重的三档

1. **精确**：内容 hash / 规范化标题（Mem0 v3 用 MD5）；成本 0，召回低。
2. **近似**：标题+实体集合规范化、SimHash/BM25、embedding 余弦阈值；成本低，需要阈值调参。
3. **语义**：LLM 判"是否同一事实、信息量谁更大"；成本高，只对前两档的候选做（Mem0 v3 用 top-10 既有记忆做去重上下文；Zep 把候选限制在同实体对）。

**坑**：embedding 相似 ≠ 同义——"喜欢咖啡"与"讨厌咖啡"余弦很高；只靠阈值会误合并。反之只靠 hash 会漏掉改写。必须"代码粗筛 + LLM 细判 + 人审兜底"。

### 6.4 十个高频坑（按危害排序）

1. **原地 UPDATE/演化 = 静默丢历史**（A-MEM evolution、LangMem profile、Letta block 覆写）。文件即权威的系统必须 append-only + `superseded_by`。
2. **让 LLM 判"哪个更新"**，而系统里明明有确定的时间戳/序号（§6.2 证据）。
3. **细节污染**：新消息没提的细节从既有条目"补"进来（Mem0 把它列为 integrity rule 明令禁止）。
4. **时间语义混用**：事件时间（valid time）、写入时间（transaction time）、观察时间三者的区别不写进 schema，后期无法做历史查询。
5. **相对时间未锚定**："上周""最近"直接入库，三个月后就是错的（Mem0 用 Observation Date 锚定，且禁止用"今天"解析历史）。
6. **去重只做一档**（只 hash 或只 embedding）。
7. **MERGE 自动化**：把两条不同来源的偏好合成一条，事后无法拆开。
8. **失效无证据/无恢复路径**：误判后无法回滚。
9. **粒度过粗**：一条塞 3 个主题，无法精确 supersede，也无法链接。
10. **只追加不整理**：冗余率随时间上升，检索精度下降（ADD-only 的债，官方文档自己承认需要 expiration/delete 兜底）。

---

## 7. 增量、水位与调度

### 7.1 三种交付语义与"幂等消费者"

Kafka 的框架可以直接借用：**at-most-once**（先提交位点再处理，崩溃丢消息）、**at-least-once**（先处理再提交位点，崩溃会重复处理，因此消费者必须幂等）、**exactly-once**（位点与输出在同一事务里提交）。Kafka 默认至少一次，靠消息主键让重复写入变成覆盖（幂等）。来源：[Confluent: Kafka Message Delivery Guarantees](https://docs.confluent.io/kafka/design/delivery-semantics.html)。

我们的 `extract material` / `extract done` 就是"消费位点"：**默认只能做到至少一次**（propose 成功但 done 失败 → 下轮重复提案）。所以必须：
- proposal 带 `run_id` + `watermark`，重复提案可被检测/合并；
- `extract done` 用 **CAS**（携带期望的旧水位），并发/重复调用直接失败而不是推进两次；
- 若"提案集合与水位"需要原子提交，用 outbox 思路：**先把"本轮提案清单"写进账本，再推进水位**，两者在同一文件/同一提交里；relay 可能重复投递，故消费侧（propose）必须幂等。来源：[Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)。

### 7.2 增量计算的经典模式（dbt）

dbt incremental 的三件套与我们的水位逻辑同构：
- `is_incremental()` 决定是否只处理增量；
- 过滤条件通常是"目标表里最大时间戳"（`where event_time >= (select max(event_time) from this)`），**用 `>=` 而不是 `>`**，以纳入与上次同一时间戳的迟到行；
- 定义 `unique_key` 后走 merge（存在则更新、不存在则插入），否则 append-only 会重复；
- 逻辑变更时要 **full-refresh**（全量重跑）。
- 边界坑：`event_time` 为 NULL 或表被截断时条件恒真 → 会全量加载。

来源：[dbt: Configure incremental models](https://docs.getdbt.com/docs/build/incremental-models)。

映射到我们：水位不要只存"最后时间戳"，而应存 **(last_event_id, last_ts, 已处理事件 id 集合/去重窗口)**；窗口取 `last_ts - lookback` 起步、按 event id 精确去重；prompt/instruction 变更时提供 `extract run --full` 做受控全量重跑。

### 7.3 触发与调度

| 触发方式 | 代表 | 适合我们的场景 |
|---|---|---|
| 每次写入即跑 | Mem0 `add()` | 实时性要求高、成本敏感度低 |
| 事件数/重要性阈值 | Generative Agents（重要性累积 150） | 高频低价值事件多时，避免空跑 |
| 上下文压力 | MemGPT（70% 告警 / 100% flush） | 会话型宿主，适合"快满了再蒸馏" |
| 空闲/定时/压缩后 | Letta dreaming（步数或压缩触发）、sleep-time compute | 本地 hub：夜间定时最自然 |
| 手动 | 所有系统的"再整理"命令 | 必须保留：`extract run --dry-run` / `--since` |

**工程要点**：
- **单飞锁 + lease**：同一 hub 同时只允许一个蒸馏进程（`.memhub/locks/extract.lock`，带 pid + 过期时间），崩溃后 lease 过期可被接管。
- **失败恢复**：propose 是逐条命令，天然可重入；用 `run_id` 记录"本轮已提案哪些"，重跑时跳过已存在的指纹。
- **预算上限**：单轮 token/条目上限（如 material ≤ 50k tokens、提案 ≤ 30 条），超限分片并顺延水位。
- **避开同步窗口**：`sync pull/push` 与 `extract` 不要并发跑（同仓 git 操作会打架）；蒸馏写独立 worktree/分支。

---

## 8. 评估：benchmark 怎么评，我们该借哪些指标

### 8.1 四个基准的分工

| 基准 | 规模/形态 | 评什么 | 对我们的价值 |
|---|---|---|---|
| **DMR**（MemGPT 提出） | 500 段 MSC 多会话对话（5 段 × ~12 条），每段 1 个 QA | 单跳事实召回；指标 = 准确率 + ROUGE-L + LLM judge | 太简单：full-context 基线已 98%（Zep 论文实测），只适合做冒烟 |
| **LoCoMo** | 平均 300 轮 / 9K tokens / 最多 35 段会话；QA 含单跳、多跳、时序、开放域、对抗不可答 | 长程对话记忆；另有事件摘要与多模态生成任务 | QA 分类可直接借来做我们的"抽取是否够用"的回归集 |
| **LongMemEval** | 500 题，haystack 平均 ~115k tokens；5 项能力：信息抽取、多会话推理、时序推理、**知识更新**、弃答 | 长程助手的记忆能力；拆成 indexing / retrieval / reading 三阶段 | "知识更新"与"弃答"正好对应我们的 supersede 与"不瞎编" |
| **MemoryAgentBench** | 4 项能力：准确检索、测试时学习、长程理解、选择性遗忘；FactConsolidation 造矛盾 | **冲突消解**：检测并解决新旧矛盾 | 我们最该借的评测：注入矛盾看系统选不选新值 |

来源：[MemGPT 论文 §3.1](https://arxiv.org/html/2310.08560v2)、[Zep 论文 §4](https://arxiv.org/html/2501.13956v1)、[LoCoMo](https://arxiv.org/abs/2402.17753)、[LongMemEval](https://arxiv.org/abs/2410.10813)、[MemoryAgentBench](https://arxiv.org/abs/2507.05257)。

Common 结论：**benchmark 分数不等于萃取质量**。这些基准大多把"记忆系统"当黑盒、用 QA 准确率代理；Mem0 论文用的是 LLM-as-a-Judge + 延迟/Token，Zep 用的是 top-k 边/实体拼上下文。我们评的是中间产物（proposal），必须自定义指标。

### 8.2 可迁移到"萃取质量"的指标

| 指标 | 口径 | 采集方式 | 目标 |
|---|---|---|---|
| **提案精确率** | 批准 / 总提案 | pending 队列统计 | ≥70%（低于则 prompt 或阈值有问题） |
| **召回代理** | 金标事实被抽中的比例 | 30–50 条金标 eval set + 注入事件 | ≥80% |
| **冗余率** | 语义重复条目对数 / 100 条已批准 | 批准后跑 near-dup 检测（标题+实体+embedding/LLM） | <5% |
| **过期率** | 已失效但未标 `valid_until` 的条目占比 | 定期审计：新事件与旧条目冲突数 | <2% |
| **冲突检出率** | 注入 k 组矛盾，正确产出 supersede 的比例 | 受控注入（仿 FactConsolidation） | 单跳 ≥80% |
| **幂等率** | 同窗口重跑产生的新增提案数 / 首次提案数 | 重跑同一 `run_id` | =0 |
| **证据完备率** | 带 ≥1 条 ledger event 引用的提案占比 | proposal 校验 | 100% |
| **单位成本** | token / 每批准条目；人审分钟 / 每条 | 计量 | 持续下降 |
| **弃答正确率** | 无可抽内容的窗口，提案数应为 0 | 空窗口回归 | 100% |
| **下游可用性** | 固定 50 题 QA 集（LoCoMo 风格）准确率 | 用 `pack` 注入后测 | 不退化 |

**建 eval set 的方法**：从 ledger 里挑 5–10 个真实时间段，人工写"应该被抽出的条目"（含应 supersede 谁）；再**程序化注入 10 组反事实**（同一事实给新值，仿 MQUAKE/FactConsolidation 的做法），用来测冲突检出。每次改 instruction/模型/粒度，跑一遍全套并把数字记进变更记录。

---

## 9. 批次与审核闸门（batch & human gate）

> 需求约束：一次蒸馏运行 = 一批提案；提案进**独立于日常审核的第二队列**；必须人审通过才入库；闸门不可绕过。
> 本节回答四个问题：运行怎么建模、Letta 的产出先落库还是先待审、水位与批次如何对齐、产出如何溯源。

### 9.1 业界怎么建模"一次运行"

| 系统 | 运行单元 | 有持久 run 记录？ | 元数据 | 与产出的关联 |
|---|---|---|---|---|
| **Mem0** | 一次 `add()` 调用 | **没有** | 仅条目自身 `created_at`/`updated_at`（Platform 另有 Memory Timestamps） | 响应体 `results[]` 即凭据，落库后只剩条目；防重靠正文 MD5 精确去重，不是 run 幂等 |
| **LangMem** | 一个可取消的延迟任务 | **没有** | 待处理消息列表（内存态） | `ReflectionExecutor` 按线程维护 pending 队列，新消息到来**取消旧任务并用新消息重排**（debounce 30–60 分钟）；取消即丢弃该批 |
| **Letta** | 两次 dreaming 之间的后台会话 | **没有**（只有 git commit 与对话记录） | 触发原因（步数阈值/上下文压缩）、可选"先审后写" | 产出直接更新 MemFS；可追溯性由 git 历史承担；`/doctor` 只审放置/重复/token，不审批次 |
| **Zep / Graphiti** | **episode**（可显式传 `uuid`），另有 **saga**（有序 episode 组） | 部分（episode 节点持久，saga 可 `summarize_saga` 出滚动摘要） | `reference_time`（事件时间）、`source_description`、`source` 类型、`group_id`、`previous_episode_uuids`（显式上下文窗口）、`saga`/`saga_previous_episode_uuid` | 边↔episode 双向索引，可回指来源 |
| **OpenLineage**（非记忆系统，但正是"运行账本"标准） | `Run`（客户端生成 `runId`，建议 UUIDv7） | **是** | run facet：`nominalTime`、`parent`、`errorMessage`；job facet：`sourceCodeLocation`（含 git SHA）；dataset facet：`version`、`outputStatistics`（输出行数） | 每次 RunEvent 携带输入/输出 dataset，状态机 START/COMPLETE/FAIL/ABORT |
| **Airflow DAG Run** | 一次调度实例 | **是** | `run_id` + `data_interval_start/end`（输入窗口）+ `logical_date`；支持 catchup/backfill 补跑历史窗口 | run 持有其 task 实例与状态 |

来源：[Mem0 v3 迁移](https://docs.mem0.ai/migration/oss-v2-to-v3)、[Mem0 prompt 源码](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)、[LangMem 延迟后台处理](https://langchain-ai.github.io/langmem/guides/delayed_processing/)、[Letta Memory & dreaming](https://docs.letta.com/configuration/memory)、[Letta MemFS](https://docs.letta.com/concepts/memfs)、[Graphiti MCP 工具定义（add_memory / saga / 串行处理）](https://github.com/getzep/graphiti/blob/main/mcp_server/src/graphiti_mcp_server.py)、[OpenLineage 对象模型](https://openlineage.io/docs/spec/object-model/)、[Airflow Dag Runs](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html)。

**关键结论**：记忆系统普遍**缺运行账本**——Mem0/LangMem/Letta 三家都没有持久 run 对象，只有 Zep 的 episode+saga 接近；而数据工程界（OpenLineage/Airflow）早已把它标准化。我们必须自己补这一层，而且它恰好能用文件实现（不需要数据库）。

### 9.2 Letta：先落库还是先待审？有没有影子记忆 / staging？

- **早期 sleep-time agents 是双 agent 架构**：`primary agent` 不持有编辑 core memory 的工具，这些工具挂在 `sleep-time agent` 上；后者同时管理 primary 的上下文记忆与自己的。它以 **"anytime" 方式改写记忆**——primary 随时可能读到半成品。**没有暂存区、没有人工确认。**
- **当前 dreaming**：后台子代理复盘近期会话并**直接更新 MemFS**（git 提交即生效）；可选 "Agent reviews before applying" 是**第二个模型会话**做复核，不是人；并发用 git worktree 而不是锁。
- 所以 Letta 的"staging"实质是 **git 工作区 + commit**：未提交的编辑算暂存，提交即发布。这套在我们这里不成立——**我们的发布点必须是人，而 commit 由 agent 产生**。
- **可抄的形状来自通用 HITL（非记忆系统）**：生成区（无发布权）→ **输出暂存区 output staging（把 AI 速度与审核节奏解耦）**→ 不可变源归档（保留原文 + 审计轨迹：时间戳、模型版本、prompt hash）→ 审批闸门（Approve / Edit-then-Approve / Reject 三态，全部审计，超时自动升级）→ 下游只能经闸门访问。

来源：[Letta: Sleep-time Compute 博客（双 agent、anytime 写入、频率与模型可独立配置）](https://www.letta.com/blog/sleep-time-compute/)、[Sleep-time Compute 论文](https://arxiv.org/abs/2504.13171)、[Memory & dreaming](https://docs.letta.com/configuration/memory)、[Human-in-the-Loop Approval Gates 模式](https://microsoft.github.io/ai-cheatcode/interactive/issue-005/)。

**结论**：记忆系统里**没有现成的 shadow memory 模式可抄**；能抄的是通用 HITL 的分层：独立暂存区 + 三态决定 + 源归档 + 下游不可绕过闸门。

### 9.3 水位与批次：窗口边界、重跑幂等

- **窗口边界怎么定**：Airflow 用调度定义的 `data_interval`；dbt incremental 用"目标表最大时间戳 + `>=`"（含同一时间戳的迟到行）；LangMem 用"消息静默期"；Graphiti 用 `previous_episode_uuids` 显式指定上下文。**没有一家用裸时间戳单点水位界定窗口**——时间戳不可靠（乱序、补录、同刻多条）。
- **我们应取**：`window = (from_event_id, to_event_id]` + lookback（重放上批尾部 1–2 条做上下文），按 event id 集合去重；时间戳只用于排序与展示。
- **幂等三重键**：`run_key`（窗口 + 条目快照 hash + prompt 版本 + 模型）、`proposal_key`（run + kind + target + 规范化正文）、正文内容 hash（Mem0 的 MD5 做法）。重跑同窗口 → 命中既有 `run_key` → **resume 既有 run 只补缺**，不新建批次。
- **失败恢复**：append-only run 账本（每次状态转换写一行 JSONL，仿 OpenLineage 的 START/COMPLETE/FAIL/ABORT + 计数 facet），保证可 replay 出"这批提了什么、批了什么、拒了什么"。
- **原子性**：outbox 模式的核心是"业务状态与要发出的消息写在同一事务，relay 可能重复投递故消费侧必须幂等"。映射到我们：**run 文件 + 账本行 + 水位三者必须在同一次落盘里写完**，杜绝"提了案但水位没记"或反之。

来源：[dbt incremental models（`>=` 与 late-arriving rows）](https://docs.getdbt.com/docs/build/incremental-models)、[Airflow data interval / backfill](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html)、[LangMem ReflectionExecutor 去抖](https://langchain-ai.github.io/langmem/guides/delayed_processing/)、[Kafka 交付语义（at-least-once 与幂等消费者）](https://docs.confluent.io/kafka/design/delivery-semantics.html)、[Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)。

### 9.4 溯源：产出怎么回指"哪次运行、哪些源事件"

- **一手参照是 Zep/Graphiti**：episode 是原文载体；episodic 边把 episode 连到实体/事实，并建**双向索引**（既能从事实回指来源做引用，也能从 episode 找回它产出的事实）。MCP 暴露 `get_episode_entities(episode_uuids)` 专门"给 episode 找产出"，而 `delete_episode` **只级联删除该 episode 单独创建的实体/事实**——被多个 episode 共同支持的事实会保留。这个"多来源支持 vs 单一来源"的区分是很少人注意到的精确点。
- **标准词汇**：W3C PROV 的 entity / activity / agent，关系 `wasGeneratedBy` / `used` / `wasDerivedFrom` / `wasAttributedTo`；OpenLineage 的 RunEvent + 输入/输出 dataset + `outputStatistics`。
- **我们落成**：proposal 与 knowledge 上记 `run_id`、`evidence: [{event_id, span}]`、`prompt_version`、`model`；run 文件记 `window`、`counts`、`duration_ms`、`token_usage`。span 用 `{event_id, offset, length}` 或 ≤200 字引文，足够做审计与"召回质量分析"（哪次运行/prompt 产出的条目后来被 supersede 最多）。

来源：[Zep 论文 §2.1（episodic 边与双向索引、可引用回源）](https://arxiv.org/html/2501.13956v1)、[Graphiti MCP（`get_episode_entities` 溯源、`delete_episode` 级联仅限独占产物）](https://github.com/getzep/graphiti/blob/main/mcp_server/src/graphiti_mcp_server.py)、[W3C PROV-Overview](https://www.w3.org/TR/prov-overview/)、[OpenLineage Run/Dataset 模型](https://openlineage.io/docs/spec/object-model/)。

### 9.5 我们该长什么样（一张对照表）

| 关注点 | 业界做法 | 我们的落点 |
|---|---|---|
| 批次身份 | OpenLineage `runId` / Airflow `run_id`；Mem0/LangMem/Letta 无 | `runs/RUN-<ts>-<rand>.json` + `runs/ledger.jsonl`（append-only，可 replay） |
| 输入窗口 | Airflow data interval / Graphiti `previous_episode_uuids` | `window{from_event_id, to_event_id, lookback}`，按 id 集合去重 |
| 产出归属 | Graphiti 边↔episode；OpenLineage output dataset | proposal `run_id` + `evidence[]`；knowledge `extract_run` |
| 暂存区 | HITL：output staging（与生产解耦） | `pending/inbox/distill/`（第二队列），与 `pending/inbox/` 物理分目录、共用 approve 原语 |
| 闸门 | Approve / Edit-then-Approve / Reject 三态 + 审计 + 超时升级 | 同一套三态；reject 必带原因码；编辑使待批失效 |
| 水位推进 | dbt `unique_key` merge / Kafka offset 与输出同事务 | `open_watermark`（已取料）与 `committed_watermark`（已结案）分离，仅 `closed` 才推 committed |
| 重跑 | Airflow backfill / dbt full-refresh | 同 `run_key` resume；`--full` 受控重放并标记 `parent_run` |
| 度量 | WorkOS：拒绝率 + 最老条目年龄 | 面板在批次页直接显示这两个数（防橡皮章与积压） |

**两条来自真实运营的警告**（WorkOS 的公开复盘）：(a) **橡皮章**——若某队列接近 100% 通过率，闸门就成了表演，应提高标准或不再称其为控制点；(b) **排空率**——产出速度超过审核速度只是把瓶颈搬了个位置，要看"最老条目年龄"并下调生成量。这两条正好是我们第二队列的验收指标。

来源：[WorkOS: Curating queues beats approving actions（批次入队、队列内去重、拒绝率/最老年龄、编辑使待批失效）](https://webflow.workos.com/blog/curating-queues-beats-approving-actions)、[HITL 审批闸门模式](https://microsoft.github.io/ai-cheatcode/interactive/issue-005/)、[AWS Step Functions Wait-for-Callback（闸门挂起 + 心跳超时，避免无限等待）](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html)。

---

## 10. 架构层设计建议清单（可执行）

> 编号即优先级；每条给"怎么做 + 验收"。与现有命令对齐：`extract material` / `propose` / `inbox approve` / `validate` / `extract done`。

1. **proposal 增加类型与目标**：`kind: add | supersede | merge | invalidate`，`target: KNO-xxxx`（supersede/merge/invalidate 必填），`evidence: [event ids]`，`run_id`，`watermark`。验收：缺 `evidence` 或 supersede 缺 `target` 时 `memhub validate` 失败。
2. **knowledge frontmatter 补时间四元组**：`created_at`、`valid_from`、`valid_until`（空=有效）、`superseded_by`，外加 `source_refs`、`extract_run`、`prompt_version`。验收：`memhub pack` 只注入 `valid_until` 为空的条目；历史视图可查询。
3. **抽取契约写进 instruction**（可直接抄 Mem0 v3）：15–80 词自包含；相对时间用 `observation_date` 锚定、禁止用今天；禁止回声抽取、禁止跨条目细节污染、禁止同一响应内重复；一条只讲一个主题；扫完整窗口（多主题对话应产多条）。
4. **material 输入契约升级**：除"水位以来事件 + 条目清单 + 待审标题"外，增加 `window: {from_event_id, to_event_id, captured_at}`、`observation_date`、`recently_extracted: [{title, fingerprint}]`、每条既有条目的 `valid_from/valid_until/superseded_by`。验收：同一窗口两次 `extract material` 输出除 `captured_at` 外完全一致。
5. **决定论优先**：候选筛选（按 entities/scope/标题）、指纹去重（内容 hash + 标题规范化）、"哪条更新"（`valid_from` 最大值）全部由代码做；LLM 只回答"是否同一事实/是否矛盾/信息量谁更大"。
6. **两阶段蒸馏**：L1 = 事件→原子条目；L2 = 条目→洞察/项目状态/教训（带 `evidence: [KNO-xxxx]`）。L2 只产 pending，**不得覆盖 L1**；被新洞察取代时走 retire（`valid_until` + `superseded_by`）。
7. **水位 CAS**：`extract done --expect <watermark>`；proposal 记录其来源水位；水位推进必须是"批准完成或显式 defer"之后。验收：并发两次 done，第二次失败并提示当前水位。
8. **幂等键**：`run_key = hash(to_event_id + entries_version_hash + prompt_version)`；同 key 重跑复用已存在 pending（返回既有 PRO id），不新建。验收：§8.2 幂等率 = 0 新增。
9. **迟到与乱序**：窗口用事件 id 精确界定（不只用时间戳），保留 lookback（如上一水位前 1–2 个事件）；按 event id 集合去重。验收：人为插入一条时间戳早于水位、id 未处理的事件，下一轮能被抽到。
10. **失败恢复**：每条 proposal 独立提交（已具备）；`extract status --run <id>` 列已提案/待提案；崩溃后重跑只补缺。验收：kill 进程后重跑不产生重复 PRO。
11. **调度策略**：三条件满足其一即触发——(a) 新增事件数 ≥ N；(b) 距上次 ≥ 24h；(c) 手动。加单飞锁 + lease、夜间执行、单轮预算（事件数/token/提案数上限）、超限分片并顺延水位。验收：并发触发只有一个进程运行。
12. **冲突策略分级**：默认 `add`；`supersede` 需 target 存在且 `valid_from` 更新（代码校验）；`merge` 必须人审且正文展示被合并的原文；`invalidate` 只用于证据充分且保留原文的场景。验收：validate 拒绝"target 不存在/已被 supersede"的提案。
13. **去重三档落地**：内容 hash（静默丢弃）→ 标题+实体规范化（可疑则进 pending 标注 `duplicate_of`）→ LLM 语义等价（只对候选对，输出 `NOOP` 或 `merge` 提案）。
14. **证据锚定与防幻觉**：每条 proposal 附 ≥1 条 ledger event 引用（id + ≤200 字引文）；L2 洞察要求 ≥2 条证据；正文出现的实体/数字必须能在证据里找到。验收：人工抽查 20 条，0 条无据。
15. **人审界面按 kind 分组**：新增 / 取代（显示 old→new diff）/ 合并（并排原文）/ 失效（显示冲突证据）；支持批量；approve 时用 `target` 的版本号做乐观锁。验收：两人同时批准同一 supersede 只有一次生效。
16. **索引与派生层可重建**：`knowledge/INDEX.md`（按 scope/domain 分组，标题+一句话）增量维护、每次 N 轮或每月全量重建；引入检索时先做标题/实体倒排 + grep，**不引入向量库作为必需依赖**；任何索引删除后可由 Markdown 重建。
17. **审计与回滚**：所有 supersede/invalidate 保留旧条目与原因；提供 `memhub restore KNO-xxxx`（把 `valid_until` 清空）与"撤销批准"路径；git 历史是最后防线。
18. **评估闭环**：建 30–50 条金标 + 10 组注入矛盾；每次改 prompt/模型/粒度跑 §8.2 指标；把 `prompt_version`、模型名、指标一起记入变更记录，便于归因与回滚。

### 批次与闸门专项（19–26，续上）

19. **run 对象落盘**：`runs/RUN-<ts>-<rand>.json`，字段 `id, status, window{from_event_id,to_event_id,lookback}, entries_snapshot_hash, model, prompt_version, started_at, finished_at, duration_ms, counts{proposed,approved,rejected,deferred}, token_usage, parent_run`。验收：`memhub extract run show RUN-x` 全字段可见；缺 `prompt_version` 时 `validate` 失败。
20. **append-only 运行账本** `runs/ledger.jsonl`：每行 `{run_id, at, state, from, to, counts}`，状态机 `planned → extracting → staged → reviewing → (closed | abandoned | failed)`，只允许前向转换。验收：仅凭账本 replay 能重建任一批次的当前状态与历史。
21. **第二队列物理隔离、闸门共用**：`pending/inbox/distill/` vs `pending/inbox/`，proposal 带 `queue: distill`；面板按队列分 tab；**批准必须走同一个 approve 实现**（失败关闭语义一致），禁止为蒸馏队列另写一套审批代码。验收：用测试断言"不存在绕过 approve 直写 `knowledge/` 的路径"。
22. **批次三态决定 + 拒绝原因**：approve / edit-then-approve / reject；reject 必须选原因码（`wrong|duplicate|stale|too-specific|no-evidence|not-worth-persisting`）+ 备注；超时 N 天升级提醒；拒绝原因进批次统计。验收：reject 不带原因 → 命令失败。
23. **双水位解耦**：维护 `open_watermark`（已取料）与 `committed_watermark`（已结案）；只有 run 到 `closed`（全部分项已决定）才把 committed 推到该 run 的 `to_event_id`；`abandoned` 必须显式二选一——rebase 成新 run 重跑，或记录 skip（带原因）。验收：`staged` 未结案时再次 `extract material` 要么报错、要么显式标注重叠区间，不得静默产生重叠批次。
24. **幂等三件套**：`run_key = sha256(from_event_id|to_event_id|entries_hash|prompt_version|model)`；`proposal_key = sha256(run_id|kind|target|norm_text)`；正文内容 hash。重跑命中 `run_key` → resume 既有 run。验收：同窗口连续两次 `extract run` 只产生一个 run、新增提案数 = 0。
25. **批准期乐观锁与失效**：批准时校验 (a) 目标条目 `revision` 未变、(b) 证据 event 仍存在、(c) run 未 `abandoned`；编辑提案正文会重置其确认令牌，需重新确认。验收：两客户端同时批准同一 supersede，只有一次生效，第二次提示 stale。
26. **溯源可查询**：`memhub extract run trace RUN-x`（列出该 run 全部提案与证据）、`memhub trace KNO-000012`（条目 → run → 证据事件 → 原始会话片段）；knowledge frontmatter 记 `extract_run`。验收：任一条 approved 条目都能一路点到原始事件；批次页面显示拒绝率与最老条目年龄。

---

## 11. 最容易忽略的坑（含批次专项）

1. **水位与提案不是原子的**：先 `extract done` 后批准 → 事件永久丢失；批准后 done 失败 → 重复提案；两者都"看起来正常"。必须 proposal 携带水位、done 做 CAS、批准滞后时显式 defer，而不是靠人记得顺序。
2. **追加式设计把冲突消解推迟给检索，而检索不会解决冲突**：Mem0 v3 的取舍在它自己的场景成立，但在"知识库要回答当前值"的场景，MAB 上 18% 的单跳正确率就是证据。必须写时产出 supersede 提案、由代码比较时间，而不是等读时排序。
3. **原地演化破坏"文件即权威"的可审计性**：A-MEM 的 evolution、LangMem 的 profile、Letta 的 block 覆写都是 last-write-wins；一旦写入，人审看不到 diff，git 里也只剩结果。文件原生系统只能 append-only + `superseded_by` 指针 + 版本化，演化必须走新提案。
4. **批次没有独立身份，所谓"独立审核队列"就是假的**：若蒸馏提案与日常提案混在同一扁平队列、且没有 run 记录，则 (a)"这批为什么被拒"无法回答，(b) 无法按批重跑或回滚，(c) 审核者失去"整批节奏"的判断力，只能逐条看，闸门自然退化成橡皮章。队列页必须显示**拒绝率**与**最老条目年龄**这两个数字（WorkOS 的运营经验），否则无人能发现闸门已失效。

---

## 参考来源

- Mem0: [论文 arXiv:2504.19413](https://arxiv.org/abs/2504.19413) · [v2→v3 迁移（ADD-only、混合检索、指标）](https://docs.mem0.ai/migration/oss-v2-to-v3) · [抽取/更新 prompt 源码](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py) · [Memory Expiration](https://docs.mem0.ai/platform/features/memory-expiration) · [Memory Timestamps](https://docs.mem0.ai/platform/features/timestamp)
- MemGPT / Letta: [MemGPT 论文](https://arxiv.org/abs/2310.08560) · [HTML 正文（内存压力/事件）](https://arxiv.org/html/2310.08560v2) · [Memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks) · [Archival memory](https://docs.letta.com/v1-sdk/memory/archival-memory) · [MemFS（Markdown+YAML、git、worktree）](https://docs.letta.com/concepts/memfs) · [Memory & dreaming](https://docs.letta.com/configuration/memory) · [Sleep-time Compute](https://arxiv.org/abs/2504.13171)
- Zep / Graphiti: [Zep 论文](https://arxiv.org/abs/2501.13956) · [HTML 正文（双时态/失效/社区）](https://arxiv.org/html/2501.13956v1) · [Facts 与四时间戳](https://help.getzep.com/facts) · [Observations](https://help.getzep.com/observations) · [Graphiti 概览（与 GraphRAG 对比）](https://help.getzep.com/graphiti/getting-started/overview)
- 其他系统: [A-MEM](https://arxiv.org/abs/2502.12110) · [A-MEM HTML](https://arxiv.org/html/2502.12110v11) · [Cognee 仓库](https://github.com/topoteretes/cognee) · [Cognee 论文](https://arxiv.org/abs/2505.24478) · [LangMem 概念文档](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) · [LangMem 发布博客](https://www.langchain.com/blog/langmem-sdk-launch) · [MemoryBank](https://arxiv.org/abs/2305.10250) · [MemoryBank HTML](https://arxiv.org/html/2305.10250v3) · [Generative Agents](https://arxiv.org/abs/2304.03442) · [Generative Agents HTML（reflection）](https://ar5iv.labs.arxiv.org/html/2304.03442)
- 评估与冲突: [MemoryAgentBench](https://arxiv.org/abs/2507.05257) · [Deterministic Recipe for Memory Conflict Resolution](https://arxiv.org/abs/2606.01435) · [LoCoMo](https://arxiv.org/abs/2402.17753) · [LongMemEval](https://arxiv.org/abs/2410.10813)
- 增量与可靠性: [dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models) · [Kafka delivery guarantees](https://docs.confluent.io/kafka/design/delivery-semantics.html) · [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- 批次 / 闸门 / 溯源: [LangMem 延迟后台处理（去抖、取消重排）](https://langchain-ai.github.io/langmem/guides/delayed_processing/) · [Graphiti MCP（episode uuid、saga、逐 group 串行、`get_episode_entities` 溯源）](https://github.com/getzep/graphiti/blob/main/mcp_server/src/graphiti_mcp_server.py) · [Letta Sleep-time Compute 博客（双 agent、anytime 写入）](https://www.letta.com/blog/sleep-time-compute/) · [OpenLineage 对象模型（Run/runId/facet）](https://openlineage.io/docs/spec/object-model/) · [Airflow Dag Run（run_id/data interval/backfill）](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html) · [W3C PROV-Overview](https://www.w3.org/TR/prov-overview/) · [HITL 审批闸门模式（staging + 三态 + 审计）](https://microsoft.github.io/ai-cheatcode/interactive/issue-005/) · [WorkOS: 队列而非逐动作审批（拒绝率/积压年龄/编辑使待批失效）](https://webflow.workos.com/blog/curating-queues-beats-approving-actions) · [AWS Step Functions Wait-for-Callback](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html)
