# 仓库与目录结构设计（agent-memory-hub 数据体系全貌）

> 本文回答"这套系统到底涉及哪些 git 仓、每个仓里长什么样、数据怎么流"。
> 设计依据：ADR-0021（本地优先宪法）、ADR-0023（三级联邦）、ADR-0024 rev 3（单仓 + 仓内分层）。

## 1. 仓库清单（先看全貌，再谈结构）

| # | 仓库 | 角色 | 可见性 / 权限 | 状态 |
|---|------|------|--------------|------|
| 1 | `zhiwuli0228/agent-memory-hub` | **组件源码仓**：CLI（memhub）、MCP server、DSH 插件（host/dsh）、测试、ADR 文档 | public（npm Trusted Publisher 从 tag 自动发版） | 活跃 |
| 2 | `zhiwuli0228/memory-hub` | **中心数据仓（唯一权威）**：团队 + 部门的共享知识，仓内分 department / groups 两层 | private；协作者 = 团队 + 部门成员 | 活跃 |
| 3 | 个人云备份仓（每人一个，自建，建议命名 `memory-hub-<user>`） | 个人层**权威**：全量镜像（含 knowledge-private/）；**同一人在多台机器的同步枢纽** | private；**仅本人** | 可选，用户自管 |
| 4 | `zhiwuli0228/memory-hub-data` | **上一代**（dsh-memory-hub 0.7.0 / 腾讯 v2.0.1-beta）的中心仓 | private | **存档**，内容未迁移未修改 |
| 5 | `zhiwuli0228/memory-hub-frontend`、`-dept` | 本次联邦**验证期**的临时测试仓 | private | 退役 / 闲置（dept 若未来重启部门级聚合可复用） |

**仓的分工一句话**：1 号是"程序"，2 号是"团队与部门共享知识的唯一权威"，3 号是"每个人自己的私有备份"，4、5 号是历史遗产。**数据权威只有一个：memory-hub**。

## 2. 中心仓目录结构（`memory-hub`）

```
memory-hub/                          ← clone 下来就是这个样子
├── knowledge/                       ← 共享知识（git 追踪的全部内容）
│   ├── department/                  ← 【部门层】global 条目：跨小组通用
│   │   └── <type>/                  ← decision/ knowledge/ process/ …
│   │       └── DEC-000001.md
│   ├── groups/                      ← 【小组层】domain 条目：按小组分目录
│   │   └── <domainId>/              ← 如 team-frontend、team-backend …
│   │       └── <type>/
│   │           └── PRC-000001.md
│   └── projects/                    ← 【项目层】project 条目（可选使用）
│       └── <workspaceId>/<type>/…
├── MEMORY-HUB.md                    ← 仓说明（git 追踪）
└── .gitignore                       ← 只排 per-hub 本地状态（见 §3）
```

规则：

- **目录即层级**：`department/` 与 `groups/<小组>/` 一眼可辨；clone 即见分层，无同步期重映射。
- **frontmatter 的 `scope` 是权威**，路径是它的投影（`knowledgePath(root, type, id, scope)`）。
- **条目 ID 全局唯一**（防撞：序列 floor 取本地可见最大 ID + push 前强制 pull）。
- **检索仍按 scope + 调用方声明过滤**（ADR-0019）：部门条目全员可见；小组条目仅声明该小组的调用方可检索——文件本体对全体协作者开放是已知取舍（换取零聚合运维）。

## 3. 个人 hub 本地目录结构（每个节点 / 每个人）

本地 hub = 中心仓的超集（多出 private 与本地状态），**本地与中心是同一棵树**：

```
<hub-root>/                          ← 如 E:\tmp\amh-e2e\hub、服务器 ~/memory-hub
├── knowledge/                       ← 共享层：与中心仓完全同构（§2）
│   ├── department/<type>/
│   ├── groups/<domainId>/<type>/
│   └── projects/<workspaceId>/<type>/
├── knowledge-private/               ← 【个人层】private 条目 —— gitignore，物理不出仓
│   └── <type>/<ID>.md
├── pending/                         ← 待审提案（PRO-*.md），本地工作区
├── history/                         ← 版本快照（<ID>@v<N>.md），本地审计
├── records/                         ← 本地状态：sequences.json（发号器）、ledger.jsonl（操作账本）
├── journal/                         ← journal 记录（本地）
├── index/                           ← 检索索引缓存（可随时重建）
├── hub.yaml                         ← 本 hub 配置（remote 地址等）
├── MEMORY-HUB.md                    ← hub 说明
└── .gitignore                       ← 记录：records/ pending/ history/ journal/ index/
                                     ←   hub.yaml .gitignore MEMORY-HUB.md knowledge-private/
```

**git 边界**：`sync push` 只把 `knowledge/`（department/groups/projects）推上中心仓；
`knowledge-private/` 与一切本地状态**构造性不出仓**（drill 已验证 git 树零出现）。

**同一人多台机器（完全同一份数据）**：每台机器都对**同一个个人仓**执行
`memhub personal init --remote git@github.com:<you>/memory-hub-<user>.git`，
之后各自 `memhub personal sync`。该命令是**双向**的：先 fetch 远端并把其
`knowledge-private/` 子树恢复到本地（只动私有层，共享层永远归中心线），
再合并本地变化、commit、push。两台机器交替 sync 即收敛为同一份数据
（已实测：机器 B 写私有条目 → 个人仓 → 机器 A personal sync 后检索命中）。

## 4. 数据流

```
写：宿主（opencode/claude-code）→ MCP memory_propose → 审批 → commitKnowledge
    └─ scope 决定落盘路径：global→department/  domain→groups/<小组>/  private→knowledge-private/
推：memhub sync push   （纪律：先 pull 后 push；冲突显式报错，绝不静默覆盖）
中心：github.com/zhiwuli0228/memory-hub（唯一权威，异地容灾即 GitHub 本身）
拉：memhub sync pull   （各节点各自 pull 到本地索引）
读：检索走本地索引（零网络）；scope + 调用方声明（--team / MEMHUB_TEAM）过滤可见性
```

## 5. 节点形态（对等，无主从）

| 节点 | 形态 | 接入 |
|------|------|------|
| 本地 Windows | opencode + claude-code，hub 在本地盘 | deploy key / 个人 ssh key |
| 腾讯云 43.138.213.197 | opencode 1.19.6 + memhub，hub 在 ~/memory-hub | per-node deploy key（读写） |

未来加节点 = 装包 + `sync init --remote git@github.com:zhiwuli0228/memory-hub.git` + 配一把独立 deploy key（GitHub 规则：一把 key 不能挂两个仓，每节点一把）。

## 6. 历史与迁移

- `memory-hub-data`（上一代）**保持原样存档**；如需引用旧知识，人工拣选后按新分层重新入库（重新生成 ID 与 frontmatter），不做自动迁移。
- 退役测试仓（frontend/dept）保留作审计痕迹，不删除。
