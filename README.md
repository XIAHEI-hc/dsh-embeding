# DSH Workbench · 第一步：独立二次开发

基于官方 Python SDK 的独立工作台，可从命令行启动，也可启动独立网页。先验证“对话 → 文件操作 → 执行 → 继续修改 → 产物下载”，再接 Ezprober / iframe。

## 本版实际包含

- 官方 `deepseek-harness-sdk==0.1.5rc1` 原始 wheel，位于 `vendor/official-sdk/`，未修改 SDK 源码。安装时自动拉取同版本、对应操作系统的官方 runtime wheel。
- Python 核心适配器，调用真实 `DeepSeekHarness.run()`，生产路径没有模拟回答。
- CLI 单次任务、交互对话、会话续接、配置检查。
- FastAPI 独立网页：访问令牌登录、会话列表、任务提交、执行事件、历史结果。
- 上传文件、UTF-8 文本编辑、保存差异、产物列表及下载。网页上传/预览最大 10 MB；目录列表最多 1000 个文件。
- SQLite 保存会话、任务和事件；SDK 自己的日志和配置独立放在各会话 `dsh-home/`。
- Docker Compose 单用户容器运行；Linux/macOS 和 Windows 开发安装脚本。

**边界：本版是单用户独立工作台。一个服务只允许一个任务同时执行。会话目录分开，但不构成会话之间的安全隔离。Docker 为整个应用提供一个容器，不是“一会话一容器”的多用户沙箱平台。**

## 1. 安装

要求 Python 3.10+；SDK native runtime 的操作系统/架构支持由官方发布包决定。推荐 Linux x64 + Python 3.12。

Linux/macOS：

```bash
bash scripts/install.sh
cp .env.example .env
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
Copy-Item .env.example .env
```

也可以手工安装：

```bash
python -m venv .venv
# Linux/macOS
. .venv/bin/activate
# Windows: .venv/Scripts/Activate.ps1
python -m pip install -c constraints.txt --pre "vendor/official-sdk/deepseek_harness_sdk-0.1.5rc1-py3-none-any.whl" ".[dev]"
```

如果公司镜像没有 SDK，需使用能够访问官方 PyPI 的安装环境，或准备同版本 runtime wheel。仓库携带的 SDK wheel 本身不包含平台运行时，不能据此声称完全离线安装。

## 2. 配置

编辑 `.env`：

```dotenv
DEEPSEEK_API_KEY=你的模型API密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DSH_MODEL=deepseek-v4-flash
DSH_PROFILE=sdk
WORKBENCH_TOKEN=生成的工作台访问令牌
```

生成工作台令牌：

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

WORKBENCH_TOKEN 是访问本工作台的令牌，至少 24 字符；DEEPSEEK_API_KEY 是服务端调用模型的凭据。页面不填写模型密钥。网页令牌仅存当前浏览器标签页 sessionStorage，API 请求通过 Authorization Header 携带。

```bash
python -m workbench.cli doctor
```

doctor 只检查安装和配置，不验证模型连通性；真正调用模型请用下一节命令。

## 3. 单独运行 SDK / 命令行

```bash
python -m workbench.cli chat "在 scripts/ 下创建一个 Python 脚本，计算 1 到 100 的和，执行后把结果写入 output/result.txt"
```

终端会显示会话 ID 和实际工作目录。继续同一会话：

```bash
python -m workbench.cli chat --session 上次打印的会话ID "把范围改成 1 到 1000，修改脚本并重新执行"
```

交互模式：

```bash
python -m workbench.cli chat
# 输入任务；输入 /exit 退出
python -m workbench.cli sessions
```

CLI 和网页使用相同的数据目录。请不要同时运行 CLI 任务和网页任务，或启动多个后端进程；本版锁在单进程内，不提供跨进程任务调度。

## 4. 独立网页

```bash
python -m workbench.cli web --reload
```

访问 http://127.0.0.1:8765，输入 WORKBENCH_TOKEN，创建会话。

1. 上传 CSV，文件进入会话的 `input/`。
2. 输入：“读取 input/ 下的 CSV，统计每列缺失值并生成 output/report.md。”
3. 页面显示执行事件与最终回复，文件面板刷新产物。
4. 继续输入：“把报告补充一段结论，再生成一份汇总 CSV。”
5. 点击文件查看文本、编辑保存或下载。

`--reload` 用于 Python 代码开发自动重启；重启会中断当前任务。浏览器静态文件编辑后刷新页面即可。正式运行去掉 `--reload`。

事件展示保留官方通知结构，通过约 900 ms 增量轮询展示，不承诺逐 token 打字效果。已结束任务的历史可恢复；执行事件通过 API 可按游标重新读取。网页当前执行区最多显示最近 300 条，数据库保留完整已接收事件。

## 5. Docker 单独启动

```bash
docker compose up -d --build
docker compose logs -f workbench
```

默认只绑定宿主机 127.0.0.1:8765；修改 `.env` 中 WORKBENCH_PORT 可改变独立服务端口。数据保存在命名卷。

```bash
docker compose down
# 保留数据卷。不要使用 down -v，除非确定删除所有会话和文件。
```

容器镜像带 Python、bash、git，SDK/runtime 由 pip 安装，模型调用需出网。额外数据分析依赖请明确加入 Dockerfile/项目依赖并重建镜像。Docker 开发改代码需重建；自动 reload 使用上面的本地开发模式。

容器以普通用户运行、不挂宿主机 Docker socket，不能直接调度其他容器。本版文件路径检查保护文件 API，但模型工具可以访问整个运行环境；提示词中的工作目录约束也不构成隔离。宿主机运行应选择可修改的测试环境；需要容器边界时使用 Compose。本版没有生产多用户登录、角色授权或业务数据库回写。

## 6. 可继续开发的位置

| 位置 | 用途 |
|---|---|
| workbench/runtime.py | 官方 SDK 适配、模型路由、profile/patch 参数 |
| workbench/service.py | 会话执行、并发控制、文件操作 |
| workbench/store.py | SQLite 会话、任务和事件持久化 |
| workbench/api.py | 网页 API、访问令牌、独立页面 |
| workbench/static/ | 网页 UI 与事件显示 |
| workbench/cli.py | 单独启动与命令行对话 |
| vendor/official-sdk/ | 官方原始包、许可证、版本与哈希 |
| docs/ | API、架构、验证记录和后续阶段 |

通过 `.env` 的 DSH_PATCHES 配置官方 profile patch 文件（多个路径用系统路径分隔符：Linux/macOS `:`，Windows `;`）。自定义 profile 必须保留 SDK JSON-RPC 服务；不能用 `web` profile 替代 SDK profile。官方插件应安装到实际会话的 dsh-home 中。当前没有可视化 Skills 管理器，相关能力通过 profile/插件二次开发。

## 7. 测试与完整验收

```bash
python -m pytest -q
```

接口测试使用显式注入的测试运行时验证服务行为，不调用收费模型。生产 API 没有 mock 模式。真实 SDK 初始化检查和测试情况见 docs/VALIDATION.md。

模型验收需要真实凭据：创建/执行脚本 → 第二轮修改/执行 → 重启服务后继续相同会话 → 上传 CSV/分析 → 下载报告。必须同时检查最终文件及其内容，不能只看模型声称成功。

## 8. 下一阶段

先在你的机器上完成上述真实模型验收，再实现会话沙箱管理、停止/超时回收和多用户权限。最后加入 Ezprober 短期身份凭证、业务工具以及 iframe 通信。本版 CSP 明确禁止被其他页面嵌入，避免误认为已完成 iframe 接入。

停止任务不能仅中止网页轮询；目前本版没有停止按钮。SDK 当前没有单独的中途 prompt-cancel 方法。运行时请求设超时，最终调用 close 回收子进程；如果关闭失败，本服务停止接受新任务，须检查残留进程并重启。

## 9. Git 仓库

交付包包含仓库源码，以及记录初始提交的 `dsh-workbench.bundle`，可完整恢复 Git 仓库：

```bash
git clone dsh-workbench.bundle dsh-workbench
```

本次未创建 GitHub 在线仓库。创建私有空仓库后，可将这个本地仓库推送：

```bash
git remote add origin https://github.com/你的账号/dsh-workbench.git
git push -u origin main
```
