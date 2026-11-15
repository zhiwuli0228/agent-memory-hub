# Development Guide

## 环境

- Node.js >= 20、npm
- 编辑器任意；Windows / macOS / Linux 均可开发（纯 Node 无 native）

## 常用命令

```sh
npm install          # 安装依赖（仅 typescript + vitest，零运行时依赖）
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/（cli.js bin 入口）
npm run test         # vitest run
npm run check        # typecheck + build + test（每轮改动收尾必跑，必须绿）
```

## 开发工作流

1. 读 [current-state.md](../00-project/current-state.md)。
2. 小改动直接改；大改动先提案（[03-openspec](../03-openspec/README.md)）。
3. 补充或更新测试（契约改动先改测试样例）。
4. `npm run check` 绿。
5. 更新 current-state.md；架构级改动写 ADR。

## 项目结构

见 [01-architecture/module-boundaries.md](../01-architecture/module-boundaries.md)（含禁入符号清单）。

## 已知工程坑（从旧仓继承，勿再踩）

1. **edit 截断**：文档编辑后必须 grep 复验关键段落完整（旧仓 edit 工具曾静默截断/重复标题）。
2. **vitest 收集期求值**：测试文件顶层不要执行有副作用的初始化（旧仓踩过：收集期读文件系统）。
3. **网络测试必须闸门**：涉及网络的测试用环境变量闸门控制（旧仓 `DMH_FUSION` 模式），CI 与默认 `npm test` 永远离线。
4. **CRLF**：Windows 开发，.gitignore 已就位；文档换行差异不影响 CI。
5. **npm 发布**：首次发布新包名不能走 Trusted Publisher（那是 per-package 配置）；占名 → 正式版流程见 [06-operations/release.md](../06-operations/release.md)。

## 宿主验证

见 [02-harness/host-capability-matrix.md](../02-harness/host-capability-matrix.md) 复验清单（Step 3 验收）。
