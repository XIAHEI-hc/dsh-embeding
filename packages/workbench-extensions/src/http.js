import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WorkbenchExtensionError, extensionError } from './errors.js'

export function requestId(req) {
  const supplied = req.headers['x-request-id']
  return typeof supplied === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(supplied)
    ? supplied
    : `req_${randomUUID()}`
}

export async function readJson(req, limit = 64 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new WorkbenchExtensionError('EMBED_PROTOCOL_UNSUPPORTED', { message: '请求正文过大' })
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed
  } catch (error) {
    throw new WorkbenchExtensionError('EMBED_PROTOCOL_UNSUPPORTED', { message: '请求正文必须是 JSON 对象', cause: error })
  }
}

export function writeJson(res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(bytes)
}

export function writeError(res, error, id, headers = {}) {
  const known = extensionError(error)
  writeJson(res, known.status, known.envelope(id), headers)
}

export function method(req, res, allowed) {
  if (allowed.includes(req.method)) return true
  res.writeHead(405, { allow: allowed.join(', '), 'cache-control': 'no-store' })
  res.end()
  return false
}

export function bearer(req) {
  const value = req.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined
}

export function secretEqual(actual, expected) {
  if (typeof actual !== 'string') return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
