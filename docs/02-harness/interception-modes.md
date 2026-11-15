# Interception Modes — 四条接入方式

> 状态：设计定案（继承旧仓 interception-modes 核心结论，本仓按双层结构改写）。

## ① API 代理（改 base_url）

- **原理**：在宿主与模型 API 之间放本地代理，改写请求（注入预检上下文）与响应（捕获会话内容）。
- **能力**：唯一的"在途"通道——注入与捕获全自动，覆盖任何支持自定义端点的宿主。
- **代价与红线**：
  - 改写 system/tools/messages 会触发 preserved thinking 校验（400 bound to a different conversation）——**不改 system 头部**，只改尾部消息。
  - 企业钉定 allowedProviders 后本地代理被**代码层拒绝**——不是需要申请。
  - 默认不落盘：代理内存态处理，磁盘零残留（可配置关闭时零网络零写盘）。
  - 必须失败透传：代理挂了，请求原样过，宿主不受影响。
- **定位**：个人用户 + 无组织策略时的增强通道，不是默认路径。

## ② 生命周期钩子

- **原理**：宿主提供轮前/轮末钩子，执行 `memhub pack` / `memhub extract`。
- **能力**：轮前注入（SessionStart 静态包 + UserPromptSubmit 变化检测）、轮末萃取（SessionEnd）。
- **定位**：有钩子的宿主（Claude Code / opencode / DSH）首选注入方式——不受网关策略影响、不改请求体。
- 拉取策略：静态包 ~250 tokens + 每轮变化检测 + 主动工具兜底（context-policy.md 详述）。

## ③ MCP / 工具（基本盘）

- **原理**：`memhub mcp` 起 stdio server，宿主注册后模型主动调用 `memory_*` 工具。
- **能力**：search / get / propose / status 等（tool-surface.md）。
- **定位**：所有宿主的地基。T1 档宿主只有这条路，也够用（模型主动查）。

## ④ CLI / 文件

- **原理**：`memhub search|get|propose|inbox` 子命令；hub 本身是纯文本。
- **定位**：兜底与运维。人可以直接 grep、diff、git 管理 hub——这是不变量 3 的最终保障。

## 选择决策树

```text
宿主支持 MCP？──否──→ ④ CLI（T0）
      │是
      ▼
有轮前钩子？──否──→ ③ MCP 打底（T1）
      │是
      ▼
③ + ② 注入/萃取（T3）
      │
      └─ 个人用户 + 无组织策略 + 接受代价 → 可选叠加 ①（增强，非必需）
```
