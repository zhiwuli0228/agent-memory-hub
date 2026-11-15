# Scope Rules

> 作用域模型（ADR-0002 修订版）：**workspace 零配置自动，global 默认，domain 可选**。作用域是权限边界，不是检索优化。状态：📐 设计定案（Step 2 registry.ts 落地）。

## 模型

- **workspace（project）**：零配置——`git remote get-url origin`（可用时）否则规范项目目录。首次使用自动登记，名字可在面板/CLI 改。**注册不是前置条件**。
- **global**：hub 级，天然存在，零配置。
- **domain（可选）**：一组 workspace 的归组层。无 `domains` 配置时祖先链 = `project ∪ global` 两层（对绝大多数用户足够）；配置后才生效。旧 hub 的 `core_workspaces` / `parentCoreIds` 照读（兼容层），新 hub 默认不生成。
- **祖先链**：project 的可见集 = 本工作区 ∪（配置了 domain 时的上游 domains）∪ global。

## 可见性规则

1. 检索默认 status=accepted + 可见 scope 集过滤；pending 永不出现在普通检索。
2. **只进不升**：萃取/回写只落 `project:<本工作区>`；project → domain/global 必须走提炼提案 + 人批准。
3. **降写不降读**：读可以跨上游；写永远落在身份对应的 workspace（身份由入口进程决定，模型不能选）。
4. **回退必须可见**：cwd 匹配不上任何项目信号时回退合成 workspace，`memory_status` 必须 `workspace.exact=false` 如实标注——绝不静默隐藏 project 知识。

## 身份解析顺序（Step 2 registry.ts 契约）

1. 显式 `--workspace` 参数（人指定，最高优先）。
2. `git remote get-url origin`（在 git 仓库内时——跨子目录/worktree 稳定）。
3. 规范化项目目录（向上找 git root，否则 cwd）。
4. 合成 workspace + `exact=false` 标注。

## forget 传播（继承旧仓 DEC-000020）

- 删除/废弃跨边界传播：forget 一个 global 条目 → 已镜像的远端 provider 收到 forget；删不掉的记 `orphans.jsonl`，不假装成功。
- 镜像方向的远端（mirror 角色）只收到显式 forget，不做隐式清理。
- GDPR 被遗忘权路径：授权后 hard-delete（tombstone → 物理删除 + 级联派生索引重建），全程 ledger 记录。
