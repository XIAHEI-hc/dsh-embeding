# API

所有 `/api/*` 请求需要 `Authorization: Bearer <WORKBENCH_TOKEN>`。

| 方法 | 路径 | 输入 / 用途 |
|---|---|---|
| GET | /api/health | SDK 版本、凭据是否配置、当前任务 |
| GET | /api/sessions | 会话列表 |
| POST | /api/sessions | JSON: title，返回 id |
| GET | /api/sessions/{sid}/runs | 历史任务与结果 |
| POST | /api/sessions/{sid}/runs | JSON: prompt，返回任务 id |
| GET | /api/runs/{rid} | state、response、reason |
| GET | /api/runs/{rid}/events?after=0 | 事件游标分页，一页最多 200 条 |
| GET | /api/sessions/{sid}/files | 工作目录文件列表 |
| POST | /api/sessions/{sid}/files | multipart: file，保存到 input/ |
| PUT | /api/sessions/{sid}/files | JSON: path,text，保存并返回 unified diff |
| GET | /api/sessions/{sid}/file?path=... | UTF-8 文本 |
| GET | /api/sessions/{sid}/download?path=... | 文件下载 |

任务状态：running / completed / incomplete / failed / interrupted。只有 SDK finish_reason=completed 才标 completed。完成态表示 agent 自报告执行结束，不替代对产物的业务验证。

没有流式重连副作用：页面重新读取事件不会重新提交任务。客户端应把“发送任务”和“订阅状态”分开；POST 本版没有 idempotency key，不要自动重试任务提交。
