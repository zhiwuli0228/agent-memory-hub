# Source Ref Rules

> 证据引用规范：每条入库知识的 `source_refs` 是可追溯性的根基（不变量 2 的配套——批准的是"有证据的事实"）。

## 格式

| 形式 | 含义 | 示例 |
| --- | --- | --- |
| `session:<id>#<from>-<to>` | 会话事件区间 | `session:TSK-20261115#560-620` |
| `file:<path>` | 仓库/工作区文件（可带行号） | `file:docs/01-architecture/design.md` |
| `url:<https-url>` | 外部网页 | `url:https://example.com/spec` |
| `note:<text>` | 人手写备注（低强度证据） | `note:口头确认` |

## 强度分档

1. **强**：session 区间 + file 行号（可复核到原始事件/代码）。
2. **中**：url（外部可变，需 `last_verified`）；file 无行号。
3. **弱**：note（仅作辅助，decision/constraint 类不允许只有 note）。

## 规则

1. `decision` / `constraint` / `process` / `api-catalog` 入库时**必须**有强证据（人审界面弱证据标黄）。
2. `memory_reflect` 产物标 `reflection` tag + session 区间。
3. 引用即责任：`memory_cite` 记录"哪条知识被用于哪个任务"，形成老化依据（90 天未引用 → 维护报告标 stale）。
