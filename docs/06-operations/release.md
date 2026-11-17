# 发布手册 — 自动 release 到 npm

> 两个 npm 包共用一条流水线：**push 任意 `v*` tag → GitHub Actions 跑测试 → 双包发布 → GitHub Release 附 tarball**。
> 发布走 **npm Trusted Publisher (OIDC)**：不需要任何 token、不会触发 2FA OTP。

## 包与触发关系

| 包 | 目录 | 当前版本 | npm |
| --- | --- | --- | --- |
| `agent-memory-hub` | 仓库根（CLI / MCP server） | 独立演进 | [npmjs](https://www.npmjs.com/package/agent-memory-hub) |
| `dsh-agent-memory-hub` | `host/dsh/`（DSH 插件壳，esbuild 打包 core） | 独立演进 | [npmjs](https://www.npmjs.com/package/dsh-agent-memory-hub) |

流水线语义：`v*` tag 是"发布当前仓库状态"的信号；**每个包只发布自己 package.json 里的 version**，npm 上已存在的版本自动跳过（幂等，可安全重跑 tag）。tag 名不必等于包版本。

## 一次性配置：绑定 npm Trusted Publisher（每人每包一次，需在 npmjs.com 操作）

对**两个包**各做一遍（登录 npmjs.com → 包页面 → Settings）：

1. **Publishing access**（或 Settings → Publishing access）
2. **Trusted Publisher → Connect Publisher**
3. 填写：
   - **Repository owner**: `zhiwuli0228`
   - **Repository name**: `agent-memory-hub`
   - **Workflow filename**: `release.yml`
   - **Environment**（可选）: 留空
4. 保存。两个包都绑定后，`release.yml` 里的 OIDC 发布即被 npm 接受。

> 首次发布过的包（0.1.0 / 0.1.2）当年是手动发（OTP 流程）——Trusted Publisher 对**后续**版本生效，无需 bootstrap。
> Fallback（不推荐）：生成 **Classic Automation** token 存入 GitHub Secret `NPM_TOKEN`，workflow 里改用 `NODE_AUTH_TOKEN` 方式发布——多一个 secret 多一份泄露面，仅在无法绑定 Trusted Publisher 时使用。

## 日常发版流程（维护者）

```sh
# 1. 改好代码，版本号 bump 到 npm 上不存在的新版本
#    根包：package.json "version"；host：host/dsh/package.json "version"
npm run check && (cd host/dsh && npm run check)   # 本地先过一遍

# 2. 提交 + 打 tag + 推送
git add -A && git commit -m "release: agent-memory-hub@0.1.1 + dsh-agent-memory-hub@0.1.3"
git tag v0.1.3-20261118 && git push origin main --follow-tags

# 3. GitHub Actions 自动：双包 check → publish (provenance) → Release
#    https://github.com/zhiwuli0228/agent-memory-hub/actions
```

## 质量闸门

每个包发布前必须过自己的 `npm run check`：

- 根包：`typecheck` + `build`（tsc 产出 dist）+ `test`（121 vitest）
- host/dsh：`build`（tsc --noEmit + esbuild 打包 dist/index.js ≈42KB）+ `test`（7 vitest）

任何一步失败 → 该包不发布（另一个包不受影响，独立 job step）。

## 供应链可见性

发布带 `--provenance`——npmjs 包页面会显示 provenance 徽章（构建自 zhiwuli0228/agent-memory-hub 的哪个 commit/workflow），第三方可验证 tarball 来源。

## 故障处理

| 现象 | 处理 |
| --- | --- |
| Actions 报 `403 publish` / OIDC 错误 | Trusted Publisher 绑定不对：核对 owner/repo/workflow filename 三项与 `release.yml` 完全一致 |
| 某包显示 `skip: already on npm` | 该版本已发布过——bump version 重新打 tag；这是幂等保护，不是错误 |
| check 失败但本地全绿 | CI 上 Node 22 vs 本地版本差异；看 Actions 日志里第一个失败测试 |
| Release 没创建 | 两包版本都已在 npm（幂等跳过）——本次 tag 无新版本可发，属正常 |
| 需要撤销已发布版本 | `npm unpublish <pkg>@<version>`（72h 内）；npm 不允许同号重发，撤销后必须 bump 新版本 |
