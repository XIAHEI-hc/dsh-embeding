import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isBindableInspection, verifyContext, verifySessionContext } from '../packages/workbench-extensions/src/integration.js'
import { durableUsagePayload, drainUsageOutbox, recordUsageDurably } from '../packages/workbench-extensions/src/index.js'
import { normalizePageSurface } from '../packages/workbench-extensions/src/page-surface.js'
import { IntegrationStore, requestHash } from '@dsh-workbench/extensions/integration-store'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-integration-'))
  const path = join(root, 'integration.sqlite3')
  return { root, path, close() { rmSync(root, { recursive: true, force: true }) } }
}

const metadata = { project_id: 'project-a', function_type: 'SITE_DESIGN' }

test('Memory Lab context verification requires the exact browser grant', async () => {
  await assert.rejects(
    verifyContext({ integrationKind: 'memorylab' }, 'context-a'),
    { code: 'CONTEXT_REVOKED' },
  )
})

test('Memory Lab session verification rejects a missing grant before network', async () => {
  await assert.rejects(
    verifySessionContext({ integrationKind: 'memorylab' }, 'context-a', 'session-a'),
    { code: 'CONTEXT_REVOKED' },
  )
})

test('Memory Lab context verification rejects returned grant drift', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    context: {
      context_id: 'context-a', user_id: 'user-a', access_grant_id: 'grant-b',
      dsh_instance_id: 'instance-a', function_type: 'MEMORYLAB_CHN',
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      verifyContext({
        integrationKind: 'memorylab', apiOrigin: 'http://memorylab.test',
        toolSecret: 'tool-secret', instanceId: 'instance-a',
        allowedFunctionTypes: ['MEMORYLAB_CHN'], verifyTimeoutMs: 1000,
      }, 'context-a', undefined, undefined, 'grant-a'),
      { code: 'SESSION_CONTEXT_MISMATCH' },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

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

test('Memory Lab binding retains the exact login grant for provider scope', () => {
  const f = fixture()
  const store = new IntegrationStore(f.path)
  try {
    const request = {
      clientId: 'memorylab', contextId: 'context-user', workspaceId: 'workspace-a',
      sessionId: 'session-user', instanceId: 'dsh-memorylab',
      metadata: { user_id: 'user-a', function_type: 'MEMORYLAB_CHN',
        runtime_id: 'runner-a', access_grant_id: 'grant-a' },
    }
    store.bind(request)
    assert.equal(store.requireActive('session-user').accessGrantId, 'grant-a')
    assert.throws(() => store.bind({ ...request, metadata: { ...request.metadata, access_grant_id: 'grant-b' } }), {
      code: 'CONTEXT_REVOKED',
    })
    assert.equal(store.requireActive('session-user').accessGrantId, 'grant-a')
    assert.equal(store.revokeContext('context-user', 'memorylab'), 1)
    assert.equal(store.bind({ ...request, metadata: { ...request.metadata, access_grant_id: 'grant-b' } }).accessGrantId, 'grant-b')
    assert.equal(store.revokeBinding('session-user', 'memorylab'), 1)
    assert.throws(() => store.requireActive('session-user'), { code: 'CONTEXT_REVOKED' })
  } finally { store.close(); f.close() }
})

test('active binding scan survives restart and excludes revoked sessions', () => {
  const f = fixture()
  const store = new IntegrationStore(f.path)
  try {
    store.bind({
      clientId: 'memorylab', contextId: 'context-a', workspaceId: 'workspace-a',
      sessionId: 'session-a', instanceId: 'dsh-a',
      metadata: { user_id: 'user-a', function_type: 'MEMORYLAB_CHN',
        runtime_id: 'runner-a', access_grant_id: 'grant-a' },
    })
    store.bind({
      clientId: 'memorylab', contextId: 'context-b', workspaceId: 'workspace-b',
      sessionId: 'session-b', instanceId: 'dsh-a',
      metadata: { user_id: 'user-b', function_type: 'MEMORYLAB_CHN',
        runtime_id: 'runner-b', access_grant_id: 'grant-b' },
    })
    assert.deepEqual(store.activeBindings().map(binding => binding.sessionId), ['session-a', 'session-b'])
    assert.equal(store.revokeContext('context-a', 'memorylab'), 1)
    assert.deepEqual(store.activeBindings().map(binding => binding.sessionId), ['session-b'])
  } finally { store.close(); f.close() }
})

test('a failed native fork can remove only its pre-bound child binding', () => {
  const f = fixture()
  const store = new IntegrationStore(f.path)
  try {
    const parent = {
      clientId: 'memorylab', contextId: 'context-user', workspaceId: 'workspace-a',
      sessionId: 'session-parent', instanceId: 'dsh-memorylab',
      metadata: { user_id: 'user-a', function_type: 'MEMORYLAB_CHN',
        runtime_id: 'runner-a', access_grant_id: 'grant-a' },
    }
    store.bind(parent)
    store.bind({ ...parent, sessionId: 'session-child' })
    store.bind({ ...parent, sessionId: 'other-child', clientId: 'other-client' })
    assert.equal(store.removeUnmaterializedBinding('session-child', {
      contextId: 'context-user', clientId: 'memorylab',
    }), 1)
    assert.throws(() => store.requireActive('session-child'), { code: 'CONTEXT_NOT_BOUND' })
    assert.equal(store.requireActive('other-child').clientId, 'other-client')
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

test('page surface is normalized and retained as an immutable session binding', () => {
  const f = fixture()
  const store = new IntegrationStore(f.path)
  const pageSurface = normalizePageSurface({
    surface_id: 'surface-a', conversation_slot: 'slot-a', page_kind: 'failure_map',
    dataset_id: 'dataset-a', display_mode: 'compact_chat',
  })
  try {
    const request = {
      clientId: 'memorylab', contextId: 'context-page', workspaceId: 'workspace-a',
      sessionId: 'session-page', instanceId: 'dsh-memorylab',
      metadata: { user_id: 'user-a', function_type: 'MEMORYLAB_CHN',
        runtime_id: 'runner-a', access_grant_id: 'grant-a' }, pageSurface,
    }
    store.bind(request)
    assert.deepEqual(store.requireActive('session-page'), {
      sessionId: 'session-page', contextId: 'context-page', workspaceId: 'workspace-a',
      clientId: 'memorylab', instanceId: 'dsh-memorylab', projectId: 'user-a',
      functionType: 'MEMORYLAB_CHN', runtimeId: 'runner-a', accessGrantId: 'grant-a',
      pageSurfaceId: 'surface-a', conversationSlot: 'slot-a', pageKind: 'failure_map',
      datasetId: 'dataset-a', displayMode: 'compact_chat', status: 'active',
    })
    assert.throws(() => store.bind({ ...request, pageSurface: { ...pageSurface, dataset_id: 'dataset-b' } }), {
      code: 'SESSION_CONTEXT_MISMATCH',
    })
  } finally { store.close(); f.close() }
})

test('page surface request hash changes when the server-authorized surface changes', () => {
  const a = normalizePageSurface({
    surface_id: 'surface-a', conversation_slot: 'slot-a', page_kind: 'failure_map',
    dataset_id: 'dataset-a', display_mode: 'compact_chat',
  })
  const b = normalizePageSurface({ ...a, dataset_id: 'dataset-b' })
  assert.notEqual(
    requestHash({ context_id: 'ctx', workspace_id: 'ws', session_id: null, page_surface: a }),
    requestHash({ context_id: 'ctx', workspace_id: 'ws', session_id: null, page_surface: b }),
  )
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

test('usage outbox survives restart and deduplicates stable event ids', () => {
  const f = fixture()
  try {
    let now = 1_000
    let store = new IntegrationStore(f.path, () => now)
    const payload = {
      scope: { context_id: 'context-a', session_id: 'session-a', access_grant_id: 'grant-a' },
      invocationId: 'invocation-a', nativeRequestId: 'native-a', phase: 'completed',
    }
    store.enqueueUsage('event-a', payload)
    store.enqueueUsage('event-a', { ...payload, phase: 'failed' })
    assert.deepEqual(store.pendingUsage(), [{
      eventId: 'event-a', payload, attempts: 0, nextAttemptAt: 1_000,
    }])
    store.rescheduleUsage('event-a', 5_000)
    assert.equal(store.pendingUsage().length, 0)
    store.close()

    now = 6_000
    store = new IntegrationStore(f.path, () => now)
    assert.equal(store.pendingUsage()[0].attempts, 1)
    store.markUsageDelivered('event-a')
    assert.deepEqual(store.pendingUsage(), [])
    store.close()
  } finally { f.close() }
})

test('durable usage retries keep the original occurred_at fingerprint', () => {
  const payload = { invocationId: 'invocation-a', phase: 'completed' }
  const first = durableUsagePayload(payload, 'event-a', '2026-10-15T10:00:00.000Z')
  const replay = durableUsagePayload(first, first.eventId, '2026-10-15T10:05:00.000Z')
  assert.equal(first.eventId, 'event-a')
  assert.equal(first.occurredAt, '2026-10-15T10:00:00.000Z')
  assert.deepEqual(replay, first)
})

test('successful usage delivery removes the exact durable event from the outbox', async (t) => {
  const originalFetch = globalThis.fetch
  const delivered = []
  const enqueued = []
  globalThis.fetch = async () => new Response(JSON.stringify({ accepted: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  t.after(() => { globalThis.fetch = originalFetch })
  const integration = {
    store: {
      markUsageDelivered(eventId) { delivered.push(eventId) },
      enqueueUsage(eventId, payload) { enqueued.push({ eventId, payload }) },
    },
  }
  const result = await recordUsageDurably(integration, {
    integrationKind: 'memorylab', apiOrigin: 'http://memorylab.test',
    toolSecret: 's'.repeat(32), instanceId: 'instance-a',
  }, {
    scope: { context_id: 'context-a', session_id: 'session-a', access_grant_id: 'grant-a' },
    locator: { owner: 'context-a', activation_id: 'activation-a', version_id: 'version-a', generation: 1, archive_sha256: 'a'.repeat(64) },
    invocationId: 'invocation-a', nativeRequestId: 'native-a', phase: 'completed',
  })
  assert.equal(result.accepted, true)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /^[0-9a-f-]{36}$/u)
  assert.deepEqual(enqueued, [])
})

test('permanent usage scope failures purge stale outbox events', async (t) => {
  const f = fixture()
  const store = new IntegrationStore(f.path)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'CONTEXT_REVOKED', message: '授权已撤销' },
  }), { status: 403, headers: { 'content-type': 'application/json' } })
  t.after(() => { globalThis.fetch = originalFetch; store.close(); f.close() })
  store.enqueueUsage('revoked-event', {
    scope: { context_id: 'context-a', session_id: 'session-a', access_grant_id: 'old-grant' },
    locator: { activation_id: 'activation-a', version_id: 'version-a', generation: 1, archive_sha256: 'a'.repeat(64) },
    invocationId: 'invocation-a', nativeRequestId: 'native-a', phase: 'completed',
  })
  await drainUsageOutbox({ store }, {
    integrationKind: 'memorylab', apiOrigin: 'http://memorylab.test',
    toolSecret: 's'.repeat(32), instanceId: 'instance-a',
  })
  assert.deepEqual(store.pendingUsage(), [])
})

test('Memory Lab session status verifier binds context, session, grant, and instance', async () => {
  const originalFetch = globalThis.fetch
  let requested
  globalThis.fetch = async (url, options) => {
    requested = { url, options }
    return new Response(JSON.stringify({ ok: true, scope: {
      context_id: 'context-a', session_id: 'session-a', access_grant_id: 'grant-a',
      dsh_instance_id: 'instance-a',
    } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await verifySessionContext({
      apiOrigin: 'http://memorylab.test', instanceId: 'instance-a', toolSecret: 's'.repeat(32),
      verifyTimeoutMs: 1000,
    }, 'context-a', 'session-a', 'grant-a')
    assert.equal(result.session_id, 'session-a')
    assert.match(requested.url, /\/contexts\/context-a\/sessions\/session-a\/verify$/u)
    assert.equal(requested.options.headers['x-dsh-access-grant-id'], 'grant-a')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Memory Lab session status verifier maps a revoked lease to CONTEXT_REVOKED', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false, error: { code: 'CONTEXT_REVOKED', message: '授权已撤销' },
  }), { status: 403, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      verifySessionContext({
        apiOrigin: 'http://memorylab.test', instanceId: 'instance-a', toolSecret: 's'.repeat(32),
        verifyTimeoutMs: 1000,
      }, 'context-a', 'session-a', 'grant-a'),
      { code: 'CONTEXT_REVOKED' },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
