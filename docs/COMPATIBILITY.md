# COMPATIBILITY — 宿主验证记录

> 状态标注三档：✅ 实测 / 📄 文档 / ⏳ 待核（不许混用；规则见 [01-architecture/compatibility.md](01-architecture/compatibility.md)）。
> 基线：旧仓 dsh-memory-hub V30–V33 四宿主接入实测（工具面）。本仓复验从 Step 3 开始，逐条升档。

## 1. 工具面（MCP stdio）

| 宿主 | 旧仓基线 | 本仓复验 |
| --- | --- | --- |
| Claude Code | ✅ V30：add-json 注册 + `claude -p --allowedTools` 真实调用 | ✅ 2026-11-16：全局配置 memory-hub 指向本仓 dist（备份 `.claude.json.bak-memhub-20261116`）+ `claude mcp list` ✓ Connected + `claude -p --allowedTools mcp__memory-hub__memory_status` 真实调用返回正确 hubRoot/计数 |
| Codex | ✅ V31：exec + bypass 旗标真实调用 | ⏳ Step 3 |
| opencode | ⚠️ V32：MCP 配置就绪；端到端被宿主侧 provider key 失效挡住（非本服务问题） | ⚠️ 2026-11-16：配置已指向本仓 dist（备份 `opencode.json.bak-memhub-20261116`）；端到端仍被宿主侧 provider key 挡（glm-5.1 身份验证失败 / mimo Invalid API Key，与本服务无关——同一 server 进程经 Claude Code 真实调用 ✅） |
| gemini | ✅ V33：注册成功（untrusted 目录抑制为信任机制预期） | ⏳ Step 3 |

裸握手冒烟（initialize → tools/list → memory_status → memory_search）：✅ 2026-11-16 本仓 `node dist/cli.js mcp` 全通过，tools/list 11 工具。

## 2. 写链路（propose → 人审 → 入库）

| 链路 | 状态 |
| --- | --- |
| DSH 插件内：propose → 原生审批 → commit | ✅ 旧仓生产在用 |
| 跨宿主 MCP：propose → 面板/CLI inbox → commit | ⏳ 旧仓未闭环，**本仓 Step 4 必须闭环** |

## 3. 写锁租约（跨入口互操作）

| 场景 | 状态 |
| --- | --- |
| DSH 插件持锁 → 旧仓 MCP 入口如实报 `readOnly: true` + 租约信息 | ✅ 旧仓实测 |
| 同 hub 双仓共存（旧仓插件 + 本仓 memhub）写锁互操作 | ⏳ 待核（本仓 Step 2 lock.ts 后验证） |

## 4. workspace 注册表匹配

| 场景 | 状态 |
| --- | --- |
| 非根目录 cwd → 注册表匹配到已注册 workspace | ⏳ 本仓 Step 2（旧仓已知塌陷问题，本仓根除目标） |
| cwd 匹配不上 → 文档化回退 + `status.workspace.exact=false` | ⏳ 本仓 Step 2 |

## 5. 复验命令（Step 3 用）

```sh
node dist/cli.js mcp --root <hub>          # 裸 stdio，配宿主前先冒烟
claude mcp add-json memhub '<json>'        # 见 host-capability-matrix.md 速查
codex exec --dangerously-bypass-approvals-and-sandbox ...  # 仅测试
```

复验一条升档一条：⏳ → ✅（附日期 + 环境）。发现行为差异立即记 [00-project/current-state.md](00-project/current-state.md) 并回溯 tool-surface 契约。
