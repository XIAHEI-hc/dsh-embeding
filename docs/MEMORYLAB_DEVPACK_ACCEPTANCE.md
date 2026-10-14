# Memory Lab Skills / DSH DevPack 现场验收记录

更新时间：2026-10-15（本机 WSL2 Docker）

本记录只使用当前两个真实仓库、真实容器和可复现命令的结果。DevPack 的
`reference/`、`prototype/`、旧的 `acceptance/check-results.json` 不作为通过证据。

## 已确认 PASS

| 范围 | 证据 |
|---|---|
| DSH 扩展回归 | `npm run test:extensions`：42/42 通过；包含 live Memory Lab lease verify、延迟 provider 注册、fork rollback 和重启后 active binding 扫描。 |
| Memory Lab 后端回归 | `PYTHONPATH=backend; python -m pytest -q backend/tests`：66/66 通过；覆盖 context/login revoke 后 terminal usage 以及同 `event_id` 的完整业务 payload replay 冲突；Windows 退出清理阶段的 SQLite `WinError 32` 不影响 pytest 返回码 0。 |
| Memory Lab 前端 | `npm run typecheck`、`npm run build` 均通过（既有验收记录）。 |
| 协议契约 | DevPack `python acceptance/check_contracts.py`：6 个合法示例通过，2 个伪造 scope 被拒绝。脚本已显式使用 UTF-8，避免 Windows GBK 环境误报。 |
| 双 runtime 部署 | `docker ps` 显示 `dsh-user-a`、`dsh-user-b`、`dsh-gateway`、`private_mem_lab-backend` 正常运行；runtime registry 将 `runner-a`、`runner-b` 指向不同 subject、origin 和私有数据目录。 |
| 真实 runtime 链路 | A runtime 已现场完成 `/catalog`、`/resolve`、`/ack`、`/admit`、`usage loaded`、`usage completed`；数据库 receipt 为 `completed`，usage 有 `loaded` 与 `completed`。 |
| 当前 overlay bootstrap | 使用主 compose 加 `deploy/compose.dsh-private.yaml` 重建 backend 后，真实 mock 用户 bootstrap 返回 `dsh_origin=http://localhost:8875`、既有 context/session、access grant 和 scope ticket；容器环境包含 `AI_TOOL_RUNTIME_SECRETS_JSON`、`AI_TOOL_RUNTIME_SUBJECTS_JSON` 及 `AI_DSH_CONTROL_ORIGIN=http://dsh-gateway:8765`。 |
| runner scope admission | gateway 转发时剥离浏览器 scope cookie，注入 runner credential HMAC proof；官方 Connection fork 仅在 runner role、精确 runtime ID 和 proof 全部匹配时接受 native `/`、RPC、WS 请求。 |
| native scoped bootstrap smoke | 真实 `localhost:7891` 登录后 bootstrap=200；scope redeem=303；gateway `/embed/bootstrap/redeem`=200；官方 native root=200，并同时收到 scoped 与 runner `dsh-auth-*` cookie。HTTP 转发回归断言 runtime/subject/context/session/grant/proof 全部注入。 |
| private compose 可复现 | 修正 `examples/deploy/compose.private-runners.yaml` 的 compose-relative env、secret、volume 和 build context 路径；从仓库根目录直接 `docker compose -f examples/deploy/compose.private-runners.yaml config --quiet` 通过。 |
| stale heartbeat fence | runtime `/catalog` 将超过 60 秒未 heartbeat 的历史 `installed` ACK 转为 `unreachable`，native provider 不再暴露陈旧技能；新增测试覆盖。 |
| runtime provider path and fixed package integrity | provider 已将 Memory Lab API origin 正确映射到 `/api/skills/runtime/v1`；demo seed 使用 content-addressed `approved/<archive_sha256>.zip`。真实 backend/runner 联调中，后台同步完成 `catalog → resolve → ack`，随后 catalog 对 `knowledge-cleanup-assistant` 与 `runtime-probe-35a513fa79` 均返回 `ack_status=installed`，resolve 均返回 200 和 instruction hash。 |
| Memory Lab UI runtime projection | 真实 `/api/skills/me/activations` 返回两个启用项 `sync_state=synced`、`effective_enabled=true`、`generation=1` 和最近 heartbeat；Skill 详情页启用后会轮询该 projection 显示 pending 到最终运行端状态。 |
| immutable demo seed repeatability | demo seed ZIP 使用固定元数据生成；连续执行两次均成功且 SkillVersion hash 保持不变，旧版本不会被原地改写。重启 backend 后 runtime catalog 仍返回 `installed`。 |
| instruction package execution boundary | 上传校验现在拒绝未声明顶层文件以及 `.sh/.py/.js/.mjs/.ts/.ps1/.bat/.cmd/.exe` 等脚本/可执行扩展，即使 ZIP 权限位没有标记 executable；新增 runtime contract 测试覆盖。 |
| ACK replay semantics | 同一 `ack_id` 的重试忽略新的 transport `request_id` 并幂等返回；改变 generation/hash/status/provider revision 仍产生冲突，新增协议测试覆盖。 |
| scoped runtime credential fence | `AI_DSH_REQUIRE_SCOPED_RUNTIME=true` 时，全局 control secret 不再能用于带 runtime ID 的 runtime data-plane 请求；只有对应 runner credential 能通过，真实 runner-a catalog 仍返回 200。 |
| queued skill terminal fact | queued `/ml-*` 在切版、停用、revoke 或正文加载失败时，会消费对应 admission queue 并写 `failed`/`cancelled` usage 终态，不再遗留 `admitted`。 |
| terminal usage after revoke | 已准入 receipt 在 context、login grant 或权限撤销后仍可通过窄权限路径写入 `completed`/`failed`/`cancelled`；目录、resolve、admit 仍拒绝；同 `event_id` 改变 occurred_at/error_code/turn_ref 会返回 `IDEMPOTENCY_CONFLICT`。 |
| 跨 runtime 拒绝 | B 使用 A 的 context/session/grant 重放 catalog、resolve、admit、usage、ack 均得到 `403 SCOPE_DENIED`。 |
| live revoke | logout 前旧 scope cookie 访问带 channel 的 embed 为 200；logout 后同一 cookie 为 403。无 scope cookie 的 embed/API 请求为 401。 |
| 同浏览器换用户 | Memory Lab logout 清除 `dsh.embed.pending.v1` sessionStorage；下一用户不会继承上一用户的 iframe handoff，HttpOnly scope cookie 由新 bootstrap 替换。 |
| CHN 权限边界 | runtime bridge 现在额外要求 `chn_vis:use`；即使拥有 `ai_workbench:use`，没有 CHN 权限的用户也不能 query/upload。新增测试覆盖。 |
| WebSocket live fence | gateway 在升级成功后按 live-check interval 重新验证 Memory Lab lease，失效时销毁浏览器与 runner 两端 socket。 |
| fork pre-persistence admission | 官方 session-controller fork 在生成 child ID 后、`agents.create()` 前触发 `api-session/fork-admission`；DSH 先调用 Memory Lab 的 service-auth runtime association endpoint，以 parent 的 live lease/context/runtime 预绑定 child，再写本地 binding；native fork 持久化失败时通过 `api-session/fork-failed` 在两端精确清理未物化 binding。 |
| 后台 runtime synchronizer | DSH extension 启动时立即扫描持久化的 active binding，并每 30 秒重试 `catalog → resolve → ack`；按 session 去重、dispose 时取消请求。A/B runner 镜像已在真实 private compose 中重建并重启，启动日志无 activation error。首次暴露出的 `/catalog` 路径和 demo package path 问题已修复；真实请求随后完成 `catalog → resolve → ack`，两个启用版本均变为 `installed`。 |

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
- 浏览器现场尝试：Memory Lab mock login/bootstrap 成功，gateway scope redeem 命令行返回 303/200；Codex IAB 对 `localhost:8875` 被客户端阻断，改为 `127.0.0.1:8875` 后 iframe 仍被 IAB 网络拒绝连接，原生 Chrome 自动化未完成，因此不计入浏览器 PASS。
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
