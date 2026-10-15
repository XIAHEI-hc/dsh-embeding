import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRuntimeRegistry, runtimeForSubject } from '@dsh-workbench/extensions/runtime-registry'
import { requireProvisionedGrantSubject } from '@dsh-workbench/extensions'

function file(value) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-registry-'))
  const path = join(root, 'registry.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}

const base = {
  schema_version: '1.0',
  host_instance_id: 'memorylab-local-dsh',
  runtimes: [{ subject: 'user-a', runtime_id: 'runner-a', internal_origin: 'http://dsh-user-a:8765', status: 'ready' }],
}

test('registry resolves only a ready subject', () => {
  const registry = loadRuntimeRegistry(file(base))
  assert.equal(runtimeForSubject(registry, 'user-a').runtimeId, 'runner-a')
  assert.throws(() => runtimeForSubject(registry, 'user-b'), { code: 'RUNTIME_NOT_PROVISIONED' })
})

test('multi-user grant issuance rejects an unprovisioned subject before ticket creation', () => {
  const registry = loadRuntimeRegistry(file(base))
  assert.equal(requireProvisionedGrantSubject(registry, 'user-a').runtimeId, 'runner-a')
  assert.throws(() => requireProvisionedGrantSubject(registry, 'user-b'), { code: 'RUNTIME_NOT_PROVISIONED' })
  assert.equal(requireProvisionedGrantSubject(undefined, 'external-subject'), undefined)
})

test('registry rejects duplicate subjects and invalid origins', () => {
  assert.throws(() => loadRuntimeRegistry(file({ ...base, runtimes: [...base.runtimes, { ...base.runtimes[0], runtime_id: 'runner-b' }] })), { code: 'CONFIG_INVALID' })
  assert.throws(() => loadRuntimeRegistry(file({ ...base, runtimes: [{ ...base.runtimes[0], internal_origin: 'http://user:pass@host/path' }] })), { code: 'CONFIG_INVALID' })
})

test('provisioning and disabled runners do not become shared fallback', () => {
  const registry = loadRuntimeRegistry(file({ ...base, runtimes: [{ ...base.runtimes[0], status: 'provisioning' }] }))
  assert.throws(() => runtimeForSubject(registry, 'user-a'), { code: 'RUNTIME_NOT_PROVISIONED' })
})
