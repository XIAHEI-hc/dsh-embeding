# DSH Embedding · 官方 Web + Python SDK

独立网页现在直接运行 **官方 `@deepseek-ai/dsh@0.2.0-rc.2` 完整发行包**，同时保留官方 Python SDK `0.1.5rc1` 的命令行入口。原先自写的聊天页面已移除。界面、会话协议、流式输出、工具调用、文件展示、模型配置、插件和工作区管理均由官方实现；本仓库负责安装、启动、持久化目录和容器入口。

这一步先完成独立运行与官方扩展基础，Ezprober / iframe 接入放在下一阶段。官方发行版仍标记 Preview。

## 启动官方网页

推荐 Python 3.12、Node.js 24（最低 22.19），插件安装还需 pnpm（`npm install -g pnpm@10.12.1`）。Linux/macOS：

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

打开终端打印的 **带 token 的登录地址**。官方服务将 token 换成 Cookie，随后从地址栏移除 token。它不是旧版 `WORKBENCH_TOKEN` 登录流程。

进入 **Settings → Models** 填 API Key，也可修改 Base URL、添加第三方模型或 Custom model API。建议在这里配置，避免复用旧 `.env` 的模型地址。官方 DeepSeek Web 默认使用 `https://api.deepseek.com/anthropic`（Messages 协议）；旧配置的 `https://api.deepseek.com` 不能直接当作该接口使用。

`npm ci` 安装完整官方程序；不用自行编写静态页面，也不用复制上游内部会话协议。修改 Python 启动代码后重启即可，`web --reload` 已停用。

## Docker

```bash
cp .env.example .env
# 编辑 .env 后
docker compose up -d --build
docker compose logs -f workbench
```

打开日志中带 token 的地址。默认宿主入口为 `http://localhost:8765`，仅绑定宿主机回环地址；改端口设置 `WORKBENCH_PORT`。经其他域名访问时设置 `WORKBENCH_PUBLIC_URL=https://你的域名`，它必须是无路径的 origin，并在外部配置 HTTPS 反向代理。

官方服务监听容器内 `127.0.0.1`；本仓库 Nginx 暴露容器入口，保留真实 Host / Origin、Cookie、官方鉴权与 WebSocket，关闭代理缓冲。模型执行仍在同一个容器内。Compose 保留非 root、cap_drop、no-new-privileges、数据卷等设置。

保留你已有的 `DSH_PERMISSION_MODE=danger-full-access` 容器配置：本镜像没有可用的 bubblewrap / Landlock 后端，`workspace-write` 会使 bash 失败；容器是当前隔离边界。本地启动默认保留官方权限策略。这里还不是每会话独立容器的多用户沙箱。

```bash
docker compose down
```

数据卷保持不变；`down -v` 会删除数据。镜像包含 Python、Node.js、npm、pnpm、bash、git 和 Nginx。模型调用需要出网。

## 持久化与旧版迁移

| 内容 | 默认目录 |
|---|---|
| 官方 Web 配置、模型凭据、会话 | `data/web/dsh-home/` |
| 官方 Web 工作区根目录 | `data/web/workspace/` |
| 自动建立的默认工作区 | `data/web/workspace/deepseek-harness/default-workspace/` |
| 保留的 Python SDK 会话 | 原 `data/` 目录结构 |

容器中 `data` 对应 `/data` 命名卷。用 `WORKBENCH_WEB_HOME` / `WORKBENCH_WEB_WORKSPACE` 覆盖目录。官方模型凭据按上游配置机制保存于 DSH_HOME，请保护数据目录。

旧 SDK SQLite 会话没有伪装成官方 Web 会话，不自动迁移；原文件和 CLI 入口保留。可在官方 Workspaces 中添加已有文件目录。升级时先备份原数据卷，重建镜像即可；无需删除卷。

## Python SDK 单独运行

仓库继续携带官方 SDK 原始 wheel；安装时拉取同版本平台 runtime。

```bash
.venv/bin/python -m workbench.cli doctor
.venv/bin/python -m workbench.cli chat "创建 Python 脚本，计算 1 到 100 的和，执行后写入 output/result.txt"
.venv/bin/python -m workbench.cli chat --session 上次的ID "改成 1 到 1000 并重新执行"
```

SDK CLI 的 `DSH_MODEL`、`DSH_PROFILE`、`DSH_PATCHES` 与 Web 的官方模型/配置管理独立。旧 `workbench.api` 仅保留兼容接口，不再提供网页，也不承载官方 Web 协议。

## 二次开发

| 位置 | 用途 |
|---|---|
| `package.json` / `package-lock.json` | 固定官方完整 Web 发行版与依赖 |
| `workbench/official_web.py` | 官方启动、工作区 bootstrap、Nginx、进程回收 |
| `workbench/cli.py` | Web 与 Python SDK 启动入口 |
| `workbench/runtime.py` | 保留的 Python SDK 适配 |
| `Dockerfile` / `compose.yaml` | 单用户容器执行与数据持久化 |
| `vendor/official-sdk/` | Python SDK 原始 wheel、许可证与哈希 |

Web 扩展优先使用官方 Plugins / profile patch，而不是重写流式、文件面板或模型设置。`DSH_WEB_PATCHES` 接受 patch 文件列表（Linux/macOS 用 `:`，Windows 用 `;`），在本仓库工作区 patch 后加载。`DSH_WEB_DIR` 可指向安装了上述固定版本的其他目录。

上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。如果要改官方组件源码，需基于上游源码构建自己的发行包，再有明确版本控制地接入；本次没有改动上游内部实现。

## 验证

```bash
python -m pytest -q
npm ci
npx playwright install chromium
node scripts/web-smoke.cjs
# 安装 Nginx 后验证容器入口相同的代理模式
node scripts/web-smoke.cjs --proxy
```

浏览器验收调用本地可控模型夹具，检查真实官方服务的 SSE → 工具执行 → WebSocket → 文件预览链路，不消耗真实模型额度。它不证明模型推理质量；真实 API Key 的联网任务需在部署环境验收。详细结果见 [docs/VALIDATION.md](docs/VALIDATION.md)。

下一阶段在官方协议之上接 Ezprober 身份、受控工具和会话沙箱，再处理 iframe 的 frame-ancestors、Cookie、可信来源与 postMessage；当前没有放开嵌入限制。
