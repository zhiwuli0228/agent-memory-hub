# Security Policy

> 不变量的运维化表述。状态：设计定案（Step 4 serve 实现时逐条落地为代码守卫）。

## 本地边界

1. **serve 只绑 loopback**：监听 `0.0.0.0` 直接拒绝启动（不是警告）。
2. **Host 头白名单 + 本地 Origin 校验 + 写操作令牌**：令牌启动时打印一次，写请求必须携带。
3. 面板进程与 CLI 同权：都是 hub 的普通写者，写锁租约仲裁。

## 数据安全

1. **写入前扫描**：pending → commit 的路径上扫描注入短语、凭据形状、不可见字符——风险标注进 ledger（不阻断，人看到标注再决定；继承旧仓 memory_propose 风险扫描设计）。
2. **hub 可入 git 但注意**：知识是明文——含公司敏感信息的 hub 不应推公共仓库；`.gitignore` 不代替人的判断。
3. 删除跨边界传播记 orphan，不静默成功。

## 供应链

1. 零运行时依赖 + 禁 postinstall（见 dependency-policy）——安装面最小化。
2. GitHub 仓库 secret scanning 已启用；push protection 保持开启。
3. 发布 npm 用 automation token，用完即撤（远程协作场景的闭环纪律）。
