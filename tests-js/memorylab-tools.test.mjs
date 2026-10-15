import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MemoryLabToolClient } from '../packages/memorylab-data-tools/src/client.js'
import { apply } from '../packages/memorylab-data-tools/src/index.js'

function client(root, store) {
  return new MemoryLabToolClient({
    origin: 'http://memorylab.test', publicOrigin: 'http://portal.test',
    instanceId: 'memorylab-dsh', secret: 'x'.repeat(32), timeoutMs: 1000,
    maxUploadBytes: 1024 * 1024, attachmentsRoot: root, store,
  })
}

const exec = { agent: { session: { header: { id: 'session-a' } } } }

function execWithFile(ref) {
  return {
    agent: { session: {
      header: { id: 'session-a' },
      eventSource: { getSnapshot: () => ({ entries: [{ type: 'event', event: {
        type: 'user/message', data: { message: { content: [{ type: 'file', attachment: ref }] } },
      } }] }) },
    } },
  }
}

function execWithPendingFile(ref) {
  return {
    agent: { session: {
      header: { id: 'session-a' },
      getSnapshot: () => ({ pendingSubmissions: [{ attachments: [{ type: 'file', value: ref }] }] }),
    } },
  }
}

test('Memory Lab query scope comes only from the bound DSH session', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memorylab-attachments-'))
  const store = { requireActive(id) {
    assert.equal(id, 'session-a')
    return { contextId: 'context-a', instanceId: 'memorylab-dsh', accessGrantId: 'grant-a' }
  } }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.context_id, 'context-a')
    assert.equal(body.session_id, 'session-a')
    assert.equal(options.headers['x-dsh-access-grant-id'], 'grant-a')
    assert.equal('user_id' in body, false)
    return new Response(JSON.stringify({ ok: true, data: { items: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  assert.equal((await client(root, store).query('memorylab_list_datasets', {}, exec)).ok, true)
})

test('Memory Lab tools fail closed before network on an incomplete binding', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memorylab-incomplete-binding-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = { requireActive() { return { contextId: 'context-a', instanceId: 'memorylab-dsh' } } }
  let called = false
  t.mock.method(globalThis, 'fetch', async () => { called = true; throw new Error('network must not be reached') })
  await assert.rejects(
    client(root, store).query('memorylab_list_datasets', {}, exec),
    /SESSION_CONTEXT_MISMATCH/u,
  )
  assert.equal(called, false)
})

test('Memory Lab client creates a missing attachment root on first startup', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'memorylab-home-'))
  const root = join(parent, 'attachments', 'v1', 'files')
  const store = { requireActive() { return { contextId: 'context-a', instanceId: 'memorylab-dsh', accessGrantId: 'grant-a' } } }
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  assert.equal(client(root, store).attachmentsRoot, root)
})

test('Memory Lab tool definitions compile and register with the official schema compiler', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memorylab-plugin-'))
  const previous = new Map()
  const environment = {
    DSH_HOME: root,
    MEMORYLAB_AI_INTEGRATION_ENABLED: 'true',
    MEMORYLAB_AI_API_ORIGIN: 'http://memorylab.test',
    MEMORYLAB_AI_PUBLIC_ORIGIN: 'http://portal.test',
    MEMORYLAB_AI_DSH_INSTANCE_ID: 'memorylab-dsh',
    MEMORYLAB_AI_TOOL_SECRET: 'x'.repeat(32),
  }
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  const definitions = []
  let dispose
  apply({
    tools: { register(definition) { definitions.push(definition) } },
    effect(callback) { dispose = callback() },
  })

  assert.equal(definitions.length, 7)
  dispose()
})

test('Memory Lab upload accepts only a CSV inside the DSH attachment store', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memorylab-attachments-'))
  const csvContent = 'CHN,BG,BANK,Row,Col\n0,0,0,1,2\n'
  const digest = createHash('sha256').update(csvContent).digest('hex')
  const ref = { attachmentId: `sha256:${digest}`, name: 'sample.csv', bytes: Buffer.byteLength(csvContent) }
  const nested = join(root, digest.slice(0, 2), digest)
  mkdirSync(nested, { recursive: true })
  const csv = join(nested, 'sample.csv')
  const outside = join(tmpdir(), `outside-${Date.now()}.csv`)
  writeFileSync(csv, csvContent)
  writeFileSync(outside, 'outside')
  const store = { requireActive() { return { contextId: 'context-a', instanceId: 'memorylab-dsh', accessGrantId: 'grant-a' } } }
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { force: true })
  })
  let uploaded = false
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    uploaded = options.body instanceof FormData
    assert.equal(options.body.get('context_id'), 'context-a')
    assert.equal(options.body.get('session_id'), 'session-a')
    assert.equal(options.body.get('attachment_id'), ref.attachmentId)
    assert.equal(options.body.get('attachment_bytes'), String(ref.bytes))
    assert.equal(options.body.get('attachment_sha256'), digest)
    assert.equal(options.headers['x-dsh-access-grant-id'], 'grant-a')
    return new Response(JSON.stringify({ ok: true, data: { job_id: 'job-a' } }), {
      status: 202, headers: { 'content-type': 'application/json' },
    })
  })
  assert.equal((await client(root, store).upload(csv, execWithFile(ref))).data.job_id, 'job-a')
  assert.equal(uploaded, true)
  await assert.rejects(client(root, store).upload(outside, execWithFile(ref)), /FILE_NOT_ALLOWED|ATTACHMENT_SESSION_MISMATCH/u)
  await assert.rejects(client(root, store).upload({ attachmentId: `sha256:${'b'.repeat(64)}` }, execWithFile(ref)), /ATTACHMENT_SESSION_MISMATCH/u)
})

test('Memory Lab upload reads official file blocks and pending submission references only', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memorylab-attachments-'))
  const csvContent = 'CHN,BG,BANK,Row,Col\n0,0,0,1,2\n'
  const digest = createHash('sha256').update(csvContent).digest('hex')
  const ref = { attachmentId: `sha256:${digest}`, name: 'pending.csv', bytes: Buffer.byteLength(csvContent) }
  const nested = join(root, digest.slice(0, 2), digest)
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, ref.name), csvContent)
  const store = { requireActive() { return { contextId: 'context-a', instanceId: 'memorylab-dsh', accessGrantId: 'grant-a' } } }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.body.get('session_id'), 'session-a')
    assert.equal(options.body.get('attachment_id'), ref.attachmentId)
    assert.equal(options.body.get('attachment_bytes'), String(ref.bytes))
    assert.equal(options.body.get('attachment_sha256'), digest)
    return new Response(JSON.stringify({ ok: true, data: { job_id: 'job-pending' } }), {
      status: 202, headers: { 'content-type': 'application/json' },
    })
  })

  // The official durable transcript shape is a `type: file` block.
  const transcriptExec = execWithFile(ref)
  assert.equal((await client(root, store).upload({ attachmentId: ref.attachmentId }, transcriptExec)).data.job_id, 'job-pending')

  // The official pending submission shape is `{ type: 'file', value: ref }`.
  const pendingExec = execWithPendingFile(ref)
  assert.equal((await client(root, store).upload({ attachmentId: ref.attachmentId }, pendingExec)).data.job_id, 'job-pending')

  // An image block must never become a file upload reference, even if it has
  // a file-looking name and digest-shaped attachment id.
  const imageExec = {
    agent: { session: {
      header: { id: 'session-a' },
      eventSource: { getSnapshot: () => ({ entries: [{ event: {
        data: { message: { content: [{ type: 'image', attachment: ref }] } },
      } }] }) },
    } },
  }
  await assert.rejects(
    client(root, store).upload({ attachmentId: ref.attachmentId }, imageExec),
    /ATTACHMENT_SESSION_MISMATCH/u,
  )
})

