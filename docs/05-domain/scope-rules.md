# Scope Rules

> 作用域金字塔：project < domain < global。状态：📐 设计定案（Step 2 registry.ts 落地）。

## 模型

- **project**：一个工作目录/仓库的工作区。条目属于唯一 workspace。
- **domain**：一组工作区的领域层（如"前端""记忆系统"）。由 `core_workspaces` 聚合。
- **global**：跨一切的个人/公司通用知识。
- **祖先链**：project 的可见集 = 本工作区 ∪ 上游 domains ∪ global（由 `parentCoreIds` 声明上游）。

## 可见性规则

1. 检索默认 status=accepted + 可见 scope 集过滤；pending 永不出现在普通检索。
2. **只进不升**：萃取/回写只落 `project:<本工作区>`；project → domain/global 必须走提炼提案 + 人批准。
3. **降写不降读**：读可以跨上游；写永远落在身份对应的 workspace（身份由宿主/入口决定，模型不能选）。
4. **回退必须可见**：cwd 匹配不上注册表时回退合成 workspace，但 `memory_status` 必须 `workspace.exact=false` 如实标注——绝不静默隐藏 project 知识（金字塔塌陷教训，ADR-0001 原则 2）。

## forget 传播（继承旧仓 DEC-000020）

- 删除/废弃跨边界传播：本仓 forget 一个 global 条目 → 已镜像的远端 provider 收到 forget；删不掉的记 `orphans.jsonl`，不假装成功。
- 镜像方向的远端（mirror 角色）只收到显式 forget，不做隐式清理。
