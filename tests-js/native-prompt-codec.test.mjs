import assert from 'node:assert/strict'
import test from 'node:test'
import { TYPERT as host } from '../vendor/official-web-forks/dsh-api-session-controller/lib/typert.host.js'
import remote from '../vendor/official-web-forks/dsh-api-session-controller/lib/typert.remote-client.js'

const request = {
  requestId: 'native-request', sessionId: 'native-session', mode: 'queue',
  content: [{ type: 'text', text: 'Current page' }, { type: 'file', receiptId: 'upload-receipt' }],
  pageContext: { snapshotId: 'snapshot-id', snapshotSha256: 'a'.repeat(64), surfaceId: 'chn:dataset', protocolVersion: '1.0' },
}

for (const [label, descriptor] of [['host', host], ['remote', remote]]) {
  test(`official ${label} prompt codec preserves and validates page context`, () => {
    const method = (descriptor.invocations ?? descriptor.descriptors).find(row => row.namespace === 'session' && row.method === 'prompt')
    const schema = method.parameters[0].codec.create()
    assert.deepEqual(schema.parse(request), request)
    assert.equal(schema.safeParse({ ...request, pageContext: { ...request.pageContext, protocolVersion: '2.0' } }).success, false)
    assert.equal(schema.safeParse({ ...request, pageContext: { ...request.pageContext, snapshotSha256: 'invalid' } }).success, false)
    assert.equal(schema.safeParse({ ...request, pageContext: { ...request.pageContext, invented: true } }).success, false)
  })
}
