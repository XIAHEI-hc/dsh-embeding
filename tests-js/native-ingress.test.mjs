import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { createRuntimeGateway, nativeRoute, signScope } from '@dsh-workbench/runtime-gateway'

test('native route keys reject arbitrary URLs, traversal, methods and upgrade confusion', () => {
  assert.equal(nativeRoute('/internal/native/transport/rpc/session/prompt', 'POST'), '/api/session/prompt')
  assert.equal(nativeRoute('/internal/native/transport/file?path=a%2Fb', 'GET'), '/api/file?path=a%2Fb')
  assert.equal(nativeRoute('/internal/native/transport/upload?sessionId=session-a&name=a.bin', 'POST', false, { session_id: 'session-a' }), '/api/session/uploadFileBinary?sessionId=session-a&name=a.bin')
  for (const query of ['', '?sessionId=other', '?sessionId=session-a&sessionId=session-a', '?sessionId=session-a&url=evil']) {
    assert.equal(nativeRoute(`/internal/native/transport/upload${query}`, 'POST', false, { session_id: 'session-a' }), undefined)
  }
  for (const key of ['https://evil.test', '//evil', '../control', 'rpc/session/unknown', 'rpc/session/prompt?url=evil']) {
    assert.equal(nativeRoute(`/internal/native/transport/${key}`, 'POST'), undefined)
  }
  assert.equal(nativeRoute('/internal/native/transport/rpc/session/prompt', 'GET'), undefined)
  assert.equal(nativeRoute('/internal/native/transport/stream', 'GET'), undefined)
  assert.equal(nativeRoute('/internal/native/transport/stream', 'GET', true), '/api/remote.mux')
})

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-'))
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
    res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'application/octet-stream', 'set-cookie': 'operator=never-leak' })
    res.end(Buffer.concat(chunks))
  })
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', (socket, req) => { requests.push({ url: req.url, headers: req.headers }); socket.on('message', (data, binary) => socket.send(data, { binary })) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  writeFileSync(join(root, 'secret'), 'runner-secret-012345678901234567890123')
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ schema_version: '1.0', host_instance_id: 'instance-a', runtimes: [
    { subject: 'user-a', runtime_id: 'runner-a', internal_origin: `http://127.0.0.1:${upstream.address().port}`, control_secret_file: join(root, 'secret'), status: 'ready' },
  ] }))
  const previous = process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN
  process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN = 'http://memorylab.test'
  let allowed = true
  const gateway = createRuntimeGateway({ registryPath: join(root, 'registry.json'), scopeSecret: 'scope-secret', serviceSecret: 'service-secret', liveCheckIntervalMs: 1000,
    fetchImpl: async () => Response.json({ ok: allowed, scope: { context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a', dsh_instance_id: 'instance-a' } }, { status: allowed ? 200 : 403 }),
  })
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening')
  t.after(() => {
    for (const client of wss.clients) client.terminate()
    gateway.server.closeAllConnections(); gateway.server.close(); wss.close(); upstream.closeAllConnections(); upstream.close()
    if (previous === undefined) delete process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN
    else process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN = previous
    rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${gateway.server.address().port}`
  const scope = { subject: 'user-a', runtime_id: 'runner-a', context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a', connection_id: 'connection-a' }
  const auth = { authorization: 'Bearer service-secret' }
  const bind = body => fetch(`${base}/internal/native/bind`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const bound = await bind(scope)
  assert.equal(bound.status, 200)
  const credential = (await bound.json()).scope_credential
  return { base, scope, auth, bind, requests, credential, revoke: () => { allowed = false } }
}

test('native ingress requires both service and native scope; preserves binary and original Origin', async t => {
  const f = await fixture(t)
  const headers = { ...f.auth, 'x-dsh-native-scope': f.credential, origin: 'http://memorylab.test', cookie: 'operator=must-not-forward', 'content-type': 'multipart/form-data; boundary=bytes', 'x-dsh-scope-subject': 'forged' }
  const bytes = Buffer.from([0, 255, 13, 10, 128, 1])
  const url = `${f.base}/internal/native/transport/upload?sessionId=session-a`
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-dsh-native-scope': f.credential } })).status, 401)
  assert.equal((await fetch(url, { method: 'POST', headers: f.auth })).status, 403)
  const legacy = signScope(f.scope, 'scope-secret')
  assert.equal((await fetch(url, { method: 'POST', headers: { ...f.auth, 'x-dsh-native-scope': legacy } })).status, 403)
  assert.equal((await f.bind({ ...f.scope, runtime_id: 'runner-b' })).status, 403)
  const response = await fetch(url, { method: 'POST', headers, body: bytes })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal(f.requests[0].url, '/api/session/uploadFileBinary?sessionId=session-a')
  assert.deepEqual(f.requests[0].body, bytes)
  assert.equal(f.requests[0].headers.origin, 'http://memorylab.test')
  assert.equal(f.requests[0].headers['x-dsh-scope-subject'], 'user-a')
  for (const key of ['cookie', 'authorization', 'x-dsh-native-scope']) assert.equal(f.requests[0].headers[key], undefined)
  f.revoke()
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 403)
  assert.equal((await f.bind(f.scope)).status, 403)
  assert.equal(f.requests.length, 1)
})

test('native mux preserves text/binary frames and closes an active socket after lease revoke', async t => {
  const f = await fixture(t)
  const socket = new WebSocket(`${f.base.replace('http:', 'ws:')}/internal/native/transport/stream`, { headers: { ...f.auth, 'x-dsh-native-scope': f.credential }, origin: 'http://memorylab.test' })
  t.after(() => socket.terminate())
  await once(socket, 'open')
  socket.send('{"type":"open","rpcId":"unchanged"}')
  const [text, isBinary] = await once(socket, 'message')
  assert.equal(text.toString(), '{"type":"open","rpcId":"unchanged"}'); assert.equal(isBinary, false)
  socket.send(Buffer.from([0, 255, 128]))
  const [binary, binaryFlag] = await once(socket, 'message')
  assert.deepEqual(binary, Buffer.from([0, 255, 128])); assert.equal(binaryFlag, true)
  assert.equal(f.requests[0].url, '/api/remote.mux')
  assert.equal(f.requests[0].headers.origin, 'http://memorylab.test')
  f.revoke()
  const timeout = setTimeout(() => socket.terminate(), 4000)
  const [code] = await once(socket, 'close'); clearTimeout(timeout)
  assert.equal(code, 1006)
  assert.equal(socket.readyState, WebSocket.CLOSED)
})
