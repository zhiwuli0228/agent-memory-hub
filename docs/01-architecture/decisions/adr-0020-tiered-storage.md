# ADR-0020: 分级存储——private 档与个人云空间

日期：2026-11-18　状态：accepted

## 模型（每层一个仓库，scope 决定流向）

| 层 | 内容 | 载体 |
|---|---|---|
| L0 本地 hub | 全部（private + 共享） | 本地目录（文件即权威） |
| L1 个人云空间（可选） | 全量私有备份 | 个人 hub 的 git remote（`memhub sync init --remote <私有repo>`，零新代码） |
| L2 团队中心 hub | 仅批准的共享提案 | 中心 serve + 收件箱（写侧双闸：token + 人工批准） |
| L3 通用知识版本化 | 中心仓 git | 中心 hub 的 sync |

**"git 只负责通用知识"是 L2/L3 的天然属性**：中心只收人工批准的提案。
个人隐私靠写侧闸门，不靠中心分区；跨团队检索价值不因分库而损失。

## private scope 档

- `scope: { level: private }`：本地可见、本地 git 备份、**永不 push**（hubSync
  过滤并报告 privateSkipped）、**中心拒收**（/api/propose 返回 400——拒绝而非改写）。
- `hub push --token <secret>`：推送凭证传递（或 hub.yaml publish.header.Authorization）。
- 可见性：private 条目只存在于所有者的 hub（传输层保证），故检索层见到即可见。

## 本地模拟团队（无需多人环境）

一台机器、三个目录：

```
memhub init --root E:\tmp\amh-sim\central   # 中心
memhub init --root E:\tmp\amh-sim\alice     # 成员 A
memhub init --root E:\tmp\amh-sim\bob       # 成员 B
# 中心：memhub serve --root ...\central --token team-secret-7
# alice：提案 → inbox approve → hub push --remote http://127.0.0.1:7779 --token ...
# 中心：面板/POST /api/inbox/<id>/approve（Bearer）
# bob：hub pull；或直接实时检索中心 /api/search?q=...
```

## 演练结果（真实跑通）

push ok:true pushed:1 **privateSkipped:1**；中心收件箱只见共享条目；
bob pull applied；bob 实时检索命中；**全库搜私有关键词 0 命中**（零泄露）。
143 测试全绿（+3 private）。
