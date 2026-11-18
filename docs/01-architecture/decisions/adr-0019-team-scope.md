# ADR-0019: 多团队 scope 模型——调用方声明访问域，中心仓不分区

日期：2026-11-18　状态：accepted

## 背景

团队使用后出现三个维度：团队（共享域）、个人（私有域）、中心仓的组织方式。
问题：检索要不要按团队分区处理？中心仓要不要按团队/个人分库？

## 决策

### 1. 团队档 = 激活预留的 domain 档（ADR-0002 预留，schema 零变更）

可见性三级：**global（全公司）∪ domain（团队域，domainId 即团队 id）∪ project（单项目）**。
`SearchOptions` 增加 `teamId`，viewer 可同时声明 workspace 与 team：

- `isVisibleIn(scope, { workspaceId?, teamId? })` = global ∪ 声明的团队 ∪ 声明的项目
- 命中所属域的条目获得 LOCAL_BOOST（与 project 对称）
- CLI `memhub search --team <id>`；中心 API `GET /api/search?team=<id>`

### 2. 读侧边界：调用方声明访问范围（用户拍板）

消费方**自己配置**自己的访问域，**默认项目级**（由它服务的项目决定）：

```
GET /api/search?q=...&workspace=<my-project>      # 项目域（默认建议）
GET /api/search?q=...&team=<my-team>              # 团队域
GET /api/search?q=...&workspace=all               # 显式全库（调用方自主声明）
```

中心不维护 per-consumer 凭据/ACL——信任内网 + 调用方声明；`?team=` 钩子已就位，
未来需要服务端强制时在同一参数上升权。

### 3. 中心仓不分区（劝阻并否决的分库方案）

- **个人私有层在本地 hub**（边缘沙盒）：只有本人批准的提案才 push——隐私靠
  写侧批准闸门，不靠中心按人分库。
- **团队内容靠 scope 标注**，不靠目录分区：`hub push` 的 payload 现在携带条目
  scope（此前被中心硬编码改写为接收方 project——已修），`/api/propose` 校验并
  透传 domain/project/global。
- 文件即权威的平铺结构不变；跨团队检索（"别的组踩过的坑"）保持可能。
- 物理分区（per-team 目录/索引/token）等规模需要时再做——`domainId` 就是
  现成的分区键。

## 后果

- 团队条目写入：frontmatter `scope: { level: domain, domainId: team-xxx }`
  （提案/直接提交均可）；推送、批准、检索、老化复审全链路透传。
- CLI/MCP 本地检索默认仍带 workspace 隔离；`--team` 为加档（显式扩大可见域）。
- 140 测试全绿（+6 team scope）；真实库全库检索 11 命中、团队参数 200。
