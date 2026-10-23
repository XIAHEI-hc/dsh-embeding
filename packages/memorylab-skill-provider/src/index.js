import { createHash, randomUUID } from 'node:crypto'

const PROVIDER = 'memorylab-remote'
const BUNDLE_NAME = 'ml-selected-skills'
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

const SHA256 = /^[0-9a-f]{64}$/u

function validateScope(scope) {
  for (const field of ['context_id', 'session_id', 'access_grant_id']) {
    if (typeof scope?.[field] !== 'string' || scope[field].length === 0) {
      const error = new Error(`Memory Lab scope is missing ${field}`)
      error.code = 'SCOPE_INVALID'
      throw error
    }
  }
}

function validateLocator(locator, scope) {
  if (locator?.owner !== scope?.context_id) {
    const error = new Error('candidate scope denied')
    error.code = 'SCOPE_DENIED'
    throw error
  }
  if (typeof locator.activation_id !== 'string' || locator.activation_id.length === 0
    || typeof locator.version_id !== 'string' || locator.version_id.length === 0
    || !Number.isInteger(locator.generation) || locator.generation < 1
    || !SHA256.test(locator.archive_sha256)) {
    const error = new Error('candidate locator is invalid')
    error.code = 'LOCATOR_INVALID'
    throw error
  }
  return {
    activation_id: locator.activation_id,
    version_id: locator.version_id,
    generation: locator.generation,
    archive_sha256: locator.archive_sha256,
  }
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
  validateScope(scope)
  const catalog = await protocolRequest({ baseUrl, serviceSecret, instanceId, runtimeId, scope, path: '/catalog', body: undefined, fetchImpl, signal })
  const installed = []
  for (const row of catalog.items ?? []) {
    const locator = { activation_id: row.activation_id, version_id: row.version_id, generation: row.generation, archive_sha256: row.archive_sha256 }
    const status = row.desired_enabled ? 'installed' : 'removed'
    if (row.desired_enabled) {
      const resolved = await protocolRequest({ baseUrl, serviceSecret, instanceId, runtimeId, scope, path: '/sync/resolve', body: locator, fetchImpl, signal })
      if (resolved.archive_sha256 !== row.archive_sha256
        || resolved.runtime_name !== row.runtime_name
        || resolved.activation_id !== row.activation_id
        || resolved.version_id !== row.version_id
        || resolved.generation !== row.generation
        || typeof resolved.instruction !== 'string'
        || typeof resolved.instruction_sha256 !== 'string') {
        const error = new Error('resolved skill hash mismatch'); error.code = 'HASH_MISMATCH'; throw error
      }
      if (createHash('sha256').update(resolved.instruction, 'utf8').digest('hex') !== resolved.instruction_sha256) {
        const error = new Error('resolved instruction hash mismatch'); error.code = 'HASH_MISMATCH'; throw error
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
export function createRemoteProvider({ baseUrl, serviceSecret, instanceId, runtimeId, scope, control, fetchImpl = fetch, integrationKind = 'memorylab' }) {
  validateScope(scope)
  const pixlab = integrationKind === 'pixlab'
  const providerName = pixlab ? 'pixlab-remote' : PROVIDER
  const bundleName = pixlab ? 'px-selected-skills' : BUNDLE_NAME
  const source = pixlab ? 'pixlab' : 'memorylab'
  const commandPrefix = pixlab ? 'px-' : 'ml-'
  const hostLabel = pixlab ? 'PixLab' : 'Memory Lab'
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
  let invocationBundle = []
  let providerControl = control
  const resolveCandidate = async (candidate, options) => {
    const locator = validateLocator(candidate.locator, captured)
    const result = await request('/resolve', locator, options.signal)
    if (result.runtime_name !== (candidate.locator.runtime_name ?? candidate.name)
      || result.activation_id !== candidate.locator.activation_id
      || result.version_id !== candidate.locator.version_id
      || result.generation !== candidate.locator.generation
      || result.archive_sha256 !== candidate.locator.archive_sha256) {
      const error = new Error('skill version changed'); error.code = 'SKILL_VERSION_CHANGED'; throw error
    }
    if (typeof result.instruction !== 'string' || typeof result.instruction_sha256 !== 'string'
      || createHash('sha256').update(result.instruction, 'utf8').digest('hex') !== result.instruction_sha256) {
      const error = new Error('resolved instruction hash mismatch'); error.code = 'HASH_MISMATCH'; throw error
    }
    return { candidate, result }
  }
  const bundleCandidate = () => invocationBundle.length < 2 ? undefined : ({
    name: bundleName,
    description: `${hostLabel} 组合技能：${invocationBundle.map(candidate => candidate.metadata.display_name).join('、')}`,
    source, provider: providerName, rank: 900,
    invocation: { userInvocable: true, modelInvocable: false },
    locator: { owner: captured.context_id, members: invocationBundle.map(candidate => candidate.locator) },
    metadata: { display_name: invocationBundle.map(candidate => candidate.metadata.display_name).join('、'), members: invocationBundle.map(candidate => candidate.name) },
  })
  const provider = {
    name: PROVIDER,
    async list(options = {}) {
      abortIfNeeded(options.signal)
      const result = await request('/catalog', undefined, options.signal)
      const next = new Map()
      for (const row of result.items ?? []) {
        if (!row.desired_enabled || row.ack_status !== 'installed') continue
        const commandName = typeof row.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.slug)
          ? `${commandPrefix}${row.slug}`
          : row.runtime_name
        const candidate = { name: commandName, description: `${row.display_name} · v${row.version} · ${hostLabel}：${row.description}`, source, provider: providerName, rank: 600, invocation: { userInvocable: true, modelInvocable: false }, locator: { activation_id: row.activation_id, version_id: row.version_id, generation: row.generation, archive_sha256: row.archive_sha256, runtime_name: row.runtime_name, owner: captured.context_id }, metadata: { display_name: row.display_name, version: row.version } }
        next.set(candidate.name, candidate)
      }
      const fingerprint = (value) => JSON.stringify([...value.values()]
        .map(candidate => ({
          name: candidate.name,
          description: candidate.description,
          locator: candidate.locator,
          metadata: candidate.metadata,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)))
      if (fingerprint(next) !== fingerprint(installed)) providerControl?.invalidate?.()
      installed = next
      const bundle = bundleCandidate()
      return [...installed.values(), ...(bundle ? [bundle] : [])]
    },
    setInvocationBundle(candidates) {
      if (!Array.isArray(candidates) || candidates.length > 5
        || candidates.some(candidate => installed.get(candidate.name) !== candidate)) {
        const error = new Error('selected skill bundle is invalid'); error.code = 'SKILL_BUNDLE_INVALID'; throw error
      }
      invocationBundle = [...candidates]
      providerControl?.invalidate?.()
      return bundleCandidate()
    },
    setControl(value) { providerControl = value },
    async get(candidate, options = {}) {
      abortIfNeeded(options.signal)
      if (candidate?.provider !== providerName) { const error = new Error('candidate scope denied'); error.code = 'SCOPE_DENIED'; throw error }
      if (candidate.name === bundleName) {
        const members = candidate.locator?.members
        if (!Array.isArray(members) || members.length < 2 || members.length > 5
          || members.some(member => !invocationBundle.some(selected => selected.locator.activation_id === member.activation_id
            && selected.locator.version_id === member.version_id && selected.locator.generation === member.generation
            && selected.locator.archive_sha256 === member.archive_sha256))) {
          const error = new Error('selected skill bundle changed'); error.code = 'SKILL_VERSION_CHANGED'; throw error
        }
        const loaded = []
        for (const member of members) {
          const selected = invocationBundle.find(item => item.locator.activation_id === member.activation_id
            && item.locator.version_id === member.version_id && item.locator.generation === member.generation
            && item.locator.archive_sha256 === member.archive_sha256)
          if (!selected) { const error = new Error('selected skill version changed'); error.code = 'SKILL_VERSION_CHANGED'; throw error }
          loaded.push(await resolveCandidate(selected, options))
        }
        const content = loaded.map(({ candidate: item, result }) =>
          `## ${item.metadata.display_name} (v${item.metadata.version})\n\n${result.instruction}`).join('\n\n---\n\n')
        return { name: candidate.name, description: candidate.description, source, provider: providerName,
          invocation: { userInvocable: true, modelInvocable: false }, content,
          resourceBase: { kind: 'opaque', description: `静态资源通过已授权 ${hostLabel} broker 提供。` },
          metadata: { display_name: candidate.metadata.display_name, members: loaded.map(({ result }) => result.instruction_sha256) } }
      }
      const { result } = await resolveCandidate(candidate, options)
      abortIfNeeded(options.signal)
      return { name: candidate.name, description: candidate.description, source, provider: providerName, invocation: { userInvocable: true, modelInvocable: false }, content: result.instruction, resourceBase: { kind: 'opaque', description: `静态资源通过已授权 ${hostLabel} broker 提供。` }, metadata: { ...candidate.metadata, instruction_sha256: result.instruction_sha256, archive_sha256: result.archive_sha256 } }
    },
  }
  return provider
}

/** Create the server-side receipt immediately before native prompt admission. */
function brokerLocator(scope, locator) {
  return validateLocator(locator, scope)
}

export async function admitInvocation({ baseUrl, serviceSecret, instanceId, runtimeId, scope, locator, invocationId, nativeRequestId, fetchImpl = fetch, signal }) {
  const resolvedLocator = brokerLocator(scope, locator)
  const response = await fetchImpl(runtimeUrl(baseUrl, '/admit'), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${serviceSecret}`, 'x-dsh-instance-id': instanceId, 'x-dsh-runtime-id': runtimeId },
    body: JSON.stringify({ protocol_version: '1.0', request_id: randomUUID(), ...scope, ...resolvedLocator, invocation_id: invocationId, native_request_id: nativeRequestId }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) { const error = new Error(payload?.detail?.message ?? 'Memory Lab admission failed'); error.code = payload?.detail?.code ?? 'PROVIDER_UNAVAILABLE'; throw error }
  return payload
}

/** Record one fact about a receipt after the native host has observed it. */
export async function recordUsage({ baseUrl, serviceSecret, instanceId, runtimeId, scope, locator, invocationId, nativeRequestId, phase, eventId = randomUUID(), occurredAt = new Date().toISOString(), errorCode, fetchImpl = fetch, signal }) {
  const resolvedLocator = brokerLocator(scope, locator)
  const response = await fetchImpl(runtimeUrl(baseUrl, '/usage'), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${serviceSecret}`, 'x-dsh-instance-id': instanceId, 'x-dsh-runtime-id': runtimeId },
    body: JSON.stringify({ protocol_version: '1.0', request_id: randomUUID(), ...scope, ...resolvedLocator, event_id: eventId, invocation_id: invocationId, native_request_id: nativeRequestId, phase, occurred_at: occurredAt, ...(errorCode === undefined ? {} : { error_code: errorCode }) }),
    signal,
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) { const error = new Error(payload?.error?.message ?? payload?.detail?.message ?? `Memory Lab usage failed: ${response.status}`); error.code = payload?.error?.code ?? payload?.detail?.code ?? 'PROVIDER_UNAVAILABLE'; throw error }
  return payload
}

export { PROVIDER }
