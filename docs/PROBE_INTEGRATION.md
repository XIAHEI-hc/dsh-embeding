# EzProber 业务集成

## 边界

本集成在完整官方 DSH Web 上增加 EzProber 的不可变 `session -> context` 绑定和九个只读业务工具。
原生会话、侧栏、文件、工具、流式输出与设置保持不变。当前部署模型仅支持可信本地单用户和共享
DSH operator，不提供多用户历史隔离、恶意代码隔离或每会话容器。

功能默认关闭。普通独立 DSH Web 和既有 iframe API 不受影响。

## DSH 配置

工作区配置必须把固定 alias 指向 Host 可见的真实 Probe 仓库目录，使用 `read_write`，并让
`allowed_roots` 最小包含该目录。不得接受浏览器传入的 cwd，也不得在路径缺失时回退到 documents root。

```dotenv
WORKBENCH_EMBED_ENABLED=true
WORKBENCH_WORKSPACE_CONFIG=/private/config/workspaces.json
WORKBENCH_EMBED_CONFIG=/private/config/embed.json
WORKBENCH_PUBLIC_URL=http://127.0.0.1:8765
PROBE_AI_INTEGRATION_ENABLED=true
PROBE_AI_DSH_INSTANCE_ID=local-dsh
PROBE_AI_API_ORIGIN=http://127.0.0.1:9100
PROBE_AI_TOOL_SECRET_FILE=/private/config/probe_tool_secret
PROBE_AI_INTEGRATION_STATE=/private/state/probe-integration.sqlite3
PROBE_AI_VERIFY_TIMEOUT_MS=5000
PROBE_AI_TOOL_TIMEOUT_MS=10000
```

`embed.json` 中的 EzProber client 必须只允许平台的精确 parent origin 和固定 workspace alias。
client secret 与 Probe 的 `AI_DSH_CLIENT_SECRET(_FILE)` 相同；工具 secret 与
`AI_TOOL_SERVICE_SECRET(_FILE)` 相同。两类 secret 至少 32 字符，不能进入 URL、前端变量或 Git。

## Host-only API

以下接口只接受已配置 client 的 Bearer secret：

| 接口 | 作用 |
|---|---|
| `POST /embed/control/integration/prepare` | 幂等创建/恢复官方 session 并绑定 context |
| `POST /embed/control/integration/bind-session` | 绑定原生新建的空白 session |
| `GET /embed/control/integration/session-status` | 校验绑定、workspace、归档状态 |
| `POST /embed/control/integration/revoke` | 撤销 context 的业务数据访问 |

绑定保存在版本化 SQLite store。session 一旦绑定不能改到另一 context；工具执行从真实
`exec.agent.session.header.id` 查绑定，不接受模型提供 user、project、context、session 或 SQL。

## 生命周期

父页初始化 ticket 时恢复 Probe 记录的精确 session。官方侧栏切换会发送 `session.opened`；新建、
fork、归档、取消归档和删除会发送生命周期事件。父后端仍须调用 Host-only API 验证事件，浏览器消息
本身不构成授权。绑定完成前数据工具关闭失败。

## 验证

```powershell
npm ci
npm run build:extensions
npm run test:extensions
.\.venv\Scripts\python.exe -m pytest -q
```

真实联调还必须验证两种项目模式使用不同 session、刷新恢复、原生新建/切换/fork/归档/删除、
权限撤销、跨项目拒绝、真实数据库来源和连续追问。固定模型桩不能替代真实模型验收。

## 回滚与备份

先设置 Probe `AI_WORKBENCH_ENABLED=false` 和 DSH `PROBE_AI_INTEGRATION_ENABLED=false`，再重启对应
服务。保留 DSH 原生 session/store、`probe-integration.sqlite3` 和 Probe 的 AI 元数据表；常规回滚
不删除这些数据。备份需覆盖 `DSH_HOME`、集成 SQLite、Probe PostgreSQL 和允许目录中的分析产物。
不要执行 `docker compose down -v` 或删除工作区。
