import assert from 'node:assert/strict'
import test from 'node:test'

import { ProbeToolClient } from '../packages/probe-data-tools/src/client.js'

test('tool client derives scope only from the executing agent session', async (t) => {
  const calls = []
  const store = {
    requireActive(sessionId) {
      assert.equal(sessionId, 'session-a')
      return { contextId: 'context-a', instanceId: 'dsh-a' }
    },
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ ok: true, data: { items: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  const client = new ProbeToolClient({
    origin: 'http://probe.test', instanceId: 'dsh-a', secret: 'x'.repeat(32),
    timeoutMs: 1000, store,
  })
  const result = await client.query(
    'get_wafer_summary',
    { limit: 2 },
    { agent: { session: { header: { id: 'session-a' } } } },
  )
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.context_id, 'context-a')
  assert.equal(calls[0].body.session_id, 'session-a')
  assert.deepEqual(calls[0].body.arguments, { limit: 2 })
  assert.equal('project_id' in calls[0].body, false)
  assert.equal('user_id' in calls[0].body, false)
  assert.match(calls[0].options.headers.authorization, /^Bearer /)
})

test('tool client fails closed without an executing session or active binding', async () => {
  const missing = new ProbeToolClient({
    origin: 'http://probe.test', instanceId: 'dsh-a', secret: 'x'.repeat(32),
    timeoutMs: 1000, store: { requireActive() { throw new Error('CONTEXT_NOT_BOUND') } },
  })
  await assert.rejects(missing.query('get_project_overview', {}, {}), /CONTEXT_NOT_BOUND/)
  await assert.rejects(
    missing.query('get_project_overview', {}, { agent: { session: { header: { id: 'unknown' } } } }),
    /CONTEXT_NOT_BOUND/,
  )
})
