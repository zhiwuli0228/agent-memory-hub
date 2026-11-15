# Knowledge Types

> 继承旧仓类型体系（格式契约共享，类型枚举与 frontmatter 解析器一致）。状态：✅ 枚举已实现（src/core/types.ts）。

| type | 用途 | 典型来源 |
| --- | --- | --- |
| `decision` | 已定决策（为什么选 A 不选 B） | ADR、用户拍板 |
| `constraint` | 硬约束（不变量、红线、兼容性承诺） | AGENTS、契约文档 |
| `knowledge` | 事实与认知（某机制如何工作、某坑如何修） | 调试、调研 |
| `api-catalog` | API/接口清单（签名 + 语义 + 实现状态） | 源码提炼 |
| `process` | 可复用操作流程（场景 → 步骤 → 规范） | 运维复盘 |
| `open-questions` | 未决问题（含当前倾向与证据缺口） | 讨论残留 |
| `runtime-base` | 运行时版本事实（某版本某行为） | 升级实测 |
| `playbooks` | 端到端玩法（多步流程 + 验证点） | 场景沉淀 |
| `assets` | 外部资源索引（链接 + 定位说明，非代码资产） | 收藏整理 |

## 使用规则

1. 一个条目一个 type——跨类型的拆成多条（检索粒度）。
2. `decision` 必须带证据链（source_refs：session/file/url），无证据不入库。
3. `constraint` 是最强承诺：变更需走提案；读者应把它当"不能动"。
4. `open-questions` 有结论后转为对应类型并 `supersedes` 原条目，不留僵尸问题。
