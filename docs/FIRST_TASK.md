# 官方 Web 首次验收

启动 `python -m workbench.cli web`，用日志中的 token 地址登录，在 Settings → Models 填凭据。

1. 创建会话，要求生成并执行脚本，将结果写入 `output/result.txt`。
2. 查看 Trajectory，检查真实工具执行记录和最终文件。
3. 第二轮修改脚本并执行，确认文件内容改变。
4. 用官方文件展示打开产物；上传 CSV 并生成报告。
5. 重启服务后恢复会话，确认工作区文件和模型设置保留。

浏览器夹具验收见 README；真实模型验收需要部署环境凭据。旧 SDK 会话继续通过 CLI 读取。
