# v0.2 架构

浏览器直接使用 npm 官方发行包内的前端和服务端。Python `official_web.py` 只启动官方 `--profile web`、指定 DSH_HOME、配置可持久化的默认工作区，并回收子进程。

本地：浏览器 → 官方 DSH Web（127.0.0.1）。
容器：浏览器 → Nginx → 官方 DSH Web（容器回环）。Nginx 保留 Host/Origin/Cookie，支持 WebSocket，不缓冲流式数据。

完整会话事件、工具审批、流式显示、文件呈现、模型凭据、插件及工作区由上游负责。Python SDK CLI 和旧兼容 API 使用原有 adapter/store，与官方 Web 的存储和协议独立。

容器整体是当前执行隔离边界。未来在官方扩展点上加入业务工具与更细粒度沙箱，不重新实现官方 UI。
