import assert from 'node:assert/strict'
import test from 'node:test'
import { signScope, verifyScope, safeUpstreamTarget } from '@dsh-workbench/runtime-gateway'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntimeGateway } from '@dsh-workbench/runtime-gateway'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'

test('scope token is opaque, signed, and expires', () => {
  const issuedAt = 1_000_000
  const token = signScope({ subject: 'user-a', runtime_id: 'runner-a' }, 'secret', issuedAt)
  const value = verifyScope(token, 'secret', 60_000, issuedAt + 1_000)
  assert.equal(value.subject, 'user-a')
  assert.equal(value.runtime_id, 'runner-a')
  assert.equal(verifyScope(token, 'wrong', 60_000, issuedAt + 1_000), undefined)
  assert.equal(verifyScope(token, 'secret', 60_000, issuedAt + 60_001), undefined)
})

test('scope token rejects tampering and malformed payloads', () => {
  const token = signScope({ subject: 'user-a', runtime_id: 'runner-a' }, 'secret', 1_000)
  const [payload, mac] = token.split('.')
  assert.equal(verifyScope(`${payload}x.${mac}`, 'secret', 60_000, 2_000), undefined)
  assert.equal(verifyScope('garbage', 'secret'), undefined)
})

test('gateway binds only a registry-owned subject and issues HttpOnly scope cookie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-'))
  const registryPath = join(root, 'registry.json')
  writeFileSync(registryPath, JSON.stringify({ schema_version: '1.0', host_instance_id: 'instance-a', runtimes: [
    { subject: 'user-a', runtime_id: 'runner-a', internal_origin: 'http://127.0.0.1:9', status: 'ready' },
  ] }))
  const gateway = createRuntimeGateway({ registryPath, scopeSecret: 'scope-secret', serviceSecret: 'service-secret' })
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  const address = gateway.server.address()
  const base = `http://127.0.0.1:${address.port}`
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  const denied = await fetch(`${base}/internal/scope/bind`, { method: 'POST', headers: { authorization: 'Bearer service-secret', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-b', runtime_id: 'runner-b' }) })
  assert.equal(denied.status, 409)
  const bound = await fetch(`${base}/internal/scope/bind`, { method: 'POST', headers: { authorization: 'Bearer service-secret', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-a', runtime_id: 'runner-a', context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a' }) })
  assert.equal(bound.status, 200)
  const scopeTicket = (await bound.json()).scope_ticket
  const redeemed = await fetch(`${base}/scope/redeem?ticket=${encodeURIComponent(scopeTicket)}`, { redirect: 'manual' })
  assert.equal(redeemed.status, 303)
  assert.match(redeemed.headers.get('set-cookie'), /HttpOnly/)
  gateway.server.close()
})

test('gateway rejects malformed scope cookies and never redirects outside its origin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-cookie-'))
  const registryPath = join(root, 'registry.json')
  writeFileSync(registryPath, JSON.stringify({ schema_version: '1.0', host_instance_id: 'instance-a', runtimes: [
    { subject: 'user-a', runtime_id: 'runner-a', internal_origin: 'http://127.0.0.1:9', status: 'ready' },
  ] }))
  const gateway = createRuntimeGateway({ registryPath, scopeSecret: 'scope-secret', serviceSecret: 'service-secret' })
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  const address = gateway.server.address()
  const base = `http://127.0.0.1:${address.port}`
  const malformed = await fetch(`${base}/api/native`, { headers: { cookie: 'dsh_scope=%E0%A4%A' } })
  assert.equal(malformed.status, 401)
  const bound = await fetch(`${base}/internal/scope/bind`, { method: 'POST', headers: { authorization: 'Bearer service-secret', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-a', runtime_id: 'runner-a', context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a' }) })
  const ticket = (await bound.json()).scope_ticket
  const redeemed = await fetch(`${base}/scope/redeem?ticket=${encodeURIComponent(ticket)}&next=https%3A%2F%2Fevil.example%2Fsteal`, { redirect: 'manual' })
  assert.equal(redeemed.status, 303)
  assert.equal(redeemed.headers.get('location'), '/')
  gateway.server.close()
})

test('gateway target validation rejects absolute-form and network-path targets', () => {
  assert.equal(safeUpstreamTarget('/api/native?x=1', 'http://runner:8765').origin, 'http://runner:8765')
  assert.equal(safeUpstreamTarget('http://evil.example/steal', 'http://runner:8765'), undefined)
  assert.equal(safeUpstreamTarget('//evil.example/steal', 'http://runner:8765'), undefined)
})

test('gateway performs a live Memory Lab lease check before forwarding native requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-live-'))
  let forwardedHeaders
  const upstream = http.createServer((req, res) => { forwardedHeaders = req.headers; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('runner-ok') })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  const registryPath = join(root, 'registry.json')
  const runtimeSecretPath = join(root, 'runner-secret')
  writeFileSync(runtimeSecretPath, 'runner-secret')
  writeFileSync(registryPath, JSON.stringify({ schema_version: '1.0', host_instance_id: 'instance-a', runtimes: [
    { subject: 'user-a', runtime_id: 'runner-a', internal_origin: `http://127.0.0.1:${upstreamAddress.port}`, control_secret_file: runtimeSecretPath, status: 'ready' },
  ] }))
  const previous = process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN
  process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN = 'http://memorylab.test'
  let allowed = true
  let scopeMatches = true
  const gateway = createRuntimeGateway({
    registryPath, scopeSecret: 'scope-secret', serviceSecret: 'service-secret',
    fetchImpl: async () => new Response(JSON.stringify({
      ok: allowed,
      ...(scopeMatches ? { scope: { context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a', dsh_instance_id: 'instance-a' } } : {
        scope: { context_id: 'ctx-other', session_id: 'session-other', access_grant_id: 'grant-other', dsh_instance_id: 'instance-a' },
      }),
    }), { status: allowed ? 200 : 403 }),
  })
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  const address = gateway.server.address()
  const base = `http://127.0.0.1:${address.port}`
  const bound = await fetch(`${base}/internal/scope/bind`, { method: 'POST', headers: { authorization: 'Bearer service-secret', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-a', runtime_id: 'runner-a', context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a' }) })
  const ticket = (await bound.json()).scope_ticket
  const redeemed = await fetch(`${base}/scope/redeem?ticket=${encodeURIComponent(ticket)}`, { redirect: 'manual' })
  const cookie = redeemed.headers.get('set-cookie').split(';', 1)[0]
  const forwarded = await fetch(`${base}/api/native`, { headers: { cookie } })
  assert.equal(forwarded.status, 200)
  assert.equal(await forwarded.text(), 'runner-ok')
  assert.equal(forwardedHeaders['x-dsh-runtime-id'], 'runner-a')
  assert.equal(forwardedHeaders['x-dsh-scope-subject'], 'user-a')
  assert.equal(forwardedHeaders['x-dsh-scope-context-id'], 'ctx-a')
  assert.equal(forwardedHeaders['x-dsh-scope-session-id'], 'session-a')
  assert.equal(forwardedHeaders['x-dsh-access-grant-id'], 'grant-a')
  const proofBody = JSON.stringify({ subject: 'user-a', runtime_id: 'runner-a', context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a' })
  assert.equal(forwardedHeaders['x-dsh-scope-proof'], createHmac('sha256', 'runner-secret').update(proofBody).digest('base64url'))
  scopeMatches = false
  const mismatched = await fetch(`${base}/api/native`, { headers: { cookie } })
  assert.equal(mismatched.status, 403)
  allowed = false
  const revoked = await fetch(`${base}/api/native`, { headers: { cookie } })
  assert.equal(revoked.status, 403)
  gateway.server.close(); upstream.close()
  if (previous === undefined) delete process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN
  else process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN = previous
})

test('gateway preserves the Connection: Upgrade header for native WebSocket clients', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-ws-'))
  const upstream = http.createServer()
  const upstreamWs = new WebSocketServer({ server: upstream })
  upstreamWs.on('connection', socket => socket.send('runner-ws-ok'))
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  const registryPath = join(root, 'registry.json')
  const runtimeSecretPath = join(root, 'runner-secret')
  writeFileSync(runtimeSecretPath, 'runner-secret')
  writeFileSync(registryPath, JSON.stringify({ schema_version: '1.0', host_instance_id: 'instance-a', runtimes: [
    { subject: 'user-a', runtime_id: 'runner-a', internal_origin: `http://127.0.0.1:${upstreamAddress.port}`, control_secret_file: runtimeSecretPath, status: 'ready' },
  ] }))
  const previous = process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN
  process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN = 'http://memorylab.test'
  const gateway = createRuntimeGateway({
    registryPath, scopeSecret: 'scope-secret', serviceSecret: 'service-secret',
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, scope: {
      context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a', dsh_instance_id: 'instance-a',
    } }), { status: 200 }),
  })
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  const address = gateway.server.address()
  const base = `http://127.0.0.1:${address.port}`
  const bound = await fetch(`${base}/internal/scope/bind`, { method: 'POST', headers: { authorization: 'Bearer service-secret', 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'user-a', runtime_id: 'runner-a', context_id: 'ctx-a', session_id: 'session-a', access_grant_id: 'grant-a' }) })
  const ticket = (await bound.json()).scope_ticket
  const redeemed = await fetch(`${base}/scope/redeem?ticket=${encodeURIComponent(ticket)}`, { redirect: 'manual' })
  const cookie = redeemed.headers.get('set-cookie').split(';', 1)[0]
  const message = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/remote.mux`, { headers: { cookie }, origin: 'http://127.0.0.1' })
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('websocket handshake timed out')) }, 3000)
    socket.once('message', value => { clearTimeout(timer); resolve(value.toString()); socket.close() })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
  assert.equal(message, 'runner-ws-ok')
  gateway.server.close(); upstreamWs.close(); upstream.close()
  if (previous === undefined) delete process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN
  else process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN = previous
})

