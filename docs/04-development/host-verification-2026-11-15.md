# DSH Host Verification — 2026-11-15（web/desktop profile 真机）

> 目标：验证 `host/dsh`（agent-memory-hub-dsh）在真实 DSH 宿主上的接入面。
> 环境：desktop profile（运行中 GUI，https://127.0.0.1:58912），旧插件 dsh-memory-hub 0.8.1 同 profile 活跃。

## 已验证（本轮实测）

| # | 复验项 | 方法 | 结果 |
| --- | --- | --- | --- |
| 1 | 接入面契约 | cordis inspect：`tools.register(definition, options) → dispose`、`tools.get(name)` | ✅ 与薄包假设一致 |
| 2 | 工具形状对照 | Tool.listTools 对照运行中旧插件 memory_* schema | ✅ `{name, description, parameters}` 同构 |
| 3 | 安装链路 | `install_bundle file:E:\...\host\dsh`（pnpm file: 协议 + bundle patch 解析） | ✅ applied，`agent-memory-hub-dsh@file:...` 入 registry |
| 4 | 加载链路 | list_plugins：`include:agent-memory-hub-dsh` enabled=true、**fiberPhase=active** | ✅ cordis fiber 启动、apply 已执行 |
| 5 | 挂载失败不崩宿主 | GUI 持续运行、本会话继续工作（hub 未初始化 → 自禁用分支真机走到） | ✅ 无异常、无崩溃 |
| 6 | 与旧插件共存 | 旧插件 include:dsh-memory-hub 仍 active；本会话 memory_* 工具（close_task 等）继续可用 | ✅ toolConflict=skip 生效设计 |
| 7 | 失败关闭（设计层） | 薄包**不含 memory_commit**（adapter 测试断言） | ✅ 进 knowledge/ 只走人工通道 |

## 未验证（需宿主重启，风险：中断所有会话）

- **工具调用级端到端**：`toolConflict: suffix` + `root` 指向真实 hub → 新工具以 `memory_*__amh` 注册 → 从新会话调用查真实数据。当前 profile 中 8 个工具名全部与旧插件撞名，skip 策略下薄包 0 工具注册（零风险但无调用面）。
- 面板（memhub serve）从 DSH 内打开。

## 复验步骤（重启宿主后执行）

1. `memhub init --root <目标hub>`（或复用旧 hub：`root: 'E:\009workspace\dsh\dsh-plugin-dev'`）
2. config-editor 把 `agent-memory-hub-dsh` 的 config 设为 `{ root: <hub>, toolConflict: 'suffix' }`
3. 重启宿主 → Tool.listTools 应出现 `memory_search__amh` 等 8 个
4. 调用 `memory_search__amh {query: ...}` → 命中即端到端全通
5. CLI 侧 `memhub inbox list/approve`（人通道）走一遍完整闭环

## 决策待定（用户拍板）

- **切换时机**：旧插件（0.8.1，全功能面板）vs 薄包（新引擎，无面板 UI）。共存期建议：薄包保持默认 skip（不注册、零干扰），等薄包补齐面板后再切换。
- 四宿主清单：desktop ✅（本轮）；web / CLI / ACP(headless) 待验——同一 bundle 不同 profile，接入面相同，安装即验。
