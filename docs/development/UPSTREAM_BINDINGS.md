# 上游绑定与受控 fork

## 固定基线

| 项目 | 值 |
|---|---|
| 上游仓库 | `deepseek-ai/deepseek-harness` |
| npm 发行版 | `@deepseek-ai/dsh@0.2.0-rc.2` |
| 上游 tag | `dsh-v0.2.0-rc.2` |
| 上游 commit | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| 本仓库基线 | `origin/main` `b51a330bcc7b8cd8e1f11ab7a5508222176e5e12` |

所有扩展均针对该精确版本构建。升级 DSH 时必须重新比对这些绑定、重建受控 fork 并运行独立 Web 与嵌入浏览器回归，不能仅更新 semver。

## 已验证的官方扩展面

| API/服务 | 用法 |
|---|---|
| Host plugin/profile patch | 将仓库扩展加入官方 Host 组合 |
| `ctx.webServer.register` | 注册 `/embed/*` 精确 HTTP 路由 |
| workspace registry/controller | 注册已有目录并取得稳定官方 workspace ID |
| `ctx.uiWorkspace.connectWorkspace` | 通过官方导航创建或采用 workspace session |
| `ctx.uiWorkspace.openSession` | 打开官方会话，不猜 URL |
| `ctx.sessions.refresh` / `binding` | 验证既有 session 并取得官方 conversation binding |
| `ctx.conversation.input.for(...).setDraft` | 只填初始草稿，不提交 |
| `agent/pre-step` waterfall | 工具执行前再次执行工作区策略 |
| connection Fetch/trust services | 保留官方 Host/Origin、Cookie、HTTP 和 WebSocket 权威边界 |

Client 插件必须等待官方 workspace controller snapshot。直接在首次加载时调用 `openWorkspace()` 会被官方启动恢复流程覆盖；已验证流程是等待 snapshot 后调用 `connectWorkspace()`，随后 `openSession()`。

## Fork 1：connection

位置：`vendor/official-web-forks/dsh-client-connection`。

基于上游 `packages/client/connection`，只增加：

- `ctx.connection.issueBrowserSession(request)`：先运行现有 `isTrustedApiRequest`，再调用官方 BrowserAuth 签发 authority-bound session；失败返回拒绝状态。
- `connection.cookieSecure`：公开 origin 为 HTTPS 时为官方 Cookie 增加 Secure；HttpOnly 和 SameSite=Strict 保持官方实现。

需要此 fork 是因为公开 rc.2 没有供可信 bootstrap 调用的浏览器 credential issuance API。实现没有复制启动 token、没有共享固定 token、没有绕过 Host/Origin 检查，也没有伪造 Origin。

## Fork 2：session-controller

位置：`vendor/official-web-forks/dsh-api-session-controller`。

基于上游 `packages/api/session-controller`，只增加两个 Cordis waterfall admission：

- `api-session/create-admission`：位于 session ID/Agent/durable state 创建之前；
- `api-session/prompt-admission`：位于 Agent 恢复和用户内容落盘之前。

需要此 fork 是因为仅在 `agent/pre-step` 检查太晚，无法保证 `preview_only` 或失效目录不会先产生 durable mutation。扩展继续保留 `agent/pre-step` 作为执行时二次检查。

两个 fork 的 `package.json` 都包含 `workbenchFork.upstreamTag`、`upstreamCommit` 和 `purpose`。根 `package.json` 通过 npm `file:` 依赖替换精确包，Dockerfile 在依赖安装前后复制源目录，避免最终阶段出现悬空 symlink。

## 插件加载决策

`patches/web-embedding.patch.template.json` 中的裸包名只有在包已由 DSH profile/plugin manager 管理时才可用。本仓库虽然可以通过 Node 普通 import 解析 workspace package，但官方 profile package governance 会拒绝该裸名。

因此 `workbench/official_web.py` 在每次启动时生成 `DSH_HOME/workbench-web.patch.json`，使用经过验证的本地 `file:` URL 指向扩展入口，并在官方日志报告扩展 inactive 时让启动失败。这份生成文件是本仓库唯一受支持的加载路径；模板不能直接传给当前部署。

## 升级检查表

1. checkout 新上游 tag，记录精确 commit。
2. 从上游重新复制两个包，不在旧构建产物上叠加未知差异。
3. 重新应用最小 API、类型、源码和构建产物变更，更新 `workbenchFork` 元数据。
4. 核对 BrowserAuth、trust fence、Cookie 属性、session create/prompt mutation 顺序和 Client 导航服务。
5. 更新 peer dependencies、lockfile 和 Docker 构建上下文。
6. 运行扩展单测、真实 iframe smoke、原独立 Web smoke、Python 回归和隔离 Docker 验收。

不要直接修改 `node_modules`，不要用 DOM 自动点击代替公开服务调用，也不要在反代层伪造身份或 Origin。
