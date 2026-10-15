import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { enrichPagePrompt } from '../packages/workbench-extensions/src/page-context.js'

const canonical = JSON.stringify({
  page_kind: 'failure_map', dataset_id: 'dataset-1', revision: 'rev-1',
  applied_filters: {}, scope: { level: 'Channel' },
  facts: { scoped_rows: 3 }, sources: [], skills: [], truncated: false,
})
const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
const config = {
  integrationKind: 'memorylab', pageContextEnabled: true, apiOrigin: 'http://memorylab.test',
  toolSecret: 'secret', instanceId: 'instance-1', verifyTimeoutMs: 1000,
}
const integration = { store: { requireActive: () => ({
  pageSurfaceId: 'failure-map:dataset-1', accessGrantId: 'grant-1', runtimeId: undefined,
}) } }

test('page context enrichment preserves native attachments and appends verified facts', async () => {
  let request
  const result = await enrichPagePrompt(integration, config, {
    requestId: 'native-1', sessionId: 'session-1',
    pageContext: { snapshotId: 'snapshot-1', snapshotSha256: digest,
      surfaceId: 'failure-map:dataset-1', protocolVersion: '1.0' },
    content: [{ type: 'text', text: '分析当前范围' }, { type: 'file', receiptId: 'file-1' }],
  }, async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200, async json() {
      return { ok: true, snapshot_sha256: digest, canonical_json: canonical }
    } }
  })
  assert.equal(request.url, 'http://memorylab.test/api/ai/internal/page-contexts/snapshot-1')
  assert.equal(request.options.headers['x-dsh-runtime-id'], undefined)
  assert.equal(result.content[1].receiptId, 'file-1')
  assert.match(result.content.at(-1).text, /PAGE_CONTEXT_DATA_V1/)
  assert.match(result.content.at(-1).text, /"scoped_rows":3/)
})

test('page context enrichment rejects a tampered canonical digest', async () => {
  await assert.rejects(
    enrichPagePrompt(integration, config, {
      requestId: 'native-2', sessionId: 'session-1',
      pageContext: { snapshotId: 'snapshot-1', snapshotSha256: digest,
        surfaceId: 'failure-map:dataset-1', protocolVersion: '1.0' }, content: [{ type: 'text', text: 'x' }],
    }, async () => ({ ok: true, status: 200, async json() {
      return { ok: true, snapshot_sha256: digest, canonical_json: `${canonical}x` }
    } })),
    error => error.code === 'PAGE_CONTEXT_DIGEST_MISMATCH',
  )
})

test('page context enrichment maps FastAPI detail errors', async () => {
  await assert.rejects(
    enrichPagePrompt(integration, config, {
      requestId: 'native-3', sessionId: 'session-1',
      pageContext: { snapshotId: 'missing', snapshotSha256: digest,
        surfaceId: 'failure-map:dataset-1', protocolVersion: '1.0' }, content: [{ type: 'text', text: 'x' }],
    }, async () => ({ ok: false, status: 404, async json() {
      return { detail: { code: 'PAGE_CONTEXT_NOT_FOUND' } }
    } })),
    error => error.code === 'PAGE_CONTEXT_NOT_FOUND',
  )
})
