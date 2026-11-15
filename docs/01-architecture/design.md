# V0.1 Design

> 状态：设计骨架（架构已定案，模块细节随 Step 2/3 实现充实）。逐项标注状态：**已实现 / 设计 / 待核**（三档不混用）。

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
│  store · index/search · scope/registry · ledger     │
│  lock(lease+fencing) · frontmatter · hub-init       │
│  零宿主依赖 · 零网络（远端由注入的 client 承担）      │
└───────────────▲────────────────────────────────────┘
                │ 读/写文件（文件是权威）
        knowledge/ pending/ history/ records/
```

## 与旧仓 dsh-memory-hub 的结构差异

| 旧仓（三层） | 本仓（双层） | 原因 |
| --- | --- | --- |
| core → transport → host-glue | core → transport | DSH 接入是独立薄包，不属于本仓（ADR-0001 原则 1） |
| hub-handle 合成 workspace（塌陷） | 注册表匹配 + 文档化回退 | 原则 2：非 DSH 入口不得静默隐藏 project 知识 |
| 审批依赖宿主钩子（DSH 原生 prompt） | transport 层失败关闭 | 原则 4：任何入口的写操作不依赖宿主配合 |

## 数据面

- **写路径**（唯一）：模型/用户 → transport 门禁 → core 校验 → `pending/` 候选 → **人批准**（面板/CLI inbox）→ core commit → `knowledge/` + `history/` 快照 + `records/ledger.jsonl`。
- **读路径**：`search`（倒排 + BM25-lite + scope 过滤 + 祖先链）→ `get`（frontmatter + 摘要，按需全文）→ 引用即 ID。
- **蒸馏/升级**（后期）：project → domain/global 只能经提炼提案 + 人批准，永不自动晋升。

## 检索设计（Step 2 落地）

- 分词：CJK bigram + ASCII 词干（继承旧仓 search 实现思路）。
- 索引：内存倒排，启动全量重建（旧仓实测规模 45–3000 条无压力；规模预案见旧仓 scale-plan）。
- 过滤：scope 祖先链（project 只见本工作区 + 上游 domain/global）+ status=accepted。
- 排序：BM25-lite + 本地加成（local_boost）+ 时间衰减（继承旧仓 DEC-000002 参数基线，重标定）。

## 身份与作用域

- workspace 身份由入口进程执行上下文决定：`--root`/`--workspace` 显式参数 > 注册表匹配 cwd > 文档化回退（合成 workspace + `status.workspace.exact=false` 如实标注）。
- 模型永远不能在工具参数里选"以谁的身份查"（原则 3）。
