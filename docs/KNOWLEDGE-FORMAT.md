# KNOWLEDGE-FORMAT — 知识文件格式契约

> 与 dsh-memory-hub **共享的硬契约**：本仓直接读写旧 hub（零迁移）。权威实现：`src/core/frontmatter.ts`（解析）+ `tests/format.test.ts`（锁定）。改格式的流程见 [01-architecture/compatibility.md](01-architecture/compatibility.md)。

## 文件形态

```markdown
---
id: DEC-000001            # 必需；<TYPE前缀>-<6位序号>
version: 2                # 必需；正整数，每次实质变更 +1
type: decision            # 必需；九类枚举（05-domain/knowledge-types.md）
status: accepted          # 必需；candidate|accepted|rejected|superseded|deprecated
title: 写锁改为租约
summary: 一句话结论（≤240 字符）
scope:                    # 必需；三形态之一
  level: project
  workspaceId: dsh-memory-hub
tags: [lock, lease]       # 可选；内联数组
created: 2026-10-20T10:00:00+08:00
updated: 2026-11-01T09:30:00+08:00
last_verified: 2026-11-15T08:00:00+08:00
expires_at: 2027-01-01T00:00:00+08:00   # 可选；到期降权不删除
supersedes: [DEC-000009]  # 可选
related: [ADR-0009]       # 可选
---

正文 Markdown。
```

## 解析契约（tests/format.test.ts 锁定）

1. frontmatter 必须是文件开头 `---` 围栏块；无围栏 → 明确报错。
2. 标量：裸字符串 / 引号字符串 / 数字 / 布尔。
3. 数组：内联 `[a, b]` 与空 `[]`。
4. scope：块级嵌套（level + domainId|workspaceId）或内联 map。
5. **未知键原样保留**进 `extra`——前向兼容，读者不丢字段。
6. 契约键缺失/非法（id 空值、type 越界、version 非数字）→ 描述性报错，由调用方决定呈现。

## 兼容铁律

- 样例只来自真实 hub，不发明语法。
- 旧仓能写的本仓必须能读；本仓写的旧仓必须能读（双向 CI）。
- 新增可选键 = minor；改必需键语义或删键 = major + 两仓同步 ADR。
