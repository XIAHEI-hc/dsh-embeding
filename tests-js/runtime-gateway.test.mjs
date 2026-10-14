import assert from 'node:assert/strict'
import test from 'node:test'
import { signScope, verifyScope } from '@dsh-workbench/runtime-gateway'

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
