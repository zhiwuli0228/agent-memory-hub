# Host Capability Matrix

> 状态标注三档：✅ 实测 / 📄 文档 / ⏳ 待核。旧仓 V30–V33 实测数据继承为基线，本仓复验后升档（见 [COMPATIBILITY.md](../COMPATIBILITY.md)）。

| 宿主 | MCP 工具 | 轮前注入 | 轮末捕获 | 审批落点 | 档位 | 复验状态 |
| --- | --- | --- | --- | --- | --- | --- |
| **DSH** | ✅（插件内嵌） | ✅ systemPrompt + 预检 | ✅ 预检/萃取 | ✅ 原生审批 prompt | T3 | ⏳ 待核（旧仓生产使用中） |
| **Claude Code** | ✅ 实测（add-json 注册，`--` 分隔符坑已记录） | 📄 UserPromptSubmit 钩子 | 📄 SessionEnd 钩子 | 📄 面板/CLI inbox | T3（配钩子）/ T1 | ⏳ 待核（旧仓 V30 端到端实测过工具面） |
| **Codex** | ✅ 实测（exec + bypass 旗标，非交互 approval never 坑已记录） | ❌ | ❌ | 📄 面板/CLI inbox | T1 | ⏳ 待核（旧仓 V31 实测过工具面） |
| **opencode** | ✅ 配置就位 | 📄 钩子 | 📄 | 📄 | T3（配钩子）/ T1 | ⏳ 待核（旧仓 V32：provider key 失效挡在宿主侧，MCP 链路本身就绪） |
| **gemini** | ✅ 注册成功 | ❌ | ❌ | 📄 面板/CLI inbox | T1 | ⏳ 待核（旧仓 V33：untrusted 目录抑制为预期行为） |
| **Cline / Cursor / Zed** | 📄 均支持 MCP | ❌ | ❌ | 📄 | T1 | ⏳ 待核 |
| **任何 shell** | — | — | — | CLI inbox | T0 | ✅（CLI 天然） |

## 注册方式速查（复验时用）

- **Claude Code**：`claude mcp add-json memhub '{"type":"stdio","command":"node","args":["<abs>/dist/cli.js","mcp","--root","<hub>"]}' --scope user`（`claude mcp add -- args` 的 `--` 会被 commander 吃掉——必须 add-json）。
- **Codex**：`codex mcp add memhub -- node <abs>/dist/cli.js mcp --root <hub>`；非交互 exec 需 `--dangerously-bypass-approvals-and-sandbox`（仅测试）。
- **opencode**：`~/.config/opencode/opencode.json` 增 mcp 段。
- **gemini**：`gemini mcp add`；untrusted 目录提示为信任机制预期行为。

## 复验清单（Step 3 验收）

1. 裸握手冒烟（initialize → tools/list → memory_search → memory_status）逐宿主通过。
2. 写链路：memory_propose 产生候选 → 人审批（面板/CLI inbox）→ 入库（旧仓未闭环项，本仓必须闭环）。
3. 写锁互操作：DSH 插件持锁时本仓 MCP 如实报 readOnly。
4. workspace 注册表匹配：同一 hub，各宿主 cwd 命中注册表 → project 知识可见。
