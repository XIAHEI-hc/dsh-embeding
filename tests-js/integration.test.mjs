import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isBindableInspection } from '../packages/workbench-extensions/src/integration.js'
import { IntegrationStore, requestHash } from '@dsh-workbench/extensions/integration-store'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-integration-'))
  const path = join(root, 'integration.sqlite3')
  return { root, path, close() { rmSync(root, { recursive: true, force: true }) } }
}

const metadata = { project_id: 'project-a', function_type: 'SITE_DESIGN' }

test('official initialization events keep a session bindable until its first turn', () => {
  const base = {
    meta: { id: 'session-a' },
    events: [
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ],
  }
  assert.equal(isBindableInspection(base), true)
  assert.equal(isBindableInspection({
    ...base, events: [...base.events, { type: 'turn/start', data: { turn: 1 } }],
  }), false)
  assert.equal(isBindableInspection({
    ...base, meta: { ...base.meta, parentSession: 'session-parent' },
  }), false)
  assert.equal(isBindableInspection({
    ...base,
    meta: { ...base.meta, parentSession: 'session-parent' },
    events: [...base.events, { type: 'turn/start', data: { turn: 1 } }],
  }, 'session-parent'), true)
  assert.equal(isBindableInspection({
    ...base, meta: { ...base.meta, parentSession: 'session-other' },
  }, 'session-parent'), false)
})

test('integration bindings survive restart and remain immutable', () => {
  const f = fixture()
  try {
    let store = new IntegrationStore(f.path)
    store.bind({
      clientId: 'probe', contextId: 'context-a', workspaceId: 'workspace-a',
      sessionId: 'session-a', instanceId: 'dsh-a', metadata,
    })
    store.close()

    store = new IntegrationStore(f.path)
    assert.deepEqual(store.requireActive('session-a'), {
      sessionId: 'session-a', contextId: 'context-a', workspaceId: 'workspace-a',
      clientId: 'probe', instanceId: 'dsh-a', projectId: 'project-a',
      functionType: 'SITE_DESIGN', status: 'active',
    })
    assert.throws(() => store.bind({
      clientId: 'probe', contextId: 'context-b', workspaceId: 'workspace-a',
      sessionId: 'session-a', instanceId: 'dsh-a', metadata,
    }), { code: 'SESSION_CONTEXT_MISMATCH' })
    assert.equal(store.revokeContext('context-a', 'probe'), 1)
    assert.throws(() => store.requireActive('session-a'), { code: 'CONTEXT_REVOKED' })
    store.close()
  } finally { f.close() }
})

test('Memory Lab user scope persists through the shared immutable binding store', () => {
  const f = fixture()
  const store = new IntegrationStore(f.path)
  try {
    store.bind({
      clientId: 'memorylab', contextId: 'context-user', workspaceId: 'workspace-a',
      sessionId: 'session-user', instanceId: 'dsh-memorylab',
      metadata: { user_id: 'user-a', function_type: 'MEMORYLAB_CHN' },
    })
    assert.deepEqual(store.requireActive('session-user'), {
      sessionId: 'session-user', contextId: 'context-user', workspaceId: 'workspace-a',
      clientId: 'memorylab', instanceId: 'dsh-memorylab', projectId: 'user-a',
      functionType: 'MEMORYLAB_CHN', status: 'active',
    })
    assert.throws(() => store.bind({
      clientId: 'memorylab', contextId: 'context-user', workspaceId: 'workspace-a',
      sessionId: 'session-user', instanceId: 'dsh-memorylab',
      metadata: { user_id: 'user-b', function_type: 'MEMORYLAB_CHN' },
    }), { code: 'SESSION_CONTEXT_MISMATCH' })
  } finally { store.close(); f.close() }
})

test('integration binding rejects ambiguous or absent upstream scope identity', () => {
  const f = fixture()
  const store = new IntegrationStore(f.path)
  try {
    const request = {
      clientId: 'memorylab', contextId: 'context-a', workspaceId: 'workspace-a',
      sessionId: 'session-a', instanceId: 'dsh-memorylab',
    }
    assert.throws(() => store.bind({ ...request, metadata: {
      project_id: 'project-a', user_id: 'user-a', function_type: 'MEMORYLAB_CHN',
    } }), { code: 'SESSION_CONTEXT_MISMATCH' })
    assert.throws(() => store.bind({ ...request, metadata: {
      function_type: 'MEMORYLAB_CHN',
    } }), { code: 'SESSION_CONTEXT_MISMATCH' })
  } finally { store.close(); f.close() }
})

test('prepare reservations are idempotent and reject changed bodies', () => {
  const f = fixture()
  const store = new IntegrationStore(f.path)
  try {
    const request = {
      clientId: 'probe', requestId: 'request-a', contextId: 'context-a',
      workspaceId: 'workspace-a', sessionId: 'session-a',
      hash: requestHash({ context_id: 'context-a', workspace_id: 'workspace-a', session_id: null }),
    }
    assert.equal(store.reservePrepare(request).created, true)
    const repeat = store.reservePrepare(request)
    assert.equal(repeat.created, false)
    assert.equal(repeat.sessionId, 'session-a')
    assert.throws(() => store.reservePrepare({ ...request, hash: requestHash({ changed: true }) }), {
      code: 'INTEGRATION_REQUEST_CONFLICT',
    })

    const response = store.completePrepare({
      clientId: 'probe', requestId: 'request-a', contextId: 'context-a',
      workspaceId: 'workspace-a', sessionId: 'session-a', instanceId: 'dsh-a', metadata,
    })
    assert.equal(response.session_id, 'session-a')
    assert.deepEqual(store.reservePrepare(request).response, response)
  } finally { store.close(); f.close() }
})

test('failed prepare reservations can be retried without allocating another session', () => {
  const f = fixture()
  const store = new IntegrationStore(f.path)
  try {
    const request = {
      clientId: 'probe', requestId: 'request-a', contextId: 'context-a',
      workspaceId: 'workspace-a', sessionId: 'session-stable', hash: requestHash({ value: 1 }),
    }
    store.reservePrepare(request)
    store.failPrepare('probe', 'request-a', 'DSH_UNAVAILABLE')
    const retry = store.reservePrepare(request)
    assert.equal(retry.state, 'failed')
    assert.equal(retry.sessionId, 'session-stable')
  } finally { store.close(); f.close() }
})
