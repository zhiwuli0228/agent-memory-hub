# 新电脑安装与记忆迁移指南

> 目标：在任何一台新电脑上装好 agent-memory-hub 生态，并把已有的记忆完整带过去。
>
> **先分清两条线**：npm / install_bundle 装的是**程序**（封装包，含 CLI、MCP server、插件壳）——发布的新版本直接安装即可；你的**记忆数据**永远不在封装包里（local-first，ADR-0001 文件即权威），只存在于你的 hub 目录——迁移针对的是它（第 2 节三选一）。
>
> 核心事实：**hub 目录（`knowledge/` + `history/` + `pending/` + `records/`）就是全部数据**——文件即权威，拷走它 = 完整迁移，无黑盒数据库。

## 1. 一次性安装（5 分钟，一条命令一个宿主）

```sh
npm i -g agent-memory-hub
```

### 1.1 一键安装：`memhub install <host>`

自动完成三件事：**初始化 hub（若不存在）→ 把 MCP server 注册进宿主配置文件（合并不覆盖其余内容，写前备份 .bak-memhub）→ 把 hub 位置写入用户环境变量 MEMHUB_ROOT**（Windows setx，新终端生效）：

```sh
memhub install opencode     --root D:\mem\my-hub
memhub install claude-code  --root D:\mem\my-hub
memhub install gemini       --root D:\mem\my-hub
memhub install codex        # codex 是 TOML，打印需手工粘贴的配置块
```

- root 解析顺序：显式 `--root` > `$MEMHUB_ROOT` > `~/mem-hub`——**绝不会落到系统临时目录**（那种位置的记忆重启即失）
- 幂等：重复执行同样的命令 `action: unchanged`，零副作用
- 不带 `--root` 的默认是用户主目录下的 `mem-hub`（持久），想放其他盘就显式 `--root`

### 1.2 不用 install 的手工路径（等价）

| 宿主 | 接入方式 |
| --- | --- |
| **DSH** | `install_bundle dsh-agent-memory-hub`；固定 hub 位置则在 profile patch 加 override：`- id: agent-memory-hub-dsh` / `config: { root: 'D:\mem\my-hub' }` |
| **Claude Code** | `claude mcp add memory-hub -- node <npm全局路径>/agent-memory-hub/dist/cli.js mcp --root D:\mem\my-hub`（或直接编辑 `~/.claude.json` 的 mcpServers） |
| **OpenCode** | `~/.config/opencode/opencode.json` 的 `mcp` 段：`{ "memory-hub": { "type": "local", "enabled": true, "command": ["node", "<cli.js 路径>", "mcp", "--root", "D:\\mem\\my-hub"] } }` |
| **其他 MCP 宿主** | 通用命令：`memhub mcp --root <hub>`，stdio JSON-RPC，11 个工具 |
| **不支持 MCP 的环境** | 纯 CLI 兜底：`memhub search/get/propose/inbox` 全流程可用 |

### 1.3 防呆设计

如果某个宿主会话在没有配置 hub 位置的情况下运行，`memory_status` 的 freshness.notes 会显式警告 "hubRoot is inside the OS temp dir — memories here are NOT persistent" 并给出修复命令——**记忆悄悄落进临时目录**会被 agent 主动看见，而不是无声丢失。

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

#### git 仓库里提交什么、忽略什么（init 已自动生成 .gitignore）

| 类别 | 内容 | 处理 |
| --- | --- | --- |
| **权威数据**（必须提交） | `knowledge/`（记忆本体）、`history/`（版本历史）、`pending/`（提案——MR 审核对象）、`reports/`（萃取报告）、`records/ledger.jsonl`（审计台账）、`records/sequences.json`（id 计数器）、`config.yaml`（策略） | 提交 |
| **派生缓存**（忽略） | `index/`（倒排索引，运行时自动重建——提交只会制造合并冲突） | init 自动忽略 |
| **机器本地状态**（忽略，安全敏感） | `records/.writer.lock`（写锁）、`records/server.json` + `records/server-token`（**本地 serve 的进程信息和凭据——绝不能进共享历史**） | init 自动忽略 |
| **水位线**（默认提交，团队仓可选忽略） | `records/extract-state.json`、`tencent-state.json` 等——**单人迁移**：提交让新机器延续游标；**多机器团队仓**：各机器游标互覆盖，可在 .gitignore 里追加忽略、每台机器本地留存 | 默认提交 |

分支与节奏（ADR-0014 闭环）：`main` = 已批准 + 已发布的权威记忆；`sync push --branch <名字>` 产生个人分支 = pending 提案，MR 合并即批准落库。远端建议 **PRIVATE**（记忆是敏感资产）。`init` 重跑幂等，已有 `.gitignore` 永不覆盖（可自定义后放心重 init）。

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
