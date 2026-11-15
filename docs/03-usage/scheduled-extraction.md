# 定时萃取与团队记忆协作接线指南

> ADR-0011 §4（触发器无关萃取）+ ADR-0014（闭环：git 仓 = 审核流水线，腾讯 memory hub = 运行时服务）。

## 闭环全景（三部件，各一个职责）

```
每人电脑                          git 中心仓                    腾讯 memory hub
┌─────────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│ workflow 定时萃取 │    │ 个人分支 → MR 审核      │    │                  │
│ extract material │    │  · 人审：通用化/查重/意见 │    │  运行时检索服务     │
│ agent 通用化萃取  │───▶│  · 机审：validate CI   │───▶│  （复用原有能力，   │
│ memhub 批准(第一道)│    │  合入 main = 终审通过   │publish│ 不自建，大家共用） │
│ 本地深度记忆      │    │ （记忆的"源码"仓库）     │    │ （agent 查询走它）  │
└─────────────────┘    └──────────────────────┘    └──────────────────┘
        ▲                                                    │
        └────────────── sync pull 回流 ──────────────────────┘
```

- **git 中心仓**：记忆的权威文本 + 审核流水线（MR 逐条意见/拒绝/改后重推；`memhub validate` 作为 CI 机审）。合入 main = 终审通过。
- **腾讯 memory hub**：运行时检索服务（已有，复用）。单向 publish，不做第二处真相。
- **memhub**：本地工作站 + 萃取流水线 + 双闸门（本地批准 + validate CI）。不参与运行时查询路径。

## 拓扑一览（本地侧）

```
每人的电脑（无需独立服务器）
├── 本地 hub 目录（knowledge/ + pending/ + records/）
├── memhub serve            → 本地控制台（收件箱/记忆库/审计，仅自己用）
├── workflow agent + 定时任务 → 每天萃取（extract material → propose）
└── memhub sync push --branch <自己> → 推到 git 中心仓个人分支 → MR 审核
```

## 每日萃取循环（任何 workflow 平台/cron/任务计划程序）

一台机器上完整的每日循环共 6 步，全部是 memhub CLI 命令：

```powershell
$hub = 'C:\mem\my-hub'   # 本地 hub 目录

# 1. 拉增量（本地→远端，获得别人合入的新记忆）
memhub sync pull  --root $hub

# 2. 取萃取原料（自水位线以来的 ledger 事件 + 现有条目 + pending 标题，JSON）
memhub extract material --root $hub > material.json

# 3. workflow agent 读 material.json 做通用化萃取
#    → 对每条结论调用 memhub propose（重萃取加 --supersedes）
#    （这一步由你的 agent 平台执行，模型由平台提供）

# 4. 人工批准（本地闸门）
memhub serve --root $hub   # 浏览器收件箱点批准；或 memhub inbox approve PRO-xxx

# 5. 验证 + 推送个人分支（MR 审查）
memhub validate --root $hub
memhub sync push  --root $hub --branch $env:USERNAME --message "daily extraction"

# 6. 推进水位线
memhub extract done --root $hub
```

## 平台接线样例

### cron / 任务计划程序（单机自用）

```powershell
# Windows 任务计划程序，每天 03:00：
node C:\path\to\memhub extract material --root C:\mem\my-hub
# 触发的命令里调用你的 agent CLI（如 claude -p / codex exec）：
#   "读取 material.json，按 instruction 萃取，对每条结论执行
#    memhub propose ...，完成后 memhub extract done"
```

### agent-workflow 平台（如类 MulticA 工具，推荐）

1. **定时触发器**：每天一次，选自己的电脑作为执行机
2. **Agent 步骤**：执行 `memhub extract material --root <hub>`，读 JSON，
   按 instruction 萃取（通用化改写、supersedes 重萃取），逐条
   `memhub propose`
3. **通知步骤**：推送"本轮萃取 N 条，待批准"到你常用的 IM
4. **人工步骤**：你打开本地控制台批准
5. **收尾步骤**：`memhub validate` → `memhub sync push --branch <名字>`
   → `memhub extract done`

### 团队 CI（git 服务侧，第二道闸门）

在 git 服务的 CI 里对每个 MR 运行：

```yaml
# 任意 CI 语法，核心是一条命令（非零退出 = 挡合入）：
memhub validate --root <checked-out-hub>
```

## MR 协作流（审查者的视角）

- **接纳**：MR 合入 main —— 提交者的下次 `sync pull` 自动获得
- **拒绝**：MR 关闭 —— 提交者本地条目仍在，可改后重新 push
- **提意见**：MR 评论（如"这条绑定环境了，通用化一下"）—— 提交者在
  本地用控制台"编辑（重新萃取）"或 supersedes 提案改好，push 同一分支，
  MR 自动更新，审查者再看
- **条目级长期问题**（适用性争议、过期提醒）：在 git 服务上开 issue，
  引用条目 id（如 `KNO-000012`）

## 命令速查

| 命令 | 作用 |
|---|---|
| `memhub extract material [--since]` | 萃取原料（喂给任意平台的 agent）|
| `memhub extract done [--since iso]` | 推进萃取水位线 |
| `memhub propose` | agent 提案（绝不直接写 knowledge/）|
| `memhub inbox approve <PRO>` | 人工批准（panel 通道更常用）|
| `memhub validate` | 萃取验证闸门（本地 + CI）|
| `memhub sync init --remote <url>` | 首次接线：本地 hub ↔ 团队 git 服务 |
| `memhub sync push --branch <名字>` | 推个人分支 → MR 审查 |
| `memhub sync pull` | 同步 main 已合入的记忆 |
| `memhub serve` | 本地控制台（不是中心服务！）|

## 备选路径（当前未启用）

- **publish 出口已实现（ADR-0015）**：`memhub publish` 把批准的条目发到**你们自定义的出口**——hub.yaml 里 `publish.adapter: http`（POST 到 publish.endpoint）或 `publish.adapter: exec`（跑你们自己的脚本，stdin 收条目 JSON——腾讯风格 API 怎么变都只改脚本，memhub 不动）。增量发布走水位线（publish-state.json），失败不动水位线可重试。当前探索阶段建议用 exec：先写一个 `push-to-hub.mjs` 调你们的记忆库 API。
- **HTTP 中心枢纽**（ADR-0012）：若团队未来改为常驻中心服务统一管理，`memhub hub push|pull --remote` 已实现并有测试覆盖，配置切换即可，不是重写。
