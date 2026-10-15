# Page context S0 evidence

日期：2026-10-15（Asia/Shanghai）

本仓库固定的 DSH session-controller fork 基于上游 `dsh-v0.2.0-rc.2`、commit
`639ed015397290b3745d163aafe02ffee4aa3f84`。源码入口为
`vendor/official-web-forks/dsh-api-session-controller/lib/index.js` 的
`SessionController.prompt()`。

## 已落地的扩展点

`prompt()` 在原始请求通过基础内容检查后复制 request 和 content parts，然后等待
`api-session/prompt-enrichment` waterfall。listener 可以在 clone 上异步替换
`content` 或附加 typed metadata。随后同一个 clone 进入原有
`api-session/prompt-admission`、附件 receipt 解析、`createUserMessage`、queue/steer
和流式 Agent 路径。

这证明页面数据可以在原生 prompt 真正落盘前进入请求管线；它没有修改原始 RPC 对象，
没有模拟 DOM 点击，也没有把 `initial_prompt` 当作上下文注入。原有附件顺序、
`requestId`/`rpcId` 和 queue/steer 路径继续由官方 controller 处理。

## 当前页面上下文处理

当请求包含 `pageContext` 且 `WORKBENCH_PAGE_CONTEXT_ENABLED=true` 时，扩展会：

1. 从当前 DSH session 的持久 binding 取得 page surface 和授权信息；
2. 向 Memory Lab server-only page-context endpoint 请求指定 snapshot；
3. 校验 session、surface、权限和 canonical JSON 的 SHA-256；
4. 将后端事实作为 `[PAGE_CONTEXT_DATA_V1]` 用户数据块追加到本次原生 content；
5. 再交给原有 admission 和附件流程。

snapshot 不存在、授权失效、surface 不匹配或 digest 不一致时请求失败，不降级成无上下文问题。

## 验证

- `npm run build:extensions`：通过。
- `npm run test:extensions`：48 项通过。
- `node --check vendor/official-web-forks/dsh-api-session-controller/lib/index.js`：通过。
- 真实 Memory Lab endpoint、真实模型 provider 和浏览器页面发送尚未联调；因此本记录是 DSH
  仓内 S0/L1 进展，不是产品 L4 完成证据。
