import assert from 'node:assert/strict'
import test from 'node:test'
import { admitInvocation, createRemoteProvider, recordUsage, synchronizeRemoteProvider } from '@dsh-workbench/memorylab-skill-provider'

const scope = { context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a' }

test('provider only exposes installed fixed versions and resolves through broker', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers })
    return { ok: true, async json() { return url.endsWith('/catalog') ? { items: [
      { desired_enabled: true, ack_status: 'installed', runtime_name: 'ml-chn-v1-0-0-habc', display_name: 'CHN', version: '1.0.0', description: 'facts', activation_id: 'a', version_id: 'v', generation: 2, archive_sha256: 'a'.repeat(64) },
      { desired_enabled: true, ack_status: 'pending', runtime_name: 'ml-pending-v1-0-0-hdef', display_name: 'Pending', version: '1.0.0', description: '', activation_id: 'p', version_id: 'pv', generation: 1, archive_sha256: 'b'.repeat(64) },
    ] } : { runtime_name: 'ml-chn-v1-0-0-habc', activation_id: 'a', version_id: 'v', generation: 2, archive_sha256: 'a'.repeat(64), instruction: 'Use facts.', instruction_sha256: '0b51f6cda8a51221bb6084d84fb271fb069e848ffe5306a8cb96f38054ebd5cd' } } }
  }
  const provider = createRemoteProvider({ baseUrl: 'http://memorylab', serviceSecret: 'secret', instanceId: 'instance-a', runtimeId: 'runner-a', scope, fetchImpl })
  const [candidate] = await provider.list()
  assert.equal(candidate.name, 'ml-chn-v1-0-0-habc')
  const definition = await provider.get(candidate)
  assert.equal(definition.content, 'Use facts.')
  assert.equal(calls[0].body.context_id, 'ctx-a')
  assert.equal(calls[1].body.archive_sha256, 'a'.repeat(64))
  assert.equal(calls[0].headers['x-dsh-runtime-id'], 'runner-a')
})

test('provider rejects candidates from another scope', async () => {
  const provider = createRemoteProvider({ baseUrl: 'http://memorylab', serviceSecret: 'secret', instanceId: 'instance-a', runtimeId: 'runner-a', scope, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
  await assert.rejects(provider.get({ provider: 'memorylab-remote', locator: { owner: 'ctx-b' } }), { code: 'SCOPE_DENIED' })
})

test('provider rejects a resolve response whose canonical identity changed', async () => {
  const provider = createRemoteProvider({
    baseUrl: 'http://memorylab', serviceSecret: 'secret', instanceId: 'instance-a', runtimeId: 'runner-a', scope,
    fetchImpl: async () => ({ ok: true, json: async () => ({
      runtime_name: 'ml-other-v1-0-0-hash', activation_id: 'a', version_id: 'v', generation: 2,
      archive_sha256: 'a'.repeat(64), instruction: 'Use facts.', instruction_sha256: '0b51f6cda8a51221bb6084d84fb271fb069e848ffe5306a8cb96f38054ebd5cd',
    }) }),
  })
  await assert.rejects(provider.get({
    name: 'ml-chn-v1-0-0-habc', provider: 'memorylab-remote',
    locator: { owner: 'ctx-a', activation_id: 'a', version_id: 'v', generation: 2, archive_sha256: 'a'.repeat(64) },
  }), { code: 'SKILL_VERSION_CHANGED' })
})

test('provider rejects a resolve response whose instruction hash does not match its body', async () => {
  const calls = []
  const scope = { context_id: 'ctx', session_id: 'session', access_grant_id: 'grant' }
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/catalog')) {
      return new Response(JSON.stringify({ catalog_revision: 'rev-1', items: [{
        desired_enabled: true, ack_status: 'installed', runtime_name: 'ml-expected-v1-0-0-habc',
        display_name: 'Expected', description: 'desc', version: '1.0.0', activation_id: 'a',
        version_id: 'v', generation: 1, archive_sha256: 'a'.repeat(64),
      }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      runtime_name: 'ml-expected-v1-0-0-habc', activation_id: 'a', version_id: 'v', generation: 1,
      archive_sha256: 'a'.repeat(64), instruction: 'Use facts.', instruction_sha256: 'b'.repeat(64),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const provider = createRemoteProvider({ baseUrl: 'http://memorylab', serviceSecret: 'secret', instanceId: 'instance-a', runtimeId: 'runner-a', scope, fetchImpl })
  await assert.rejects(() => provider.get({
    name: 'ml-expected-v1-0-0-habc', provider: 'memorylab-remote',
    locator: { owner: 'ctx', activation_id: 'a', version_id: 'v', generation: 1, archive_sha256: 'a'.repeat(64) },
  }), error => error.code === 'HASH_MISMATCH')
})

test('broker admission and usage strip local owner metadata from wire payloads', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ accepted: true }) }
  }
  const locator = { owner: 'ctx-a', activation_id: 'a', version_id: 'v', generation: 2, archive_sha256: 'a'.repeat(64) }
  await admitInvocation({ baseUrl: 'http://memorylab', serviceSecret: 'secret', instanceId: 'instance-a', runtimeId: 'runner-a', scope, locator, invocationId: 'inv-1', nativeRequestId: 'req-1', fetchImpl })
  await recordUsage({ baseUrl: 'http://memorylab', serviceSecret: 'secret', instanceId: 'instance-a', runtimeId: 'runner-a', scope, locator, invocationId: 'inv-1', nativeRequestId: 'req-1', phase: 'loaded', fetchImpl })
  assert.equal(calls.length, 2)
  assert.equal('owner' in calls[0], false)
  assert.equal('owner' in calls[1], false)
  assert.equal(calls[0].activation_id, 'a')
  assert.equal(calls[1].phase, 'loaded')
})

test('synchronizer acknowledges only a self-checked fixed version', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body })
    return { ok: true, json: async () => url.endsWith('/catalog')
      ? { catalog_revision: 'rev-1', items: [{ desired_enabled: true, runtime_name: 'ml-chn-v1-0-0-habc', activation_id: 'a', version_id: 'v', generation: 3, archive_sha256: 'a'.repeat(64) }] }
      : url.endsWith('/resolve')
        ? { runtime_name: 'ml-chn-v1-0-0-habc', activation_id: 'a', version_id: 'v', generation: 3, archive_sha256: 'a'.repeat(64), instruction: 'Use facts.', instruction_sha256: '0b51f6cda8a51221bb6084d84fb271fb069e848ffe5306a8cb96f38054ebd5cd' }
        : { accepted: true, duplicate: false } }
  }
  const result = await synchronizeRemoteProvider({ baseUrl: 'http://memorylab', serviceSecret: 'secret', instanceId: 'instance-a', runtimeId: 'runner-a', scope, fetchImpl })
  assert.equal(result.revision, 'rev-1')
  assert.deepEqual(calls.map(call => call.url), [
    'http://memorylab/api/skills/runtime/v1/catalog',
    'http://memorylab/api/skills/runtime/v1/resolve',
    'http://memorylab/api/skills/runtime/v1/ack',
  ])
  assert.equal(calls[2].body.status, 'installed')
  assert.equal(calls[2].body.generation, 3)
})

test('synchronizer refuses to acknowledge a canonical runtime name mismatch', async () => {
  const fetchImpl = async (url) => ({ ok: true, json: async () => url.endsWith('/catalog')
    ? { catalog_revision: 'rev-1', items: [{ desired_enabled: true, runtime_name: 'ml-expected-v1-0-0-habc', activation_id: 'a', version_id: 'v', generation: 3, archive_sha256: 'a'.repeat(64) }] }
    : { runtime_name: 'ml-wrong-v1-0-0-hdef', activation_id: 'a', version_id: 'v', generation: 3, archive_sha256: 'a'.repeat(64), instruction: 'Use facts.', instruction_sha256: '0b51f6cda8a51221bb6084d84fb271fb069e848ffe5306a8cb96f38054ebd5cd' } })
  await assert.rejects(synchronizeRemoteProvider({ baseUrl: 'http://memorylab', serviceSecret: 'secret', instanceId: 'instance-a', runtimeId: 'runner-a', scope, fetchImpl }), { code: 'HASH_MISMATCH' })
})

