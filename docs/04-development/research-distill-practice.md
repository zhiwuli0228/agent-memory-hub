# LLM Agent 长期记忆的自动萃取：生产实践与 Prompt 工程调研

> 调研对象：dsh-memory-hub 的「定时蒸馏萃取（distill）」能力 + 配套 skill。
> 范围：生产实践 + prompt 工程。不涉及向量库选型、embedding 方案（本 hub 明确不依赖向量库）。
> 调研时间：2026-11-29。所有结论附来源链接，标注 **[官方]** / **[论文]** / **[工程实践]**。
> 结论对现有基础（`extract material` → LLM 蒸馏 → proposal → 人工批准 → `knowledge/`）做增量设计，不推翻写路径。

---

## 0. TL;DR：十条最重要结论

1. **自动记忆 + 人工规则必须是两条轨**：Claude Code 把「你写的 CLAUDE.md」和「Claude 自己写的 auto memory」明确分开，用不同加载预算管理 [官方](https://code.claude.com/docs/en/memory)。我们的 pending→approved 是同一思想的强形式。
2. **自动记忆的第一原则是"跳过可推导的东西"**：Claude Code 明确不记架构、文件路径、调试修复，也不记 CLAUDE.md 已说过的话 [官方](https://code.claude.com/docs/en/memory)。我们的萃取器必须显式写「不抽什么」清单，而不是只写「抽什么」。
3. **索引与正文分离是规模化关键**：`MEMORY.md` 只放一行一条的索引（限 200 行/25KB），细节放主题文件按需读取 [官方](https://code.claude.com/docs/en/memory)。我们的"当前条目清单 + 待审标题"注入就是索引层，body 不应全量进 prompt。
4. **记忆条目必须能在孤立语境下自解释**：LangMem 用 `context` 字段解决"User said yes"式歧义 [工程实践](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/)。对应我们的 `summary` 必须含条件与代价，不能只有一个名词短语。
5. **写入要分"抽取"和"更新"两阶段**：Mem0 先抽候选事实，再与相似既有记忆比对做 ADD/UPDATE/DELETE/NOOP [论文](https://arxiv.org/abs/2504.19413)。把两者塞进一次调用会让模型在"多任务"上失败。
6. **冲突不该由模型静默裁决**：Claude Code 直言两条互相矛盾的指令，模型可能任选其一 [官方](https://code.claude.com/docs/en/memory)。冲突必须上升为提案里的显式字段，交人工。
7. **"失效"优于"删除"**：Zep/Graphiti 用时间图在事实上标 `invalid_at` 而非物理删除 [论文](https://arxiv.org/abs/2501.13956)；Claude 的 memory tool 也建议周期性清理长期未访问文件而非即时删 [官方](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)。对应我们已有 `expires_at` + `supersedes`。
8. **记忆库是可攻击面**：MINJA 证明攻击者只靠"查询 + 观察输出"就能把恶意记录注进 agent 记忆 [论文](https://arxiv.org/abs/2503.03704)。所以 `sourceRefs` 必须是可机器校验的事件指针，不是模型自述。
9. **离线蒸馏是被验证的架构**：sleep-time compute 把"想"从"答"里拆出来，同等准确率下省约 5x 推理 [论文](https://arxiv.org/abs/2504.13171)。定时萃取是这条路线在记忆侧的直接应用。
10. **审批瓶颈靠分级而非靠"全自动"**：行为塑造型（constraint/decision/process）逐条审，知识型批量审，低风险带 TTL 自动入库——这是本报告给出的分级模型，见 §5.2。

---

## 1. Anthropic / Claude Code 官方记忆机制

### 1.1 CLAUDE.md 的四层作用域与加载语义

**[官方]** [How Claude remembers your project](https://code.claude.com/docs/en/memory)

| 层 | 位置（Windows） | 用途 | 共享范围 |
| --- | --- | --- | --- |
| Managed policy | `C:\Program Files\ClaudeCode\CLAUDE.md` | 组织级规范、安全/合规 | 机器上所有用户 |
| User | `~/.claude/CLAUDE.md` | 跨项目个人偏好 | 仅自己 |
| Project | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` | 团队共享的架构/命令/约定 | 随源码分发 |
| Local | `./CLAUDE.local.md` | 个人 project 偏好（应 gitignore） | 仅自己 |

关键机制（对萃取设计有直接启发）：

- **全部拼接而非覆盖**：从文件系统根到工作目录依次拼接，越靠近工作目录越靠后读；同目录内 `CLAUDE.local.md` 追加在 `CLAUDE.md` 之后。
- **子目录文件按需加载**：只在该子目录里的文件被读/写/编辑时才加载——这是"渐进披露"在最基础层的实现。
- **`@path/to/import`**：相对路径以**引用它的那个文件**为基准；最多 4 跳；路径含空格要 `\ ` 转义；用引号包住的路径**不会**被导入；反引号包住的 `@README` 保持字面量。**导入不省 context**（导入文件与宿主一起加载），只改善组织。
- **外部导入需一次性审批**：project 级文件里指向工作目录之外的 import（如 `@~/.claude/xxx.md`），首次遇到会弹审批框；拒绝后永久禁用。
- **路径作用域规则**：`.claude/rules/*.md` 用 `paths:` frontmatter 做 glob 限定，只在匹配文件被读/写/编辑时加载。

### 1.2 官方给的「记忆写作原则」

这是本报告最该抄的一节，原文要点：

- **判断标准**：把它当成"你否则要重复解释一遍的东西"。触发写入的四类信号：同一错误犯第二次 / code review 抓到本应知道的事 / 你重复输入了上次纠正的话 / 新同事也需要同样的上下文。
- **具体到可验证**：`"Use 2-space indentation"` 而不是 `"Format code properly"`；`"Run npm test before committing"` 而不是 `"Test your changes"`。
- **规模**：单个 CLAUDE.md 目标 < 200 行；超了模型遵从度下降。> 200 行会告警，> 4 MiB 直接不加载。
- **一致性**：两条指令冲突时模型"可能任选一条"，所以要周期性审计；官方还提供了 `/doctor prompt-audit` 做冲突/过时检查。
- **不强制的边界**：CLAUDE.md 是"上下文"不是"强制配置"；必须阻断的行为要用 hook。
- **分工**：多步流程 → skill；只对部分代码有效 → path-scoped rule；会话级临时 → 不写。

### 1.3 Auto memory（模型自己写的记忆）

- 位置：`~/.claude/projects/<project>/memory/`，`MEMORY.md` 为索引（一行一条），每条记忆一个主题文件；**机器本地，不跨机器同步**。
- 启动只加载 `MEMORY.md` 前 200 行或 25KB；主题文件按需读。
- frontmatter 的 `type` 四类：`user`（角色/专业/偏好）、`feedback`（纠正与确认过的做法）、`project`（进行中的工作、截止期、从代码/git 推不出的决策）、`reference`（外部信息在哪找）。
- **明确的负向清单**：跳过可从代码库推导的（架构、文件路径、调试修复）；跳过 CLAUDE.md 已说过的。
- **不是每次都写**：判断标准是"在未来的对话里是否有用"。
- 写了带 YAML frontmatter 的文件时，Claude Code 自动补 `modified` ISO 时间戳——**"新鲜度"是记忆的一等字段**。
- 接近上限时会被提醒"合并或丢弃过期条目"；记忆文件不受会话 transcript 保留期清理。

**[官方]** [Memory tool（beta）](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) 的额外机制：

- 客户端工具，`/memories` 目录由**你**实现后端（文件/DB/加密存储均可）；beta header `context-management-2025-06-27`，tool 类型 `memory_20250818`。
- 六个命令：`view`（可带 `view_range`）、`create`（`file_text`，可覆盖）、`str_replace`（`old_str`/`new_str`）、`insert`（`insert_line`/`insert_text`）、`delete`、`rename`（`old_path`/`new_path`）。
- **自动注入的系统提示范式**（可直接借到我们的 skill 里）：
  > `ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.` … `ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory.`
- 官方还给了"防垃圾化"的一句话补丁：编辑记忆时保持内容最新、连贯、有组织；可重命名或删除不再相关的文件；非必要不新建文件。
- 可与 context editing 联动：context 超阈值前模型先把要点写进 memory 再清 tool results；`exclude_tools: ["memory"]` 可让 memory 调用不被清理。
- **安全四件套**（我们要全部实现）：敏感信息过滤（官方说 Claude 通常会拒绝写，但"应立即实现更严格的校验"）、文件大小上限与分页、**记忆过期（清理长期未访问的文件）**、路径穿越防护（必须以 `/memories` 开头、解析后仍在目录内、拒绝 `../`、拒绝 `%2e%2e%2f`）。

### 1.4 Contextual Retrieval 对「身体 / 切块」的启示

**[官方]** [Introducing Contextual Retrieval](https://www.anthropic.com/research/contextual-retrieval)

- 做法：给每个 chunk 前置 50–100 token 的"这段在整篇文档中的定位说明"，再用它做 embedding 和 BM25 索引。
- 效果：contextual embeddings 让 top-20 检索失败率 −35%（5.7%→3.7%）；加 contextual BM25 −49%（→2.9%）；再加 rerank −67%（→1.9%）。
- 成本：800 token chunk / 8k 文档 / 50 token 指令 / 100 token 上下文时，用 prompt caching 一次性处理约 **$1.02 / 百万文档 token**。
- 官方额外给的判断：**知识库 < 200k token（约 500 页）时别搞 RAG，整库塞 prompt + prompt caching 更快更便宜**。
- 注意事项：chunk 大小/边界/重叠影响巨大；定制化的 contextualizer prompt（例如塞术语表）能进一步提升；chunk 数取 20 优于 5/10；**务必跑 eval**。

**对我们的直接含义**（不依赖向量库也能用）：我们的"条目"就相当于 chunk，而 `summary` 就相当于 chunk 的 contextual prefix——**检索/BMI 未建之前，`summary` 的定位质量决定这条知识将来能不能被找到**。所以：

- `title + summary` 应写"在什么场景下、关于什么对象、结论是什么"，而不是抽象名词堆。
- 若将来做 BM25（纯 `rg`/倒排也能做），把 `scope`、`tags`、关键实体词写进 summary 命中的词面集合里。
- 切块（条目粒度）比 embedding 更早决定上限：一条里塞三个结论，将来只能整条命中。

### 1.5 可落地建议（§1）

- `S1` 把 CLAUDE.md 的四层作用域映射为我们的 `scope`：`level: project|domain|workspace` + `workspaceId`，并在萃取 prompt 里逐一写明每一层的写入条件。
- `S2` 在 skill 里内置"记忆写作原则"原文级检查：每条候选必须能回答"这能否让一个没有本次会话上下文的 agent 做对事"。
- `S3` 实现 `modified` 语义：我们有 `updated`/`last_verified`，应把 `last_verified` 当作"新鲜度"主字段，并在索引注入时带上它（模型才知道哪些可能过期）。
- `S4` 把 memory tool 的 `ASSUME INTERRUPTION` 段落改写成"萃取任务可被中断"的语义：manifest 记录水位与本次 run id，中断后从水位重跑而不是从零。
- `S5` 实现 memory tool 的四项安全约束（敏感信息、大小上限、过期清理、路径穿越）——我们的路径来自 pending 文件名，仍有必要做白名单校验。

### 1.6 反例 / 陷阱

- ❌ **把"总结这次会话"当成萃取**：得到的是事件回放，不是可复用知识。Claude Code 明确不记"可从代码库推导"的内容。
- ❌ **用 import 来省 context**：官方明确导入不省 token；把它当"分文件组织"工具可以，当"压缩"工具必错。
- ❌ **只写"抽什么"**：没有负向清单，模型会把 PR 号、临时分支名、今天的环境变量全抽进来。
- ❌ **条目无时间戳**：半年后无法判断"这条还算不算数"，这是陈旧率失控的根因。

---

## 2. OpenAI / Cursor / Windsurf：产品化记忆的共性设计

### 2.1 ChatGPT Memory

**[官方]** [Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)

| 维度 | 做法 |
| --- | --- |
| 自动 vs 手动 | 双轨：可自动从聊天/文件/连接应用提取；也支持"记住这个"显式保存 |
| 两代形态 | **improved memory**（持续更新的高层摘要）vs **legacy saved memories**（显式条目列表），用户可切换 |
| 用户可见性 | 三层：memory summary（顶层）→ Sources 面板（回答下方显示引用了哪个记忆/聊天/文件）→ 条目级编辑 |
| 冲突/纠正 | 直接改 summary 文本、划词纠错、"Don't mention this again"（**只降权，不删源**）、"Delete and turn off memory" |
| 过期/清理 | 关掉 Reference chat history 后，来自历史聊天的记忆 **30 天内**从系统删除；删除的记忆日志最多保留 30 天 |
| 重要边界 | 临时会话**既不产生也不更新**记忆；regulated workspace 默认关闭 improved memory 且不在 BAA 覆盖内 |
| 检索时机 | 不是每次回答都搜历史，而是"当它可能改善回答时"才取 |

**可抄的三点**：① "Don't mention this again" 与 "Delete" 是两个不同动作（降权 vs 删除）——我们的 `status: deprecated` vs 物理删除应该分开；② 用户看到的是 summary + Sources，不是原始记录——我们面板应默认展示 `title + summary + sourceRefs`；③ 删除要从**所有来源**删，"删了聊天不等于删了记忆"。

### 2.2 Cursor Rules

**[官方]** [Rules](https://cursor.com/docs/rules)

- 四类规则：**Project**（`.cursor/rules/*.mdc`，版本受控）、**User**（全局个人）、**Team**（dashboard 管理，Team/Enterprise）、**AGENTS.md**（纯 markdown 的简化替代）。
- `.mdc` frontmatter 三字段决定应用方式（`alwaysApply` / `description` / `globs`）：

| `alwaysApply` | `description` | `globs` | 行为 |
| --- | --- | --- | --- |
| `true` | — | — | 总是包含 |
| `false` | — | 有 | 匹配文件进上下文时自动附加 |
| `false` | 有 | 无 | 模型读 description 自行决定是否拉入（"Apply Intelligently"） |
| `false` | 无 | 无 | 仅 `@` 提及时生效 |

- 注意：`.cursor/rules` 里的**纯 `.md` 会被忽略**（没有 frontmatter 无法判定应用方式）。

**启发**：这就是"记忆的四种加载策略"分类法，非常值得搬到我们的索引注入层：`always`（红线约束）/`by-scope`（workspace/domain 匹配）/`by-description`（模型按需）/`manual`（仅在 skill 里显式点名）。

### 2.3 Windsurf（Cascade）Memories

**[官方]** [Cascade Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)

- 双轨：**Memories**（Cascade 自动生成 + 用户可"create a memory of …"）+ **rules**（人写）。
- 自动记忆**绑定 workspace**，不跨 workspace；"当它认为相关时"检索。自动记忆的生成与使用**不消耗 credits**（说明成本由厂商吸收，我们的形态是本地算力/API，需自行计量）。
- rules 在 `global_rules.md`（全局）与 `.windsurfrules`（workspace）；**每个限 6000 字符**，合计超 12000 时先保留 global 再 workspace，其余截断。
- 写作最佳实践：简单、具体、别写通用规则（"write good code" 无用）；用 bullet/编号/markdown，**XML 标签分组**同类规则效果更好。

**启发**：① 记忆总量必须有**硬预算**（6000 字符/条级别），否则加载变噪音；② 用 XML 标签分组不同类别的记忆（我们的 `type` 天然就是分组）。

### 2.4 三家共性 → 我们的设计要点

1. **永远两条轨**：自动萃取（低信任）+ 人工规则/已批准知识（高信任）。自动产物必须显式标注来源与置信度。
2. **作用域隔离是默认行为**：workspace 级记忆不串到别的 workspace（Windsurf 明确不共享）。我们的 `scope` 字段必须强制、且检索默认按 scope 过滤。
3. **可见 + 可改 + 可删是产品底线**：三家都提供面板/列表/编辑/删除，且都有"为什么它出现在这里"（Sources）。
4. **冲突处理靠人**：三家都没有自动冲突裁决器；ChatGPT 用"纠正"、Cursor 靠人维护 rules。我们的 pending→人工批准正是这个位置。
5. **过期策略分层**：ChatGPT 有 30 天删除承诺；Windsurf 靠硬预算；Claude 靠"提醒合并/丢弃"。我们需要 `expires_at` + 定期 stale 扫描 + 索引预算告警三条一起上。

### 2.5 反例 / 陷阱

- ❌ **自动记忆无上限**：Windsurf 的 6000/12000 字符上限不是可选项，是防止记忆退化成噪音。
- ❌ **把 workspace 记忆当全局偏好用**：同一个 agent 在另一个项目里复用了"本项目用 pnpm"就出事。
- ❌ **只有"删除"没有"降权"**：删掉一条错记忆会丢掉它承载的上下文；先 deprecate，再删。

---

## 3. 萃取 Prompt 工程最佳实践

### 3.1 抽什么：类型学先行，再谈 prompt

三类主流类型学，建议**以我们现有的 9 类 type 为准**（[knowledge-types.md](../05-domain/knowledge-types.md)），并用其余两家做"缺失检查"：

| 来源 | 类型 | 对我们的映射 |
| --- | --- | --- |
| Claude auto memory | `user` / `feedback` / `project` / `reference` | → `constraint`（偏好即约束）/ `knowledge` / `knowledge` / `assets` |
| LangMem | semantic（triple） / episodic / profile | → `knowledge`、`api-catalog`、`process` |
| Mem0 | facts / preferences / events（含时间） | → `knowledge` / `constraint` / 一般不抽事件（见 3.2） |

**我们的 9 类与"该不该自动抽"（重要）**：

| type | 可自动抽 | 审批级别 | 理由 |
| --- | --- | --- | --- |
| `knowledge` | ✅ 主力 | 批量 | 事实性，可验证 |
| `api-catalog` | ✅ | 批量 | 从源码/文档提炼，可回归校验 |
| `process` | ✅ | 逐条 | 行为塑造型，错了会带偏后续所有任务 |
| `playbooks` | ✅ | 逐条 | 同上，且多步 |
| `constraint` | ⚠️ 仅当用户明确表达 | **强制逐条** | 红线，最强承诺 |
| `decision` | ⚠️ 需用户拍板证据 | **强制逐条** | 需证据链 |
| `runtime-base` | ✅ | 批量 | 版本事实，易过期 → 必带 `expires_at` |
| `open-questions` | ✅ | 批量 | 低风险，且有价值（保留证据缺口） |
| `assets` | ✅ | 批量 | 链接索引，可检测死链 |

### 3.2 抽多少 / 粒度：原子判断，不是段落摘要

**结论：一条 = 一个可独立复用的判断句。** 依据：

- Mem0 的抽取阶段就是从对话里抽出"salient information"的候选事实，粒度是事实级，再进更新阶段合并 [论文](https://arxiv.org/abs/2504.19413)。
- LangMem 明确警告：没有 context 的记忆检索后无法使用（`{"content": "User said yes"}` 反例），并建议"schematize 或至少在指令里要求保存**在孤立语境下信息足够**的记忆" [工程实践](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/)。
- Contextual Retrieval 用 50–100 token 的上下文前缀拿到 −35% 检索失败，说明"定位信息"和"内容"要一起存 [官方](https://www.anthropic.com/research/contextual-retrieval)。

**三段式粒度规则**（写进 prompt）：

1. 一条只允许一个 `结论`；出现"并且/另外/同时还"就拆条。
2. 每条必须自包含：**在什么前提 → 什么对象 → 什么结论 → 什么代价/例外**。
3. 会话级"发生了什么"不抽；只在它能支撑一条结论时，作为 `sourceRefs.quote` 存在。

**摘要 vs 原子事实的取舍**：两者都要，但放不同字段——`summary`（≤240 字符，判断句）承载原子性，`body`（markdown）承载脉络/验证步骤/反例。这正是索引/正文分离（§1.3）。

### 3.3 强制"可复用、去环境细节、给占位符"

**做法**（层层设卡，别只靠一句"请去环境化"）：

1. **占位符白名单**：`<PROJECT_ROOT>`、`<WORKSPACE>`、`<HOST>`、`<PORT>`、`<USER>`、`<API_KEY_NAME>`、`<DATE>`。prompt 里给出替换示例。
2. **"新人测试"**：让模型自问——"把这条给一个从没来过这个仓库的 agent，它能照做吗？会卡在哪个具体路径/域名/人名上？"卡住的必须占位符化或补上下文。
3. **三档判定**（要求模型显式输出，便于审计）：
   - `portable`：无环境依赖，可直接复用；
   - `parameterized`：含占位符，需填参；
   - `local-only`：本质绑死本机/本项目（→ 加 `scope.level=workspace` 或干脆不抽）。
4. **反例对**（few-shot 里给正反各一条）：

   | ❌ 反例 | ✅ 正例 |
   | --- | --- |
   | 在 `E:\009workspace\dsh\dsh-memory-hub` 下跑 `pnpm test` 就过了 | 在 `<PROJECT_ROOT>` 下跑 `pnpm test`；若失败先检查 `<PROJECT_ROOT>/node_modules` 是否为 workspace 链接 |
   | 我们决定用 SQLite | 决策：本地优先场景选 SQLite 而非 Postgres，理由是零运维与单文件可备份；代价是不支持并发写，需在 `<DATA_DIR>` 加文件锁 |
   | 用户让我以后都用中文 | （若确实是长期偏好）约束：与 `<USER>` 的交互默认中文；仅在代码/标识符/外部引用保留原文 |

### 3.4 明确"不抽什么"（负向清单是效果分水岭）

必须在 prompt 里逐条列出，且要求模型**输出被拒项及理由**（可观测性来源之一）：

- 一次性的状态与进度（"今天跑到第 3 步"）——属于 checkpoint，不属于知识。
- 可从代码/配置/文档直接推导的（目录结构、依赖清单、架构图）——Claude Code 的明确负向清单 [官方](https://code.claude.com/docs/en/memory)。
- 已经存在于 `knowledge/` 或 `pending/` 的内容（重复＝噪音）。
- 敏感信息：密钥、token、cookie、身份证/手机号/住址、客户隐私、内部 URL 带签名参数——memory tool 的安全节明确要求做**比模型自觉更严格的**校验 [官方](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)。
- 模型的推测与"我觉得"：无 `sourceRefs` 支撑的一律不抽。
- 临时性/时效性信息（"这周先这样"）——除非用户明确说"以后都这样"。
- 情绪化评价与人际判断（"某人代码很烂"）——不可复用且有害。

### 3.5 结构化输出：JSON schema + 为什么要"先写理由再写结论"

- LangMem 通过 **parallel tool calling** 让模型一次产出多条 insert/update/delete 动作，并用 `RemoveDoc` 表达删除（软删/硬删/降权由宿主决定）[工程实践](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/)。
- Mem0 的更新阶段本质上是**在既有候选集上做分类决策**（ADD/UPDATE/DELETE/NOOP），这比"自由改写整库"稳得多 [论文](https://arxiv.org/abs/2504.19413)。
- 因此我们的 schema 必须包含：`op`（动作）、`novelty`（与既有条目的关系）、`source_refs`（证据）、`confidence`、`approval_tier`。

**字段顺序技巧**：把 `rejected` 与 `self_check` 放在 `candidates` **之前**输出（schema 里 property 顺序即生成顺序），迫使模型先排除再产出。实测中这是降低"凑数提案"最便宜的手段（属于 prompt 工程常规技巧，非本文献结论——标注为 **本报告建议**）。

### 3.6 增量与去重：必须给模型"既有地形图"

- 输入三段：**事件流（自水位以来）** + **当前条目清单（id/title/summary/type/status，不含 body）** + **待审标题（pending 的 title 列表）**。
- 要求模型对每条候选显式给出 `novelty`：`new` / `extends:<ID>` / `duplicate_of:<ID>` / `conflicts:<ID>`。
- 重复的处置：`duplicate_of` → `op: noop` + 说明（**不要**再提一条同义提案，这是重复率指标的死因）。
- 冲突的处置：`op: supersede` 或 `op: update`，并在 `conflict.resolution_note` 里写清"旧的条件仍成立/旧条件已失效"。

### 3.7 反例 / 陷阱

- ❌ **一次调用同时做"抽取 + 合并 + 改写全库"**：模型会漏项或擅自重写，LangMem 建议这种情况改成多轮 agent 式管理 [工程实践](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/)。
- ❌ **只给事件流不给既有条目**：必然重复抽出已有知识，重复率飙升。
- ❌ **让模型输出"整篇 markdown 知识文档"**：无法做字段级校验、无法算 diff、无法分级审批。
- ❌ **不给来源 id 只给"会话摘要"**：事后无法复核，等于幻觉记忆的温床（见 §5.3）。
- ❌ **温度调高求"创造力"**：萃取是判决任务，用低温度；创造性留给 body 的表述。

---

## 4. Skill / Agent 指令写法最佳实践

### 4.1 SKILL.md 的硬规范

**[官方]** [Agent Skills 规范](https://agentskills.io/specification)（Claude Code 遵循该开放标准，并做了扩展 [官方](https://code.claude.com/docs/en/skills.md)）

- 目录结构：`SKILL.md`（必需）+ `scripts/`（可执行）+ `references/`（文档）+ `assets/`（模板）。
- frontmatter：

| 字段 | 必需 | 约束 |
| --- | --- | --- |
| `name` | ✅ | ≤64 字符；小写字母/数字/连字符；不得首尾连字符、不得连续连字符；需与目录名一致 |
| `description` | ✅ | ≤1024 字符；**写清"做什么 + 何时用"** |
| `license` / `compatibility`(≤500) / `metadata` / `allowed-tools` | ❌ | 可选 |

- **渐进披露**：`SKILL.md` 建议 < 500 行且 < 5,000 token；细节移到 `references/`，并**明确写出何时加载哪个文件**（"若 API 返回非 200 读 `references/api-errors.md`"比"详见 references/" 有用得多）。
- Claude Code 扩展：`disable-model-invocation: true`（禁止模型自动调用）、`context: fork` + `agent:`（跑在子代理里）、`allowed-tools`（预授权）、`` !`cmd` ``（动态注入命令输出）、`$ARGUMENTS` 参数占位。

### 4.2 description 怎么写"何时使用 / 何时不要使用"

官方最佳实践（[skill 创作最佳实践](https://agentskills.io/skill-creation/best-practices)）没有单独的"反触发"字段，但工程上的可靠做法是把负向边界写进 description 与正文首段：

- **description 模板**：`<做什么>。当 <触发条件 1/2/3> 时使用；当 <反触发条件> 时不要使用，改用 <别的 skill/直接回答>。`
- **正文第一屏**必须有三块：`## 何时使用`、`## 何时不要使用`、`## 前置检查`。因为 skill 一旦被触发，正文全文进上下文，前 20 行决定模型是否走对路。
- 触发词要写**用户会说的话**，不是术语（"萃取/蒸馏/整理记忆/把这次的坑记下来" 而非 "memory distillation"）。

### 4.3 长流程拆步骤 + 校验点

官方给的可执行模式（[最佳实践](https://agentskills.io/skill-creation/best-practices)）：

- **Match specificity to fragility**：越脆弱的环节写得越具体；越稳定越给原则。
- **Provide defaults, not menus**：给默认值和一个备选，不给 5 个选项。
- **Favor procedures over declarations**："先跑 X，检查 Y，再 Z"优于"要保证质量"。
- **Gotchas 段**：把已知坑写成短列表（这是 skill 最高价值的部分，因为它装的是模型不可能自己知道的经验）。
- **Templates for output format**：直接给输出模板，别描述格式。
- **Checklists for multi-step workflows**：多步流程用复选框清单，模型会照着勾。
- **Validation loops / Plan-validate-execute**：每步产出后可验证就验证，验证失败回退。

**对我们的蒸馏 skill，建议的步骤骨架**（每步带校验点）：

```
0 前置检查：hub 根存在、水位文件可读、pending 数 < 阈值（否则先清 backlog）
1 取料：memhub extract material --since <watermark> → 拿到事件流 + 条目索引 + 待审标题
2 分诊：事件流按会话切块；丢弃明显无信息量的会话（只有寒暄/只有工具输出）
3 抽取：按 §9 骨架产出 candidates（先 rejected/self_check，再 candidates）
4 门禁（§5.1 清单）：去重 / 冲突 / 证据 / 敏感 / 可复用 / 类型 / 置信度
5 提交：memhub proposal submit --batch <run_id>（每条一个文件，写 sourceRefs）
6 复核输出：打印 accepted/rejected 计数、与既有条目的冲突列表
7 落水位：仅在提交成功后推进 watermark；失败则水位不动（幂等，见 §6.2）
```

**每个校验点要给"失败怎么办"**，否则模型会硬着头皮往下走：
- 第 1 步失败 → 报错退出，不推进水位。
- 第 4 步任一条不过 → 该条移到 `rejected`，其余照常提交（不要整体失败）。
- 第 5 步部分失败 → 已完成的不回滚，水位只推进到"最后一个成功批次覆盖的事件"之前。

### 4.4 资源文件组织

- `references/` 放**长期参考**：知识类型定义、frontmatter 契约、prompt 骨架、正反例库、历史踩坑。
- `scripts/` 放**确定性逻辑**：去重预筛（标题/摘要归一化）、sourceRefs 存在性校验、schema 校验、水位读写。官方明确建议"bundling reusable scripts"——能用脚本做的不要靠模型判断。
- `assets/` 放模板：proposal 文件模板、报告模板。

### 4.5 反例 / 陷阱

- ❌ **description 写成说明书**（描述实现细节而非触发条件）→ 模型永远不自动调用。
- ❌ **SKILL.md 塞 2000 行**：超过建议上限后模型抓不住重点，且每轮都花 token。
- ❌ **只写 happy path**：没有"取料失败/水位缺失/pending 积压"的分支，模型会自己发明奇怪的做法。
- ❌ **把可验证的事写成"请注意"**：能脚本校验的都脚本化。
- ❌ **skill 里同时教"抽什么"和"怎么改格式"**：职责混在一起，改格式要动 skill。格式归 `scripts/`。

---

## 5. 质量门禁：不让坏记忆进库

### 5.1 抽取后的自检清单（建议逐条对应到代码/脚本）

| # | 检查项 | 判定规则 | 失败处置 |
| --- | --- | --- | --- |
| G1 | 字段合法 | 9 类 type 内；status=candidate；title ≤60 字；summary ≤240 字符 | 拒（脚本） |
| G2 | 自包含 | 剥离环境标识后仍可读；能回答"前提/对象/结论/代价" | 回炉一次，再失败拒 |
| G3 | 去重 | 与既有条目/待审标题的标题归一化后相似度超阈值 → `noop` | 拒并记 `duplicate_of` |
| G4 | 冲突 | 与既有条目的结论互斥 → 必须给 `conflicts:<ID>` + `resolution_note` | 强制单条审批 |
| G5 | 证据 | `sourceRefs` ≥1 且每个 ref 能在事件流/文件/git 中定位到 | 拒（**硬门禁**） |
| G6 | 敏感性 | 命中密钥/隐私正则，或含签名 URL/内网地址 | 拒并打日志 |
| G7 | 占位符 | 含绝对路径/主机名/用户名 → 必须有对应占位符 | 自动改写 + 提示 |
| G8 | 类型-审批一致 | `constraint`/`decision`/`process`/`playbooks` → `approval_tier=single` | 强制降级为单条 |
| G9 | 置信度 | `confidence < 0.5` 且 `evidence_strength=inferred` | 拒 |
| G10 | 时效 | `runtime-base`/版本相关必须给 `expires_at` | 默认 +90 天 |

### 5.2 分级审批：让"行为塑造型"逐条过、"知识型"批量过

设计原则：**审批成本应与"这条记忆能改变多少后续行为"成正比**。

| 级别 | 适用 type | 交互 | 边界 |
| --- | --- | --- | --- |
| **L0 自动入库** | 仅 `knowledge`/`assets` 且 `confidence ≥ 0.8`、无冲突、证据充分 | 直接 accepted，但标 `auto_promoted: true` + `expires_at` | 可一键回滚；进入周度抽查样本 |
| **L1 批量批准** | `api-catalog`/`runtime-base`/`open-questions`/`knowledge`（低置信） | 面板按 run 批量"全批准/全驳回/逐条" | 冲突项自动升级到 L2 |
| **L2 单条审批** | `constraint`/`decision`/`process`/`playbooks`，以及任何 `conflicts:*` | 一条一议，必须看 diff 与 sourceRefs | 无自动通过路径，永远人工 |

配套机制（避免审批环节被忽略）：
- **批量不是无脑全批**：面板默认展开 `conflicts` 与 `single` 两类，`batch` 类折叠。
- **审批 SLA**：pending 超过 N 条或超过 T 天 → 面板红标 + 每日摘要（不然 pending 会长期堆积，最终被一次性"全批"污染）。
- **默认动作要保守**：超时不是"自动批准"，而是"自动过期作废"（可重新萃取，成本远低于污染）。

### 5.3 业界怎么防"记忆污染 / 幻觉记忆"

- **攻击面是真实的**：MINJA 证明攻击者无需直接改库，仅通过查询 + 观察输出，用"桥接步骤"把恶意记录逐步注入记忆库，且注入后能在后续受害者查询中被检索到 [论文](https://arxiv.org/abs/2503.03704)。含义：**任何进入记忆的文本都必须被当作不可信输入**，包括"用户说的"和"工具输出里的"。
- 对应的四道闸：
  1. **写入侧校验**：G5 证据 + G6 敏感 + 结构白名单（不接受自由文本作为 title/summary）。
  2. **来源分级**：`evidence_strength ∈ {stated_by_user, observed_in_code, tool_output, inferred}`；`tool_output`（尤其网页/第三方内容）单独标记，检索时降权。
  3. **人工闸门**：L2 层级全部人工；这也是 MINJA 类攻击的最后一道。
  4. **可回滚**：每条记忆保留 `sourceRefs` 与 `run_id`，可按 run 整体回滚（"这批全是垃圾"是常见场景）。
- **幻觉记忆的判定标准**：一条记忆"幻觉"，当且仅当它的结论无法从 `sourceRefs` 指向的原文推出。所以 prompt 必须要求 `quote`（≤200 字原文片段），审核时人只看 quote 就能判——**这比看 500 字 body 快 10 倍**。

### 5.4 反例 / 陷阱

- ❌ **用"模型自评置信度"当门禁**：自评普遍偏高。真正的门禁是"证据能否定位"这类**可机器验证**的项。
- ❌ **把冲突自动"取最新"**：新旧不代表对错，可能只是 scope 不同。必须写 `resolution_note` 交人。
- ❌ **无 TTL 的自动化**：L0 自动入库若永久有效，一次系统性抽取偏差会永久污染。
- ❌ **只做入库门禁不做"入库后"门禁**：陈旧扫描、死链检测、`last_verified` 超期降权同样重要。

---

## 6. 调度与人机协同

### 6.1 触发时机：时间驱动 + 事件驱动双轨

- **纯 cron 不够**：忙的一天产生 200 条事件，闲的一周 3 条，固定频率会导致"该萃取时没跑、没料时白烧 token"。
- **参考 Generative Agents 的阈值触发**：重要性累积过阈值才反思（该文用 importance 1–10 累加，超阈值触发 reflection）[论文](https://arxiv.org/abs/2304.03442)。我们可以用"未萃取事件数 × 平均重要性"或简单阈值"未萃取事件 ≥ N 条"。
- **建议双轨**：
  - **快萃取**（每 1–6 小时或事件累积 ≥ N 条）：只处理"高价值事件"（用户显式纠正、决策拍板、踩坑解决），目标是低延迟入库。
  - **慢复盘**（每日/每周固定窗口）：处理全量事件，做合并/去重/陈旧扫描（对应 sleep-time compute 的"离线想" [论文](https://arxiv.org/abs/2504.13171)）。
- **窗口期选择**：本地优先系统，慢复盘放在**机器空闲时段**（夜间），并加并发/资源上限，避免抢占用户前台任务。

### 6.2 幂等 + 错过补偿（最容易被忽略的一节）

- **幂等三件套**：
  1. `watermark`（水位）：只在本次批次**全部提交成功**后推进；失败则不动。
  2. `run_id`（幂等键）：同一 `(watermark_from, watermark_to, skill_version, prompt_version)` 视为同一 run；重复执行先查是否已有产物，有则跳过。这是 Stripe 式幂等键思路 [工程实践](https://docs.stripe.com/api/idempotent_requests)。
  3. **去重键**：proposal 文件命名含 `run_id + 序号 + 内容哈希`，重复提交同内容直接命中已存在文件。
- **错过补偿**：参考 K8s CronJob 的三个语义——`startingDeadlineSeconds`（错过多久内仍补跑）、**错过次数超上限（100）后不再补跑并报错**、`concurrencyPolicy`（`Forbid` 禁止并发、`Replace` 用新任务替换旧的）[官方](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)。
  - 我们的建议：**补跑上限 7 天**（超过就把窗口合并成一个"大窗口"批次，而不是逐个补）；**同一时刻只允许一个萃取进程**（文件锁），第二个直接退出并记录"another run in progress"。
- **批大小上限**：单次事件流超过 N 条（如 200）时**分片**，每片独立 run——否则 prompt 溢出、模型漏项、失败代价大。

### 6.3 静默失败监控

**最危险的不是报错，是"跑成功了但什么都没产出"**。四类信号（参考 SRE 的四个黄金信号 + 症状式告警 [工程实践](https://sre.google/sre-book/monitoring-distributed-systems/)）：

| 信号 | 指标 | 告警条件 |
| --- | --- | --- |
| 活性 | `last_success_at` | 超过 2 个周期未更新 → 告警 |
| 产出 | `candidates_count` | 连续 K 次为 0 且事件流非空 → 告警（**高价值信号**） |
| 质量 | `rejected_ratio`、`duplicate_ratio` | 突增 2x → 提示 prompt/schema 回归 |
| 资源 | token/耗时/单次成本 | 超预算 → 告警并降级（分片更小） |

补充：
- **退出码分级**：`0` 成功有产出 / `0` 成功无产出（**必须可区分**，比如写 manifest 字段）/ `2` 部分失败（部分提案已提交）/ `1` 失败未提交。没有"成功但空"的区分就必然静默失败。
- **manifest 落盘**：每次 run 写 `runs/<run_id>.json`（起止水位、事件数、候选数、拒绝原因分布、耗时、模型版本、skill/prompt 版本）。这是 §7 全部指标的数据来源。
- **通知策略**：成功不通知（否则告警疲劳），失败与"连续零产出"通知；每日一条摘要（跑了什么、等几批审、多少条待审）。

### 6.4 审批不成为瓶颈的设计

- **结构化 diff 优先**：面板默认渲染 `summary` 的变化 + `sourceRefs.quote`，body 折叠。人审的是"这条结论对不对"，不是"文笔"。
- **一次决策树**：默认按钮是"批准并入库"（对 L1）、"批准并标记 supersede 旧条目"（对冲突）、"驳回并记原因"。**驳回原因要结构化**（`duplicate`/`not_reusable`/`wrong`/`sensitive`/`too_specific`），否则无法做 §7 的分析。
- **批处理 + 抽样**：L1 支持"批批准前 N 条"，但每批**强制抽样 10%** 要求人看 quote；L0 每周抽查固定条数。
- **把审批变成"改"而不是"判"**：允许审批时直接编辑 `title/summary`，编辑量与编辑类型是质量指标（人工修改率）。
- **自动化边界要写死**：`constraint`/`decision` 永不自动；`knowledge` 自动的条件必须包含"证据可定位 + 无冲突 + 有 TTL"。边界写进代码而不是 prompt，因为 prompt 会被模型合理化。
- **批量产物必须有独立的第二审核入口**（「蒸馏审核」与即时收件箱分开），且批次以卡片为容器、条目为决策单元。→ 详细证据、UI 结构与量化护栏见 **§10**。

### 6.5 反例 / 陷阱

- ❌ **先推进水位再提交**：提交失败就永久丢数据（且下次不会再抽到）。
- ❌ **并发跑两个萃取进程**：双份提案 + 水位互相覆盖。
- ❌ **"成功但 0 产出"当正常**：这是最高频的静默失败形态。
- ❌ **补跑无限重试**：错过 30 天配置一直变，补跑会产出大量过时条目；要有合并窗口与上限。
- ❌ **审批没有 SLA**：pending 堆积 → 一次性全批 → 污染入库。

---

## 7. 可观测性与评估

### 7.1 指标体系（每个指标必须能从 manifest 算出）

**产出侧**

| 指标 | 定义 | 目标/基线方向 |
| --- | --- | --- |
| `proposal_accept_rate` | accepted / 提交数 | 越高越好；< 60% 说明抽取质量差 |
| `edit_rate`（人工修改率） | 审批时被编辑过的条目 / 批准数 | 越低越好；**这是 prompt 质量最灵敏的代理指标** |
| `duplicate_rate` | `duplicate_of` / 候选数 | 越低越好；高说明既有条目注入不足 |
| `conflict_rate` | 含 `conflicts:*` 的候选比例 | 中等为宜；为 0 通常意味着没做冲突检查 |
| `reject_reason_dist` | 各拒绝原因占比 | 看 `too_specific`/`derivable` 是否过高 |
| `candidates_per_1k_events` | 抽取密度 | 突降=抽取退化；突增=标准放松 |

**质量侧**

| 指标 | 定义 | 说明 |
| --- | --- | --- |
| `retrieval_hit_rate` | 抽样问题中，回答所依据的条目确实被检索到 | 无向量库也能做：人工/LLM 标注"该用哪条"，再看搜索是否命中 |
| `staleness_rate` | `last_verified` 超期或 `expires_at` 已过的条目 / 总数 | 反映清理机制是否运转 |
| `orphan_rate` | `sourceRefs` 已不可定位的条目比例 | 反映仓库迁移/会话清理后的腐化 |
| `rework_rate` | 入库后被 supersede/deprecated 的比例（按 30/90 天） | **最重要的滞后指标**，直接衡量"入库对不对" |
| `cost_per_accepted` | token 成本 / 入库条目数 | 经济性 |

**流程侧**：`run 成功率`、`平均 pending 停留时长`、`批次数/周`、`补跑次数`。

### 7.2 业界怎么做评估与持续改进

- **建 golden set**：取自真实 hub 的 30–50 个"应该抽出来"的样本 + 30 个"绝对不该抽"的负样本（含敏感、一次性、可从代码推导）。每次改 prompt/schema 跑一遍，看 accept/duplicate/false-positive 变化。这是唯一的回归护栏。
- **用既有基准的**方法学**，不追分数**：Mem0 用 LOCOMO 的 single-hop/temporal/multi-hop/open-domain 四类问题 + LLM-as-a-Judge [论文](https://arxiv.org/abs/2504.19413)；Zep 用 DMR / LongMemEval，并强调"更贴近企业用例"的时间推理 [论文](https://arxiv.org/abs/2501.13956)。我们的对应物是：单条事实、跨条目关联、时间/版本相关、以及"该不该抽"的判断——**四类各建 10 题**。
- **检索评估用失败率而非准确率**：Anthropic 用 `1 − recall@20`（失败率）作为指标 [官方](https://www.anthropic.com/research/contextual-retrieval)。我们的搜索同样应度量"该命中的没命中"的比例，因为它对体验的影响更直接。
- **线上闭环**：
  1. 每周看 `edit_rate` 最高的 10 条 → 反推 prompt 缺什么约束（通常是"太具体/缺占位符"）。
  2. 每月看 30 天 `rework_rate` 最高的 type → 收紧该 type 的审批层级。
  3. 每季度把"被人工改写的 summary"汇总成 few-shot 正例，回填 skill 的 `references/`。
- **指标不要超过 8 个**：指标过多会导致没人看。建议核心看板只放 5 个：`accept_rate`、`edit_rate`、`duplicate_rate`、`rework_rate(30d)`、`staleness_rate`。

### 7.3 反例 / 陷阱

- ❌ **只看 accept_rate**：把所有门槛降到 0 就能拿高接受率，但 `rework_rate` 会爆炸。两个指标必须成对看。
- ❌ **没有 golden set**：任何 prompt 改动都是盲改，回归不可知。
- ❌ **用 LLM-as-judge 替代人工抽样**：judge 与被评模型同源时偏差系统性存在；judge 只用于**预筛**，最终抽样必须人看。
- ❌ **不记录 prompt/skill 版本**：质量变化时无法归因到具体改动。

---

## 8. Skill 设计建议清单（可直接执行）

1. 目录名 `distill`，`SKILL.md` frontmatter 只写 `name: distill` 与一行 `description`；description 用"做什么 + 何时用 + 何时不要用"三段式，含用户原话触发词（萃取/蒸馏/整理记忆/沉淀经验/把坑记下来）。
2. `SKILL.md` 控制在 **< 300 行 / < 4k token**；把知识类型表、frontmatter 契约、正反例库、prompt 骨架全部移到 `references/`。
3. `references/` 至少四个文件：`knowledge-types.md`（9 类判定表）、`frontmatter-contract.md`、`prompt-skeleton.md`（§9）、`examples-good-bad.md`（每类各 1 正 1 反）。
4. `scripts/` 放确定性逻辑：`prefilter.mjs`（标题归一化去重）、`check-sourcerefs.mjs`（证据可定位性）、`validate-proposal.mjs`（G1/G8 字段校验）、`watermark.mjs`（读/推进/加锁）。skill 正文写明**每个脚本何时跑、失败怎么处理**。
5. 正文第一屏固定三块：`## 何时使用` / `## 何时不要使用`（含"只做总结不做萃取"、"只是闲聊"、"用户明确说不要记"）/ `## 前置检查`。
6. 前置检查写成可执行命令：hub 根存在、`memhub extract material` 可跑、pending 数 < N、无其他 run 持锁；任一失败就报告并停止，**不得继续**。
7. 流程用编号步骤 + 每步一个 `✅ 校验点` 与 `❌ 失败分支`；不允许出现没有失败分支的步骤。
8. 在 skill 里显式给出 `watermark` 语义与"只在提交成功后推进"，并提示中断后如何重跑（同 run_id 幂等）。
9. 把 §5.1 的 G1–G10 做成 skill 内**逐条勾选的 checklist**，并要求模型在输出里附 `self_check` 结果（而不是说"我已检查"）。
10. 输出格式用 `references/prompt-skeleton.md` 里的 JSON schema，**不要**让模型自由发挥字段；schema 里给 `enum`，字段顺序 = 思考顺序（先 `rejected`/`self_check`，后 `candidates`）。
11. 强制"一条一结论 + 自包含（前提/对象/结论/代价）"，写入 skill 的正例段；出现并列连词即提示拆分。
12. 强制占位符白名单（`<PROJECT_ROOT>`/`<WORKSPACE>`/`<HOST>`/`<PORT>`/`<USER>`/`<API_KEY_NAME>`/`<DATE>`），并在校验点检查"是否还有裸绝对路径/主机名"。
13. 拒绝项必须带结构化原因（enum：`one_off`/`derivable`/`duplicate`/`sensitive`/`low_confidence`/`speculative`），供 §7 统计。
14. 分级审批写进 skill：`constraint`/`decision`/`process`/`playbooks` → 必须 `approval_tier: single`；不确定时默认升级到 single（保守优先）。
15. skill 开头写 **Gotchas 段**（至少 5 条本仓特有坑），例如"`memhub init` 位置参数会被静默忽略只认 `--root`"这类已发生过的教训。
16. 动态注入减少往返：用 `` !`memhub extract material --json` `` 让取料结果直接在 skill 展开（若运行环境支持），避免模型手抄路径。
17. 给 skill 一个"试运行"模式：`--dry-run` 只输出 candidates 与 self_check，不提交提案，用于调 prompt。
18. 用 `disable-model-invocation` 慎判：萃取涉及写入 pending，建议**允许模型自动调用但只读模式自动、写入模式需人确认**；若做不到则显式标 `disable-model-invocation: true`，由人手动触发。
19. skill 里不许出现"请注意/要保证质量/尽量"这类不可执行措辞；每句要么是命令，要么是判定条件。
20. 版本化：skill 正文顶部记录 `prompt_version`，manifest 里落版本号，使 §7 的归因分析可用。

---

## 9. 萃取 Prompt 骨架（中文，可直接改用）

> 用法：`<...>` 为运行时填充；schema 用 JSON Schema 严格校验；低温度（0–0.2）。

````text
# 角色
你是 dsh-memory-hub 的「记忆萃取器」。你的唯一产出是**可复用知识候选**，不产出会话总结。

# 任务
读取 <EVENT_STREAM>（自水位 <WATERMARK_FROM> 至 <WATERMARK_TO> 的事件流）、
<ENTRY_INDEX>（当前已入库条目：id/title/summary/type/status/last_verified，不含正文）、
<PENDING_TITLES>（待审提案标题列表），产出 JSON。不写文件，不做检索，不解释。

# 一、必须通过的门禁（任一不过就不产出该条）
G1 一条只含一个结论；出现"并且/另外/同时"要拆条。
G2 自包含：能回答「在什么前提 → 对什么对象 → 结论是什么 → 代价/例外是什么」。
G3 排除可从代码/配置/文档直接推导的内容（目录结构、依赖清单、架构概述）。
G4 排除一次性状态与进度（今天做到第几步、临时分支名、本机当前端口）。
G5 排除已存在于 <ENTRY_INDEX> 或 <PENDING_TITLES> 的内容（同义也算）。
G6 排除敏感信息：密钥/token/cookie/密码/身份证/手机号/住址/客户隐私/带签名的 URL。
G7 排除推测：无 <EVENT_STREAM> 内原文支撑的结论一律不产出。
G8 去环境化：绝对路径→<PROJECT_ROOT>/<DATA_DIR>；主机/端口/用户名→<HOST>/<PORT>/<USER>；
   密钥→<API_KEY_NAME>；具体日期→<DATE>（除非该日期本身是结论的一部分）。

# 二、允许的 type（枚举，不得发明）
- knowledge 事实与机制（可验证）           - api-catalog 接口/签名/实现状态
- process 可复用操作流程（场景→步骤→规范） - playbooks 端到端玩法（多步+验证点）
- decision 已定决策（须有拍板证据）         - constraint 硬约束/红线（须用户明确表达）
- runtime-base 运行时版本事实（必带 expires_at）
- open-questions 未决问题（含倾向与证据缺口）
- assets 外部资源索引（链接+定位说明）

# 三、输出前先做排除与自检（顺序不得调换）
1) 先在 rejected 里列出你**主动放弃**的内容及原因；
2) 再在 self_check 里逐条回答 G1–G8 是否通过（true/false + 一句话依据）；
3) 最后才产出 candidates。宁少勿滥：0 条候选是合法输出，且优于凑数。

# 四、与既有条目的关系（必须显式判定）
novelty ∈ new | extends:<ID> | duplicate_of:<ID> | conflicts:<ID>
- duplicate_of → op 必须为 noop，且不得再产出一条同义候选。
- conflicts:<ID> → 必须给 conflict.resolution_note（写清"旧条件仍成立/旧条件已失效/作用域不同"）。
- extends:<ID> → op 为 update，并在 body 里写明相对旧条目的增量。

# 五、证据（硬要求）
每条至少 1 个 source_refs，且必须是可在事件流内定位的指针：
{"kind":"event|session|file|commit|url","ref":"<可定位标识>","quote":"≤200 字原文片段"}
quote 必须逐字来自原文，不得改写；找不到原文支撑就不要产出该条。

# 六、输出 JSON（严格按 schema，不要额外字段、不要 markdown 围栏外的文字）
{
  "run": {
    "watermark_from": "ISO8601",
    "watermark_to": "ISO8601",
    "events_examined": 0,
    "sessions_examined": 0,
    "prompt_version": "distill-v1"
  },
  "rejected": [
    { "what": "≤40字摘要", "why": "one_off|derivable|duplicate|sensitive|low_confidence|speculative", "note": "≤80字" }
  ],
  "self_check": {
    "G1_single_conclusion": true,
    "G2_self_contained": true,
    "G3_no_derivable": true,
    "G4_no_transient": true,
    "G5_no_duplicate": true,
    "G6_no_sensitive": true,
    "G7_evidence_backed": true,
    "G8_placeholders_applied": true,
    "notes": "≤120字：本次萃取最不确定的判断"
  },
  "candidates": [
    {
      "op": "add|update|supersede|noop",
      "type": "knowledge|api-catalog|process|playbooks|decision|constraint|runtime-base|open-questions|assets",
      "title": "≤60字，动宾结构，含对象",
      "summary": "≤240字符。句式：在<前提>下，<对象><结论>；代价/例外是<...>",
      "body": "Markdown。必备小节：## 适用场景 / ## 做法或事实 / ## 验证方式 / ## 反例与陷阱",
      "scope": { "level": "project|domain|workspace", "workspaceId": "dsh-memory-hub|..." },
      "tags": ["≤6 个，小写，连字符"],
      "portability": "portable|parameterized|local-only",
      "placeholders_used": ["<PROJECT_ROOT>"],
      "novelty": "new|extends:KNO-000001|duplicate_of:KNO-000002|conflicts:KNO-000003",
      "conflict": { "with": "KNO-000003", "kind": "contradicts|narrows|supersedes", "resolution_note": "≤120字" },
      "source_refs": [ { "kind": "event", "ref": "evt_000123", "quote": "≤200字原文片段" } ],
      "confidence": 0.0,
      "evidence_strength": "stated_by_user|observed_in_code|tool_output|inferred",
      "behavior_shaping": true,
      "approval_tier": "auto|batch|single",
      "expires_at": "ISO8601|null",
      "sensitive_flags": []
    }
  ]
}
````

**约束表（与 schema 一一对应，供校验脚本用）**

| 字段 | 约束 | 校验方 |
| --- | --- | --- |
| `op` / `type` / `novelty` / `approval_tier` | enum | 脚本 G1/G8 |
| `title` / `summary` | 长度上限；summary 必须含"前提"与"代价" | 脚本 + 正则 |
| `source_refs` | ≥1；`ref` 可在事件流/git 定位；`quote` 为原文子串 | 脚本 G5（**硬门禁**） |
| `placeholders_used` | 与 body 中出现的 `<...>` 一致；不得残留裸绝对路径 | 脚本 G7 |
| `approval_tier` | `type ∈ {constraint,decision,process,playbooks}` ⇒ `single` | 脚本 G8 |
| `expires_at` | `type = runtime-base` ⇒ 非 null | 脚本 G10 |
| `confidence` | `inferred` 且 < 0.5 ⇒ 弃 | 脚本 G9 |

**一个正例（骨架级）**

```json
{
  "op": "add", "type": "knowledge",
  "title": "memhub init 位置参数被静默忽略，只认 --root",
  "summary": "在 memhub init 下，位置路径参数会被静默忽略并落 cwd；代价是可能在源码仓根误建 hub 模板，必须显式传 --root 并事后校验目录内容。",
  "body": "## 适用场景\n用脚本调用 `memhub init` 初始化 hub 时。\n## 做法或事实\n只使用 `--root <PATH>`；位置参数不生效。\n## 验证方式\n初始化后检查 `<PROJECT_ROOT>` 是否新增了 `knowledge/`、`pending/` 等模板目录；若出现在 cwd 则误建。\n## 反例与陷阱\n在源码仓根目录直接 `memhub init some/path`，会把模板落到 `<PROJECT_ROOT>` 并可能被 commit。",
  "scope": { "level": "project", "workspaceId": "dsh-memory-hub" },
  "tags": ["cli", "init", "path"],
  "portability": "parameterized",
  "placeholders_used": ["<PROJECT_ROOT>"],
  "novelty": "new",
  "conflict": null,
  "source_refs": [{ "kind": "event", "ref": "evt_000087", "quote": "memhub init 的位置路径参数会被静默忽略（只认 --root），默认落 cwd" }],
  "confidence": 0.92,
  "evidence_strength": "stated_by_user",
  "behavior_shaping": true,
  "approval_tier": "single",
  "expires_at": null,
  "sensitive_flags": []
}
```

**一个反例（不要这样产出）**

```json
{ "op": "add", "type": "knowledge",
  "title": "今天在 dsh-memory-hub 目录下跑测试通过了",
  "summary": "在 E:\\009workspace\\dsh\\dsh-memory-hub 执行 pnpm test 成功。",
  "novelty": "new", "confidence": 0.95 }
```

错在哪：① 一次性状态（G4）；② 绝对路径未占位符化（G8）；③ 无可复用结论（G2）；④ 无 `source_refs`（G7/G5）；⑤ 结论可从仓库推导（G3）。

---

## 10. 补充调研：界面化定时、第二审核入口、分级信任与审核疲劳

> 需求方明确三件事：① 定时**时间**在界面配置（不是写死 cron 命令），到期自动触发；② 蒸馏产物进入**独立的第二审核入口**（「蒸馏审核」），与日常即时审核分开；③ 审核通过才入库。本节逐条回答，并给出可直接落地的配置与 UI 结构。

### 10.1 界面化定时：把「调度」当配置数据，不是当代码

**做法要点**

- 用户在面板里配的是**结构化调度对象**，落盘为 JSON（`config/distill.json`），CLI 读它；**不要**让界面生成 cron 字符串再解析——那是把"展示层"当"契约层"，改一次 UI 就要动一次解析器。
- 存"人类语义"而非"机器表达式"：`mode: daily|weekly|interval` + `at`/`days`/`everyHours` + `timezone`。若需要完整重复规则，用 [RFC 5545 RRULE](https://datatracker.ietf.org/doc/html/rfc5545#section-3.8.5.3)（行业惯例，iCalendar/日历类产品通用），仍由调度器解析，界面只做表单。
- 界面必须显示三样东西才叫"可配置"：**下次触发时间（本地时区）**、**上次触发结果**、**「立即试运行（dry-run，不提交提案）」**。
- 调度器**单实例持锁**：SRE 的分布式 cron 用 Paxos 选主，只有 leader 能启动任务、并把"已启动哪些 job"作为最重要状态持久化 [官方](https://sre.google/sre-book/distributed-periodic-scheduling/)。本地优先系统等价做法：`runs/.lock` 文件锁 + `last_launch` 状态落盘。
- 错过补偿与并发策略显式可配：参考 Kubernetes CronJob 的 `startingDeadlineSeconds`（错过多久内仍补跑）、错过次数超上限后不再补跑并报错、`concurrencyPolicy: Forbid|Replace` [官方](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)。建议默认 `Forbid` + 补跑上限 7 天。
- 幂等：`run_id = hash(watermark_from, watermark_to, config_version, prompt_version)`；重复触发先查 `runs/<run_id>.json` 是否已存在。

**建议的配置 schema（可直接实现）**

```json
{
  "enabled": true,
  "schedule": { "mode": "weekly", "days": ["MO","WE","FR"], "at": "09:30", "timezone": "Asia/Shanghai" },
  "window":   { "maxHours": 72, "maxEvents": 500 },
  "batch":    { "maxCandidates": 30, "shardEvents": 200 },
  "missed":   { "policy": "merge", "maxCatchupDays": 7, "concurrency": "forbid" },
  "trust":    { "autoPromote": false, "autoPromoteTypes": ["knowledge","assets"],
                "minConfidence": 0.85, "dailyAutoCap": 5, "autoTtlDays": 90 },
  "notify":   { "onFailure": true, "zeroOutputAlertAfter": 2, "dailyDigestAt": "09:00" }
}
```

**反例 / 陷阱**

- ❌ 界面写 cron 表达式（`30 9 * * 1,3,5`）：用户不懂、时区/DST 出错、无法校验"下一次是什么时候"。
- ❌ 定时写在代码/环境变量里：需求方明确要求"界面可配"，写死等于没做。
- ❌ 只显示"已启用"不显示"下次何时跑"：用户无法判断它是否活着（这是静默失败的第一现场）。
- ❌ 允许并发触发：两份提案 + 水位互相覆盖（比不跑更糟）。

### 10.2 「批量审核」与「实时审核」是否分开：业界证据

**结论：分开是主流，且分离维度通常是「来源/信任」而不是「时间」。**

四个真实的分层证据：

| 产品/系统 | 分离维度 | 具体做法 |
| --- | --- | --- |
| Claude Code | **按来源** | 人写的 `CLAUDE.md`（每次全量加载）与模型自己写的 auto memory（独立目录、独立预算、可浏览可编辑可删）是两套机制、两个审计入口 [官方](https://code.claude.com/docs/en/memory) |
| ChatGPT | **按来源 + 按风险** | `saved memories`（显式保存）与 `Reference chat history`（从历史派生、会随更新变化）分开管理；临时会话**既不产生也不更新**记忆 [官方](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) |
| Windsurf | **按来源** | 自动生成的 Memories（绑 workspace、按相关性检索）与人写的 rules（`global_rules.md`/`.windsurfrules`）完全分开 [官方](https://docs.devin.ai/windsurf/plugins/cascade/memories) |
| Alertmanager | **按标签路由到不同接收器** | `group_by` 把同一维度的告警聚成一条通知，route 按 label 分发到不同 receiver（不同渠道/不同人），并有 `group_wait`（聚合窗口）、`repeat_interval`（未处理则重复提醒）、`inhibit_rules`（父告警抑制子告警）[官方](https://prometheus.io/docs/alerting/latest/alertmanager/) |
| 内容审核（行业通例） | **按危害优先级 + SLA** | 队列按 `severity × prevalence × virality` 排序而非 FIFO；P0 队列 15 分钟 SLA 且路由给专门审核员，常规项 24 小时 [工程实践](https://github.com/spawn08/system-design-interview/blob/1c5b1dd03f47e17c87137db1f61d307dfb4d21ab/docs/genai_ml_system_design/content_moderation.md) |

**混在一起的代价（有量化案例）**：一个内容审核 agent 在突发时把 800 条同质请求塞进同一个队列，审核员的真实行为轨迹是"前 30 分钟仔细看 → 后 30 分钟加速 → 1 小时后整批盲批 → 2 小时后放弃"；结果是 340 条自动过期、200 条未审即批、15 条问题内容上线、3 条需紧急下架。该文档同时给出经验值：**60% 的审核员在 20+ 请求后开始盖章式通过；队列深度约 50 条时质量开始劣化** [工程实践](https://github.com/sarkars/agent-failure-modes/blob/main/agents/cross-cutting/operations/goals/human-oversight-reliability/failures/approval-queue-overflow.md)。

**对我们的裁决**：必须分两个入口，且分离依据写死为**来源 + 批量性**——

| | 收件箱（即时审核） | 蒸馏审核（第二入口） |
| --- | --- | --- |
| 来源 | 当次会话、agent 主动提交、人工即时记录 | 定时 run 的批量产物 |
| 规模 | 1–5 条/次 | 10–30 条/批 |
| 上下文 | 会话内，审的人有上下文 | 无会话上下文，必须靠批次摘要 + evidence quote |
| 延迟要求 | 分钟级 | 小时–天级 |
| 审批粒度 | 逐条 | 批次卡片 + 风险置顶 + 抽样 |
| 信任门槛 | 高（默认逐条） | 分级（见 §10.4） |

### 10.3 批次在审核 UI 里怎么表达：卡片还是打散成条目

**业界两种都有，但成熟做法是「卡片为容器、条目为最小决策单元」。**

真实案例：

- **Dependabot 分组 PR（卡片化的正面案例）**：不分组时"10 个可用更新 = 10 个 PR、10 次 CI、10 条审查通知"；分组后"一次审查"（one review），官方收益写明是"reduced PR volume / simplified review with better context / improved CI efficiency" [官方 changelog](https://github.blog/changelog/2025-07-01-single-pull-request-for-dependabot-multi-ecosystem-support/) ｜ [官方博客](https://github.blog/security/supply-chain-security/tame-dependabot-group-your-updates-slow-the-cadence-keep-security-fast/)。
- **GitHub pending review（先攒后交）**：审查者把多条行内评论存为 *pending*（仅自己可见、可随时编辑），全部想清楚后一次提交，形成一次决策 [官方](https://docs.github.com/en/pull-requests/get-started/reviewing-pull-requests-quickstart)。这正好是"批量审 ≠ 批量批"的形态：**收集是批量的，提交是单次决断**。
- **Alertmanager `group_by` + `group_wait`**：把同维度告警聚成一条通知，且等待窗口内的迟到者并入下一次（`group_interval`）；未处理则按 `repeat_interval` 重复提醒 [官方](https://prometheus.io/docs/alerting/latest/alertmanager/)。
- **Google 小 CL 原则（卡片大小的上限依据）**："一个自包含的改动"；**100 行通常合理，1000 行通常过大**；审查者有权**仅因为太大**就直接拒绝 [官方](https://google.github.io/eng-practices/review/developer/small-cls.html)。

**优劣对比**

| 形态 | 优 | 劣 | 适用 |
| --- | --- | --- | --- |
| 打散成条目（无批次概念） | 单条决策最干净、无连带风险 | 失去批次上下文；条目过多时必然盲批；回滚无边界 | 即时收件箱 |
| 一张批次卡片，只能整批接受/驳回 | 认知负担最低 | **连带风险**：一包里混进一条红线，整批被批或整批被退；且极易"抽看几条就整批通过"（overflow 文档明确指出 batching 会让审核员凭少数样本盖章，漏掉包内 outlier）[工程实践](https://github.com/sarkars/agent-failure-modes/blob/main/agents/cross-cutting/operations/goals/human-oversight-reliability/failures/approval-queue-overflow.md) | ❌ 不建议 |
| **卡片为容器 + 条目为决策单元 + 风险分层置顶** | 保留上下文、可整批处理低风险、高风险强制逐条；回滚以批为单位 | 实现稍复杂 | ✅ 蒸馏审核 |

**建议的批次卡片结构（面板第一屏，从下往上折叠）**

```
┌─ run 2026-11-29T09:30  ✅ 成功 · 用时 3m12s · 成本 $0.021 · prompt distill-v1
│  窗口 03:00→09:30 UTC+8 · 事件 213 / 会话 14 · 候选 18（自动入库 4 / 批量 9 / 逐条 5）
│  拒绝 7：derivable×3、duplicate×2、sensitive×1、one_off×1
│  ⚠ 冲突 2 条（KNO-000012, DEC-000004）
├─ [必须逐条] 5 条（constraint/decision/process/conflict）   ← 默认展开、不可整批
├─ [可批量]   9 条  [全批准] [全驳回] [抽样复核 10%]        ← 默认折叠、强制抽样
└─ [已自动入库] 4 条（可整批回滚）                          ← 只读、每日配额内
```

- 卡片头部必带：`run_id`、窗口、事件/会话数、候选数、按 tier 的计数、拒绝原因 top3、成本、`prompt_version`、水位前后、以及 `[回滚本批]`。
- 条目行必带：`title`、`summary`、`source_refs[0].quote`（原文片段，一眼能判真假）、`confidence`、与既有条目的关系（`new/extends/conflicts`）。
- **diff 高亮**：`op: update/supersede` 时展示相对旧条目的 `summary` 变化（增加/删除的词），而不是整段重排。

**反例 / 陷阱**

- ❌ 只给"批次标题 + 批准"：等于鼓励盲批（见 §10.5 的数字）。
- ❌ 把红线条目埋在批量组里：一包 30 条里混一条 `constraint`，人只会看第一屏。
- ❌ 批次卡片不显示"拒绝原因分布"：人看不到系统在漏什么，也无法据以调 prompt。
- ❌ 整批接受后无法按批回滚：一次系统性偏差就永久入库。

### 10.4 分级审批与自动通过阈值：业界做法与失败模式

**主流是三段式风险路由**（不是"自动 vs 人工"二分）：

1. **高置信 + 低风险 → 自动放行（auto-clear）**，事后可查、可撤销；
2. **灰区 → 人工**，只让真正模糊的进队列；
3. **高置信 + 高风险 → 自动升级到专用队列/强制人工**。

这一形态在审核系统里被明确写为"throttle-and-triage gateway"：在队列前加一层自动分流（confidence-based auto-clear + auto-escalate），让峰值期间只有灰区到达人工 [工程实践](https://github.com/sarkars/agent-failure-modes/blob/main/agents/cross-cutting/operations/goals/human-oversight-reliability/failures/approval-queue-overflow.md)。

**策略化自动化的成熟形态**：GitHub 的 Dependabot auto-triage rules 允许用**规则**表达"这类告警自动忽略/自动开 PR"，把"自动化边界"变成可审计的配置而不是模型的一次判断 [官方](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-auto-triage-rules)。对我们的启示：**自动入库条件必须是配置项 + 规则引擎判定，不能是 prompt 里的一句"若置信度高可自动通过"**——后者会被模型自我合理化。

**推荐的三级信任模型（写进代码）**

| Tier | 条件（全部满足） | 处置 | 兜底 |
| --- | --- | --- | --- |
| **T0 自动入库** | type ∈ `{knowledge, assets}`；`confidence ≥ 0.85`；`source_refs ≥ 2` 且均可定位；无 `conflicts`；非敏感；**每日配额内（≤5 条）** | 直接 accepted + `auto_promoted: true` + `expires_at = +90d` | 周度抽样 10%；可按 run 整批回滚；超期自动降权 |
| **T1 批量审** | `{api-catalog, runtime-base, open-questions, knowledge(低置信)}`；无冲突 | 批次卡片内批量批准/驳回 | 强制抽样 10% 看 quote |
| **T2 逐条审** | `{constraint, decision, process, playbooks}` **或** 任何 `conflicts:*` **或** 任何 `evidence_strength=tool_output` | 一条一议、必须看 quote、不可整批 | 永不自动；无 SLA 自动批准，超时只能作废 |

**自动入库后被污染的案例与防护**

- **攻击侧**：MINJA 证明攻击者只靠"查询 + 观察输出"即可把恶意记录逐步注入 agent 记忆，注入后能被后续查询检索到 [论文](https://arxiv.org/abs/2503.03704)。**自动化放行的每一分便利，都在为这类攻击扩大可达面**——所以 T0 必须排除"从外部内容（网页/第三方工具输出）来的信息"，只对"用户陈述 + 代码/仓库内可验证事实"开放。
- **事故侧**：上述 overflow 案例里 200 条未审即批、15 条问题内容上线、3 条紧急下架 [工程实践](https://github.com/sarkars/agent-failure-modes/blob/main/agents/cross-cutting/operations/goals/human-oversight-reliability/failures/approval-queue-overflow.md)。可迁移的教训是：**批量批准必须留下"批内抽样证据"，且事后必须做抽样审计**。
- 四道兜底（缺一不可）：① 自动入库带 TTL 且到期降权；② 每日/每批配额上限（防止一次 run 把库冲刷）；③ 可按 `run_id` 整批回滚；④ 周度抽样审计 + 审计结果反向调阈值。

**失败模式清单（尤其注意前两条）**

| 失败模式 | 表现 | 防护 |
| --- | --- | --- |
| **自评置信度通胀** | 模型学会输出 0.9+，T0 比例飙升 | 阈值只读**外部可验证信号**（证据条数、冲突数、是否有 quote、占位符合规），不读模型自评 |
| **triage 层自身是新失败点** | 自动放行了本该人审的（拦错的代价被藏起来） | 对"自动放行"做**反向抽样**（不只抽灰区）；记录 auto-clear 的后续 rework 率 |
| **灰区变宽** | 阈值一调，人工队列暴涨 → 盲批 | 监控"人工队列长度/审均耗时"作为一等指标；超阈值先降批大小而不是催人 |
| **自动化边界写在 prompt 里** | 模型自行决定"这条可以自动过" | 边界只在代码/配置里，prompt 只输出 `approval_tier` 建议值，最终由规则引擎裁决 |
| **只增多不淘汰** | 自动入库条目永不失效 | TTL + `last_verified` 超期降权 + 季度 stale 扫描 |

### 10.5 审核疲劳的量化经验与对抗手段

**可引用的量化数据**

| 数据 | 数值 | 来源 |
| --- | --- | --- |
| 盖章式通过率 | **20+ 请求后 60% 的审核员开始盲批** | [工程实践](https://github.com/sarkars/agent-failure-modes/blob/main/agents/cross-cutting/operations/goals/human-oversight-reliability/failures/approval-queue-overflow.md) |
| 队列深度劣化点 | **约 50 条**；告警阈值 200 | 同上 |
| 溢出期请求丢失 | **25%**；目标"自动过期率 < 2%"、告警 > 15% | 同上 |
| 盲批检测口径 | 目标 `rubber_stamp_rate < 10%`，> 40% 告警 | 同上 |
| on-call 事件上限 | **每个 12 小时班次最多 2 个 incident**（单个 incident 约 6 小时含复盘） | [官方 SRE](https://sre.google/sre-book/being-on-call/) |
| 告警/事件比 | 噪声告警应调到接近 **1:1**；每小时都在响的低优先级告警会削弱对重要告警的注意力 | 同上 |
| 单次代码审查量 | **200–400 LOC / 次**，约 **300–500 LOC/小时**，**不超过 60–90 分钟** | [工程实践](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/)（Cisco 2500 次审查研究） |
| CL 大小上限 | 100 行通常合理、1000 行通常过大；审查者可仅因过大而拒绝 | [官方](https://google.github.io/eng-practices/review/developer/small-cls.html) |

**换算到我们的审核预算（建议直接写进产品约束）**

- **单批候选 ≤ 30 条**（对应"100 行合理 / 1000 行过大"的类比上限）。
- **单次蒸馏审核 ≤ 60 分钟**；超过则拆批。
- **人工队列长度 > 50 条（或 > 2 批）→ 触发 backpressure**：缩小批大小、拉长周期、暂停低价值 type 的萃取，而不是催人加班。
- **盲批检测**：条目平均停留 < 8 秒即批准，计入 `rubber_stamp`；比率 > 40% 时强制启用"必须看 quote 才能点批准"模式。

**对抗手段（按性价比排序）**

1. **按风险排序而非按时间**：T2/冲突项永远置顶；审核者第一屏只该看到"必须你决定的"（与 SRE "所有 paging 告警都必须可行动"同理 [官方](https://sre.google/sre-book/being-on-call/)）。
2. **批次摘要卡**：先给"这次跑了什么、拒绝原因分布、异常信号"，再看条目——这是"概览先于细节"。
3. **证据高亮**：默认展示 `source_refs[0].quote`（原文 200 字），审核判定的是"结论能否由原文推出"，不是文笔。
4. **差异高亮**：`update/supersede` 只展示 summary 的词级 diff。
5. **抽样复核**：T1 强制抽 10%，T0 反向抽 10%；抽样结果作为阈值调整依据。
6. **抑制与去重**：同一 `run` 内同义条目合并（Alertmanager `inhibit_rules` 的等价物——父事件已覆盖的子事件不再单独打扰 [官方](https://prometheus.io/docs/alerting/latest/alertmanager/)）。
7. **重复提醒而非塞更多**：未处理的批次按固定节奏提醒（`repeat_interval` 语义），而不是每次 run 都新增一批。
8. **生成侧限流**：队列满时先**减少生成**（backpressure），这是唯一真正治本的手段 [工程实践](https://github.com/sarkars/agent-failure-modes/blob/main/agents/cross-cutting/operations/goals/human-oversight-reliability/failures/approval-queue-overflow.md)。

**反例 / 陷阱**

- ❌ 用"提高审核速度"当解法：速度提升的代价必然是判定质量，且不可观测。
- ❌ 把每日摘要做成"又来 40 条待审"：这只是把压力转成通知噪音，制造第二层疲劳。
- ❌ 无 SLA 的超时策略：要么自动批准（污染），要么静默过期（丢知识）——应显式选择"作废并可重跑"。
- ❌ 只统计"批准数"不统计"停留时长/抽样结果"：疲劳是不可见的，直到某天整批被污染。

### 10.6 落到 dsh-memory-hub 的最小改动清单

1. **配置**：新增 `config/distill.json`（schema 见 §10.1），面板加"蒸馏调度"表单 + 下次触发时间 + 立即 dry-run；CLI 加 `memhub distill schedule get/set`、`memhub distill run [--dry-run]`。
2. **路由**：`proposal` 文件增加 `origin: inbox|distill` 与 `run_id` 两个字段（属新增可选键 → 按 `KNOWLEDGE-FORMAT.md` 属 minor）；面板据此渲染两个 tab。
3. **第二入口**：新增 `蒸馏审核` tab，按 §10.3 的卡片结构渲染；批次操作以 `run_id` 为单位，提供"整批回滚"。
4. **规则引擎**：新增 `decideTier(candidate, config)` 纯函数（T0/T1/T2 判定），单测覆盖 §10.4 的五种失败模式；**prompt 只输出建议值**。
5. **疲劳护栏**：`batch.maxCandidates=30`、队列 > 50 触发 backpressure、`rubber_stamp` 采样统计（批准耗时 < 8s）。
6. **指标**：在 §7 的 manifest 上增加 `auto_promoted_ratio`、`t2_queue_depth`、`rubber_stamp_rate`、`auto_rollback_count` 四个字段；核心看板仍控制在 8 个以内。

---

## 11. 参考来源

**Anthropic 官方**
- [How Claude remembers your project（CLAUDE.md / rules / auto memory）](https://code.claude.com/docs/en/memory)
- [Extend Claude with skills（SKILL.md、渐进披露、动态注入）](https://code.claude.com/docs/en/skills.md)
- [Memory tool（beta，`/memories`，六命令、系统提示、安全约束）](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Introducing Contextual Retrieval（−49%/−67% 检索失败率、prompt caching 成本）](https://www.anthropic.com/research/contextual-retrieval)
- [Agent Skills 规范](https://agentskills.io/specification) ｜ [Skill 创作最佳实践](https://agentskills.io/skill-creation/best-practices)

**产品机制**
- [Memory in ChatGPT（summary/Sources/纠正/30 天删除）](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)
- [Cursor Rules（四类规则、`.mdc` frontmatter 决策矩阵）](https://cursor.com/docs/rules)
- [Windsurf Cascade Memories & Rules（自动记忆绑 workspace、6000 字符上限）](https://docs.devin.ai/windsurf/plugins/cascade/memories)

**工程实现与论文**
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)（抽取+更新两阶段、ADD/UPDATE/DELETE/NOOP、LOCOMO）
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)（双时间轴、失效而非删除、DMR/LongMemEval）
- [LangMem: How to Extract Semantic Memories](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/)（schema 化、context 字段、并行工具调用、RemoveDoc、memory manager agent）
- [Sleep-time Compute](https://arxiv.org/abs/2504.13171)（离线"想"、约 5x 推理节省、按上下文摊销）
- [Memory Injection Attacks on LLM Agents via Query-Only Interaction (MINJA)](https://arxiv.org/abs/2503.03704)（记忆投毒攻击面）
- [Generative Agents](https://arxiv.org/abs/2304.03442)（importance 累积到阈值触发 reflection）

**运维与度量**
- [Kubernetes CronJob（startingDeadlineSeconds、错过补跑上限、concurrencyPolicy）](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [Stripe Idempotent requests（幂等键语义）](https://docs.stripe.com/api/idempotent_requests)
- [Google SRE Book: Monitoring Distributed Systems（四个黄金信号、症状式告警）](https://sre.google/sre-book/monitoring-distributed-systems/)

**审核队列 / 批次 / 分级信任（§10 使用）**
- [Approval Queue Overflow（盲批率 60%/20+ 请求、队列劣化点 ~50、溢出丢失 25%、批处理漏 outlier）](https://github.com/sarkars/agent-failure-modes/blob/main/agents/cross-cutting/operations/goals/human-oversight-reliability/failures/approval-queue-overflow.md)
- [Google SRE：Being On-Call（12 小时班次最多 2 个 incident、告警/事件比 1:1、paging 必须可行动）](https://sre.google/sre-book/being-on-call/)
- [Google SRE：Distributed Periodic Scheduling with Cron（单 leader 启动、以"已启动哪些 job"为最重要状态、幂等性讨论）](https://sre.google/sre-book/distributed-periodic-scheduling/)
- [Google eng-practices：Small CLs（100 行合理/1000 行过大、可仅因过大拒绝）](https://google.github.io/eng-practices/review/developer/small-cls.html)
- [SmartBear：Best Practices for Peer Code Review（Cisco 研究：200–400 LOC/次、300–500 LOC/小时、≤60–90 分钟）](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/)
- [GitHub Changelog：Dependabot 单 PR 分组（10 更新=10 PR/10 CI/10 通知 → 一次审查）](https://github.blog/changelog/2025-07-01-single-pull-request-for-dependabot-multi-ecosystem-support/)
- [GitHub 博客：Tame Dependabot（分组降噪、保持安全更新快节奏）](https://github.blog/security/supply-chain-security/tame-dependabot-group-your-updates-slow-the-cadence-keep-security-fast/)
- [GitHub Docs：Reviewing pull requests（pending review：先攒评论后一次提交）](https://docs.github.com/en/pull-requests/get-started/reviewing-pull-requests-quickstart)
- [GitHub Docs：Dependabot auto-triage rules（策略化自动分诊，可审计的自动化边界）](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-auto-triage-rules)
- [Prometheus Alertmanager（group_by / group_wait / group_interval / repeat_interval / inhibit_rules）](https://prometheus.io/docs/alerting/latest/alertmanager/)
- [内容审核队列分层与 SLA（按 severity×prevalence×virality 排序，P0 15 分钟 vs 常规 24 小时）](https://github.com/spawn08/system-design-interview/blob/1c5b1dd03f47e17c87137db1f61d307dfb4d21ab/docs/genai_ml_system_design/content_moderation.md)
- [RFC 5545 §3.8.5.3 RRULE（界面化重复规则的通用表达）](https://datatracker.ietf.org/doc/html/rfc5545#section-3.8.5.3)
- [Kubernetes CronJob（startingDeadlineSeconds / 错过上限 / concurrencyPolicy）](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)

**本仓内相关文档**
- [知识类型定义](../05-domain/knowledge-types.md) ｜ [知识文件格式契约](../KNOWLEDGE-FORMAT.md)

---

*本文只做调研与建议，未改动任何实现文件。落地时请以 `KNOWLEDGE-FORMAT.md` 的字段契约为准，本文中的 schema 字段名需映射到实际 proposal 文件格式。*
