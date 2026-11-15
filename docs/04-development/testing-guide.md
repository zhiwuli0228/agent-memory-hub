# Testing Guide

## 原则：测试即契约（ADR-0001 原则 8）

- **一个行为一个测试**；四入口（MCP / HTTP / CLI / 面板 API）共享同一套集成测试——入口差异只在 transport 适配层测一次。
- 契约测试（格式/工具面/账本）的样例**必须来自真实 hub 数据**，不许发明语法。
- 默认测试套件**永不离线**（不变量 4 的测试化）；网络相关测试用环境变量闸门（如 `MEMHUB_E2E=1`）。

## 目录

```text
tests/
  format.test.ts        # ✅ frontmatter 契约（7 用例，与旧仓格式互锁）
  store.test.ts         # Step 2：CRUD + 原子写 + history 快照
  search.test.ts        # Step 2：分词/倒排/BM25 + scope 祖先链
  registry.test.ts      # Step 2：注册表匹配 + 文档化回退
  lock.test.ts          # Step 2：租约 + fencing + 超龄回收
  transport/
    mcp.test.ts         # Step 3：握手/工具面/错误语义（裸 stdio 冒烟）
    cli.test.ts         # Step 3：子命令
    approval.test.ts    # Step 4：失败关闭门禁（无审批落点 → 拒绝）
  compat/
    old-hub.test.ts     # 对真实旧 hub 只读盘点（验收级）
```

## 关键测试策略

1. **静态边界测试**：grep `src/core/` 禁入符号（宿主 SDK / fetch / 宿主事件名），命中即 fail——把 harness-standard 的硬性约束自动化。
2. **失败关闭测试**：把审批落点 mock 掉，断言所有写工具拒绝——不变量 2 的测试化。
3. **零网络测试**：测试进程内断言无出网（可用 DNS mock / 禁网断言库，或代码审查 + 静态禁符号双保险）。
4. **租约竞态测试**：双写者并发、心跳超时、fencing token 拒绝旧 token。
5. **双向格式兼容**：本仓解析器读旧仓写的 fixture；旧仓解析器读本仓写的 fixture（CI 里跑旧仓测试脚本）。

## 覆盖基线

不追求覆盖率数字，追求**行为被测试**：每个 ADR 的 Consequences 至少一条可测陈述进入测试。
