import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { IntegrationStore, integrationStatePath } from '../../workbench-extensions/src/integration-store.js'

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`)
  return value
}

function secret() {
  const direct = process.env.PROBE_AI_TOOL_SECRET
  const file = process.env.PROBE_AI_TOOL_SECRET_FILE
  if ((direct === undefined) === (file === undefined)) {
    throw new Error('configure exactly one of PROBE_AI_TOOL_SECRET or PROBE_AI_TOOL_SECRET_FILE')
  }
  const value = direct ?? readFileSync(file, 'utf8').trim()
  if (value.length < 32) throw new Error('Probe AI tool secret is too short')
  return value
}

export class ProbeToolClient {
  constructor(options = {}) {
    this.origin = required(options.origin ?? process.env.PROBE_AI_API_ORIGIN, 'PROBE_AI_API_ORIGIN').replace(/\/$/u, '')
    this.instanceId = required(options.instanceId ?? process.env.PROBE_AI_DSH_INSTANCE_ID, 'PROBE_AI_DSH_INSTANCE_ID')
    this.secret = options.secret ?? secret()
    this.timeoutMs = Number(options.timeoutMs ?? process.env.PROBE_AI_TOOL_TIMEOUT_MS ?? 10000)
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120000) {
      throw new Error('PROBE_AI_TOOL_TIMEOUT_MS must be 100..120000')
    }
    this.store = options.store ?? new IntegrationStore(integrationStatePath())
    this.ownsStore = options.store === undefined
  }

  async query(tool, args, exec) {
    const sessionId = exec?.agent?.session?.header?.id
    if (typeof sessionId !== 'string') throw new Error('CONTEXT_NOT_BOUND: tool execution has no owning DSH session')
    const binding = this.store.requireActive(sessionId)
    if (binding.instanceId !== this.instanceId) throw new Error('SESSION_CONTEXT_MISMATCH: DSH instance differs')
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('QUERY_TIMEOUT')), this.timeoutMs)
    const signal = exec.signal === undefined ? timeout.signal : AbortSignal.any([exec.signal, timeout.signal])
    try {
      const response = await fetch(`${this.origin}/api/ai/tool-query`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.secret}`,
          'content-type': 'application/json',
          'x-dsh-instance-id': this.instanceId,
        },
        body: JSON.stringify({
          request_id: randomUUID(),
          context_id: binding.contextId,
          session_id: sessionId,
          tool,
          arguments: args,
        }),
        signal,
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok || body?.ok !== true) {
        const code = body?.error?.code ?? `HTTP_${response.status}`
        const message = body?.error?.message ?? 'Probe tool query failed'
        throw new Error(`${code}: ${message}`)
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  close() {
    if (this.ownsStore) this.store.close()
  }
}
