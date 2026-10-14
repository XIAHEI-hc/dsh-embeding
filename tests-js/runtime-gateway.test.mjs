import assert from 'node:assert/strict'
import test from 'node:test'
import { signScope, verifyScope } from '@dsh-workbench/runtime-gateway'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntimeGateway } from '@dsh-workbench/runtime-gateway'

test('scope token is opaque, signed, and expires', () => {
  const issuedAt = 1_000_000
  const token = signScope({ subject: 'user-a', runtime_id: 'runner-a' }, 'secret', issuedAt)
  const value = verifyScope(token, 'secret', 60_000, issuedAt + 1_000)
  assert.equal(value.subject, 'user-a')
  assert.equal(value.runtime_id, 'runner-a')
  assert.equal(verifyScope(token, 'wrong', 60_000, issuedAt + 1_000), undefined)
  assert.equal(verifyScope(token, 'secret', 60_000, issuedAt + 60_001), undefined)
})

test('scope token rejects tampering and malformed payloads', () => {
  const token = signScope({ subject: 'user-a', runtime_id: 'runner-a' }, 'secret', 1_000)
  const [payload, mac] = token.split('.')
  assert.equal(verifyScope(`${payload}x.${mac}`, 'secret', 60_000, 2_000), undefined)
  assert.equal(verifyScope('garbage', 'secret'), undefined)
})

test('gateway binds only a registry-owned subject and issues HttpOnly scope cookie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-'))
  const registryPath = join(root, 'registry.json')
  writeFileSync(registryPath, JSON.stringify({ schema_version: '1.0', host_instance_id: 'instance-a', runtimes: [
    { subject: 'user-a', runtime_id: 'runner-a', internal_origin: 'http://127.0.0.1:9', status: 'ready' },
  ] }))
  const gateway = createRuntimeGateway({ registryPath, scopeSecret: 'scope-secret', serviceSecret: 'service-secret' })
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  const address = gateway.server.address()
  const base = `http://127.0.0.1:${address.port}`
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  const denied = await fetch(`${base}/internal/scope/bind`, { method: 'POST', headers: { authorization: 'Bearer service-secret', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-b', runtime_id: 'runner-b' }) })
  assert.equal(denied.status, 409)
  const bound = await fetch(`${base}/internal/scope/bind`, { method: 'POST', headers: { authorization: 'Bearer service-secret', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-a', runtime_id: 'runner-a', context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a' }) })
  assert.equal(bound.status, 200)
  assert.match(bound.headers.get('set-cookie'), /HttpOnly/)
  gateway.server.close()
})
