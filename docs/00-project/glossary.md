# Glossary

| 术语 | 含义 |
| --- | --- |
| **Hub** | 一个记忆根目录：`knowledge/` + `pending/` + `history/` + `records/`。文件是权威。 |
| **knowledge/** | 已批准的知识文件（Markdown + YAML frontmatter），按类型分目录。 |
| **pending/** | 模型创建的候选（`PRO-*.md`），等待人批准。模型永远不能自批。 |
| **history/** | 每次版本变更的原文快照 `<ID>@v<N>.md`，只追加。 |
| **records/ledger.jsonl** | 审批账本：谁、何时、以什么证据批准了什么。只追加。 |
| **workspace** | 一个项目作用域（对应一个工作目录/仓库）。金字塔：project < domain < global。 |
| **core** | 存储、检索、审批、账本、锁。零宿主依赖，不得 import 任何宿主 SDK。 |
| **transport** | MCP stdio / HTTP router / CLI。把 core 的能力翻译成协议，含审批失败关闭门禁。 |
| **memhub** | CLI 命令与 MCP server 名。 |
| **T 档** | 宿主能力分档：T3（注入+捕获+审批齐备）/ T2 / T1（仅工具面）/ T0（仅 CLI）。见 harness-standard。 |
| **注入（inject）** | 会话开始/每轮前把预检摘要放入上下文。三条通道：base_url 代理 / 生命周期钩子 / MCP+skill。 |
| **萃取（extract）** | 会话结束时把有价值的经验写成 pending 候选。红线：只写本工作区 scope。 |
| **金字塔塌陷** | 旧仓教训：非 DSH 入口合成 workspace 导致 project 知识不可见。本仓 day 0 用注册表匹配根除。 |
| **失败关闭（fail closed）** | 无审批落点时写操作直接报错，不降级为自动批准。 |
| **写锁租约** | 多入口并发写仲裁：心跳 + 超龄回收 + fencing token（继承旧仓 ADR-0009）。 |
