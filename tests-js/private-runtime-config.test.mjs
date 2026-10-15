import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const script = join(process.cwd(), 'scripts', 'check-private-runtime-config.mjs')
const longSecret = 'runner-secret-012345678901234567890123'

function fixture({ subject = 'user-a', secret = longSecret } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-private-runtime-config-'))
  const registry = join(root, 'runtime-registry.json')
  const env = join(root, 'runtime-secrets.env')
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
  return { registry, env }
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
