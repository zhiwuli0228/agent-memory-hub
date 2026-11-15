# ADR-0010: 独立 Web 管理台为第一公民，宿主内嵌为可选复用

日期：2026-11-15 · 状态：已接受 · 触发：用户产品反馈（切换薄包后审批退化成命令行，不可接受）

## 背景

引擎切换（dsh-memory-hub 0.8.1 → agent-memory-hub 薄包）后，审批入口只剩 `memhub inbox` CLI 命令——用户明确否定："命令审批的形式完全不可行，使用者不会用这么复杂的命令去做审批"。同时用户给出通用性要求："应该有专门的 web 界面……独立的界面来管理，这样通用性才是最好的，避免 opencode cli 以及 claude code cli 等无法直接在界面上操作"。

## 决策

1. **`memhub serve` 面板升级为独立 Web 管理台**（memory console）：所有宿主共用的人机管理面。功能覆盖审批之外的记忆库管理——条目浏览/检索/详情/废弃/删除、journal 与 ledger 审计视图、统计概览。任何宿主（DSH、Claude Code、opencode、gemini CLI、codex）的用户用同一条命令进入同一套界面。
2. **宿主内嵌（如 DSH client slot）是可选的第二层**：内嵌组件消费与独立管理台**完全相同**的路由 API，只是渲染宿主不同。不做宿主专属管理功能。
3. **启动体验**：`memhub serve` 默认绑定 loopback 并打印（后续自动打开）URL；服务按需启动（DEC-0018 维持），不常驻。
4. **CLI 保留为兜底人通道**（isHumanChannel 契约不变），但不再是主推路径。
5. 失败关闭不变：管理台的一切写操作都走 core 的 `isHumanChannel`/审批门禁，HTTP 面板通道标记为 `panel`。

## 理由

- 审批/管理是记忆系统的日常人机交互，体验差距直接决定系统是否被使用（KNO-000003：预检运行不等于被使用）。
- CLI 宿主没有可内嵌 GUI——独立 Web 界面是唯一对所有宿主形态公平的入口。
- 腾讯 Agent Memory 的管理台是用户认可的产品形态对标。

## 后果

- V0.2 里程碑：管理台多 tab（收件箱/记忆库/审计）+ 路由扩展（entries 浏览、deprecate/hard-delete 门禁）。
- DSH 薄包的 client slot 延后为可选增强（复用同一 API，架构成本为零）。
- 测试期 config 中 `root` 指向真 hub 的现状维持，管理台操作真实数据。
