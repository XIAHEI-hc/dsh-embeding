# 通用工作区与嵌入架构

## 运行拓扑

独立访问：浏览器 -> 官方 DSH Web。容器访问：浏览器 -> 仓库内 Nginx -> 容器回环上的官方 DSH Web。同站点嵌入：父页面 -> `/embed` bootstrap -> 一次性 ticket 兑换 -> 官方 Cookie -> 官方 DSH Web/API/WebSocket。

父系统后端先验证自己的登录与业务权限，再以 server-only client secret 调用 `POST /embed/control/grants`。浏览器只得到短期一次性 ticket，并通过 `postMessage` 发给 iframe；ticket、prompt 和工作目录都不进入 URL。兑换操作把 ticket 原子标记为已消费，签发官方 authority-bound 浏览器 Cookie，然后跳转至原始官方 Web。

## 组件职责

| 组件 | 职责 |
|---|---|
| 官方 DSH rc.2 | UI、会话、RPC、流、工具、文件、模型、插件和持久化 |
| `workbench/official_web.py` | 固定版本检查、Host patch 生成、public origin、Nginx、生命周期 |
| `packages/workbench-extensions` Host | 配置、工作区注册、路径检查、执行守卫、grant HTTP 路由、CSP |
| `packages/workbench-extensions` Client | 等待官方快照，连接工作区，打开会话，填充草稿，发 P0 状态消息 |
| `vendor/official-web-forks` | 在原始权威边界内增加 Cookie 签发和 durable mutation 前的 admission hooks |
| 父系统 | 用户认证、业务 ACL、grant 代理、严格校验 iframe 消息 |

扩展通过官方 `webServer.register` 注册精确路由，通过官方 workspace registry 注册稳定 ID，通过官方 `uiWorkspace`、`sessions` 和 conversation input 服务完成导航。它不复制 WebSocket 协议、不查询 DOM、不猜测会话 URL。

## 工作区策略

配置只接受绝对路径，允许根必须已存在。启动和每次执行入口都对工作区做 canonical/realpath 检查，用路径关系而不是字符串前缀阻止 `..`、相似前缀和 symlink 越界；同一真实路径得到稳定且去重的官方 workspace ID。若工作区启动时暂时缺失，策略先按规范化配置路径保留已有 ID 关联并失败关闭，目录恢复后仍使用原配置模式。`WORKBENCH_WEB_WORKSPACE` 只是官方 documents root，不代替项目 cwd。

策略把 missing、not-directory、denied、read-only、outside-root 和 I/O 失败显式映射为结构化错误，绝不静默回退到默认目录。守卫覆盖：

- session create admission：在 durable session 或 Agent 创建前检查；
- prompt admission：在恢复 Agent 或记录用户内容前检查；
- `agent/pre-step`：执行过程中再次检查路径和模式；
- `preview_only`：服务端阻止上述执行入口。

路径白名单不是 shell 沙箱。可信账户仍可在所授予容器权限范围内执行工具。

## 身份与浏览器安全

连接 fork 暴露 `ctx.connection.issueBrowserSession(request)`，但仍先执行官方 Host/Origin trust fence，再使用官方 credentials 生成签名 Cookie。Cookie 是 HttpOnly、SameSite=Strict；`WORKBENCH_PUBLIC_URL` 为 HTTPS 时增加 Secure。

`public_origin` 必须与 `WORKBENCH_PUBLIC_URL` 完全一致。父子 origin 必须同 scheme 且具有 Public Suffix List 推导出的相同可注册域；不使用“最后两个标签”启发式。`/embed` 只输出配置中允许父 origin 的精确 `frame-ancestors`，不发送冲突的 `X-Frame-Options`，并设置 `no-store` 与严格 referrer policy。

grant 数据库只保存 ticket 的 SHA-256 哈希。兑换在 SQLite `BEGIN IMMEDIATE` 中完成，重放、过期和撤销均有明确错误；已消费、撤销和过期记录在清理阈值后保留 24 小时，供审计与重放判定。

## 初始化状态

bootstrap 向允许 origin 发送 `ready`。父页核对 `origin`、`source`、协议版本、channel 和 request 后申请 ticket，并发送 `init`。兑换成功后只把已净化的工作区、会话、模式和初始草稿状态写入 `sessionStorage`，随后进入官方页面。

Client 插件等待官方 workspace controller snapshot。首次进入时调用 `connectWorkspace(workspaceId)`，立即持久化返回的 session ID；刷新时校验该 session 仍属于授权工作区，再用 `openSession(sessionId)` 恢复同一对话。有初始 prompt 时，仅在当前 draft 为空且尚未应用时调用 `setDraft`；它永不自动提交，刷新和重连也不重新兑换 ticket 或新建会话。`connection.changed` 直接订阅官方 Connection 的 WebSocket/Host 恢复状态，不使用 `navigator.onLine` 代替服务可用性。

P0 消息只有 `ready`、`initialized`、`session.opened`、`connection.changed`、`error`。P1 的任务与产物事件未实现。

## 信任边界与限制

当前 deployment mode 固定为 `trusted_shared_account`。父系统可以限制谁获得 ticket，但 ticket 兑换后使用的是同一个 DSH operator 权限边界；本实现不声称为每个终端用户提供全 HTTP/RPC/WebSocket ACL，也拒绝无法在普通共享 Cookie 上持续兑现的客户端级 `preview_only`。真正的多租户或客户端级只读需求必须使用隔离 Host，或在官方所有通道上实现统一身份与授权。

Python SDK CLI 和旧兼容 API 使用原 adapter/store，与官方 Web 的存储和协议独立。容器整体是当前工具执行隔离边界，不是每 session 独立容器。
