import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, resolve, sep } from 'node:path'
import { IntegrationStore, integrationStatePath } from '../../workbench-extensions/src/integration-store.js'

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`)
  return value
}

const FILE_ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/u

function fileAttachmentRefFromBlock(block) {
  // The official session contract exposes durable file references only on a
  // `type: 'file'` content block.  Do not treat image blocks or arbitrary
  // model content carrying an attachment-shaped object as an uploadable file.
  if (block?.type !== 'file' || typeof block?.attachment !== 'object' || block.attachment === null) {
    return undefined
  }
  const id = block.attachment.attachmentId
  if (typeof id === 'string' && FILE_ATTACHMENT_ID.test(id)) return block.attachment
  return undefined
}

function fileAttachmentRef(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const id = value.attachmentId
  return typeof id === 'string' && FILE_ATTACHMENT_ID.test(id) ? value : undefined
}

function attachmentIdFromBlock(block) {
  const id = fileAttachmentRefFromBlock(block)?.attachmentId
  return typeof id === 'string' && FILE_ATTACHMENT_ID.test(id) ? id : undefined
}

function sessionAttachmentRefs(exec) {
  const refs = new Map()
  const session = exec?.agent?.session
  const window = session?.eventSource?.getSnapshot?.()
  for (const entry of window?.entries ?? []) {
    const content = entry?.event?.data?.message?.content
    for (const block of content ?? []) {
      const ref = fileAttachmentRefFromBlock(block)
      const id = attachmentIdFromBlock(block)
      if (id !== undefined) refs.set(id, ref)
    }
  }
  const pending = session?.getSnapshot?.()?.pendingSubmissions ?? []
  for (const submission of pending) {
    for (const attachment of submission.attachments ?? []) {
      if (attachment?.type !== 'file') continue
      const ref = fileAttachmentRef(attachment.value)
      if (ref !== undefined) refs.set(ref.attachmentId, ref)
    }
  }
  return refs
}

function secret() {
  const runner = process.env.WORKBENCH_ROLE === 'runner'
  const direct = process.env[runner ? 'MEMORYLAB_AI_RUNTIME_SECRET' : 'MEMORYLAB_AI_TOOL_SECRET']
  const file = process.env[runner ? 'MEMORYLAB_AI_RUNTIME_SECRET_FILE' : 'MEMORYLAB_AI_TOOL_SECRET_FILE']
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
    this.runtimeId = options.runtimeId ?? process.env.DSH_RUNTIME_ID
    if (process.env.WORKBENCH_ROLE === 'runner') {
      this.runtimeId = required(this.runtimeId, 'DSH_RUNTIME_ID')
    }
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
    if (binding.instanceId !== this.instanceId
      || typeof binding.contextId !== 'string' || binding.contextId.length === 0
      || typeof binding.accessGrantId !== 'string' || binding.accessGrantId.length === 0
      || (this.runtimeId !== undefined && binding.runtimeId !== this.runtimeId)) {
      throw new Error('SESSION_CONTEXT_MISMATCH: DSH binding is incomplete or belongs to another instance')
    }
    return { binding, sessionId }
  }

  headers(binding) {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.secret}`,
      'x-dsh-instance-id': this.instanceId,
      ...(this.runtimeId === undefined ? {} : { 'x-dsh-runtime-id': this.runtimeId }),
      'x-dsh-access-grant-id': required(binding?.accessGrantId, 'accessGrantId'),
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

  filePathForRef(ref) {
    const match = FILE_ATTACHMENT_ID.exec(ref?.attachmentId ?? '')
    if (match === null || typeof ref?.name !== 'string' || basename(ref.name) !== ref.name) return undefined
    return resolve(this.attachmentsRoot, match[1].slice(0, 2), match[1], ref.name)
  }

  async query(tool, args, exec) {
    const { binding, sessionId } = this.binding(exec)
    const timer = this.signal(exec)
    try {
      const response = await fetch(`${this.origin}/api/ai/tool-query`, {
        method: 'POST',
        headers: { ...this.headers(binding), 'content-type': 'application/json' },
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

  async upload(reference, exec) {
    const { binding, sessionId } = this.binding(exec)
    const attachmentId = typeof reference === 'object' ? reference?.attachmentId : undefined
    const filePath = typeof reference === 'object' ? reference?.filePath : reference
    if ((attachmentId === undefined) === (filePath === undefined)) {
      throw new Error('ATTACHMENT_REFERENCE_REQUIRED: provide exactly one attachment_id or file_path')
    }
    let candidate
    let selectedRef
    if (attachmentId !== undefined) {
      if (typeof attachmentId !== 'string' || !FILE_ATTACHMENT_ID.test(attachmentId)) {
        throw new Error('ATTACHMENT_ID_INVALID: attachment_id must be a canonical file reference')
      }
      const refs = sessionAttachmentRefs(exec)
      if (!refs.has(attachmentId)) {
        throw new Error('ATTACHMENT_SESSION_MISMATCH: attachment is not present in the current DSH session')
      }
      selectedRef = refs.get(attachmentId)
      candidate = this.filePathForRef(selectedRef)
      if (candidate === undefined) throw new Error('ATTACHMENT_REFERENCE_INVALID: missing file name')
    } else {
      if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('FILE_PATH_INVALID')
      candidate = resolve(filePath)
    }
    const actual = realpathSync(candidate)
    if (actual !== this.attachmentsRoot && !actual.startsWith(`${this.attachmentsRoot}${sep}`)) {
      throw new Error('FILE_NOT_ALLOWED: only a file attached in this DSH conversation can be uploaded')
    }
    const refs = sessionAttachmentRefs(exec)
    const allowedPaths = new Set()
    for (const ref of refs.values()) {
      const path = this.filePathForRef(ref)
      if (path === undefined) continue
      try { allowedPaths.add(realpathSync(path)) } catch { /* missing attachment is rejected below */ }
    }
    if (!allowedPaths.has(actual)) {
      throw new Error('ATTACHMENT_SESSION_MISMATCH: file is not present in the current DSH session')
    }
    if (selectedRef === undefined) {
      for (const ref of refs.values()) {
        const path = this.filePathForRef(ref)
        if (path === undefined) continue
        try {
          if (realpathSync(path) === actual) { selectedRef = ref; break }
        } catch { /* missing attachment is rejected below */ }
      }
    }
    if (selectedRef === undefined) throw new Error('ATTACHMENT_REFERENCE_INVALID: missing session reference')
    if (extname(actual).toLowerCase() !== '.csv') throw new Error('FILE_TYPE_UNSUPPORTED: Memory Lab requires a CSV file')
    const info = statSync(actual)
    if (!info.isFile() || info.size === 0 || info.size > this.maxUploadBytes) {
      throw new Error('FILE_SIZE_INVALID: CSV is empty or exceeds the configured upload limit')
    }
    const bytes = readFileSync(actual)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const expected = String(selectedRef.attachmentId).replace(/^sha256:/u, '')
    if (digest !== expected || bytes.byteLength !== selectedRef.bytes) {
      throw new Error('ATTACHMENT_HASH_MISMATCH: attachment bytes do not match the session reference')
    }
    const form = new FormData()
    form.set('request_id', randomUUID())
    form.set('context_id', binding.contextId)
    form.set('session_id', sessionId)
    form.set('attachment_id', selectedRef.attachmentId)
    form.set('attachment_bytes', String(selectedRef.bytes))
    form.set('attachment_sha256', digest)
    form.set('file', new Blob([bytes], { type: 'text/csv' }), basename(actual))
    const timer = this.signal(exec)
    try {
      const response = await fetch(`${this.origin}/api/ai/tool-upload`, {
        method: 'POST', headers: this.headers(binding), body: form, signal: timer.signal,
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
