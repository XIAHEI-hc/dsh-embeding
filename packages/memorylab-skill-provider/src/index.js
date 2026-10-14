import { createHash, randomUUID } from 'node:crypto'

const PROVIDER = 'memorylab-remote'
const RUNTIME_PATH = '/api/skills/runtime/v1'

function runtimeUrl(baseUrl, path) {
  const origin = baseUrl.replace(/\/$/u, '')
  const prefix = origin.endsWith(RUNTIME_PATH) ? origin : `${origin}${RUNTIME_PATH}`
  return `${prefix}${path}`
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function scopeBody(scope, extra = {}) {
  return { protocol_version: '1.0', request_id: randomUUID(), ...scope, ...extra }
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

async function protocolRequest({ baseUrl, serviceSecret, instanceId, runtimeId, scope, path, body, fetchImpl, signal }) {
  abortIfNeeded(signal)
  const response = await fetchImpl(runtimeUrl(baseUrl, path), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${serviceSecret}`, 'x-dsh-instance-id': instanceId, 'x-dsh-runtime-id': runtimeId },
    body: JSON.stringify({ protocol_version: '1.0', request_id: randomUUID(), ...scope, ...body }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) { const error = new Error(payload?.error?.message ?? payload?.detail?.message ?? `Memory Lab request failed: ${response.status}`); error.code = payload?.error?.code ?? payload?.detail?.code ?? 'PROVIDER_UNAVAILABLE'; throw error }
  return payload
}

/** Pull, validate, self-check and acknowledge one exact runtime catalog. */
export async function synchronizeRemoteProvider({ baseUrl, serviceSecret, instanceId, runtimeId, scope, fetchImpl = fetch, signal }) {
  const catalog = await protocolRequest({ baseUrl, serviceSecret, instanceId, runtimeId, scope, path: '/catalog', body: undefined, fetchImpl, signal })
  const installed = []
  for (const row of catalog.items ?? []) {
    const locator = { activation_id: row.activation_id, version_id: row.version_id, generation: row.generation, archive_sha256: row.archive_sha256 }
    const status = row.desired_enabled ? 'installed' : 'removed'
    if (row.desired_enabled) {
      const resolved = await protocolRequest({ baseUrl, serviceSecret, instanceId, runtimeId, scope, path: '/resolve', body: locator, fetchImpl, signal })
      if (resolved.archive_sha256 !== row.archive_sha256 || typeof resolved.instruction !== 'string' || typeof resolved.instruction_sha256 !== 'string') {
        const error = new Error('resolved skill hash mismatch'); error.code = 'HASH_MISMATCH'; throw error
      }
      installed.push({ ...row, locator })
    }
    await protocolRequest({
      baseUrl, serviceSecret, instanceId, runtimeId, scope, path: '/ack',
      body: { ...locator, ack_id: randomUUID(), status, provider_revision: catalog.catalog_revision }, fetchImpl, signal,
    })
  }
  return { revision: catalog.catalog_revision, installed }
}

/**
 * A single-session, server-bound provider. The scope is supplied by the trusted
 * host integration; cwd is deliberately ignored as an identity signal.
 */
export function createRemoteProvider({ baseUrl, serviceSecret, instanceId, runtimeId, scope, control, fetchImpl = fetch }) {
  if (!scope?.context_id || !scope?.session_id || !scope?.access_grant_id) throw new Error('Memory Lab scope is incomplete')
  const captured = Object.freeze({ ...scope })
  const headers = () => ({ accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${serviceSecret}`, 'x-dsh-instance-id': instanceId, 'x-dsh-runtime-id': runtimeId })
  const request = async (path, body, signal) => {
    abortIfNeeded(signal)
    const response = await fetchImpl(runtimeUrl(baseUrl, path), { method: 'POST', headers: headers(), body: JSON.stringify(scopeBody(captured, body)), signal })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok) { const error = new Error(payload?.detail?.message ?? payload?.error?.message ?? `Memory Lab request failed: ${response.status}`); error.code = payload?.detail?.code ?? payload?.error?.code ?? 'PROVIDER_UNAVAILABLE'; throw error }
    return payload
  }
  let installed = new Map()
  const provider = {
    name: PROVIDER,
    async list(options = {}) {
      abortIfNeeded(options.signal)
      const result = await request('/catalog', undefined, options.signal)
      const next = new Map()
      for (const row of result.items ?? []) {
        if (!row.desired_enabled || row.ack_status !== 'installed') continue
        const candidate = { name: row.runtime_name, description: `${row.display_name} · v${row.version} · Memory Lab：${row.description}`, source: 'memorylab', provider: PROVIDER, rank: 600, invocation: { userInvocable: true, modelInvocable: false }, locator: { activation_id: row.activation_id, version_id: row.version_id, generation: row.generation, archive_sha256: row.archive_sha256, owner: captured.context_id }, metadata: { display_name: row.display_name, version: row.version } }
        next.set(candidate.name, candidate)
      }
      if (JSON.stringify([...next.keys()]) !== JSON.stringify([...installed.keys()])) control?.invalidate?.()
      installed = next
      return [...installed.values()]
    },
    async get(candidate, options = {}) {
      abortIfNeeded(options.signal)
      if (candidate?.provider !== PROVIDER || candidate?.locator?.owner !== captured.context_id) { const error = new Error('candidate scope denied'); error.code = 'SCOPE_DENIED'; throw error }
      const result = await request('/resolve', { activation_id: candidate.locator.activation_id, version_id: candidate.locator.version_id, generation: candidate.locator.generation, archive_sha256: candidate.locator.archive_sha256 }, options.signal)
      if (candidate.name !== `ml-${candidate.name.slice(3)}` || result.archive_sha256 !== candidate.locator.archive_sha256) { const error = new Error('skill version changed'); error.code = 'SKILL_VERSION_CHANGED'; throw error }
      abortIfNeeded(options.signal)
      return { name: candidate.name, description: candidate.description, source: 'memorylab', provider: PROVIDER, invocation: { userInvocable: true, modelInvocable: false }, content: result.instruction, resourceBase: { kind: 'opaque', description: '静态资源通过已授权 Memory Lab broker 提供。' }, metadata: { ...candidate.metadata, instruction_sha256: result.instruction_sha256, archive_sha256: result.archive_sha256 } }
    },
  }
  return provider
}

/** Create the server-side receipt immediately before native prompt admission. */
export async function admitInvocation({ baseUrl, serviceSecret, instanceId, runtimeId, scope, locator, invocationId, nativeRequestId, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(runtimeUrl(baseUrl, '/admit'), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${serviceSecret}`, 'x-dsh-instance-id': instanceId, 'x-dsh-runtime-id': runtimeId },
    body: JSON.stringify({ protocol_version: '1.0', request_id: randomUUID(), ...scope, ...locator, invocation_id: invocationId, native_request_id: nativeRequestId }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) { const error = new Error(payload?.detail?.message ?? 'Memory Lab admission failed'); error.code = payload?.detail?.code ?? 'PROVIDER_UNAVAILABLE'; throw error }
  return payload
}

/** Record one fact about a receipt after the native host has observed it. */
export async function recordUsage({ baseUrl, serviceSecret, instanceId, runtimeId, scope, locator, invocationId, nativeRequestId, phase, eventId = randomUUID(), occurredAt = new Date().toISOString(), errorCode, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(runtimeUrl(baseUrl, '/usage'), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${serviceSecret}`, 'x-dsh-instance-id': instanceId, 'x-dsh-runtime-id': runtimeId },
    body: JSON.stringify({ protocol_version: '1.0', request_id: randomUUID(), ...scope, ...locator, event_id: eventId, invocation_id: invocationId, native_request_id: nativeRequestId, phase, occurred_at: occurredAt, ...(errorCode === undefined ? {} : { error_code: errorCode }) }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) { const error = new Error(payload?.error?.message ?? payload?.detail?.message ?? `Memory Lab usage failed: ${response.status}`); error.code = payload?.error?.code ?? payload?.detail?.code ?? 'PROVIDER_UNAVAILABLE'; throw error }
  return payload
}

export { PROVIDER }
