# Context Policy — 检索 vs 注入

> 状态：设计定案（继承旧仓 cross-host-memory-flow.md 的拉取混合模式结论）。数值为设计基线，实测后校准。

## 原则

**检索是主动的、注入是被动的**：模型需要历史时主动 `memory_search`（按需、精准、有引用）；注入只提供"存在感"——让模型知道有记忆、记忆里大概有什么，而不是把记忆塞进上下文。

## 注入通道与预算（拉取混合模式）

| 通道 | 时机 | 预算 | 内容 |
| --- | --- | --- | --- |
| 静态包 | SessionStart / 会话首轮 | **~250 tokens** | 工作区身份 + 知识条数 + 最近 3 条决策标题 + 指令一行（"涉及历史决策先调 memory_search"） |
| 变化检测 | UserPromptSubmit 每轮 | 0（无变化）/ ~150 tokens | 内容指纹（mtime + count hash）变化时补发增量摘要 |
| 主动检索 | 模型调用 memory_search | 按需 | 真正的知识内容（摘要级，全文按需 get） |

**不推荐每轮全量注入**：cache 位置未实测前，每轮变动的 system 尾部会让 prompt cache 全部失效——代价远超收益。

## 萃取（SessionEnd）

- `memhub extract`：把会话中有复用价值的经验写成 pending 候选。
- **红线**：只写 `project:<本工作区>` scope，永不直接写 domain/global（只进不升——升级走提炼提案 + 人批准）。
- 候选带 `source_refs`（session:<id>#from-to / file: / url:），无证据的萃取会被审批界面标黄。

## 与工具面的关系

注入提供的是**索引页**，工具面才是**正文**。两者预算此消彼长：注入预算越大，模型主动检索越少——保持注入最小化是设计立场，不是成本妥协。
