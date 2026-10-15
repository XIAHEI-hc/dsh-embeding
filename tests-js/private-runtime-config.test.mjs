import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const script = join(process.cwd(), 'scripts', 'check-private-runtime-config.mjs')
const longSecret = 'runner-secret-012345678901234567890123'

function fixture({ subject = 'user-a', secret = longSecret, runnerEnv = false, backendEnv = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-private-runtime-config-'))
  const registry = join(root, 'runtime-registry.json')
  const env = join(root, 'runtime-secrets.env')
  const runners = join(root, 'runners')
  const backend = join(root, 'backend.env')
  if (runnerEnv) {
    mkdirSync(runners)
    writeFileSync(join(runners, 'runner-a.env'), [
      'WORKBENCH_ROLE=runner',
      'DEEPSEEK_API_KEY_FILE=/private/runner-a-key',
    ].join('\n'))
  }
  if (backendEnv) writeFileSync(backend, 'APP_ENV=production\n')
  writeFileSync(registry, JSON.stringify({
    schema_version: '1.0', host_instance_id: 'instance-a', runtimes: [{
      subject: 'user-a', runtime_id: 'runner-a', internal_origin: 'http://dsh-user-a:8765',
      control_secret_file: '/private/runner-a-client-secret', status: 'ready',
    }],
  }))
  writeFileSync(env, [
    `AI_TOOL_RUNTIME_SECRETS_JSON={"runner-a":"${secret}"}`,
    `AI_TOOL_RUNTIME_SUBJECTS_JSON={"runner-a":"${subject}"}`,
  ].join('\n'))
  return { registry, env, runners, backend }
}

function run(paths) {
  return execFileSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, RUNTIME_REGISTRY: paths.registry, MEMORYLAB_RUNTIME_ENV: paths.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
}

test('private runtime config check passes matching registry and Memory Lab mappings', () => {
  const output = JSON.parse(run(fixture()))
  assert.equal(output.result, 'PASS')
  assert.deepEqual(output.runtime_ids, ['runner-a'])
  assert.equal(output.subject_bindings_verified, 1)
  assert.equal(output.secret_lengths_verified, 1)
})

test('private runtime config checks runner and backend credential boundaries', () => {
  const paths = fixture({ runnerEnv: true, backendEnv: true })
  const output = JSON.parse(execFileSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, RUNTIME_REGISTRY: paths.registry, MEMORYLAB_RUNTIME_ENV: paths.env,
      RUNNER_ENV_DIR: paths.runners, REQUIRE_MODEL_KEY_FILES: 'true', MEMORYLAB_BACKEND_ENV: paths.backend },
    encoding: 'utf8',
  }))
  assert.deepEqual(output.runner_model_key_files, { 'runner-a': true })
  assert.equal(output.backend_model_key_absent, true)
})

test('private runtime config rejects control secrets in a runner env', () => {
  const paths = fixture({ runnerEnv: true })
  writeFileSync(join(paths.runners, 'runner-a.env'), 'WORKBENCH_ROLE=runner\nWORKBENCH_GATEWAY_SERVICE_SECRET=leaked\n')
  assert.throws(() => execFileSync(process.execPath, [script], {
    cwd: process.cwd(), env: { ...process.env, RUNTIME_REGISTRY: paths.registry, MEMORYLAB_RUNTIME_ENV: paths.env,
      RUNNER_ENV_DIR: paths.runners }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  }), error => error.status === 1 && /CONFIG_INVALID/u.test(error.stderr) && !/leaked/u.test(error.stderr))
})

test('private runtime config check rejects subject drift and short secrets', () => {
  for (const paths of [fixture({ subject: 'user-b' }), fixture({ secret: 'short' })]) {
    assert.throws(() => run(paths), error => {
      assert.equal(error.status, 1)
      const body = JSON.parse(error.stderr)
      assert.equal(body.result, 'FAIL')
      assert.equal(body.code, 'CONFIG_INVALID')
      assert.doesNotMatch(error.stderr, /runner-secret/u)
      return true
    })
  }
})
