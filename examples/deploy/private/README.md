# Local private runner material

This directory is intentionally ignored because it contains generated secrets and
user-specific runtime identities. Generate it on a deployment host only after
obtaining two authenticated Memory Lab user UUIDs:

```sh
MEMORYLAB_USER_A_ID=<uuid-from-memory-lab> \
MEMORYLAB_USER_B_ID=<different-uuid-from-memory-lab> \
node scripts/bootstrap-private-runtime.mjs
```

The script creates separate A/B runner env files, `DSH_HOME` paths, workspace and
embed configs, a runtime registry, and random service/scope secrets. The script
rejects missing or placeholder subjects. Registry subjects are server-issued
user IDs and must not come from browser fields or runner-generated values.

The script also generates `memorylab-runtime.env`, a deployment-local backend
env file containing the exact runtime-to-subject mapping, per-runner secrets,
independent client/gateway secrets, `SKILLS_RUNTIME_ENABLED=true`, and the live
verifier settings. Include that file as the backend `env_file` (or import its
values through the deployment secret manager). `runtime-secrets.json` remains
available as the machine-readable mapping for tooling. The runner credential
files must never be replaced with the shared `AI_TOOL_SERVICE_SECRET`.

For local A/B acceptance accounts, use a deployment-managed env file with
`AUTH_MODE=local`, then run
`backend/scripts/bootstrap_acceptance_users.py` inside the Memory Lab backend
with `ACCEPTANCE_BOOTSTRAP_CONFIRM=YES` and two distinct usernames/passwords.
The script returns server-created UUIDs without printing passwords and refuses
production and mock mode. Pass those UUIDs to the runtime bootstrap above.

For a real model deployment, give each runner its own read-only model secret
file and set `DEEPSEEK_API_KEY_FILE` in that runner's env file. The launcher
loads the value only into that runner's child DSH process; it is never exposed
through the iframe, workspace files, browser state, logs, or the gateway. Do
not put a shared model key in the checked-in env templates. The Memory Lab
backend `.env` must not contain `DEEPSEEK_API_KEY` at all: the backend is the
trusted control plane and only receives DSH runtime/control credentials from
the secret-managed runtime env. A model key belongs exclusively in the
matching runner's private key file.

The deployment-local `gateway.env` must also set:

```text
MEMORYLAB_RUNTIME_VERIFY_ORIGIN=http://memorylab-api:9000
MEMORYLAB_RUNTIME_VERIFY_TIMEOUT_MS=5000
MEMORYLAB_RUNTIME_LIVE_CHECK_INTERVAL_MS=5000
```

Each runner gets only its own `/private` bind. Its bootstrap seed is
`/private/seed`; the deployment root is never mounted as a shared `/seed`, so
runner A cannot copy or inspect runner B's private files while initializing
its DSH_HOME.

The private compose template defaults the host gateway port to `8875`, matching
the `dsh_origin` advertised by the Memory Lab deployment. Keep the verifier
origin and port explicit when invoking compose so a restart cannot silently
disable the live lease fence or move the public origin.

When generating private material, `DEEPSEEK_API_KEY_FILE_A` and
`DEEPSEEK_API_KEY_FILE_B` can be set to the corresponding container paths; the
bootstrap script writes those paths only into the matching runner env file.

The gateway must also receive `MEMORYLAB_RUNTIME_VERIFY_ORIGIN`, pointing to the
private backend service (for example `http://memorylab-api:9000`). It uses the
runtime credential and exact `context_id/session_id/access_grant_id` from the
scope cookie to perform a live session-lease check before forwarding every
native HTTP or WebSocket request. After a WebSocket handshake it repeats that
check at `MEMORYLAB_RUNTIME_LIVE_CHECK_INTERVAL_MS` (default 5000 ms), and
closes both sides when the lease is no longer valid. If the backend is
unavailable or the grant is revoked, the gateway fails closed.

Before recreating the stack, run the deployment-only boundary check. It reads
only variable names and JSON mapping keys; it never prints secret values:

```sh
RUNTIME_REGISTRY=examples/deploy/private/runtime-registry.json \
MEMORYLAB_RUNTIME_ENV=examples/deploy/private/memorylab-runtime.env \
RUNNER_ENV_DIR=examples/deploy/private \
MEMORYLAB_BACKEND_ENV=/path/to/memorylab/.env \
REQUIRE_MODEL_KEY_FILES=true \
npm run check:private-runtime
```

The check confirms that registry subjects match Memory Lab mappings, every
runner declares `WORKBENCH_ROLE=runner`, control-plane secrets are absent from
runner env files, runner model-key file paths are distinct, and the Memory Lab
backend does not contain `DEEPSEEK_API_KEY`.

## Compose invocation on the WSL2 host

The private runner overlay must be listed before the base compose file so its
relative `env_file` and bind paths resolve under `examples/deploy/private`.
From the repository root, pass deployment variables inside WSL (Windows
environment variables are not mirrored automatically):

```sh
wsl.exe -d Ubuntu --exec env \
  DSH_INTERNAL_NETWORK=dsh-private-check \
  MEMORYLAB_DOCKER_NETWORK=memorylab-internal \
  docker compose \
  -f examples/deploy/compose.private-runners.yaml \
  -f compose.yaml \
  up -d --build dsh-gateway dsh-user-a dsh-user-b
```

This starts the scoped gateway and the two private runners. Do not start the
base `workbench` service for this topology; it does not have the generated
`/private/config` mounts and is not a substitute for the per-user runners.
