# 验证记录（2026-10-04）

状态只使用 PASS、FAIL、NOT_RUN。固定版本为官方 DSH `0.2.0-rc.2`、上游 tag `dsh-v0.2.0-rc.2`、commit `639ed015397290b3745d163aafe02ffee4aa3f84`。

## 自动化与浏览器

| 状态 | 项目 | 结果 |
|---|---|---|
| PASS | 扩展单元测试 | 11 项通过：配置/PSL、public origin、grant 重放/过期/撤销、路径状态、稳定 ID、session mismatch、preview Agent block |
| PASS | 真实 iframe smoke | 官方 Host/plugin、workspace 注册、grant、origin 拒绝、精确 CSP、Cookie、一次兑换、重放/撤销/过期、官方会话导航、只填草稿、刷新不重兑 |
| PASS | Python 回归 | 在最终 Linux 镜像和精确 SDK/runtime 中 9 项通过，1.29 秒 |
| PASS | Docker 构建 | WSL2 Docker Engine 29.7.2、Compose 5.5.0；镜像构建和受控 fork/扩展 ESM import 通过 |
| PASS | 隔离容器 | UID/GID 10001、读写/只读 bind、ready 200、精确 frame-ancestors、无 XFO、no-store；未改动已有 Compose 服务 |
| PASS | 原官方 Web smoke | 真实 Chromium 下官方页面、SSE、工具、WebSocket、文件预览链路通过 |

iframe 截图：[初始化后的官方工作台](screenshots/embed-ready.png)。独立 Web 历史截图：[官方文件预览](screenshots/official-web.png)、[Nginx 模式](screenshots/official-web-proxy.png)。浏览器 smoke 使用本地可控模型夹具，不消耗真实模型额度。

Windows `.venv` 的 runtime wheel 下载曾两次停滞，因此该宿主路径没有作为 Python 通过依据；同一代码已在最终 Linux 镜像内用精确 SDK/runtime 完成 9 项回归。依赖解析同时发现 `starlette==1.7.0` 需要 `httpx2`，已固定为 `httpx2==2.13.1`。

## 安全与失败路径

| 状态 | 项目 | 结果 |
|---|---|---|
| PASS | 票据生命周期 | SQLite 原子消费；只持久化 SHA-256；重放、过期、撤销均被拒绝 |
| PASS | 父子边界 | 校验 parent origin、event source、channel、request；ticket 不进 URL |
| PASS | Cookie/CSP | HttpOnly、SameSite=Strict；HTTPS 配置启用 Secure；`/embed` 精确 frame-ancestors 且无冲突 XFO |
| PASS | 工作区策略 | 只注册已有 canonical 目录；边界、缺失、文件、权限、只读、I/O 和 session mismatch 显式失败 |
| PASS | 服务端守卫 | create、prompt 和 agent pre-step 都受策略约束；`preview_only` 不能执行 |
| PASS | 日志/URL审查 | 已验证 smoke 未在 URL 或应用日志输出 ticket、client secret、Cookie 或初始 prompt |

## 未运行与设计外项目

| 状态 | 项目 | 原因 |
|---|---|---|
| NOT_RUN | 真实付费模型/API | 自动化使用本地夹具；需部署方用自己的凭据验收网络和推理质量 |
| NOT_RUN | 真实 HTTPS 证书浏览器部署 | 已验证配置、Secure 开关和 header，未在公开证书域名做端到端浏览器验收 |
| NOT_RUN | 跨站点 iframe | 按设计不支持并由配置拒绝，不能用同站点结果冒充通过 |
| NOT_RUN | P1 `task.changed` / `artifact.created` | 本阶段未实现，消息 schema 不声明这些能力 |
| NOT_RUN | 多租户 ACL | 当前是可信共享账户，没有每用户全 HTTP/RPC/WebSocket 授权 |
| NOT_RUN | 每 session 沙箱 | 容器整体是执行边界，没有每 session 独立容器 |

## 可重复命令

```powershell
npm ci
npm run build:extensions
npm run test:extensions
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE='D:\Program Files (x86)\Playwright\browsers\chromium-1234\chrome-win64\chrome.exe'
$env:DSH_SCREENSHOT_DIR=(Resolve-Path 'docs/screenshots').Path
npm run test:embed
node scripts/web-smoke.cjs
docker compose config --quiet
docker compose build workbench
```

镜像内 Python 回归：

```powershell
docker run --rm --entrypoint sh `
  -e PYTHONDONTWRITEBYTECODE=1 `
  -v /mnt/d/Vibe_coding/dsh-workbench:/src:ro `
  dsh-workbench-workbench:latest `
  -c 'pip install --disable-pip-version-check --no-input -q pytest httpx2 && cd /src && python -m pytest -q -p no:cacheprovider'
```

本报告不把夹具结果解释为真实模型质量，也不把目录白名单解释为 bash 沙箱。
