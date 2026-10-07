# Memory Lab 业务集成

## 边界

本集成在完整官方 DSH Web 上增加 Memory Lab 用户上下文、不可变 `session -> context` 绑定和 CHN CSV 工具。原生会话、附件、流式输出、模型配置、侧栏和 fork/归档能力保持不变。Memory Lab 与 EzProber 必须使用不同 DSH 实例、端口、volume 和集成 SQLite；配置同时启用两种宿主集成会直接失败。

## DSH 配置

工作区配置必须把固定 alias 指向容器内真实 Memory Lab 仓库，使用 `read_write`，并将 `allowed_roots` 收紧到该目录。部署配置示例：

```dotenv
WORKBENCH_EMBED_ENABLED=true
WORKBENCH_WORKSPACE_CONFIG=/private/config/workspaces.json
WORKBENCH_EMBED_CONFIG=/private/config/embed.json
WORKBENCH_PUBLIC_URL=http://127.0.0.1:8766
PROBE_AI_INTEGRATION_ENABLED=false
MEMORYLAB_AI_INTEGRATION_ENABLED=true
MEMORYLAB_AI_DSH_INSTANCE_ID=memorylab-local-dsh
MEMORYLAB_AI_API_ORIGIN=http://memorylab-api:9000
MEMORYLAB_AI_PUBLIC_ORIGIN=http://127.0.0.1:7891
MEMORYLAB_AI_TOOL_SECRET=<至少 32 字节的随机值>
MEMORYLAB_AI_INTEGRATION_STATE=/data/memorylab-integration.sqlite3
MEMORYLAB_AI_TOOL_TIMEOUT_MS=120000
MEMORYLAB_AI_MAX_UPLOAD_BYTES=104857600
```

`embed.json` 的 client 只能允许 Memory Lab 的精确 parent origin 和固定 workspace alias。client secret 与 Memory Lab 的 `AI_DSH_CLIENT_SECRET` 相同；工具 secret 与 `AI_TOOL_SERVICE_SECRET` 相同。secret 不得进入浏览器、URL、日志或 Git。

## 工具

| 工具 | 作用 |
|---|---|
| `memorylab_upload_chn_csv` | 把当前 DSH 附件中的 CSV 提交给正式 CHN 异步导入链路 |
| `memorylab_get_import_job` | 查询任务进度、终态和错误信息 |
| `memorylab_list_datasets` | 列出绑定用户可访问的数据集 |
| `memorylab_get_dataset` | 读取数据集 Schema、行数和过滤字段 |
| `memorylab_analyze_dataset` | 调用正式分析逻辑生成按 bank 的事实摘要 |
| `memorylab_open_analysis` | 返回精确 `/tools/chn_vis/{dataset_id}` 页面 |

上传工具只允许 DSH 附件根目录中的普通非空 `.csv` 文件，并限制最大字节数。所有工具从真实 `exec.agent.session.header.id` 查询服务端绑定；模型不能覆盖身份、context 或 session。Memory Lab 后端再次验证 DSH instance、工具 secret、登录授权、权限版本和对象所有权。

## 验证

```powershell
npm run build:extensions
npm run test:extensions
docker compose -p dsh-memorylab -f compose.yaml -f <本机 override> up -d --build
docker logs --tail 100 memorylab-workbench
```

启动日志不能出现 `entry did not activate`。真实验收必须在 Memory Lab iframe 对话中上传测试 CSV，确认 Celery 任务成功、工具返回真实 dataset ID、链接打开对应分析页，并在刷新后恢复相同 session。固定模型桩不能替代这条真实模型和真实后端链路。

## 回滚与清理

先关闭 Memory Lab 的 AI 工作台开关，再关闭此 DSH 实例的 Memory Lab 集成并重启。保留 DSH volume、集成 SQLite、Memory Lab PostgreSQL/Redis/uploads 和用户会话。只清理构建缓存与临时测试文件；不要执行 `docker compose down -v`，也不要停止或删除 EzProber 的 8765 实例。
