# ADR-0023: 三级 git 联邦（人 → 团队 → 部门）

日期：2026-11-18　状态：accepted

## 拓扑与分工

```
个人 hub（每人一个；knowledge-private/ 不出仓，个人层不去重）
    ↓ memhub sync push（watermark 增量，挂成员自己的调度器）
团队 git 仓库（只含 knowledge/）
    ↓ memhub team aggregate（管理员调度，pull→commit→push）
部门 git 仓库（跨团队聚合，部门级检索）
```

- **私有物理隔离**：private 条目写 `knowledge-private/`（initHub 的 gitignore
  模板忽略之）——git 从构造上只承载共享层，不靠纪律靠目录。
- **per-hub 本地状态**：`records/`（ID 序列、账本、锁、凭据）、`hub.yaml`、
  `.gitignore`、`README.md` 一律不进联邦 git——各 hub 独立记账，杜绝每跳
  add/add 冲突。
- **ID 恒由本地序列生成**（红线 3）：联邦不设中央发号方。

## 命令面

- 管理员开通：`memhub team init --team-repo <url|path> --dept-repo <url|path>`
  （幂等建 hub、bare 建本地仓、写 hub.yaml、输出成员接入行）
- 每日聚合：`memhub team aggregate`（单命令，可挂调度器）
- 成员接入：`memhub sync init --remote <团队仓>`
- 跨域检索：`memhub search <q> --team <domainId>`（ADR-0019 调用方声明）

## 演练结果（本机三角色，2026-11-18）

- alice（1 共享 domain 条目 + 1 private）→ frontend-team.git：共享条目入树，
  knowledge-private 零踪迹
- team aggregate → dept.git：条目到达，`records/`/`knowledge-private/` 零踪迹
- bob 从 dept.git 拉取后 `search --team team-frontend` 命中（score 1.70）；
  不带 --team 检索 0 命中——验证了 ADR-0019 的"默认项目级、显式扩大"在
  联邦拓扑下自洽。

## 已知边界

- 软删条目的 title 缓存行随目录 mtime 失效前可能残留（低频、报错明确、自愈）。
- 中央 serve（ADR-0018）保留为**可选的实时检索通道**；git 联邦是零常驻默认。
