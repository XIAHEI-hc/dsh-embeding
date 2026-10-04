# 父系统接入参考

parent-bridge.js 是框架无关示例，不是可直接运行的完整接入。需要父页面提供 iframe[data-dsh-frame] 与 [data-dsh-status]，并实现自己后端的 POST /api/ai/embed-grant。父后端使用 Bearer client secret 调用已实现的 DSH `POST /embed/control/grants`。

父后端先检查自己的登录、允许workspace，取server-only secret调用DSH。不得把secret回传；浏览器只收到短期ticket。避免代理接口让浏览器任意传parent_origin或host URL；从当前部署可信配置决定它们。

调用 startEmbedding(iframe, status, 'https://dsh.example.test', 'official-workspace-id')。重试先销毁旧 bridge 并重新申请。代码仅演示已实现的 P0 消息；生产应使用 contracts schema 完整校验、credentials 策略、日志脱敏、rate limit 与 scope。第一阶段是可信共享账户权限边界，不提供多租户 ACL。
