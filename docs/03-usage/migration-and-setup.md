# 新电脑安装与记忆迁移指南

> 目标：在任何一台新电脑上装好 agent-memory-hub 生态，并把已有的记忆完整带过去。
>
> **先分清两条线**：npm / install_bundle 装的是**程序**（封装包，含 CLI、MCP server、插件壳）——发布的新版本直接安装即可；你的**记忆数据**永远不在封装包里（local-first，ADR-0001 文件即权威），只存在于你的 hub 目录——迁移针对的是它（第 2 节三选一）。
>
> 核心事实：**hub 目录（`knowledge/` + `history/` + `pending/` + `records/`）就是全部数据**——文件即权威，拷走它 = 完整迁移，无黑盒数据库。

## 1. 一次性安装（5 分钟）

### 1.1 CLI / MCP server（所有宿主的底座）

```sh
npm i -g agent-memory-hub
memhub --version          # 确认安装成功
```

### 1.2 初始化本地 hub

```sh
# 方式一：环境变量固定 hub 位置（推荐，多宿主共用）
# Windows (PowerShell):
[Environment]::SetEnvironmentVariable('MEMHUB_ROOT', 'C:\mem\my-hub', 'User')
mkdir C:\mem\my-hub
memhub init C:\mem\my-hub

# 方式二：不设环境变量，hub 跟随会话工作目录（每项目一个 hub）
mkdir .\mem-hub
memhub init .\mem-hub
```

### 1.3 按宿主接入

| 宿主 | 接入方式 |
| --- | --- |
| **DSH** | `install_bundle dsh-agent-memory-hub`；固定 hub 位置则在 profile patch 加 override：`- id: agent-memory-hub-dsh` / `config: { root: 'C:\mem\my-hub' }` |
| **Claude Code** | `claude mcp add memory-hub -- node <npm全局路径>/agent-memory-hub/dist/cli.js mcp --root C:\mem\my-hub`（或直接编辑 `~/.claude.json` 的 mcpServers） |
| **OpenCode** | `~/.config/opencode/opencode.json` 的 `mcp` 段：`{ "memory-hub": { "type": "local", "command": ["node", "<cli.js 路径>", "mcp", "--root", "C:\\mem\\my-hub"] } }` |
| **其他 MCP 宿主** | 通用命令：`memhub mcp --root <hub>`，stdio JSON-RPC，11 个工具 |
| **不支持 MCP 的环境** | 纯 CLI 兜底：`memhub search/get/propose/inbox` 全流程可用 |

## 2. 记忆迁移（三选一）

### 方式 A：git 闭环迁移（推荐——顺便打通团队闭环）

hub 目录天然是纯文本，git 化后既是迁移通道，又是 ADR-0014 的审核闭环起点：

```sh
# 旧机器：hub 目录 git 化并推到私有远程
cd C:\mem\my-hub
git init && git add -A && git commit -m "migrate: full hub snapshot"
git remote add origin git@github.com:<你的私有仓库>.git   # 建议 PRIVATE
git push -u origin main

# 新机器：clone 即迁移完成
git clone git@github.com:<你的私有仓库>.git C:\mem\my-hub
```

之后 `memhub sync push --branch <名字>` / `hub pull` 走同一条远程——迁移和团队协作共用一条通道。

### 方式 B：直接拷贝（最快，单人迁移）

把 hub 目录整个拷过去（U 盘 / 网盘 / `scp -r`）：

```
knowledge/   ← 全部已批准记忆（Markdown + frontmatter）
history/     ← 版本历史
pending/     ← 待审提案
records/     ← 水位线与注册表（迁移后增量同步游标不丢）
ledger JSONL ← 审计台账
```

### 方式 C：从团队记忆服务拉取（团队场景）

如果团队已部署记忆库服务（[部署指南](memory-hub-deployment.md)）且旧机器 publish 过：

```sh
memhub hub pull <服务地址>        # 增量拉取（watermark 断点续传）
```

新机器空 hub 时会全量拉取；已有本地数据时只拉增量。

## 3. 迁移验证清单

```sh
memhub status <hub>       # workspace、indexedCount、freshness 三项都对得上旧机器
memhub validate <hub>     # 格式契约校验
memhub search <关键词>    # 抽查几条旧记忆能命中
```

DSH 里新开一个会话，调 `memory_status`：`hubRoot` 指向新位置、`indexedCount` 与旧机器一致、`freshness` 有水位线 → 迁移完成。

## 4. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `memory_status` 显示 `workspace.exact: false`（synthetic fallback） | 正常：workspace 按**路径**注册，新机器路径不同。继续使用会自动注册新路径；要沿用旧工作区身份，把项目放到与旧机器相同的路径 |
| 检索结果为空 | hub root 指错了（各宿主配置里的 `--root` 不一致）——统一用 `$MEMHUB_ROOT` + 固定路径 |
| `freshness.notes: "pull: never synced"` | 新 hub 还没接过远程——按方式 A/C 配一次即可 |
| 多台电脑同时用同一 hub | git 闭环（方式 A）：每台机器做完改动 `sync push`，开始工作前 `hub pull`；记忆格式是纯文本，git 合并冲突极少 |
| 旧机器 dsh-memory-hub（0.8.x）的记忆迁到新中枢 | 记忆格式同源（Markdown + frontmatter）——把旧 hub 的 `knowledge/` 拷进新 hub 后跑 `memhub validate`，格式契约兼容 |

## 5. 迁移后的日常循环（团队）

1. 开工：`memhub hub pull`（或 git pull）
2. 工作：agent 提案 → `memhub inbox approve` 人工把关
3. 收工：`memhub publish`（团队服务）/ `git push`（git 闭环）
4. 周期检查：`memory_status` 的 freshness——`lastPullAt` 落后超过一天就该 pull 了
