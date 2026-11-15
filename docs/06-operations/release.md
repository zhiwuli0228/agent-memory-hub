# Release

> 状态：流程定案。npm 账号 `lizhiwu <lzw1510307303@gmail.com>`；GitHub `zhiwuli0228`。

## 版本策略

| 阶段 | 版本 | 内容 |
| --- | --- | --- |
| 占名 | 0.0.1 | 占位包（README 说明 under development；已备好待发布） |
| 首个正式版 | 0.1.0 | Step 2–3 完成：core + MCP + CLI，四宿主复验通过 |
| 完整体 | 0.2.0 | Step 4–5 完成：审批面板 + 注入/萃取 |

变更遵循 semver：格式契约破坏 = major（本契约的破坏需要两仓同步 ADR）。

## 发布步骤

1. `npm run check` 绿 + 真实旧 hub 回归（compat/old-hub.test.ts）。
2. 版本号 + CHANGELOG（每版一段：能力 / 兼容性 / 升级注意）。
3. `npm publish`（新包名首发**不能**用 Trusted Publisher——那是 per-package 配置；先正常发布，稳定后再在 npmjs.com 配 Trusted Publisher 绑 GitHub Actions）。
4. GitHub Release（tag + 说明）；旧仓 COMPATIBILITY.md 交叉引用更新。
5. MCP 目录提交材料（`docs/08-publish/`，继承旧仓清单：名字、描述、工具表、安装命令）。

## 已知发布环境事实

- 2026-11-15：本机 `.npmrc` token 失效（401），占名发布待用户恢复登录（automation token 或 `npm login`）。
- 发布后立即验证 `npm view agent-memory-hub version`；jsDelivr 缓存对新包无影响。
