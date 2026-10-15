# Memory Lab Skills / DSH DevPack 现场验收记录

更新时间：2026-10-15（本机 WSL2 Docker）

本记录只使用当前两个真实仓库、真实容器和可复现命令的结果。DevPack 的
`reference/`、`prototype/`、旧的 `acceptance/check-results.json` 不作为通过证据。

## 已确认 PASS

| 范围 | 证据 |
|---|---|
| DSH 扩展回归 | `npm run test:extensions`：55/55 通过；包含 live Memory Lab session lease verify、返回 scope 精确匹配检查、撤销 lease 的 `CONTEXT_REVOKED` 映射、页面上下文 enrichment、延迟 provider 注册、fork rollback、重启后 active binding 扫描、usage outbox 重启恢复/稳定 event id 与 `occurred_at` 指纹、以及 canonical skill identity mismatch 拒绝。 |
| Memory Lab 后端回归 | `PYTHONPATH=backend; python -m pytest -q backend/tests`：76/76 通过；覆盖 immutable page snapshot、native prompt 幂等、BF MATCH/FAIL、CHN section_detail 半开区间、trusted shared service auth、stale ACK projection、fork runtime subject 隔离、缺失 session grant 的 fail-closed 路径、terminal-before-loaded 的终态栅栏和 context/login revoke 后 terminal usage；Windows 退出清理阶段的 SQLite `WinError 32` 不影响 pytest 返回码 0。 |
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
| static asset declaration boundary | 上传校验现在要求 `assets/` 下每一个文件都必须在 manifest 的 `assets` 数组中声明，避免 archive hash 覆盖了 manifest 未授权的静态内容；backend contract 测试覆盖，并已重建运行中的 Memory Lab backend。 |
| canonical remote skill identity | resolve 响应现在返回并校验不可变 `runtime_name`、activation/version/generation 与 archive hash；Provider 不再接受只凭 locator 伪造名称的 native get，A/B runner 镜像已重建并重启。 |
| ACK replay semantics | 同一 `ack_id` 的重试忽略新的 transport `request_id` 并幂等返回；改变 generation/hash/status/provider revision 仍产生冲突，新增协议测试覆盖。 |
| stale ACK error semantics | Memory Lab runtime bridge 对旧 generation/version 的 ACK 返回 `409 ACK_STALE`；resolve/admit 仍保留 `SKILL_VERSION_CHANGED`。真实 runner-a 请求在 activation generation=7 下使用 generation=6，得到 `409 ACK_STALE`。 |
| stale ACK projection fence | activation 切换版本或 generation 后，旧 runtime state 的 `installed` 不再出现在 native catalog；只有 generation、version_id、archive hash 全部匹配的新 ACK 才会重新暴露为 installed。 |
| scoped runtime credential fence | `AI_DSH_REQUIRE_SCOPED_RUNTIME=true` 时，全局 control secret 不再能用于带 runtime ID 的 runtime data-plane 请求；只有对应 runner credential 能通过，真实 runner-a catalog 仍返回 200。 |
| queued skill terminal fact | queued `/ml-*` 在切版、停用、revoke、旧 locator 被新 catalog 替换或正文加载失败时，会消费对应 admission queue 并写 `failed`/`cancelled` usage 终态，不再遗留 `admitted`。 |
| terminal usage after revoke | 已准入 receipt 在 context、login grant 或权限撤销后仍可通过窄权限路径写入 `completed`/`failed`/`cancelled`；目录、resolve、admit 仍拒绝；同 `event_id` 改变 occurred_at/error_code/turn_ref 会返回 `IDEMPOTENCY_CONFLICT`。 |
| usage outbox recovery | DSH integration SQLite 持久化脱敏 usage payload；broker 暂时失败时保留 pending、递增 attempts，重启后用相同 `event_id` 与固定 `occurred_at` 重试；真实 runner/backend 故障实验最终在 Memory Lab 写入 `acceptance-outbox-recovery-20261015-v2` 的 `completed` event，并确认 runner outbox 删除。 |
| latest deployment | 通过 WSL2 Ubuntu Docker 重建并强制重启 `dsh-gateway`、`dsh-user-a`、`dsh-user-b`；三者 healthy/running，A/B 仍分别挂载 `dsh-workbench_user-a-data` 与 `dsh-workbench_user-b-data`，未执行 `down -v`。Memory Lab backend/frontend 亦已重建/运行。 |
| 跨 runtime 拒绝 | B 使用 A 的 context/session/grant 重放 catalog、resolve、admit、usage、ack 均得到 `403 SCOPE_DENIED`。 |
| live revoke | logout 前旧 scope cookie 访问带 channel 的 embed 为 200；logout 后同一 cookie 为 403。无 scope cookie 的 embed/API 请求为 401。 |
| 同浏览器换用户 | Memory Lab logout 清除 `dsh.embed.pending.v1` sessionStorage；下一用户不会继承上一用户的 iframe handoff，HttpOnly scope cookie 由新 bootstrap 替换；同一 native session 的 active binding 不允许原地替换 access grant。 |
| CHN 权限边界 | runtime bridge 现在额外要求 `chn_vis:use`；即使拥有 `ai_workbench:use`，没有 CHN 权限的用户也不能 query/upload。新增测试覆盖。 |
| WebSocket live fence | gateway 在升级成功后按 live-check interval 重新验证 Memory Lab lease，失效时销毁浏览器与 runner 两端 socket。 |
| WebSocket gateway handshake | 现场原始握手曾返回 `101` 但遗漏 `Connection: Upgrade`，浏览器因此反复断线；修复转发头后，真实网关握手返回 `101`、`Upgrade: websocket`、`Connection: Upgrade`，Node WebSocket 客户端保持连接并通过 6 秒 live-check。 |
| runner workspace seed | runner 空数据卷首次启动从只读 `/seed` 初始化 `/data/workdir`；已有用户文件时不覆盖。`tests/test_runtime_roles.py` 5/5 通过，并在 A/B 容器实际看到 `seed_runtime_probe.py` 与 `bf-screenshots/*`。 |
| per-runner model credential path | 官方 Web 启动层支持 `DEEPSEEK_API_KEY_FILE`，bootstrap 为 A/B env 生成了不同的 `/private/runner-a-deepseek-api-key` 与 `/private/runner-b-deepseek-api-key` 路径；部署已将用户提供的 key 写入两个 deployment-local 文件，仅注入对应 runner 子进程，不进入 iframe、workspace、URL、日志或 gateway。`tests/test_runtime_roles.py` 8/8 通过。由于当前只提供一枚 key，两个文件的凭据值相同；这证明了文件和进程隔离，但不证明两个供应商凭据值独立。真实模型 turn 仍需完成端到端 usage/CHN 证据。 |
| fork pre-persistence admission | 官方 session-controller fork 在生成 child ID 后、`agents.create()` 前触发 `api-session/fork-admission`；DSH 先调用 Memory Lab 的 service-auth runtime association endpoint，以 parent 的 live lease/context/runtime 预绑定 child，再写本地 binding；native fork 持久化失败时通过 `api-session/fork-failed` 在两端精确清理未物化 binding。 |
| 后台 runtime synchronizer | DSH extension 启动时立即扫描持久化的 active binding，并每 30 秒重试 `catalog → resolve → ack`；按 session 去重、dispose 时取消请求。A/B runner 镜像已在真实 private compose 中重建并重启，启动日志无 activation error。首次暴露出的 `/catalog` 路径和 demo package path 问题已修复；真实请求随后完成 `catalog → resolve → ack`，两个启用版本均变为 `installed`。 |
| agent Skill 注入边界 | 现场会话创建曾因在 agent 子上下文直接读取未注入的 `agent.ctx.skills` 而失败；现改为 `agent.ctx.inject(['skills'], ...)` 后再注册 per-session provider，并已重建 A/B runner。新标签页可看到官方工作区会话树和已启用输入框，runner 日志不再出现 `cannot get property "skills" without inject`。 |

## 实现对应关系

- 每个 runner 有独立 `DSH_HOME`、workspace、workdir、attachments、session/history、skill cache 和 credential 文件；gateway 按 runtime registry 做 subject 路由。
- Memory Lab admission receipt 固定 user、runtime、context、session、grant、activation、version、generation、archive hash 和 invocation；usage 只允许 `loaded`、`completed`、`failed`、`cancelled` 的合法状态迁移。
- gateway 在每次 native HTTP/WS 转发前调用 Memory Lab 的 session verify；撤销、登出、权限版本变化和 runtime subject 不匹配会 fail closed。
- `agent/pre-step` 会把实际固定版本注册回官方 native `agent.ctx.skills`，并消费当前 session 的 exact receipt；provider 只做 remote get 不能伪造 loaded。
- attachment tool 支持 opaque `attachment_id`，并将路径解析限制在当前 runner 的私有 attachment root。
- Skill 上传链路使用 multipart ZIP、hash 和 immutable version；审核要求非作者，public listing 不泄露 private/draft 版本。

## 2026-10-15 local A/B login and runtime evidence

The development environment was switched from the single `AUTH_MODE=mock`
identity to `AUTH_MODE=local` using the deployment-managed `.env` backup
`.dsh-tmp/env.before-ab-local`. The protected Memory Lab acceptance bootstrap
created two server-side users:

| principal | user id | runtime |
|---|---|---|
| `admin` / Acceptance-A | `508f95e0-bf76-4c2b-994d-cc0443039393` | `runner-a` |
| `acceptance_b` / Acceptance-B | `6d16b6b5-3d30-4536-9f63-abb713fb9551` | `runner-b` |

Observed with real HTTP sessions after rebuilding both compose projects:

- each password login returned a different `ml_session` and `ml_csrf` cookie;
- each `/api/ai/bootstrap` returned a different context, session and access grant;
- `GET /scope/redeem` produced a signed scope cookie whose server-decoded
  runtime was `runner-a` for A and `runner-b` for B;
- both scoped native roots returned HTTP 200 through the gateway;
- the runtime registry subjects exactly matched the database user IDs;
- no placeholder subject is accepted by `scripts/bootstrap-private-runtime.mjs`.

The Memory Lab API also returned A's private `runtime-probe-35a513fa79` skill to
A and HTTP 404 to B, while B's own activation projection was an empty list.
That verifies the server-side owner filter rather than a frontend-only list
filter.

The local Chromium browser also completed both real local login flows. The A
workbench rendered the official DSH iframe under `Acceptance-A`; a separate
browser tab rendered a different session tree and the official DSH iframe under
`Acceptance-B`. The B tab did not inherit A's Memory Lab identity or browser
scope. The current runner deployment has non-empty model credential files, but
this record contains no captured model request, model response, admission, or
terminal usage evidence, so the browser evidence intentionally stops before a
turn is counted as L4.

This is stronger than the previous single mock-principal smoke, but it is still
an HTTP/runtime isolation check. It does not by itself prove the browser's full
cross-user RPC/WS/file/fork matrix or a real model turn.

## 尚需现场条件，暂记 BLOCKED / NOT_RUN

以下项目需要真实 Chromium 双浏览器操作、真实模型和/或专门的恢复实验，当前没有把设计预期写成 PASS：

- ISO-09 至 ISO-12 的完整 create/fork、浏览器切换、旧 cookie 和生命周期矩阵。
- ISO-13 WS 已连接时撤销/禁用的浏览器实测。
- 浏览器现场尝试：修复网关 WebSocket 握手头并注入 agent `skills` 后，真实 Chromium 已加载官方 DSH iframe；在 slash 输入触发后，官方原生技能菜单实际列出了固定 runtime names `ml-knowledge-cleanup-assistant-v0-9-0-h03c69c545e6c` 与 `ml-runtime-probe-35a513fa79-v1-0-0-hd613cd823c98`，说明 `skills/list` 已从当前 live agent scope 返回 Memory Lab catalog。关闭官方模型配置遮罩后，A 用户的真实 DSH runtime 已挂载模型 secret 文件，输入框可提交普通真实模型探针；本轮现场没有获得模型消息、admission、固定 `SKILL.md` load、`loaded`/terminal usage 或 CHN tool-call 记录，因此仍不计入完整浏览器 PASS。此前的 `WORKSPACE_NOT_FOUND` 和 `skills without inject` 均已定位并修复。
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

## 2026-10-15 Page Assistant 增量证据

本轮在两个真实工作树上继续落地 DevPack 的页面上下文 S0。DSH 侧完成并验证：

- 官方 `api-session/prompt-enrichment` seam 保留原生消息、附件、流式、Stop、queue、steer 和会话恢复。
- 每条 native prompt 固定 `native_prompt_id`，并通过 `dsh.page/1.0` 请求当前 `snapshot_id` 与 digest。
- Host 通过 Memory Lab internal endpoint 重新读取 canonical snapshot，重新计算 SHA-256，digest 或 session/surface/grant/runtime 不匹配时 fail closed。
- 官方 client session 绑定使用 `ctx.sessions.binding(sessionId)?.session`；embed smoke 曾捕获旧接口回归，修复后 smoke 通过。

Memory Lab 侧完成并验证：

- snapshot 只由正式 BF/CHN loader、view 和 preview 事实生成；loading/error 状态不生成 snapshot。
- BF FAIL 单文件来源、CHN `section_detail` 的 `row_min` 包含 / `row_max` 不包含、revision mismatch、snapshot retention、native prompt 幂等均有后端测试。
- `PageAssistant` 在 surface/session/context 变化时取消旧异步请求，旧响应不会回发到新 iframe；bridge 额外校验消息 session 一致性。
- 前端 `npm run typecheck` 和 `npm run build` 均通过，Vite dev 容器通过 HMR 加载最新文件。

当前运行证据：

- `GET http://127.0.0.1:8766/embed/health/ready`：200。
- `GET http://127.0.0.1:9000/api/platform/health`：200。
- embed capability 包含 `page_context_v1` 与 `compact_chat_v1`。
- `runner-a`、`runner-b` 的模型 key 文件路径均存在且非空；只验证存在性，不读取密钥内容。
- `npm run test:embed`：通过，覆盖官方 workspace、一次性 ticket、cookie、iframe 协议、connection、draft-only prompt 和同 session reload。

以下仍明确标记为未测/受阻：真实登录后的 BF/CHN 逐页 L4、真实 provider input 与模型回答三段证据、真实模型 Skill load/usage、以及需要真实浏览器会话的跨标签/queue/steer/Stop/恢复矩阵。当前数据库中的既有 `admin` 密码与 `.env` 配置不匹配；未重置、创建或绕过认证账号。

## 2026-10-15 continuation: live A/B, attachment, and Skill lifecycle evidence

The previous single-user note above is retained as historical context. The
current deployment was rechecked with the real local A/B accounts and the
private runner compose after the runtime bridge changes.

- A is `admin` (`508f95e0-bf76-4c2b-994d-cc0443039393`) on `runner-a`; B is
  `acceptance_b` (`6d16b6b5-3d30-4536-9f63-abb713fb9551`) on `runner-b`.
- A and B login/bootstrap returned `200` with different contexts, sessions and
  grants. A's activation projection contained one Skill; B's contained zero.
- B attempting to associate A's context/session returned `409`
  `SESSION_CONTEXT_MISMATCH`. A gateway request without a scope cookie returned
  `401`; both one-time scope redeems returned `303`.
- The live reversible Skill probe disabled A's activation, observed
  `resolve=409 SKILL_NOT_ENABLED`, re-enabled the same fixed version, ACKed the
  new generation, and observed `resolve=200`. The final runtime state was
  `synced`, `effective_enabled=true`, `ack_status=installed`.
- The A/B bootstrap script now preserves an existing ADMIN role. Re-running it
  no longer silently removes `skills:use` from an administrator.
- DSH attachment upload now requires a canonical `sha256:` file reference in
  the current session event/pending-submission set, resolves the official
  content-addressed path, verifies the bytes and digest, and uploads that same
  verified byte buffer. A guessed ID, another session's ID, an outside path, or
  a changed file is rejected.
- Current regression evidence: DSH extensions `52 passed`; Memory Lab backend
  `71 passed` with the existing Windows SQLite cleanup warning.

These results add evidence for ISO-01/02/04/06/07/15 and SKL-07/SKL-15/SKL-16,
but do not mark the remaining browser WebSocket, fork-rollback, and full
version-switch matrix as complete. Those cases still require their
corresponding live evidence.

## 2026-10-15 continuation: real usage outbox failure and drain

The DSH durable usage payload now persists `occurredAt` at the moment the
event is first created. A retry therefore reuses the complete Memory Lab
idempotency fingerprint instead of generating a new timestamp during drain.
The regression suite includes a replay test for this invariant.

The live probe used a current A-user grant and a newly admitted receipt. The
Memory Lab backend was stopped, the event was inserted into runner-a's real
`probe-integration.sqlite3`, and runner-a was restarted. The event remained
pending and its `attempts` increased from `0` to `2`. After the backend was
started again, a runner restart drained the same event. The outbox query then
returned no row, and the Memory Lab database contained:

```text
event_id: acceptance-outbox-recovery-20261015-v2
phase:    completed
```

The experiment did not remove any volume or database. Temporary probe rows and
local helper files were removed after the observation.

## 2026-10-15 continuation: restart recovery probe

`scripts/acceptance_restart.py` performed a reversible live experiment using a
real A login and an existing scoped cookie. It restarted `runner-a`, the
gateway, and the Memory Lab backend one at a time, waiting for both the health
endpoint and a real scoped business request.

Observed result:

```text
before_root_status       200
before_catalog_status    200 (1 item)
after_runner_root_status 200
after_gateway_root_status 200
after_backend_root_status 200
after_catalog_status     200 (1 item)
after_activation_status  200
activation               synced / effective_enabled=true
gateway health           200
Memory Lab health        200
```

The first draft of the probe exposed a short-lived `502` after process start:
gateway health was ready before the runner target was ready. The probe now
waits for the scoped root itself, so the final result measures the real
user-scoped path rather than only a listener health check. No volume or
database was removed.

## 2026-10-15 continuation: live WebSocket revoke

The first WebSocket probe found that the private gateway container did not
receive `MEMORYLAB_RUNTIME_VERIFY_ORIGIN`; the old implementation treated a
missing verifier as success. That was a fail-open deployment defect. The
gateway now fails closed when the verifier is absent, the private env supplies
`http://memorylab-api:9000`, and the private compose template pins the host
port to the `8875` origin advertised by Memory Lab.

With the corrected deployment, a real A scoped WebSocket on
`/api/remote.mux` was opened, the owning Memory Lab login was logged out, and
the gateway closed the socket on its 5-second live check. The same old scope
cookie then received HTTP `403`:

```text
logout_status                    204
closed_after_logout              true
close_elapsed_seconds            5.13
scoped_http_after_logout_status  403
```

The native WebSocket close code was `1006` because the gateway destroys the
socket after the lease check fails; the security result is the close itself and
the subsequent `403` fence.
