# ADR-0024: 中心 git 仓库设计（修订 2：单仓决策）

日期：2026-11-19　状态：accepted（修订 1 的双仓方案作废）

## 用户决策（原文）

> 用一套 git 仓库实现团队和部门的知识管理、萃取；个人的直接上传云服务或本地。

## 架构

```
个人层（每人本地 hub；knowledge-private/ 物理隔离；可选个人云 git 备份）
    ↓ sync push（共享条目：domain + global，单目标）
中心 git 仓（唯一一套：团队与部门共用，如 memory-hub-frontend）
    ↓ pull（各节点各自 pull 到本地索引）
萃取与治理：curate / 审批 / 老化在中心仓层面统一进行
```

## 分级的真实保证（单仓形态下）

1. **private 物理隔离**：`knowledge-private/` gitignore，构造性不出仓（已验证）。
2. **仓级权限**：GitHub 私有仓协作者边界——未授权者连 clone 都不可得。
3. **scope 逻辑分级**：`domain:team-X` 条目只对声明该团队的调用方检索可见
   （ADR-0019 调用方声明 + MEMHUB_TEAM）；`global` 条目对全体可见 = 部门通用层。

**诚实边界**：单仓下 git 文件本体对全体协作者开放——分级靠检索层过滤而非
git 层。试点期（单团队）无影响；部门推广后跨团队文件可见属已知取舍，
换取的是零聚合运维与简单性（与 ADR-0019"劝阻物理分库"同源）。

## 作废与保留

- 修订 1 的 `memory-hub-<team>` / `memory-hub-dept` 双仓 + `team aggregate`
  聚合链：**作废**（dept 仓保留不删但闲置；`team aggregate` 命令保留，
  供未来若重新需要部门级聚合时复用）。
- 服务器节点 = 对等节点不变；deploy key per node 不变。
- 命名：试点直接复用现有仓；推广期统一命名为 `memory-hub`。

## 验证基线（2026-11-19）

双向联邦实测通过：本地写→GitHub→服务器检索命中；服务器写→GitHub→
本地检索命中。防撞（ID floor + pull-before-push）已上线（v0.1.26）。
