# Dependency Policy

## 运行时依赖：目标零

Node.js 内建（fs / path / crypto / zlib / readline）优先。确需第三方时走 allowlist 评审（ADR），当前允许的类别：

| 类别 | 候选 | 决定 |
| --- | --- | --- |
| YAML | js-yaml / yaml / 自研子集 | ⏳ Step 2 评估：契约面小（单层标量/内联数组/嵌套 scope），自研已覆盖（src/core/frontmatter.ts）；出现解析不了的真实 hub 样例再引入 |
| 参数校验 | zod | ⏳ Step 3 评估（MCP schema 校验） |
| MCP SDK | @modelcontextprotocol/sdk | ⏳ Step 3 评估：协议面小（stdio JSON-RPC），可自研；SDK 稳定性优先则引入——需 ADR |

## 硬性禁止

- peer dependencies（`npm i -g` 单包全功能——ADR-0001 原则 6）
- native modules（node-gyp 等——跨平台安装失败是最大安装摩擦）
- postinstall 脚本（安全 + 离线安装）
- 任何需要联网才能完成的构建/安装步骤

## 版本纪律

- devDependencies 锁 minor；lockfile 提交。
- 运行时依赖每次升级走 ADR + 全量 check + 真实 hub 回归。

## 理由

这是给"公司内同事 + 公共用户"一键安装的工具：安装摩擦每多一分，采用少一成。旧仓零依赖纪律已被验证可行（BM25/分词/锁全部自研，348 测试绿）。
