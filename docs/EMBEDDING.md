# 同站点 iframe 部署指南

## 前提与部署模型

本实现支持可信共享账户下的同站点、不同 origin iframe。例如父页面 `https://portal.example.test` 和 DSH `https://dsh.example.test` 可以工作；`https://portal.other.test` 与 `https://dsh.example.test` 属于跨站点，配置会被拒绝。生产部署应使用 HTTPS，使官方 Cookie 同时具备 HttpOnly、SameSite=Strict 和 Secure。

父系统必须有后端。client secret 只能在父后端或 secret file 中存在，不能进入 JavaScript、HTML、URL、日志或 API 响应。

## 配置文件

复制示例，不直接编辑示例文件：

```bash
cp config/workspaces.example.json config/workspaces.json
cp config/embed.example.json config/embed.json
```

`workspaces.json` 的 `allowed_roots` 与每个 `path` 都必须是运行 Host 可见的绝对路径，而且目录必须已存在。`auto_create_user_directories` 必须为 `false`。`mode` 为 `read_write` 或 `preview_only`；后者会在服务端阻止创建执行会话、提交 prompt 和 Agent step。

`embed.json` 的关键字段：

| 字段 | 含义 |
|---|---|
| `public_origin` | DSH 对浏览器公开的精确 origin，必须等于 `WORKBENCH_PUBLIC_URL` |
| `allowed_parent_origins` | 可以承载 iframe 的精确父 origin 总表 |
| `ticket_ttl_seconds` | 默认票据寿命 |
| `ticket_max_ttl_seconds` | 票据寿命上限 |
| `ready_timeout_ms` / `init_timeout_ms` | 父子初始化超时 |
| `deployment_mode` | 必须为 `trusted_shared_account` |
| `clients[].client_id` | 父后端身份 |
| `clients[].secret_env` / `secret_file` | 二选一，secret 长度 32..4096 字符 |
| `clients[].allowed_parent_origins` | 该 client 可申请的父 origin |
| `clients[].workspace_aliases` | 该 client 可申请的配置 alias |
| `clients[].mode` | 该 client 允许的最高模式 |

不要在 `embed.json` 添加开关；唯一启用开关是环境变量 `WORKBENCH_EMBED_ENABLED`。

## 环境变量

| 变量 | 必需条件 | 说明 |
|---|---|---|
| `WORKBENCH_WORKSPACE_CONFIG` | 使用工作区扩展时 | `workspaces.json` 路径 |
| `WORKBENCH_EMBED_ENABLED` | iframe 时 | `true`/`false` 或 `1`/`0`，默认关闭 |
| `WORKBENCH_EMBED_CONFIG` | iframe 启用时 | `embed.json` 路径 |
| `WORKBENCH_PUBLIC_URL` | 反代或 iframe 时 | 无路径的精确公开 origin |
| `WORKBENCH_EMBED_STATE` | 可选 | grant SQLite 路径，默认 `DSH_HOME/extensions/embed.sqlite3` |
| `WORKBENCH_WEB_HOME` | 可选 | 官方 Web 配置、凭据与会话目录 |
| `WORKBENCH_WEB_WORKSPACE` | 可选 | 官方 documents root，不是项目 cwd |
| `DSH_EMBED_PORTAL_SECRET` | 示例 client 使用时 | 仅服务端可见的随机 secret |
| `DSH_WEB_PATCHES` | 可选 | 额外 profile patch；不用于加载本仓库扩展 |

生成 secret 的一种方式：

```bash
openssl rand -base64 48
```

配置后运行 `python -m workbench.cli doctor`。它只报告文件和扩展是否就绪，不输出 secret。任何 Host 配置、扩展、fork 或环境变量变更后都要重启 Web Host。

## 本地启动

本地 HTTP 适合独立开发和 localhost 不同端口的浏览器烟测：

```bash
npm ci
export WORKBENCH_WORKSPACE_CONFIG="$PWD/config/workspaces.json"
export WORKBENCH_EMBED_ENABLED=true
export WORKBENCH_EMBED_CONFIG="$PWD/config/embed.json"
export WORKBENCH_PUBLIC_URL=http://localhost:8765
export DSH_EMBED_PORTAL_SECRET='replace-with-at-least-32-characters'
.venv/bin/python -m workbench.cli web
```

此时配置中的 `public_origin` 和父 origin 也必须使用匹配的 localhost HTTP origins。不要把 HTTP localhost 结果当作 HTTPS Cookie 验收。

启动器在 `DSH_HOME/workbench-web.patch.json` 中生成绝对 `file:` 插件 URL，并在官方 Host 报告插件未激活时终止启动。`patches/web-embedding.patch.template.json` 只供已通过 DSH plugin manager 安装包的 profile 参考。

## Docker 与已有目录

在 `.env` 中保留现有端口、数据和模型设置，增加嵌入变量。设置宿主目录后使用 override：

```bash
export DSH_PROJECT_A_HOST_PATH=/srv/projects/project-a
export DSH_REFERENCE_HOST_PATH=/srv/reference-data
docker compose -f compose.yaml -f examples/deploy/compose.workspaces.yaml config --quiet
docker compose -f compose.yaml -f examples/deploy/compose.workspaces.yaml up -d --build
```

`create_host_path: false` 会让缺失挂载显式失败，避免 Docker 自动创建空目录。Windows 上 Docker Engine 位于 WSL2 时，手工 `-v` 或 Compose bind source 应使用 `/mnt/c/...`、`/mnt/d/...` 形式；仓库相对路径由当前目录自动映射。

生产启用时将 override 中 `WORKBENCH_EMBED_ENABLED` 改为 `"true"`，并确保 `embed.json`、`.env` 的公开 origin 和外层反代完全一致。不要执行 `docker compose down -v`。

## HTTPS 与 Nginx

将 `examples/deploy/nginx.same-site.conf` 部署到外层反代，补充真实证书和当前既有端口。必须保留 Host、Origin、Upgrade、Connection 与 `X-Forwarded-Proto`，并关闭请求/响应缓冲以支持流和 WebSocket。

不要在外层 Nginx 再添加第二份 `Content-Security-Policy` 或 `X-Frame-Options`。`/embed` 的扩展响应会根据配置生成精确 `frame-ancestors`；冲突 header 会使浏览器拒绝 iframe。

部署后检查：

```bash
curl -sS -D - -o /dev/null 'https://dsh.example.test/embed?channel_id=probe'
curl -sS 'https://dsh.example.test/embed/health/ready'
```

首个响应应包含精确 `frame-ancestors https://portal.example.test`、`Cache-Control: no-store`，且没有 `X-Frame-Options`。实际兑换响应的官方 Cookie 应为 HttpOnly、SameSite=Strict、Secure。

## 父系统后端

浏览器不能直接调用 grant API。父后端应按以下顺序：

1. 验证父系统登录、CSRF 和当前用户可访问的业务 workspace。
2. 从服务端配置决定 DSH origin、`parent_origin`、client ID、secret 和 workspace 映射，不接受浏览器传入任意目标 URL 或 origin。
3. 使用 `Authorization: Bearer <server-only-secret>` 调用 `POST /embed/control/grants`。
4. 只向浏览器返回 `ticket`、`expires_at`、`entry_url` 和 `protocol_version`，并设置 `Cache-Control: no-store`。
5. 不记录请求/响应 body。未消费 ticket 可以调用 `/embed/control/grants/revoke` 撤销。

请求示例：

```json
{
  "subject": "parent-user-audit-id",
  "parent_origin": "https://portal.example.test",
  "workspace_id": "official-workspace-id",
  "session_id": "optional-existing-session-id"
}
```

父页面实现见 `examples/host-integration/parent-bridge.js`。它严格核对 `event.origin`、`event.source`、协议、版本、channel 和 request ID。iframe URL 只包含非敏感 channel ID；ticket 通过 `postMessage` 发送。初始 prompt 可以放在 `init.payload.initial_prompt`，但只会填入官方输入框草稿，绝不自动发送。

## 升级 ZIP

1. 记录当前版本，备份 `.env`、实际 `config/*.json`、自定义 Compose/Nginx 文件和数据卷。
2. 解压新版到新目录，不覆盖运行中的 `.env`、配置、端口映射或数据目录。
3. 对比 `.env.example`、配置 schema、`compose.yaml` 和 `constraints.txt`，逐项合并新增字段。
4. 运行 `npm ci`、`npm run build:extensions`、`npm run test:extensions` 和 `python -m workbench.cli doctor`。
5. 构建新镜像，先用隔离端口/容器验证 `/embed/health/ready` 和 header，再切换服务。
6. 复用原数据卷并重启 Host；不要删除卷。验证独立 Web、iframe、WebSocket、文件面板与旧 Python CLI。
7. 确认稳定后再清理旧应用目录；保留可回滚镜像和备份。

grant 数据库存的是 ticket 哈希，不是明文 ticket。已消费、撤销和过期记录在 24 小时审计保留期之后由分钟级清理任务删除。

## 已知限制

- 仅可信共享账户；没有每用户全通道 ACL，也没有每 session 独立容器。
- 仅同站点 iframe；跨站点按设计拒绝。
- P0 消息为 `ready`、`initialized`、`session.opened`、`connection.changed`、`error`；没有 `task.changed` 或 `artifact.created`。
- `preview_only` 阻止执行，不代表提供专用只读文件浏览 UI。
- 浏览器禁用 Cookie、CSP/DNS/证书错误时会失败，父页应提供可见错误和独立打开入口。
- 测试夹具不证明真实付费模型、外网、证书链或业务数据权限正确。
