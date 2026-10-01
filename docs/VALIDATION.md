# 验证记录 · 2026-10-01

## 已完成

- 官方 Python SDK wheel SHA-256 与 PyPI metadata 一致。
- 实际安装 `deepseek-harness-sdk==0.1.5rc1` 和 Linux x64 `deepseek-harness-runtime-bin==0.1.5rc1`。
- 使用真实 SDK 启动真实官方运行时，执行 initialize 握手并关闭：PASS。此检查没有发送模型推理任务，使用测试占位凭据，不能证明 API Key、模型或出网推理可用。
- 应用 editable 安装成功；Python compileall、前端 node --check 成功。
- 9 项自动测试通过：鉴权、完整文件/API工作流与事件恢复、越界及符号链接拦截、并发与执行期写入拦截、失败脱敏与重试、缺密钥与服务重启恢复、非完成结果状态、真实 SDK 参数兼容、运行时关闭失败阻止重试。
- FastAPI 启动并正常响应；静态页面和实际 API 的无密钥错误反馈经过接口测试。

## 尚未完成

- 无真实模型 API Key，未执行收费推理；连续对话、AI 文件修改和脚本执行的完整验收需用户部署后完成。
- 环境没有 Docker，Compose build/up 未执行。
- Playwright 浏览器二进制缺失，尝试下载得到损坏的零字节压缩包，无法进行浏览器交互或截图验收。未将浏览器验证标记为通过。
- 未在 Windows/macOS 实际安装运行。

## 用户真实模型验收

1. 安装、配置 .env；doctor 确认 SDK/runtime 版本，网页令牌和模型密钥已配置。
2. CLI 让 AI 创建 scripts/sum.py、执行并写 output/result.txt；检查内容为 5050。
3. 相同会话继续改为 1..1000，检查结果为 500500。
4. 网页创建会话、上传 CSV；让 AI 生成报告与结果 CSV，检查真实文件。
5. 重启网页服务，继续相同会话，确认 SDK 恢复上下文。
6. 测试错误凭据、模型不可用、任务超时，不得把失败显示成 completed。
7. Docker 部署重复上述验证；确认关闭重开容器数据仍在。

接口测试的 FakeRuntime 仅位于 tests/，用于可重复验证，不是生产执行后端。
