# 父系统后端授权伪代码

1. 校验父系统自身会话/CSRF，当前用户能使用该workspace。
2. 从配置查DSH origin、client ID、secret、允许parent origin；不要接受浏览器传入任意目标URL。
3. POST /embed/control/grants，Authorization Bearer 使用server-only client secret；body传官方workspace ID、审计subject、配置parent_origin，session可选。
4. 超时返回结构化错误；不盲目重试票据请求，requestId追踪。
5. 仅回传ticket/expires_at/protocol_version，Cache-Control:no-store；不要日志打印body。
6. DSH iframe消费票据；父系统撤销未消费ticket可调用revoke。撤销已消费ticket不代表官方会话已退出。

本文件是实现流程，不是正在运行的SDK。后端框架可用FastAPI/Go/Node，公共接口不得依赖Ezprober模型。
