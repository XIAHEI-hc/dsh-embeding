import http from 'node:http'
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loadRuntimeRegistry, runtimeForSubject } from '../../workbench-extensions/src/runtime-registry.js'

const COOKIE = 'dsh_scope'

function b64(value) { return Buffer.from(value).toString('base64url') }
function unb64(value) { return Buffer.from(value, 'base64url').toString('utf8') }

export function signScope(scope, secret, now = Date.now()) {
  const payload = b64(JSON.stringify({ ...scope, iat: now, jti: randomUUID() }))
  const mac = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

export function verifyScope(token, secret, maxAgeMs = 8 * 60 * 60 * 1000, now = Date.now()) {
  if (typeof token !== 'string') return undefined
  const [payload, encodedMac] = token.split('.')
  if (!payload || !encodedMac) return undefined
  const expected = createHmac('sha256', secret).update(payload).digest()
  let actual
  try { actual = Buffer.from(encodedMac, 'base64url') } catch { return undefined }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  let value
  try { value = JSON.parse(unb64(payload)) } catch { return undefined }
  if (!value || typeof value.subject !== 'string' || typeof value.runtime_id !== 'string' || typeof value.iat !== 'number') return undefined
  if (now - value.iat < 0 || now - value.iat > maxAgeMs) return undefined
  return Object.freeze(value)
}

function parseCookies(value = '') {
  return Object.fromEntries(value.split(';').map(item => item.trim().split('='))
    .filter(([key, val]) => key && val).map(([key, val]) => [key, decodeURIComponent(val)]))
}

function writeJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': body.length, ...headers })
  res.end(body)
}

function serviceAuthorized(req, secret) {
  const token = req.headers.authorization
  if (typeof token !== 'string' || !token.startsWith('Bearer ')) return false
  const expected = Buffer.from(secret); const actual = Buffer.from(token.slice(7))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function runtimeControlSecret(runtime) {
  if (typeof runtime.controlSecretFile !== 'string') return undefined
  try { return readFileSync(runtime.controlSecretFile, 'utf8').trim() } catch { return undefined }
}

function scopeProof(scope, runtime) {
  const secret = runtimeControlSecret(runtime)
  if (!secret) return undefined
  const body = JSON.stringify({
    subject: scope.subject, runtime_id: runtime.runtimeId,
    context_id: scope.context_id ?? null, session_id: scope.session_id ?? null,
    access_grant_id: scope.access_grant_id ?? null,
  })
  return createHmac('sha256', secret).update(body).digest('base64url')
}

async function verifyLiveScope(scope, runtime, verifyOrigin, hostInstanceId, timeoutMs = 5000, fetchImpl = fetch) {
  if (!verifyOrigin) return { ok: true }
  const secret = runtimeControlSecret(runtime)
  if (!secret || !scope.context_id || !scope.session_id || !scope.access_grant_id) return { ok: false, error: 'SCOPE_DENIED' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${verifyOrigin.replace(/\/$/u, '')}/api/ai/contexts/${encodeURIComponent(scope.context_id)}/sessions/${encodeURIComponent(scope.session_id)}/verify`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${secret}`,
        'x-dsh-instance-id': hostInstanceId,
        'x-dsh-runtime-id': runtime.runtimeId,
        'x-dsh-access-grant-id': scope.access_grant_id,
      },
      signal: controller.signal,
    })
    const body = await response.json().catch(() => undefined)
    return response.ok && body?.ok === true ? { ok: true } : { ok: false, error: 'SCOPE_DENIED' }
  } catch {
    return { ok: false, error: 'RUNTIME_UNAVAILABLE' }
  } finally {
    clearTimeout(timer)
  }
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = []; let total = 0
  for await (const chunk of req) { total += chunk.length; if (total > limit) throw new Error('request too large'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function targetFor(req, registry, secret, now, maxAgeMs) {
  const token = parseCookies(req.headers.cookie).dsh_scope
  const scope = verifyScope(token, secret, maxAgeMs, now)
  if (!scope) return { error: 'AUTH_REQUIRED' }
  let runtime
  try { runtime = runtimeForSubject(registry, scope.subject) } catch (error) { return { error: error.code ?? 'RUNTIME_NOT_PROVISIONED' } }
  if (runtime.runtimeId !== scope.runtime_id) return { error: 'SCOPE_DENIED' }
  return { scope, runtime }
}

export function createRuntimeGateway({ registryPath, scopeSecret, serviceSecret, maxScopeAgeMs, liveCheckIntervalMs, fetchImpl = fetch }) {
  if (!scopeSecret || !serviceSecret) throw new Error('scopeSecret and serviceSecret are required')
  const registry = loadRuntimeRegistry(registryPath)
  const maxAge = maxScopeAgeMs ?? 8 * 60 * 60 * 1000
  const verifyOrigin = process.env.MEMORYLAB_RUNTIME_VERIFY_ORIGIN
  const verifyTimeoutMs = Number(process.env.MEMORYLAB_RUNTIME_VERIFY_TIMEOUT_MS ?? 5000)
  const configuredLiveInterval = Number(liveCheckIntervalMs ?? process.env.MEMORYLAB_RUNTIME_LIVE_CHECK_INTERVAL_MS ?? 5000)
  const liveInterval = Number.isFinite(configuredLiveInterval) && configuredLiveInterval >= 1000
    ? configuredLiveInterval : 5000
  const handoffs = new Map()
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') return writeJson(res, 200, { status: 'ready', host_instance_id: registry.hostInstanceId })
    if (req.url === '/internal/scope/bind' && req.method === 'POST') {
      if (!serviceAuthorized(req, serviceSecret)) return writeJson(res, 401, { error: { code: 'AUTH_REQUIRED' } })
      try {
        const body = await readJson(req)
        const runtime = runtimeForSubject(registry, body.subject)
        if (body.runtime_id !== runtime.runtimeId) return writeJson(res, 409, { error: { code: 'SCOPE_DENIED' } })
        const token = signScope({ subject: body.subject, runtime_id: runtime.runtimeId, context_id: body.context_id, session_id: body.session_id, access_grant_id: body.access_grant_id }, scopeSecret)
        const scopeTicket = randomUUID()
        handoffs.set(scopeTicket, { token, expiresAt: Date.now() + 60_000 })
        return writeJson(res, 200, { accepted: true, runtime_id: runtime.runtimeId, scope_ticket: scopeTicket })
      } catch (error) { return writeJson(res, error.code === 'RUNTIME_NOT_PROVISIONED' ? 409 : 422, { error: { code: error.code ?? 'INVALID_SCOPE' } }) }
    }
    if (req.url?.startsWith('/internal/control/') && ['GET', 'POST'].includes(req.method)) {
      if (!serviceAuthorized(req, serviceSecret)) return writeJson(res, 401, { error: { code: 'AUTH_REQUIRED' } })
      const subject = req.headers['x-dsh-subject']
      if (typeof subject !== 'string' || subject.length === 0) return writeJson(res, 422, { error: { code: 'INVALID_SCOPE' } })
      let runtime
      try { runtime = runtimeForSubject(registry, subject) } catch (error) { return writeJson(res, 409, { error: { code: error.code ?? 'RUNTIME_NOT_PROVISIONED' } }) }
      const credential = runtimeControlSecret(runtime)
      if (!credential) return writeJson(res, 503, { error: { code: 'RUNTIME_UNAVAILABLE' } })
      return proxyControl(req, res, runtime.internalOrigin, credential)
    }
    if (req.url?.startsWith('/scope/redeem') && req.method === 'GET') {
      const url = new URL(req.url, 'http://gateway.local')
      const ticket = url.searchParams.get('ticket')
      const handoff = ticket === null ? undefined : handoffs.get(ticket)
      if (ticket !== null) handoffs.delete(ticket)
      if (!handoff || handoff.expiresAt < Date.now()) return writeJson(res, 401, { error: { code: 'AUTH_REQUIRED' } })
      const next = url.searchParams.get('next') || '/'
      return res.writeHead(303, { location: next, 'set-cookie': `${COOKIE}=${encodeURIComponent(handoff.token)}; Path=/; HttpOnly; SameSite=Strict;${process.env.NODE_ENV === 'production' ? ' Secure;' : ''}` }).end()
    }
    const target = targetFor(req, registry, scopeSecret, Date.now(), maxAge)
    if (target.error) return writeJson(res, target.error === 'AUTH_REQUIRED' ? 401 : 403, { error: { code: target.error } })
    const live = await verifyLiveScope(target.scope, target.runtime, verifyOrigin, registry.hostInstanceId, verifyTimeoutMs, fetchImpl)
    if (!live.ok) return writeJson(res, live.error === 'RUNTIME_UNAVAILABLE' ? 503 : 403, { error: { code: live.error } })
    return proxyHttp(req, res, target.runtime.internalOrigin, target.scope)
  })
  server.on('upgrade', async (req, socket, head) => {
    const target = targetFor(req, registry, scopeSecret, Date.now(), maxAge)
    if (target.error) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    const live = await verifyLiveScope(target.scope, target.runtime, verifyOrigin, registry.hostInstanceId, verifyTimeoutMs, fetchImpl)
    if (!live.ok) { socket.write(`HTTP/1.1 ${live.error === 'RUNTIME_UNAVAILABLE' ? 503 : 403} Forbidden\r\nConnection: close\r\n\r\n`); socket.destroy(); return }
    proxyUpgrade(req, socket, head, target.runtime.internalOrigin, target.scope, async () => {
      const current = await verifyLiveScope(target.scope, target.runtime, verifyOrigin, registry.hostInstanceId, verifyTimeoutMs, fetchImpl)
      return current.ok
    }, liveInterval)
  })
  return { server, registry }
}

function proxyHeaders(req, scope, runtime) {
  const { cookie: _cookie, ...incoming } = req.headers
  const proof = scopeProof(scope, runtime)
  return {
    ...incoming,
    host: new URL(runtime.internalOrigin).host,
    'x-dsh-runtime-id': runtime.runtimeId,
    'x-dsh-scope-subject': scope.subject,
    ...(scope.context_id === undefined ? {} : { 'x-dsh-scope-context-id': scope.context_id }),
    ...(scope.session_id === undefined ? {} : { 'x-dsh-scope-session-id': scope.session_id }),
    ...(scope.access_grant_id === undefined ? {} : { 'x-dsh-access-grant-id': scope.access_grant_id }),
    ...(proof === undefined ? {} : { 'x-dsh-scope-proof': proof }),
  }
}

function proxyHttp(req, res, origin, scope) {
  const target = new URL(req.url ?? '/', origin)
  const upstream = http.request({ protocol: target.protocol, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: req.method, headers: proxyHeaders(req, scope, { internalOrigin: origin, runtimeId: scope.runtime_id }) }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res)
  })
  upstream.on('error', error => { if (!res.headersSent) writeJson(res, 502, { error: { code: 'RUNTIME_UNAVAILABLE', message: error.message } }); else res.destroy(error) })
  req.pipe(upstream)
}

function proxyUpgrade(req, socket, head, origin, scope, verify, liveInterval) {
  const target = new URL(req.url ?? '/', origin)
  const upstream = http.request({ protocol: target.protocol, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET', headers: { ...proxyHeaders(req, scope, { internalOrigin: origin, runtimeId: scope.runtime_id }), connection: 'Upgrade' } })
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([key]) => key !== 'connection').map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) upstreamSocket.write(head)
    upstreamSocket.pipe(socket).pipe(upstreamSocket)
    let checking = false
    const timer = setInterval(() => {
      if (checking || socket.destroyed || upstreamSocket.destroyed) return
      checking = true
      Promise.resolve(verify()).then(ok => {
        if (!ok) {
          socket.destroy()
          upstreamSocket.destroy()
        }
      }).catch(() => {
        socket.destroy()
        upstreamSocket.destroy()
      }).finally(() => { checking = false })
    }, liveInterval)
    timer.unref?.()
    const cleanup = () => clearInterval(timer)
    socket.once('close', cleanup)
    upstreamSocket.once('close', cleanup)
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
}

function proxyControl(req, res, origin, credential) {
  const target = new URL(req.url.replace(/^\/internal\/control/u, '') || '/', origin)
  const headers = { ...req.headers, host: target.host, authorization: `Bearer ${credential}` }
  delete headers['x-dsh-subject']
  const upstream = http.request({ protocol: target.protocol, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: req.method, headers }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res)
  })
  upstream.on('error', error => { if (!res.headersSent) writeJson(res, 502, { error: { code: 'RUNTIME_UNAVAILABLE', message: error.message } }); else res.destroy(error) })
  req.pipe(upstream)
}
