# 记忆库服务 API 规范 v1（memhub-compatible）

> 本规范由 agent-memory-hub 项目定义。服务端照此实现后，`memhub publish`
> 即可直连（零胶水）；agent 运行时检索也走同一套接口。
> 参考实现：memhub 自带的 `memhub serve` 就是本规范的一个完整实现
> （端点前缀不同，语义一致）。

## 设计原则

1. **与 memhub 数据模型同构**：一条记忆 = 一个不可变载荷（见下方 Entry），
   不引入服务端专有字段。
2. **写入幂等 + 版本防回退**：同 id 重复发布不会产生重复数据；
   旧版本无法覆盖新版本。
3. **增量游标统一用 `updated`（ISO 8601 UTC）**：与 memhub 的
   水位线（sync/extract/publish-state）同一种语义，全链路一致。
4. **鉴权从简**：`Authorization: Bearer <token>`，token 由部署方发放。
5. **零依赖可最小实现**：五个端点，任何一个 node/python 服务都能照做。

## 数据模型

```jsonc
// Entry —— 一条记忆的完整载荷（publish 写入 / 检索返回的最小信息单元）
{
  "id": "PRC-000012",                    // memhub 全局唯一 id（类型前缀+序号）
  "version": 3,                          // 同 id 单调递增
  "type": "process",                     // knowledge | process | preference | ...
  "title": "通用环境登录部署流程",
  "summary": "一句话摘要（检索列表展示用）",
  "scope": { "level": "project", "workspaceId": "desktop" },
                                         // level: global | domain | project
  "tags": ["universal", "deploy"],
  "updated": "2026-11-16T00:20:00.000Z", // 版本时间戳，增量游标
  "sourceRefs": "note:x hub:PRC-000012@v3",   // 空格分隔的证据来源
  "body": "Markdown 正文"
}
```

## 端点

### 1. 批量写入（memhub publish 调用）

```
POST /v1/entries
Authorization: Bearer <token>
Content-Type: application/json

{
  "publishedAt": "2026-11-16T00:20:00.000Z",
  "entries": [ Entry, ... ]
}
```

响应 `200`：

```jsonc
{ "accepted": 2, "rejected": [ { "id": "KNO-000003", "reason": "stale version" } ] }
```

**服务端必须实现的 upsert 语义**（幂等的核心）：

| 条件 | 行为 |
|---|---|
| 服务端无该 id | 写入（version 1） |
| 请求 version **高于** 已存 | 覆盖更新 |
| 请求 version **等于** 已存 | no-op，计入 accepted |
| 请求 version **低于** 已存 | 拒绝该条，rejected 里给 `stale version` |

### 2. 增量列表（本地回流 / 审计对账）

```
GET /v1/entries?since=<iso>&limit=500
```

响应 `200`：

```jsonc
{
  "entries": [ { "id": "...", "version": 3, "type": "...", "title": "...",
                 "summary": "...", "scope": {...}, "tags": [...],
                 "updated": "..." } ],   // 不含 body，控流量
  "since": "2026-11-15T00:00:00.000Z",
  "count": 42
}
```

`since` 缺省 = 全量。返回按 `updated` 升序。

### 3. 单条全文

```
GET /v1/entries/<id>
```

响应 `200`：`{ "frontmatter": { ...Entry 除 body 外的字段 }, "body": "Markdown 正文" }`
响应 `404`：`{ "error": "not found" }`

### 4. 运行时检索（agent 查询走这里）

```
GET /v1/search?q=<关键词或自然语言>&limit=5
```

响应 `200`：

```jsonc
{ "results": [ { "id": "...", "version": 3, "title": "...",
                 "summary": "...", "score": 0.93, "body": "..." } ] }
```

排序算法服务端自定（关键词/向量皆可）；契约只锁定参数与返回形状。
`score` 归一化到 0–1。

### 5. 健康检查

```
GET /v1/health    →  { "ok": true, "count": 87 }
```

## 错误格式（统一）

```jsonc
{ "error": "简短原因", "detail": "可选详情" }
```

状态码：`400` 请求不合法 · `401` 鉴权失败 · `409` 版本冲突（批量写入用 rejected 表达，不用 409）· `500` 服务端错误。

## 与 memhub 的对接关系

| memhub 命令 | 调用的规范端点 |
|---|---|
| `memhub publish` | `POST /v1/entries`（upsert 语义正是 publish 的幂等保障） |
| 未来：`memhub sync-remote pull` | `GET /v1/entries?since=` + `GET /v1/entries/<id>` |
| agent 运行时 | `GET /v1/search` |

> memhub 侧已内置该契约（`publish.adapter: http` 的请求体即本规范的
> `POST /v1/entries` 请求体）。服务端实现完成后，hub.yaml 两行配置即通：
> `publish.adapter: http` + `publish.endpoint: https://<你们的服务>/v1/entries`。
