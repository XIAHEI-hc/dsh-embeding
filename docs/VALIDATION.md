# v0.2 验证记录 · 2026-10-02

## 已完成

- 固定安装完整 `@deepseek-ai/dsh@0.2.0-rc.2` 官方 npm 发行包及锁定依赖；官方包未修改。
- Python SDK / runtime `0.1.5rc1` 保留；原 9 项 Python 回归测试全部通过，compileall 与 git diff --check 通过。
- 实际 Chromium 浏览器验收，运行真实官方 Web 服务，不使用替代前端：
  - 首次 Preview 提示、官方 token → Cookie 登录，地址栏清除 token。
  - Settings 中主题、字体、Coding View，以及模型 API Key / Base URL 保存。
  - 第三方模型提供商与 Custom model API 入口存在。
  - 本地模型 SSE 夹具逐段输出，页面在最终片段到达前已展示首段，排除整段缓冲。
  - 官方 bash 工具实际执行，生成 `output/report.md`，检查磁盘文件内容。
  - 官方模型循环收到成功的 tool_result；点击回复中的文件链接，右侧 Markdown 预览展示真实文件内容。
  - 官方 WebSocket 收到事件；刷新页面后会话和文件链接保留；没有 pageerror。
- 上述完整浏览器链路在本地直连和 Nginx 代理模式均通过；代理保持 Host/Origin，禁用缓冲。Nginx 的全部临时目录改为可写临时路径。
- 截图：[官方文件预览](screenshots/official-web.png)、[Nginx 模式](screenshots/official-web-proxy.png)。

可重复命令见 README。`scripts/web-smoke.cjs` 内的模型夹具只供测试，生产仍直接运行官方服务、使用用户配置的真实模型。

## 尚未完成

- 本轮未使用用户真实模型凭据；夹具验证协议、流式和真实工具执行，不证明模型推理质量或公网模型可用性。
- 当前执行环境没有 Docker，未执行实际镜像 build / Compose up。已单独运行容器入口相同的 Nginx + 官方服务验证，仍需部署环境完成镜像验收。
- Windows / macOS 未实际运行；iframe、Ezprober 身份集成、每会话独立沙箱尚未实现。

## 历史验证

前版已核对官方 Python wheel 哈希、真实 SDK initialize/close；用户此前在容器真实模型任务中验证了脚本执行生成 5050，因此保留其 `danger-full-access` 配置。

Python runtime `0.1.5rc1` 的直接 Web 启动缺少 session-title 插件依赖。本版使用 npm 完整 Web 发行包，Python SDK 专供原 CLI，两者配置和会话存储独立。
