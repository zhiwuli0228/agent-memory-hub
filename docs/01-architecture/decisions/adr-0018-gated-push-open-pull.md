# ADR-0018: 分发模型——推送时控制，拉取时放开

日期：2026-11-18　状态：accepted

## 背景

记忆的对外分发有两级消费方：
1. **本机宿主**（DSH / OpenCode / Claude Code）：MCP 工具每次会话实时检索本地
   hub——已是"主动每次检索"。
2. **远程消费方**（腾讯 WeKnora 类知识平台、团队成员的其他宿主、CI）：此前只有
   `hub pull` 快照同步——被动、滞后、还得先有本地 hub。

正确模型由产品原则直接给出：**写入侧是质量闸门，读取侧是自由检索**。
推送的内容必须过人工批准（中心收件箱）；拉取/检索不应有任何同步延迟与预置条件。

## 决策

中心 serve 模式（`memhub serve --host 0.0.0.0 --token <secret>`）：

- **读侧放开**：`GET /api/search?q=...` 实时检索，**免认证**。`?workspace=all`
  （默认）跨 workspace 全库检索；`?workspace=<id>` 收窄到项目域；`?detail=L0|L1|L2`
  控制摘要层级。消费方拿到 URL 即接入，无快照、无预同步。
  `GET /api/status`、`GET /api/inbox` 同为只读端点。
- **写侧控制**：所有写方法（POST/PUT/DELETE）必须携带
  `Authorization: Bearer <token>`（`--token` 显式传入，或自动读取
  `records/server-token` 中心凭据）。`hub push` 的推送端点同样被闸——
  推上来的仍是**提案**，落库还过中心收件箱批准（闸门双保险：token 挡匿名写，
  收件箱挡低质量写）。
- **本地模式不变**：默认 127.0.0.1 无 token——本机工具链零摩擦。
  配置了 `--host 0.0.0.0` 而未配 `--token` 时启动即警告。

## 接入（WeKnora / 任意消费方）

```
检索：GET http://<central>:7777/api/search?q=<urlencoded>&workspace=all&detail=L1
推送：POST /api/propose + Bearer token → 中心收件箱 → 人工批准
```

## 后果

- 外部系统从"定期拉快照"升级为"实时检索"——记忆中枢第一次成为**在线知识服务**。
- `SearchOptions.workspaceId` 变为可选：读侧 API 可全库检索，CLI/MCP 默认仍带
  workspace 隔离（本地多项目互不串扰的行为不变）。
- token 是共享密钥而非 per-consumer 凭据——够用（单团队规模）；多消费方独立
  吊销需求出现时再升级为 token 列表。
