# ADR-0024: 中心 git 仓库设计（修订 3：仓内分层布局）

日期：2026-11-19　状态：accepted

> 仓库清单与目录结构全貌见 [repos-and-layout.md](../repos-and-layout.md)。

## 用户决策（演进）

- 修订 2：一套 git 仓承载团队与部门的知识管理与萃取；个人层本地或云备份。
- 修订 3（现行）：**这套仓内的知识本身要分层**——分别管理部门和小组：

```
knowledge/
├── department/<type>/<ID>.md              ← 部门层（global 条目）
├── groups/<domainId>/<type>/<ID>.md       ← 小组层（domain 条目，按小组分目录）
└── projects/<workspaceId>/<type>/<ID>.md  ← 项目层（project 条目）
knowledge-private/<type>/<ID>.md           ← 个人层（gitignore，物理不出仓）
```

**本地 hub 与中心仓是同一棵树**：clone 中心仓即见分层；无同步期重映射。
frontmatter 的 scope 是权威，路径是它的投影；读取递归兼容旧平铺布局。

## 分级的三道保证

1. 个人层物理隔离（knowledge-private/ gitignore，git 树验证零出现）。
2. 仓级权限（GitHub 私有仓协作者边界）。
3. 层级即结构：department/ 与 groups/<小组>/ 目录一眼可辨，检索仍按
   scope + 调用方声明过滤（ADR-0019）。

## 工程细节

- titleCache stamp = depth≤3 目录 mtime；sync pull 后显式 bump 目录
  mtime（pull 只改文件 mtime，跨进程缓存否则陈旧）。
- 防撞（ID floor + pull-before-push）在分层布局下实测：服务器 pull
  基线后 mint 得 PRC-000002，双条目跨节点互检命中。
- 旧平铺文件清理：git rm 顶层 type 目录（pre-pull 的 reset 会把远端
  旧文件带回工作区，属预期合并语义，清理一次即可）。
