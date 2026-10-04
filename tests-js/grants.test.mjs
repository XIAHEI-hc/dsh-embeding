import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GrantStore } from '@dsh-workbench/extensions/grants'

function fixture(now = 1_000_000) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-grants-'))
  const clock = { value: now }
  const store = new GrantStore(join(root, 'embed.sqlite3'), () => clock.value)
  return { store, clock, close() { store.close(); rmSync(root, { recursive: true, force: true }) } }
}

function issue(store, ttlSeconds = 60) {
  return store.issue({
    clientId: 'portal', subject: 'user-1', parentOrigin: 'http://localhost:3000',
    scope: { workspaceId: 'workspace-1', mode: 'read_write' }, ttlSeconds, requestId: 'req-1',
  })
}

test('one-time grants are atomically consumed and retain only token hashes', () => {
  const f = fixture()
  try {
    const issued = issue(f.store)
    assert.equal(f.store.inspect(issued.token).scope.workspaceId, 'workspace-1')
    assert.equal(f.store.consume(issued.token, 'init-1').clientId, 'portal')
    assert.throws(() => f.store.consume(issued.token, 'init-2'), { code: 'EMBED_TICKET_REPLAYED' })
    const row = f.store.db.prepare('SELECT token_hash, result_json FROM embed_grants').get()
    assert.notEqual(row.token_hash, issued.token)
    assert.equal(row.result_json, null)
  } finally { f.close() }
})

test('expired and revoked grants never consume', () => {
  const f = fixture()
  try {
    const expired = issue(f.store, 1)
    f.clock.value += 1001
    assert.throws(() => f.store.inspect(expired.token), { code: 'EMBED_TICKET_EXPIRED' })
    const revoked = issue(f.store)
    assert.equal(f.store.revoke(revoked.token, 'portal', 'revoke-1'), true)
    assert.throws(() => f.store.consume(revoked.token, 'init-1'), { code: 'EMBED_TICKET_REVOKED' })
  } finally { f.close() }
})

test('a different client cannot revoke a grant', () => {
  const f = fixture()
  try {
    const issued = issue(f.store)
    assert.equal(f.store.revoke(issued.token, 'other', 'revoke-1'), false)
    assert.equal(f.store.consume(issued.token, 'init-1').grantId, issued.grantId)
  } finally { f.close() }
})
