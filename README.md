# DSH 通用工作区与同站点嵌入

本仓库运行完整的官方 `@deepseek-ai/dsh@0.2.0-rc.2` Web，并保留官方 Python SDK `0.1.5rc1` 命令行入口。官方界面、会话协议、流式输出、工具调用、文件面板、模型设置和插件系统不被替换；仓库在官方扩展点上增加受控工作区、一次性嵌入票据和同站点 iframe 导航。

当前已实现可信共享账户模式的 P0 嵌入：现有目录注册、路径策略、创建/提交/执行守卫、官方浏览器 Cookie 签发、精确 CSP、`postMessage` 初始化、官方工作区/会话导航，以及只填草稿且不自动发送的初始提示。工作区级 `preview_only` 在服务端阻止会话创建、提示提交和 Agent 执行；共享账户无法持续区分客户端身份，因此客户端级 `preview_only` 配置会被拒绝。

它不是多租户授权或每会话沙箱。嵌入仅支持同 scheme、同可注册域的不同 origin；跨站点部署、`task.changed`、`artifact.created` 和真实用户级 ACL 不在本阶段能力内。

## 独立 Web

推荐 Python 3.12、Node.js 24（最低 22.19），插件安装还需 pnpm `10.12.1`。

Linux/macOS：

```bash
bash scripts/install.sh
cp .env.example .env
.venv/bin/python -m workbench.cli web
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
Copy-Item .env.example .env
.venv/Scripts/python.exe -m workbench.cli web
```

打开终端打印的带一次性 token 地址。官方服务把 token 换成 HttpOnly Cookie 后清理地址栏；这不是旧 `WORKBENCH_TOKEN` 流程。进入 **Settings -> Models** 配置 API Key 和模型。官方 DeepSeek Web 默认使用 `https://api.deepseek.com/anthropic` 的 Messages 协议。

## 工作区与嵌入

1. 复制 `config/workspaces.example.json` 和 `config/embed.example.json` 为部署配置。
2. 将工作区路径改为已经存在的绝对目录，并设置允许根目录。
3. 设置 `WORKBENCH_WORKSPACE_CONFIG`。需要 iframe 时再设置 `WORKBENCH_EMBED_ENABLED=true`、`WORKBENCH_EMBED_CONFIG`、`WORKBENCH_PUBLIC_URL` 和服务端 client secret。
4. 运行 `python -m workbench.cli doctor` 检查扩展和配置文件是否就绪，再重启 Host。

详细本地、Docker、HTTPS、父系统后端和升级步骤见 [docs/EMBEDDING.md](docs/EMBEDDING.md)。API 合同位于 `contracts/openapi.json`、`contracts/embed-message.schema.json` 和 `contracts/error-codes.json`；父页面参考位于 `examples/host-integration/`。

EzProber 和 Memory Lab 使用同一套不可变会话绑定基础设施，但必须部署为两个独立 DSH 实例；单个实例会拒绝同时启用两种宿主集成。Memory Lab 的 CSV 工具、独立端口/数据卷、联调和回滚说明见 [docs/MEMORYLAB_INTEGRATION.md](docs/MEMORYLAB_INTEGRATION.md)。

扩展改变 Host 组合，修改配置、扩展源码或受控 fork 后必须重启 Web 进程。启动器会生成 `DSH_HOME/workbench-web.patch.json`，并写入仓库扩展的绝对 `file:` URL。`patches/web-embedding.patch.template.json` 仅适用于扩展已经通过 DSH 插件管理器安装的 profile，不是本仓库的直接启动入口。

## Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f workbench
```

默认入口是 `http://localhost:8765` 且只绑定宿主回环地址。嵌入部署使用 `examples/deploy/compose.workspaces.yaml` 挂载现有目录和只读配置：

```bash
docker compose -f compose.yaml -f examples/deploy/compose.workspaces.yaml up -d --build
```

Compose 保留已有端口和数据卷。不要使用 `docker compose down -v`，它会删除数据卷。容器以非 root 用户运行、移除 capabilities、启用 `no-new-privileges`，但 `DSH_PERMISSION_MODE=danger-full-access` 表示容器本身是当前执行隔离边界，不是多租户沙箱。

## 数据与升级

| 内容 | 默认位置 |
|---|---|
| 官方 Web 配置、模型凭据、会话 | `data/web/dsh-home/`；容器中为 `/data/web/dsh-home/` |
| 嵌入 grant 与审计数据库 | `DSH_HOME/extensions/embed.sqlite3` |
| 官方 Web 文档根目录 | `data/web/workspace/`；容器中为 `/data/web/workspace/` |
| Python SDK 会话 | 原 `data/` 目录结构 |

升级 ZIP 前备份 `.env`、实际配置、Compose override 和数据卷；替换应用文件后重新 `npm ci`、构建镜像并重启，不要删除数据卷。旧 SDK SQLite 会话不会伪装成官方 Web 会话，也不会自动迁移。

## Python SDK

```bash
.venv/bin/python -m workbench.cli doctor
.venv/bin/python -m workbench.cli chat "创建 Python 脚本并运行"
.venv/bin/python -m workbench.cli chat --session 上次的ID "继续修改"
```

SDK CLI 的 `DSH_MODEL`、`DSH_PROFILE`、`DSH_PATCHES` 与官方 Web 的模型和会话配置独立。旧 `workbench.api` 仅保留兼容接口，不承载官方 Web 协议。

## 代码边界

| 位置 | 用途 |
|---|---|
| `packages/workbench-extensions/` | 工作区策略、HTTP 路由、票据、Host/Client 插件 |
| `vendor/official-web-forks/` | 固定上游 commit 的两个最小受控 fork |
| `workbench/official_web.py` | 官方 Host 启动、patch 生成、Nginx 和进程回收 |
| `contracts/` | HTTP、消息和错误码合同 |
| `config/`、`examples/` | 配置、部署和父系统参考 |
| `tests-js/`、`scripts/*smoke.cjs` | 策略单测和真实浏览器回归 |

上游绑定、公开 API 和 fork 理由见 [docs/development/UPSTREAM_BINDINGS.md](docs/development/UPSTREAM_BINDINGS.md)，整体设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 验证

```bash
python -m pytest -q
npm ci
npm run build:extensions
npm run test:extensions
npm run test:embed
node scripts/web-smoke.cjs
docker compose config --quiet
docker compose build workbench
```

浏览器测试使用本地模型夹具验证真实官方 Web、SSE、工具、WebSocket、文件预览和 iframe 链路，不消耗真实模型额度，也不证明公网模型可用性。验证环境、结果和未运行项见 [docs/VALIDATION.md](docs/VALIDATION.md)。
