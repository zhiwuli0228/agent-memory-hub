# Module Boundaries

> 对齐旧仓 harness-standard §1/§3，但按双层结构改写。由静态测试守住（Step 3 加入）。

## 目录规划（src/）

```text
src/
  index.ts            # 公共导出
  cli.ts              # bin 入口（memhub）—— 只做参数解析 + 分发
  core/
    types.ts          # ✅ 类型契约（已实现）
    frontmatter.ts    # ✅ 零依赖 frontmatter 契约解析（已实现）
    ids.ts            # ID 生成（DEC-/KNO-/PRC-/PRO- 前缀 + 序列）
    time.ts           # 时间工具（ISO 8601 + 时区）
    errors.ts         # 错误码
    atomic.ts         # 原子写（tmp + rename）
    hub.ts            # Hub 目录管理 + 初始化 + 目录说明书
    store.ts          # knowledge/pending/history CRUD
    search.ts         # 分词 + 倒排 + BM25-lite
    scope.ts          # scope 祖先链与可见性
    registry.ts       # workspaces/core_workspaces/parentCoreIds 注册表
    ledger.ts         # JSONL 账本（只追加）
    lock.ts           # 写锁租约（心跳 + fencing）
    config.ts         # 配置校验
  transport/
    mcp.ts            # MCP stdio server（工具面 = tool-surface.md）
    http.ts           # HTTP router（serve 面板与 CLI 共用）
    cli-commands.ts   # 子命令实现
```

## 硬性约束（静态测试断言）

`core/` 中出现下列任一符号即为违规：

- `@deepseek-ai/`、`ctx.inject`、`ctx.get`、`webServer`、`clientModules`
- 宿主事件名（`agent/pre-step`、`UserPromptSubmit` 等字符串字面量）
- `fetch` / `http.request` / `net.connect`（零网络不变量；远端 client 由 transport 注入）

`transport/` 中禁止：

- 自己实现检索/排序/作用域判断（那是 core 的事）
- 在 MCP 层再发明一套错误语义（错误码统一在 core/errors）

## 依赖策略

- 运行时依赖：目标**零**（Node 内建 + 必要时 yaml 解析器一枚，Step 2 评估——若自研解析器覆盖契约面则保持零）。
- 开发依赖：typescript、vitest（已装）。
- 禁止：peer dependencies、native modules、postinstall 脚本。
