# ADR-0024: 中心 git 仓库设计（GitHub 私有仓形态）

日期：2026-11-19　状态：accepted

## 关键重设计：服务器不再是"中心"，GitHub 才是

腾讯云服务器（43.138.213.197）**降格为联邦中的一个普通节点**（跑 opencode +
自己的 hub），**git 权威上移到 GitHub 私有仓**：

- **零 git 服务运维**（服务器不跑 Gitea/裸仓，零备份负担——GitHub 即异地）
- 服务器节点与本地节点**完全对等**（同一套 sync push/pull，同一个私钥体系）
- 本地优先红线不受影响：各节点离线完整可用，GitHub 只在 push/pull 时刻出现

## 仓库命名与权限（150 人扩展路径）

| 仓库 | 内容 | 权限 |
|---|---|---|
| `memory-hub-<team>`（如 memory-hub-frontend） | 该团队共享记忆 | 团队成员协作者 / deploy key |
| `memory-hub-dept` | 各团队聚合（部门级检索） | 部门管理员 + 聚合节点 deploy key |

- 试点期：`main` 直推（信任 + 事后 curate 治理，ADR-0013 语义）
- 推送身份：**per-node deploy key**（每个节点一把，只授权它该读写的仓）
- private 条目物理隔离（ADR-0023 `knowledge-private/`）在任何仓中零出现

## 节点清单（首批）

| 节点 | 角色 | hub 位置 |
|---|---|---|
| 本地 Windows | 开发主节点 | E:\tmp\amh-e2e\hub（试点）→ 正式化后迁移 |
| tencent 43.138.213.197 | 远程 opencode 节点 | ~/memory-hub |
| GitHub | git 权威（私有仓群） | — |

## 验证协议（跨机联邦）

本地 opencode 写记忆 → push GitHub 团队仓 → 服务器 aggregate →
远程 opencode `search` 命中本地写的条目；反向（远程写 → 本地检索）同链路。
双宿主（opencode + claude-code）各自注册同一 MEMHUB_ROOT（试点同机共享）。
