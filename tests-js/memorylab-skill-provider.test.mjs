import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteProvider } from '@dsh-workbench/memorylab-skill-provider'

const scope = { context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a' }

test('provider only exposes installed fixed versions and resolves through broker', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers })
    return { ok: true, async json() { return url.endsWith('/catalog') ? { items: [
      { desired_enabled: true, ack_status: 'installed', runtime_name: 'ml-chn-v1-0-0-habc', display_name: 'CHN', version: '1.0.0', description: 'facts', activation_id: 'a', version_id: 'v', generation: 2, archive_sha256: 'a'.repeat(64) },
      { desired_enabled: true, ack_status: 'pending', runtime_name: 'ml-pending-v1-0-0-hdef', display_name: 'Pending', version: '1.0.0', description: '', activation_id: 'p', version_id: 'pv', generation: 1, archive_sha256: 'b'.repeat(64) },
    ] } : { archive_sha256: 'a'.repeat(64), instruction: 'Use facts.', instruction_sha256: 'c'.repeat(64) } } }
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
