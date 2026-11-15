# Tool Surface — memory_* 工具面契约

> 状态：设计定案。**工具名冻结**（四宿主实测 + 与 `agent-memory-hub` 词根一致，改名零收益高风险）。Schema 细节随 Step 3 实现充实，但名称与语义分组的变更需 ADR。

## 工具清单（对齐旧仓 V0.8 八工具 + 审批链路）

| 工具 | 语义 | 写? | 说明 |
| --- | --- | --- | --- |
| `memory_search` | 检索 | 否 | 关键词/自然语言 + scope 过滤 + status 过滤；返回 ID + version + 摘要 |
| `memory_get` | 读取 | 否 | 按 ID 取条目（默认摘要 + 章节目录；`full` / `section` 按需） |
| `memory_status` | 自检 | 否 | hub 根、工作区（含 `exact` 如实标注）、写锁租约、mounts、计数 |
| `memory_propose` | 提案 | 写→pending | 创建 `pending/PRO-*.md` 候选；**永远不能自批** |
| `memory_cite` | 引用 | 否 | 记录"某条知识影响了当前任务"（审计与老化依据） |
| `memory_close_task` | 收尾 | 否 | 任务级回写评估（proposed / no_new_knowledge / needs_evidence / deferred） |
| `memory_commit` | 批准 | 写→knowledge | **人批准专用**：宿主原生审批 prompt；无审批落点时失败关闭 |
| `memory_duplicates` | 查重 | 否 | 近重复对检测（读-only，永不写文件） |

## 错误语义（与旧仓同义，不漂移）

- 写操作被锁：返回 `readOnly: true` + 持有者租约信息（不是笼统报错）。
- 无审批落点时 `memory_commit`：**失败关闭**——错误信息写明"需在面板/CLI inbox 审批"，绝不降级自动批准。
- scope 越界：显式错误（模型不能选身份——工具不提供该参数）。
- hub 未初始化：错误信息带 `memhub init` 指引。

## 设计规则

1. 每个工具的 description 是给模型的行为规范：写清楚何时用、何时不用（继承旧仓 agent-experience 标准）。
2. 返回内容预算：search 默认 8 条摘要级；get 默认 digest——全文必须显式请求。
3. 工具数量克制：不加"顺带有用"的工具；新工具先过 harness-standard 的"三判据"。
