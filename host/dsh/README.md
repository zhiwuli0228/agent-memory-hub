# dsh-agent-memory-hub — DSH 插件

[agent-memory-hub](https://github.com/zhiwuli0228/agent-memory-hub) 的 DeepSeek Harness（DSH）宿主适配层：一个薄的 cordis 插件壳，把记忆中枢的 8 个 `memory_*` 工具挂进 DSH。全部记忆逻辑在 [`agent-memory-hub`](https://www.npmjs.com/package/agent-memory-hub) core（已随本包 esbuild 打包，约 42KB，零运行时依赖）。

## 安装

DSH 内（插件管理 / `plugin_manager`）：

```
install_bundle dsh-agent-memory-hub@0.1.0
```

或任何 npm 客户端：`npm i dsh-agent-memory-hub`

## 配置

插件的 hub 目录解析顺序：`$MEMHUB_ROOT` → 会话工作目录里含 `hub.yaml` 的目录 → 合成目录。
想固定指向某个 hub，在你的 profile patch 里 override：

```yaml
- override:
    id: agent-memory-hub-dsh
    config:
      root: 'C:\mem\my-hub'
```

与旧版 `dsh-memory-hub` 插件共存时，加 `toolConflict: suffix`（工具注册为 `memory_*__amh`）。

## 工具面（8 个）

| 工具 | 作用 |
|---|---|
| `memory_search` / `memory_get` | 本地检索（CJK 分词 + 倒排 + BM25-lite）/ 读单条 |
| `memory_status` | 自检 + **数据新鲜度**（lastPullAt/lastPublishedAt/lastExtractAt）|
| `memory_propose` | 创建候选提案（**永不直接写 knowledge/**，人工批准闸门）|
| `memory_preflight` / `memory_inject` | 上下文注入（L0 静态包）|
| `memory_cite` / `memory_close_task` | 引用记账 / 任务收尾 |
| `memory_journal` / `memory_dejavu` | 情景日志 / 会话去重索引 |

## 运行时零网络

检索、提案、批准、引用全部走本地文件（`knowledge/` + 倒排索引）。远端记忆库服务只是**发布/同步通道**：`memhub publish`（可定义出口，ADR-0015）失败自动降级报错、水位线不动、重试安全——远端挂了不影响任何宿主的运行时效果，agent 可通过 `memory_status` 的 freshness 字段感知知识边界。

## 跨宿主

同一核心也以独立 MCP server / CLI 分发（`npm i agent-memory-hub`）：

```sh
memhub mcp --root <hub>     # Claude Code / OpenCode 等 MCP 宿主挂载
memhub extract material     # 任何 workflow 平台的定时萃取原料
memhub publish              # 按你定义的出口发布到团队记忆库
```

规范与对接文档：[docs/02-spec](https://github.com/zhiwuli0228/agent-memory-hub/tree/main/docs/02-spec) · [docs/03-usage](https://github.com/zhiwuli0228/agent-memory-hub/tree/main/docs/03-usage)
