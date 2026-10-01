# 第一步架构与后续接入

CLI / 浏览器 → Workbench service → OfficialRuntime → 官方 Python SDK → dsh --profile sdk → 模型及工具。

官方 SDK 是外部依赖，不复制重写 SDK 内部代码。生产任务都调用同一个适配器。SDK/runtime 精确配对为 0.1.5rc1。每轮创建运行时并在结束时关闭；相同会话沿用会话 ID、workspace 和 dsh-home，通过官方日志恢复上下文。

数据结构：

```
data/
  workbench.sqlite3
  sessions/<id>/
    workspace/
      input/
      output/
      scripts/
    dsh-home/
      profiles/
      sessions/
```

网页 API 的单进程互斥锁避免一会话同时运行两轮，也避免执行时覆盖文件。当前服务只允许一个任务同时执行。SQLite 与 SDK 持久化有不同职责：SQLite 服务网页历史，SDK 日志服务模型续接。服务重启将 unfinished runs 标记为 interrupted，不自动重复执行副作用任务。

API 不将服务端模型凭据返回给页面。任务错误、通知中的已知密钥作脱敏。用户自上传文件并不主动脱敏；文件下载仍需访问令牌。事件/API/页面是同源，不开启跨域。内容使用 DOM textContent，模型文本不直接作为 HTML 渲染。

容器模式隔离整个应用。会话目录、dsh-home、API Token 不构成多租户边界，当前 AI 不应被授予生产机台、生产数据库或宿主机路径。后续的一会话一容器需要把官方 SDK 与 DSH 都放到对应执行容器，由主服务通过内部接口调度。

下一阶段顺序：

1. 完成真实模型回归，确定当前 profile 的文件/命令执行能力；展示事件进一步转换为工具卡片。
2. 会话容器调度、资源限制、租期回收、可验证停止、产物校验；管理服务不让模型直接操作其状态库。
3. 用户登录、项目 RBAC、审计、业务工具；Ezprober 的数据库修改走授权 API。
4. iframe 页面与宿主协议：短期票据换会话、Origin 白名单、明确的 postMessage origin/source 校验、产物完成通知；届时调整 CSP frame-ancestors。

不将官方 SDK 当作浏览器组件 SDK。前端 iframe bridge 是本项目下一阶段的独立工作。
