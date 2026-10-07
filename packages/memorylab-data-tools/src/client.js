import { randomUUID } from 'node:crypto'
import { mkdirSync, openAsBlob, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, resolve, sep } from 'node:path'
import { IntegrationStore, integrationStatePath } from '../../workbench-extensions/src/integration-store.js'

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`)
  return value
}

function secret() {
  const direct = process.env.MEMORYLAB_AI_TOOL_SECRET
  const file = process.env.MEMORYLAB_AI_TOOL_SECRET_FILE
  if ((direct === undefined) === (file === undefined)) {
    throw new Error('configure exactly one of MEMORYLAB_AI_TOOL_SECRET or MEMORYLAB_AI_TOOL_SECRET_FILE')
  }
  const value = direct ?? readFileSync(file, 'utf8').trim()
  if (value.length < 32) throw new Error('Memory Lab AI tool secret is too short')
  return value
}

export class MemoryLabToolClient {
  constructor(options = {}) {
    this.origin = required(options.origin ?? process.env.MEMORYLAB_AI_API_ORIGIN, 'MEMORYLAB_AI_API_ORIGIN').replace(/\/$/u, '')
    this.publicOrigin = required(
      options.publicOrigin ?? process.env.MEMORYLAB_AI_PUBLIC_ORIGIN,
      'MEMORYLAB_AI_PUBLIC_ORIGIN',
    ).replace(/\/$/u, '')
    this.instanceId = required(
      options.instanceId ?? process.env.MEMORYLAB_AI_DSH_INSTANCE_ID,
      'MEMORYLAB_AI_DSH_INSTANCE_ID',
    )
    this.secret = options.secret ?? secret()
    this.timeoutMs = Number(options.timeoutMs ?? process.env.MEMORYLAB_AI_TOOL_TIMEOUT_MS ?? 120000)
    this.maxUploadBytes = Number(options.maxUploadBytes ?? process.env.MEMORYLAB_AI_MAX_UPLOAD_BYTES ?? 104857600)
    const attachmentsRoot = resolve(
      options.attachmentsRoot ?? process.env.MEMORYLAB_AI_ATTACHMENTS_ROOT
        ?? resolve(process.env.DSH_HOME ?? process.cwd(), 'attachments/v1/files'),
    )
    mkdirSync(attachmentsRoot, { recursive: true })
    this.attachmentsRoot = realpathSync(attachmentsRoot)
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300000) {
      throw new Error('MEMORYLAB_AI_TOOL_TIMEOUT_MS must be 100..300000')
    }
    if (!Number.isSafeInteger(this.maxUploadBytes) || this.maxUploadBytes < 1) {
      throw new Error('MEMORYLAB_AI_MAX_UPLOAD_BYTES must be a positive integer')
    }
    this.store = options.store ?? new IntegrationStore(integrationStatePath())
    this.ownsStore = options.store === undefined
  }

  binding(exec) {
    const sessionId = exec?.agent?.session?.header?.id
    if (typeof sessionId !== 'string') throw new Error('CONTEXT_NOT_BOUND: tool execution has no owning DSH session')
    const binding = this.store.requireActive(sessionId)
    if (binding.instanceId !== this.instanceId) throw new Error('SESSION_CONTEXT_MISMATCH: DSH instance differs')
    return { binding, sessionId }
  }

  headers() {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.secret}`,
      'x-dsh-instance-id': this.instanceId,
    }
  }

  signal(exec) {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('TOOL_TIMEOUT')), this.timeoutMs)
    return {
      signal: exec.signal === undefined ? timeout.signal : AbortSignal.any([exec.signal, timeout.signal]),
      dispose: () => clearTimeout(timer),
    }
  }

  async query(tool, args, exec) {
    const { binding, sessionId } = this.binding(exec)
    const timer = this.signal(exec)
    try {
      const response = await fetch(`${this.origin}/api/ai/tool-query`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: randomUUID(), context_id: binding.contextId,
          session_id: sessionId, tool, arguments: args,
        }),
        signal: timer.signal,
      })
      return await this.result(response)
    } finally {
      timer.dispose()
    }
  }

  async upload(filePath, exec) {
    const { binding, sessionId } = this.binding(exec)
    const actual = realpathSync(resolve(filePath))
    if (actual !== this.attachmentsRoot && !actual.startsWith(`${this.attachmentsRoot}${sep}`)) {
      throw new Error('FILE_NOT_ALLOWED: only a file attached in this DSH conversation can be uploaded')
    }
    if (extname(actual).toLowerCase() !== '.csv') throw new Error('FILE_TYPE_UNSUPPORTED: Memory Lab requires a CSV file')
    const info = statSync(actual)
    if (!info.isFile() || info.size === 0 || info.size > this.maxUploadBytes) {
      throw new Error('FILE_SIZE_INVALID: CSV is empty or exceeds the configured upload limit')
    }
    const form = new FormData()
    form.set('request_id', randomUUID())
    form.set('context_id', binding.contextId)
    form.set('session_id', sessionId)
    form.set('file', await openAsBlob(actual, { type: 'text/csv' }), basename(actual))
    const timer = this.signal(exec)
    try {
      const response = await fetch(`${this.origin}/api/ai/tool-upload`, {
        method: 'POST', headers: this.headers(), body: form, signal: timer.signal,
      })
      return await this.result(response)
    } finally {
      timer.dispose()
    }
  }

  async result(response) {
    const body = await response.json().catch(() => undefined)
    if (!response.ok || body?.ok !== true) {
      const code = body?.error?.code ?? `HTTP_${response.status}`
      const message = body?.error?.message ?? 'Memory Lab tool request failed'
      throw new Error(`${code}: ${message}`)
    }
    return body
  }

  analysisUrl(datasetId) {
    return `${this.publicOrigin}/tools/chn_vis/${encodeURIComponent(datasetId)}`
  }

  close() {
    if (this.ownsStore) this.store.close()
  }
}
