# Memory Lab Skills / DSH DevPack 现场验收记录

更新时间：2026-10-15（本机 WSL2 Docker）

本记录只使用当前两个真实仓库、真实容器和可复现命令的结果。DevPack 的
`reference/`、`prototype/`、旧的 `acceptance/check-results.json` 不作为通过证据。

## 已确认 PASS

| 范围 | 证据 |
|---|---|
| DSH 扩展回归 | `npm run test:extensions`：40/40 通过；包含 live Memory Lab lease verify 和延迟 provider 注册。 |
| Memory Lab 后端回归 | `PYTHONPATH=backend; python -m pytest -q backend/tests`：56/56 通过；Windows 退出清理阶段的 SQLite `WinError 32` 不影响 pytest 返回码 0。 |
| Memory Lab 前端 | `npm run typecheck`、`npm run build` 均通过（既有验收记录）。 |
| 协议契约 | DevPack `python acceptance/check_contracts.py`：6 个合法示例通过，2 个伪造 scope 被拒绝。脚本已显式使用 UTF-8，避免 Windows GBK 环境误报。 |
| 双 runtime 部署 | `docker ps` 显示 `dsh-user-a`、`dsh-user-b`、`dsh-gateway`、`private_mem_lab-backend` 正常运行；runtime registry 将 `runner-a`、`runner-b` 指向不同 subject、origin 和私有数据目录。 |
| 真实 runtime 链路 | A runtime 已现场完成 `/catalog`、`/resolve`、`/ack`、`/admit`、`usage loaded`、`usage completed`；数据库 receipt 为 `completed`，usage 有 `loaded` 与 `completed`。 |
| 跨 runtime 拒绝 | B 使用 A 的 context/session/grant 重放 catalog、resolve、admit、usage、ack 均得到 `403 SCOPE_DENIED`。 |
| live revoke | logout 前旧 scope cookie 访问带 channel 的 embed 为 200；logout 后同一 cookie 为 403。无 scope cookie 的 embed/API 请求为 401。 |
| CHN 权限边界 | runtime bridge 现在额外要求 `chn_vis:use`；即使拥有 `ai_workbench:use`，没有 CHN 权限的用户也不能 query/upload。新增测试覆盖。 |
| WebSocket live fence | gateway 在升级成功后按 live-check interval 重新验证 Memory Lab lease，失效时销毁浏览器与 runner 两端 socket。 |

## 实现对应关系

- 每个 runner 有独立 `DSH_HOME`、workspace、workdir、attachments、session/history、skill cache 和 credential 文件；gateway 按 runtime registry 做 subject 路由。
- Memory Lab admission receipt 固定 user、runtime、context、session、grant、activation、version、generation、archive hash 和 invocation；usage 只允许 `loaded`、`completed`、`failed`、`cancelled` 的合法状态迁移。
- gateway 在每次 native HTTP/WS 转发前调用 Memory Lab 的 session verify；撤销、登出、权限版本变化和 runtime subject 不匹配会 fail closed。
- `agent/pre-step` 会把实际固定版本注册回官方 native `agent.ctx.skills`，并消费当前 session 的 exact receipt；provider 只做 remote get 不能伪造 loaded。
- attachment tool 支持 opaque `attachment_id`，并将路径解析限制在当前 runner 的私有 attachment root。
- Skill 上传链路使用 multipart ZIP、hash 和 immutable version；审核要求非作者，public listing 不泄露 private/draft 版本。

## 尚需现场条件，暂记 BLOCKED / NOT_RUN

以下项目需要真实 Chromium 双浏览器操作、真实模型和/或专门的恢复实验，当前没有把设计预期写成 PASS：

- ISO-09 至 ISO-12 的完整 create/fork、浏览器切换、旧 cookie 和生命周期矩阵。
- ISO-13 WS 已连接时撤销/禁用的浏览器实测。
- SKL-05 真实模型收到指定 hash instruction 并完成 CHN 工具调用；当前已验证 receipt/usage 链路，未声称模型质量通过。
- SKL-09 至 SKL-17 的现场切版、断连缓存、排队停用、terminal usage 和多 `/ml-*` 提交矩阵。
- REC-01 gateway/runner 重启恢复、REG-01 独立 DSH 回归、PRO-03 单边升级/停机、OPS-01 回滚覆盖。

这些项目应在有真实 Chromium、模型凭据和可控重启窗口时逐项补充命令、脱敏日志或截图。

## 复现命令

```powershell
# DSH
cd D:\Vibe_coding\dsh-workbench
npm run test:extensions
docker ps
docker compose ls

# Memory Lab
cd D:\Vibe_coding\private_MEM_LAB
$env:PYTHONPATH = 'backend'
python -m pytest -q backend/tests
npm --prefix front run typecheck
npm --prefix front run build

# DevPack contracts
cd C:\Users\Administrator\Downloads\DSH_MemoryLab_Skills_DevPack_20261015\DSH_MemoryLab_Skills_DevPack_20261015
python acceptance/check_contracts.py
```

不要使用 `docker compose down -v`；验收和回滚必须保留用户卷、runtime registry、secret 和 `.dsh-tmp/`。
