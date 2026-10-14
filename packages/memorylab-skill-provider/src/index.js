import { createHash, randomUUID } from 'node:crypto'

const PROVIDER = 'memorylab-remote'

function abortIfNeeded(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function scopeBody(scope, extra = {}) {
  return { protocol_version: '1.0', request_id: randomUUID(), ...scope, ...extra }
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
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
    const response = await fetchImpl(`${baseUrl.replace(/\/$/u, '')}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(scopeBody(captured, body)), signal })
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

export { PROVIDER }
