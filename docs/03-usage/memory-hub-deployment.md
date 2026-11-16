# 记忆库服务对接指南（路径 A：部署参考服务端）

> 路线决策 ADR-0014/0015。本指南覆盖：在一台服务器上部署参考实现
> `examples/memory-hub-server.mjs`，把 `memhub publish` 对接上去，
> 并让 agent 运行时通过 `GET /v1/search` 查询记忆。
> API 契约全文见 `docs/02-spec/memory-hub-api-v1.md`。

## 0. 架构位置

```
每人电脑                                记忆库服务器（路径 A）
memhub 本地 hub                          examples/memory-hub-server.mjs
  萃取 → 本地批准 → sync push --branch     ├── POST /v1/entries   ← memhub publish
        git MR 审核（人审+validate）  ──▶  ├── GET  /v1/entries?since=
        合入 main 后：memhub publish      ├── GET  /v1/entries/:id
                                         ├── GET  /v1/search     ← agent 运行时
                                         └── GET  /v1/health
```

发布时机：**git MR 合入 main 之后**由维护者（或服务器上的 CI）执行
`memhub publish`——记忆的权威文本在 git 仓，服务端是发布出去的检索视图。

## 1. 服务器部署（约 5 分钟）

### 前置

- 一台能常开的机器（腾讯云 CVM / 容器 / 任何有 Node.js ≥ 20 的环境）
- 已获取本仓库（`examples/memory-hub-server.mjs` 单文件即全部）

### 启动

```bash
# 1. 放置文件 + 数据目录
mkdir -p /opt/memory-hub/data
cp examples/memory-hub-server.mjs /opt/memory-hub/

# 2. 设一个 token（所有写操作必须携带；GET 检索在配置后同样校验）
export MEMORY_HUB_TOKEN="$(openssl rand -hex 32)"

# 3. 启动（默认端口 7800，数据落在 DATA_DIR）
cd /opt/memory-hub && node memory-hub-server.mjs
# 记忆库服务: http://0.0.0.0:7800 (data: /opt/memory-hub/data, auth: Bearer on)
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7800` | 监听端口（防火墙/安全组放行它） |
| `MEMORY_HUB_TOKEN` | 空=不鉴权 | **生产必须设置**；写操作校验 `Authorization: Bearer <token>` |
| `DATA_DIR` | `./data` | 条目存储目录（`entries.json` 单文件） |

### 常驻运行（systemd 示例）

```ini
# /etc/systemd/system/memory-hub.service
[Unit]
Description=memory-hub reference server (agent-memory-hub spec v1)
After=network.target

[Service]
WorkingDirectory=/opt/memory-hub
Environment=MEMORY_HUB_TOKEN=换成生成的token
Environment=DATA_DIR=/opt/memory-hub/data
ExecStart=/usr/bin/node /opt/memory-hub/memory-hub-server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now memory-hub
curl http://127.0.0.1:7800/v1/health   # → {"ok":true,"count":0}
```

### 存储说明（重要，如实定位）

参考实现用**单 JSON 文件**存储（写入合并落盘，崩溃最多丢 1 秒且发布
可重试）。适合探索阶段与中小团队规模。**备份 = 复制 `data/` 目录**（或
把 `data/` 放进 git/对象存储定时备份）。生产化时按规范实现替换存储层
（如 SQLite/Postgres/ES），端点契约不变，memhub 零改动。

## 2. memhub 侧对接（每人的本地 hub）

hub.yaml 里两行 + 一个环境变量：

```yaml
# hub.yaml（publish 段，ADR-0015）
publish.adapter: http
publish.endpoint: http://<服务器IP>:7800/v1/entries
publish.header.Authorization: Bearer <与服务器一致的token>
```

> token 也可以不写进 hub.yaml（避免随 git 仓泄露）：改用
> `publish.adapter: exec` + `examples/push-to-hub.mjs` + 系统环境变量
> `MEMORY_HUB_URL` / `MEMORY_HUB_TOKEN`。两种方式选一。

## 3. 端到端验证（一次性）

```bash
# 本地 hub（有已批准条目）
memhub validate                      # 闸门先过
memhub publish                       # 增量发布 → {"ok":true,"published":N,...}

# 服务器侧确认
curl -s http://<服务器IP>:7800/v1/health          # count 增加
curl -s "http://<服务器IP>:7800/v1/search?q=部署" # agent 检索同款接口
```

重复执行 `memhub publish` 应为 no-op（同版本幂等）；改条目重新批准后
再 publish 会以更高版本覆盖——旧版本永远无法回滚覆盖新版本。

## 4. agent 运行时查询（所有 agent 平台通用）

```bash
curl -s "http://<服务器IP>:7800/v1/search?q=数据库%20连接池&limit=5"
```

```javascript
// 任何 agent 的工具/代码里
const r = await fetch(`http://<服务器IP>:7800/v1/search?q=${encodeURIComponent(query)}&limit=5`)
const { results } = await r.json()   // [{id, version, title, summary, score, body}]
```

返回按相关度排序，`score` 归一化 0–1；`body` 为 Markdown 全文。

## 5. 故障排查

| 现象 | 处理 |
|---|---|
| publish 报 `HTTP 401` | 两端 token 不一致：核对 hub.yaml 的 `publish.header.Authorization` 与服务器 `MEMORY_HUB_TOKEN` |
| publish 报 `stale version` | 服务器上该条目已是更高版本（正常防回退）；确认本地是不是旧 clone，先 `sync pull` |
| publish 报连接失败 | 安全组/防火墙放行 `PORT`；服务器 `curl /v1/health` 自检 |
| 条目丢失 | 检查 `DATA_DIR/entries.json` 是否被误删；从 git 中心仓 main 重新 `memhub publish` 全量恢复（id+version 幂等） |

## 6. 与规范的关系

参考实现 = 规范 v1 的行为基准（`tests/memory-hub-server.test.ts` 保证
与 memhub 侧不漂移）。团队以后自研替换服务端时，以规范文档 + 参考实现
+ 该测试为验收标准。
