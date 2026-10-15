import { createHash } from 'node:crypto'

import { WorkbenchExtensionError } from './errors.js'

export function pageContextValue(request) {
  const value = request?.pageContext
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object'
    || typeof value.snapshotId !== 'string' || value.snapshotId.length === 0
    || typeof value.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.snapshotSha256)
    || typeof value.surfaceId !== 'string' || value.surfaceId.length === 0
    || value.protocolVersion !== '1.0') {
    throw new WorkbenchExtensionError('PAGE_CONTEXT_REQUIRED')
  }
  return value
}

export async function enrichPagePrompt(integration, config, request, fetchImpl = globalThis.fetch) {
  const pageContext = pageContextValue(request)
  if (pageContext === undefined) return undefined
  if (integration === undefined || config.integrationKind !== 'memorylab' || config.pageContextEnabled !== true) {
    throw new WorkbenchExtensionError('PAGE_CONTEXT_REQUIRED')
  }
  const binding = integration.store.requireActive(request.sessionId)
  if (binding.pageSurfaceId !== pageContext.surfaceId || binding.accessGrantId === undefined) {
    throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('page context timeout')), config.verifyTimeoutMs)
  try {
    const response = await fetchImpl(`${config.apiOrigin}/api/ai/internal/page-contexts/${encodeURIComponent(pageContext.snapshotId)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.toolSecret}`,
        'x-dsh-instance-id': config.instanceId,
        ...(binding.runtimeId === undefined ? {} : { 'x-dsh-runtime-id': binding.runtimeId }),
        'x-dsh-access-grant-id': binding.accessGrantId,
        'x-dsh-session-id': request.sessionId,
        'x-dsh-surface-id': pageContext.surfaceId,
        'x-dsh-snapshot-sha256': pageContext.snapshotSha256,
      },
      signal: controller.signal,
    })
    let body
    try { body = await response.json() } catch { body = undefined }
    if (!response.ok || body?.ok !== true || typeof body.canonical_json !== 'string') {
      const code = body?.error?.code ?? body?.detail?.code
      if (code === 'CONTEXT_REVOKED') throw new WorkbenchExtensionError('CONTEXT_REVOKED')
      if (code === 'PAGE_CONTEXT_DIGEST_MISMATCH') throw new WorkbenchExtensionError('PAGE_CONTEXT_DIGEST_MISMATCH')
      if (code === 'PAGE_CONTEXT_NOT_FOUND') throw new WorkbenchExtensionError('PAGE_CONTEXT_NOT_FOUND')
      throw new WorkbenchExtensionError('PAGE_CONTEXT_NOT_FOUND')
    }
    const digest = createHash('sha256').update(body.canonical_json, 'utf8').digest('hex')
    if (digest !== pageContext.snapshotSha256 || body.snapshot_sha256 !== pageContext.snapshotSha256) {
      throw new WorkbenchExtensionError('PAGE_CONTEXT_DIGEST_MISMATCH')
    }
    const marker = [
      '[PAGE_CONTEXT_DATA_V1]',
      `snapshot_id: ${pageContext.snapshotId}`,
      `snapshot_sha256: ${pageContext.snapshotSha256}`,
      body.canonical_json,
      '[/PAGE_CONTEXT_DATA_V1]',
    ].join('\n')
    return { ...request, content: [...(request.content ?? []), { type: 'text', text: marker }] }
  } catch (error) {
    if (error instanceof WorkbenchExtensionError) throw error
    throw new WorkbenchExtensionError('PAGE_CONTEXT_NOT_FOUND', { cause: error })
  } finally {
    clearTimeout(timer)
  }
}
