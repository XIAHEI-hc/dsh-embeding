# Local private runner material

This directory is intentionally ignored because it contains generated secrets and
user-specific runtime identities. Generate it on a deployment host with:

```sh
node scripts/bootstrap-private-runtime.mjs
```

The script creates separate A/B runner env files, `DSH_HOME` paths, workspace and
embed configs, a runtime registry, and random service/scope secrets. Replace the
development defaults with the real Memory Lab user IDs and service origin before
running the two-user acceptance cases.

The generated `runtime-secrets.json` is the Memory Lab control-plane mapping for
`AI_TOOL_RUNTIME_SECRETS_JSON`; inject its JSON contents into the Memory Lab
backend environment through the deployment secret manager. The runner credential
files must never be replaced with the shared `AI_TOOL_SERVICE_SECRET`.

For a real model deployment, give each runner its own read-only model secret
file and set `DEEPSEEK_API_KEY_FILE` in that runner's env file. The launcher
loads the value only into that runner's child DSH process; it is never exposed
through the iframe, workspace files, browser state, logs, or the gateway. Do
not put a shared model key in the checked-in env templates.

The gateway must also receive `MEMORYLAB_RUNTIME_VERIFY_ORIGIN`, pointing to the
private backend service (for example `http://memorylab-api:9000`). It uses the
runtime credential and exact `context_id/session_id/access_grant_id` from the
scope cookie to perform a live session-lease check before forwarding every
native HTTP or WebSocket request. After a WebSocket handshake it repeats that
check at `MEMORYLAB_RUNTIME_LIVE_CHECK_INTERVAL_MS` (default 5000 ms), and
closes both sides when the lease is no longer valid. If the backend is
unavailable or the grant is revoked, the gateway fails closed.
