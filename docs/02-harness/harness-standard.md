# Harness 集成标准

> 状态：设计定案（继承旧仓标准，双层化改写）。运行时行为以 COMPATIBILITY.md 复验记录为准。

## 1. 双层与边界

```text
core/          store · search · registry · lock · ledger · frontmatter
               ↑ 零宿主依赖：不得 import 宿主 SDK，不得出现 ctx.，不得发网络请求
transport/     mcp-stdio · http-router · cli
               ↑ 只依赖 core：把同一份能力翻译成 MCP 工具 / HTTP 端点 / 子命令
(无 host-glue) DSH 接入 = 未来独立薄包（本仓之外），只做时机映射与形状转换
```

**硬性约束**（静态测试守住）：core 中出现 `@deepseek-ai/`、`ctx.inject`、`webServer`、宿主事件名、`fetch` 即违规。违反的后果不是代码丑，而是**换宿主必须改核心**。

## 2. 四条接入路径

| 方式 | 在途？ | 能注入 | 能捕获 | 覆盖 | 实际可用性 |
| --- | --- | --- | --- | --- | --- |
| ① API 代理（改 `base_url`） | 是 | ✅ | ✅ | 支持自定义端点的宿主 | 受组织策略约束（企业 pin allowedProviders 即不可用） |
| ② 生命周期钩子 | 否 | ✅（有轮前钩子时） | ✅ | 部分宿主 | 最稳：不受网关策略与 preserved thinking 影响 |
| ③ MCP / 工具 | 否 | ❌ | ❌ | 几乎所有宿主 | **基本盘** |
| ④ CLI / 文件 | 否 | ❌ | ❌ | 全部 | 兜底 |

**优先顺序**：③ 全覆盖 → 对有轮前钩子的宿主加 ② → ① 仅限个人用户 + 无组织策略限制 + 接受隐私与缓存代价。

**不要**为"统一"用代理覆盖所有宿主。两条硬伤：改写请求体可能触发 preserved thinking 校验（400）；企业钉定 allowedProviders 后本地代理被代码层拒绝。

## 3. 宿主能力分档

判据只看三件事：**轮前注入点、轮末捕获点、审批落点**。

| 档位 | 判据 | 典型宿主 |
| --- | --- | --- |
| T3 | inject + capture + approve 齐备 | DSH（旧仓实测）；Claude Code、opencode（文档） |
| T2 | 有 inject，缺 capture 或 approve | — |
| T1 | 只有工具面 | Codex、Cline、Cursor、Zed（可靠 ① 升级） |
| T0 | 只有 CLI / 文件 | 任何 shell |

缺任一项一律 ③ MCP 打底，再评估 ② 补齐。

## 4. 降级阶梯（每格必须仍然有用）

| 缺失能力 | 退化行为 | 用户看到什么 |
| --- | --- | --- |
| 无轮前注入钩子 | 不自动预检，模型靠 MCP 主动查 | 指令写明"涉及历史决策先调 memory_search"；`status.inject=false` |
| 无原生审批落点 | 转 CLI inbox 或 serve 面板 | `memhub inbox --approve <ID>`；模型侧只产出候选 |
| 无 UI | `memhub serve` standalone 面板 | 打印 URL + token 一次 |
| 并发写冲突 | 降级只读 | `readOnly: true` + 持有者租约信息 |

**铁律**：任何降级不得触碰不变量——没有审批落点时写操作失败关闭，绝不自动批准。

## 5. 身份规则

- workspace 身份由入口进程的执行上下文决定，解析顺序（ADR-0002）：显式 `--workspace` > git origin remote > 规范项目目录 > 合成回退。首次使用**自动登记**（零配置），名字可后改。
- 回退不是塌陷：合成 workspace 必须在 `status` 中如实标注（`workspace.exact=false`），绝不静默隐藏 project 知识。
- 模型可以在参数里选"查什么"，永远不能选"以谁的身份查"。
