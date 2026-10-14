#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

const root = resolve(process.env.PRIVATE_RUNTIME_DIR ?? 'examples/deploy/private')
const userA = process.env.MEMORYLAB_USER_A_ID ?? '00000000-0000-4000-8000-00000000000a'
const userB = process.env.MEMORYLAB_USER_B_ID ?? '00000000-0000-4000-8000-00000000000b'
const apiOrigin = process.env.MEMORYLAB_API_ORIGIN ?? 'http://memorylab-api:9000'
// The browser-facing portal and gateway must be same-site.  Production should
// pass the public portal origin explicitly (usually the shared HTTPS origin).
const parentOrigin = process.env.MEMORYLAB_PARENT_ORIGIN ?? 'http://dsh-gateway:8765'

function secret() { return randomBytes(32).toString('base64url') }
async function put(path, value, mode = 0o600) {
  await writeFile(join(root, path), value.endsWith('\n') ? value : `${value}\n`, { mode })
}
function workspaceConfig() {
  return JSON.stringify({
    schema_version: 1,
    auto_create_user_directories: false,
    allowed_roots: ['/workdir'],
    default_alias: 'private-memory-lab',
    workspaces: [{ alias: 'private-memory-lab', path: '/workdir', title: 'Private Memory Lab', mode: 'read_write', write_probe: true }],
  }, null, 2)
}
function embedConfig() {
  return JSON.stringify({
    schema_version: 1,
    public_origin: 'http://dsh-gateway:8765',
    allowed_parent_origins: [parentOrigin],
    deployment_mode: 'private_runner',
    clients: [{ client_id: 'gateway', secret_file: '/private/runner-client-secret', allowed_parent_origins: [parentOrigin], workspace_aliases: ['private-memory-lab'], mode: 'read_write' }],
  }, null, 2)
}

await mkdir(join(root, 'runner-a'), { recursive: true })
await mkdir(join(root, 'runner-b'), { recursive: true })
const gatewayServiceSecret = secret()
const scopeSecret = secret()
const registry = {
  schema_version: 1,
  public_origin: 'http://dsh-gateway:8765',
  host_instance_id: process.env.MEMORYLAB_DSH_INSTANCE_ID ?? 'memorylab-local-dsh',
  runtimes: [
    { subject: userA, runtime_id: 'runner-a', internal_origin: 'http://dsh-user-a:8765', status: 'ready' },
    { subject: userB, runtime_id: 'runner-b', internal_origin: 'http://dsh-user-b:8765', status: 'ready' },
  ],
}
await put('runtime-registry.json', JSON.stringify(registry, null, 2), 0o644)
await put('gateway.env', [
  'WORKBENCH_GATEWAY_HOST=0.0.0.0',
  'WORKBENCH_GATEWAY_PORT=8765',
  'WORKBENCH_RUNTIME_REGISTRY=/private/runtime-registry.json',
  `WORKBENCH_SCOPE_COOKIE_SECRET=${scopeSecret}`,
  `WORKBENCH_GATEWAY_SERVICE_SECRET=${gatewayServiceSecret}`,
].join('\n'))
const runtimeSecrets = {}
for (const [name, runtime] of [['runner-a', 'runner-a'], ['runner-b', 'runner-b']]) {
  const runnerSecret = secret()
  runtimeSecrets[runtime] = runnerSecret
  await put(`${name}/runner-client-secret`, runnerSecret)
  await put(`${name}/workspace.json`, workspaceConfig(), 0o644)
  await put(`${name}/embed.json`, embedConfig(), 0o644)
  await put(`${name}.env`, [
    'WORKBENCH_ROLE=runner',
    'WORKBENCH_INTEGRATION_MODE=embedded_multi_user',
    'WORKBENCH_EMBED_ENABLED=true',
    'MEMORYLAB_AI_INTEGRATION_ENABLED=true',
    `MEMORYLAB_AI_API_ORIGIN=${apiOrigin}`,
    `MEMORYLAB_AI_PUBLIC_ORIGIN=${apiOrigin}`,
    `MEMORYLAB_AI_DSH_INSTANCE_ID=${registry.host_instance_id}`,
    `MEMORYLAB_AI_RUNTIME_SECRET_FILE=/private/runner-client-secret`,
    'WORKBENCH_PUBLIC_URL=http://dsh-gateway:8765',
    'WORKBENCH_DATA_DIR=/data',
    'DSH_HOME=/data/dsh-home',
    'WORKBENCH_WEB_WORKSPACE=/workdir',
    'WORKBENCH_RUNNER_BROKER_ORIGIN=http://dsh-gateway:8765',
    'WORKBENCH_RUNNER_CREDENTIAL_FILE=/private/runner-client-secret',
    'WORKBENCH_WORKSPACE_CONFIG=/private/workspace.json',
    'WORKBENCH_EMBED_CONFIG=/private/embed.json',
    'DSH_PERMISSION_MODE=danger-full-access',
    `DSH_RUNTIME_ID=${runtime}`,
  ].join('\n'))
}
await put('runtime-secrets.json', JSON.stringify(runtimeSecrets, null, 2), 0o600)
console.log(JSON.stringify({ root, users: { a: userA, b: userB }, api_origin: apiOrigin, generated: true }, null, 2))
