# Storage Contract

> Hub 目录是唯一事实源。本契约与 dsh-memory-hub 共享——**格式漂移由两仓互引的契约测试防**（本仓 `tests/format.test.ts` ↔ 旧仓格式测试）。
> 状态标注：✅ 已实现 / 📐 设计定案（Step 2 落地）/ 🔗 继承旧仓（引用不复制）。

## 目录布局

```text
<root>/                       # Hub 根（可指向现有旧仓 hub，零迁移）
├── hub.yaml                  # Hub 配置：workspaces / core_workspaces / parentCoreIds / lock 参数
├── knowledge/                # ✅ 已批准知识（人批准才能进）
│   └── <type>/<ID>.md        # 按类型分目录：decision/ knowledge/ process/ ...
├── pending/                  # 📐 候选（模型可建，人批准）
│   └── PRO-*.md
├── history/                  # 📐 版本快照（只追加）
│   └── <type>/<ID>@v<N>.md
├── records/                  # 📐 运行记录
│   ├── ledger.jsonl          # 事件流账本（只追加；跨仓兼容承诺限于 knowledge 格式，ledger 事件形状不承诺跨版本——见 04-development/search-replay-2026-11-15.md 附录）
│   └── sequences.json        # ID 序列
└── .writer.lock              # 🔗 写锁租约（心跳 15s + 超龄回收 + fencing token）
```

## 知识文件格式

frontmatter + Markdown 正文，详见 [KNOWLEDGE-FORMAT.md](../KNOWLEDGE-FORMAT.md)。契约面：

- 必需键：`id / version / type / status / title / summary / scope`
- 可选键：`tags / created / updated / last_verified / expires_at / supersedes / related / merged_ids`
- **未知键必须原样保留**（前向兼容；`extra` 字段承载，测试锁定）
- scope 三形态：`{level: global}` / `{level: domain, domainId}` / `{level: project, workspaceId}`

## 写路径铁律

1. 所有写入走 core 的原子写（tmp + rename），禁止裸 `writeFile` 到正式路径。
2. `knowledge/` 只能由 commit 写入；commit 必须有 ledger 记录（人批准的证据）。
3. `history/` 只追加，永不改写。
4. 删除知识 = `status: deprecated` + ledger 记录，物理删除仅限显式用户授权。
5. 多入口并发：拿不到写锁租约 → 降级只读 + 如实上报（`readOnly: true` + 持有者信息，继承旧仓 V30 行为）。

## 与旧仓的数据兼容

- 本仓直接打开旧 hub：✅（格式相同）。
- 两仓可同时指向同一 hub：写锁租约仲裁（跨进程心跳文件锁）。
- 兼容性回归：Step 2 的验收测试对真实旧 hub（45 条 accepted）做只读盘点。
