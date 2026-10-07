import { WorkbenchExtensionError } from './errors.js'
import { method, readJson, requestId, writeError, writeJson } from './http.js'
import {
  IntegrationStore,
  newIntegrationSessionId,
  requestHash,
} from './integration-store.js'

function oneString(value, label, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new WorkbenchExtensionError('EMBED_PROTOCOL_UNSUPPORTED', { message: `${label} 不合法` })
  }
  return value
}

function exactKeys(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) {
    throw new WorkbenchExtensionError('EMBED_PROTOCOL_UNSUPPORTED', { message: '请求包含未知字段' })
  }
}

async function verifyContext(config, contextId, signal) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('verify timeout')), config.verifyTimeoutMs)
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    const response = await fetch(`${config.probeApiOrigin}/api/ai/contexts/${encodeURIComponent(contextId)}/verify`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.toolSecret}`,
        'x-dsh-instance-id': config.instanceId,
      },
      method: 'GET',
      signal: combined,
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok || body?.ok !== true || body.context?.context_id !== contextId) {
      if (response.status === 401 || response.status === 403) {
        throw new WorkbenchExtensionError('CONTEXT_REVOKED')
      }
      throw new WorkbenchExtensionError('INTEGRATION_UPSTREAM_UNAVAILABLE')
    }
    if (body.context.dsh_instance_id !== config.instanceId
      || !['SITE_DESIGN', 'PROBECARD_DESIGN'].includes(body.context.function_type)
      || typeof body.context.project_id !== 'string') {
      throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH')
    }
    return body.context
  } catch (error) {
    if (error instanceof WorkbenchExtensionError) throw error
    throw new WorkbenchExtensionError('INTEGRATION_UPSTREAM_UNAVAILABLE', { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

export function isBindableInspection(inspection, parentSessionId) {
  if (parentSessionId !== undefined) return inspection.meta.parentSession === parentSessionId
  return inspection.meta.parentSession === undefined
    && !inspection.events.some(event => event.type === 'turn/start')
}

async function requireBindableSession(
  ctx, policy, workspaceId, sessionId, contextId, clientId, store, parentSessionId,
) {
  policy.requireSession(workspaceId, sessionId)
  const bound = store.binding(sessionId)
  if (bound !== undefined) {
    if (bound.contextId !== contextId || bound.clientId !== clientId) {
      throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH')
    }
    if (bound.status !== 'active') throw new WorkbenchExtensionError('CONTEXT_REVOKED')
    return
  }
  let inspection
  try { inspection = await ctx.sessionController.inspect(sessionId) } catch (error) {
    throw new WorkbenchExtensionError('SESSION_NOT_FOUND', { cause: error })
  }
  if (inspection.meta.cwd !== ctx.workspaceRegistry.get(workspaceId)?.path) {
    throw new WorkbenchExtensionError('SESSION_WORKSPACE_MISMATCH')
  }
  if (parentSessionId !== undefined) {
    const parent = store.requireActive(parentSessionId)
    if (parent.contextId !== contextId || parent.workspaceId !== workspaceId || parent.clientId !== clientId) {
      throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH')
    }
  }
  if (!isBindableInspection(inspection, parentSessionId)) {
    throw new WorkbenchExtensionError('SESSION_NOT_BLANK')
  }
}

export function registerIntegrationRoutes(ctx, config, policy, findClient) {
  const store = new IntegrationStore()
  const route = (path, handler) => ctx.webServer.register({ kind: 'exact', path, handler })
  const disposers = []

  disposers.push(route('/embed/control/integration/prepare', async (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['POST'])) return
    let client
    let integrationRequestId
    try {
      client = findClient(req)
      const body = await readJson(req)
      exactKeys(body, ['context_id', 'workspace_alias', 'session_id', 'request_id'])
      const contextId = oneString(body.context_id, 'context_id')
      const alias = oneString(body.workspace_alias, 'workspace_alias', 128)
      integrationRequestId = oneString(body.request_id, 'request_id', 128)
      if (!client.workspaceAliases.includes(alias)) throw new WorkbenchExtensionError('EMBED_SCOPE_DENIED')
      const workspace = await policy.requireWritable(await policy.checkAlias(alias, { register: true }))
      const requestedSessionId = body.session_id === undefined
        ? undefined
        : oneString(body.session_id, 'session_id')
      const hash = requestHash({ context_id: contextId, workspace_id: workspace.workspace_id, session_id: requestedSessionId ?? null })
      const reserved = store.reservePrepare({
        clientId: client.clientId,
        requestId: integrationRequestId,
        hash,
        contextId,
        workspaceId: workspace.workspace_id,
        sessionId: requestedSessionId ?? newIntegrationSessionId(),
      })
      if (reserved.state === 'complete') {
        writeJson(res, 200, { ...reserved.response, request_id: id })
        return
      }
      const metadata = await verifyContext(config, contextId)
      const sessionId = reserved.sessionId
      if (requestedSessionId === undefined) {
        await ctx.sessionController.create({ workspaceId: workspace.workspace_id, sessionId })
      }
      await requireBindableSession(
        ctx, policy, workspace.workspace_id, sessionId, contextId, client.clientId, store,
      )
      const result = store.completePrepare({
        clientId: client.clientId,
        requestId: integrationRequestId,
        contextId,
        workspaceId: workspace.workspace_id,
        sessionId,
        instanceId: config.instanceId,
        metadata,
      })
      writeJson(res, reserved.created ? 201 : 200, { ...result, request_id: id })
    } catch (error) {
      if (client !== undefined) {
        try {
          if (integrationRequestId !== undefined) {
            store.failPrepare(client.clientId, integrationRequestId, error.code ?? 'UNKNOWN')
          }
        } catch { /* preserve the primary failure */ }
      }
      writeError(res, error, id)
    }
  }))

  disposers.push(route('/embed/control/integration/bind-session', async (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['POST'])) return
    try {
      const client = findClient(req)
      const body = await readJson(req)
      exactKeys(body, ['context_id', 'workspace_id', 'session_id', 'parent_session_id', 'request_id'])
      const contextId = oneString(body.context_id, 'context_id')
      const workspaceId = oneString(body.workspace_id, 'workspace_id')
      const sessionId = oneString(body.session_id, 'session_id')
      const parentSessionId = body.parent_session_id === undefined
        ? undefined
        : oneString(body.parent_session_id, 'parent_session_id')
      oneString(body.request_id, 'request_id', 128)
      const workspace = await policy.requireWritable(await policy.checkWorkspaceId(workspaceId))
      if (workspace.alias === null || !client.workspaceAliases.includes(workspace.alias)) {
        throw new WorkbenchExtensionError('EMBED_SCOPE_DENIED')
      }
      const metadata = await verifyContext(config, contextId)
      await requireBindableSession(
        ctx, policy, workspaceId, sessionId, contextId, client.clientId, store, parentSessionId,
      )
      const binding = store.bind({
        clientId: client.clientId,
        contextId,
        workspaceId,
        sessionId,
        instanceId: config.instanceId,
        metadata,
      })
      writeJson(res, 200, {
        context_id: binding.contextId,
        workspace_id: binding.workspaceId,
        session_id: binding.sessionId,
        binding_status: binding.status,
        dsh_instance_id: binding.instanceId,
        request_id: id,
      })
    } catch (error) { writeError(res, error, id) }
  }))

  disposers.push(route('/embed/control/integration/revoke', async (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['POST'])) return
    try {
      const client = findClient(req)
      const body = await readJson(req)
      exactKeys(body, ['context_id', 'request_id'])
      const contextId = oneString(body.context_id, 'context_id')
      oneString(body.request_id, 'request_id', 128)
      writeJson(res, 200, { revoked_sessions: store.revokeContext(contextId, client.clientId), request_id: id })
    } catch (error) { writeError(res, error, id) }
  }))

  disposers.push(route('/embed/control/integration/session-status', async (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['GET'])) return
    try {
      const client = findClient(req)
      const url = new URL(req.url ?? '/', 'http://integration.local')
      if ([...url.searchParams.keys()].some(key => key !== 'session_id')) {
        throw new WorkbenchExtensionError('EMBED_PROTOCOL_UNSUPPORTED')
      }
      const sessionId = oneString(url.searchParams.get('session_id'), 'session_id')
      const binding = store.binding(sessionId)
      if (binding === undefined) throw new WorkbenchExtensionError('CONTEXT_NOT_BOUND')
      if (binding.clientId !== client.clientId) throw new WorkbenchExtensionError('EMBED_SCOPE_DENIED')
      policy.requireSession(binding.workspaceId, sessionId)
      writeJson(res, 200, {
        context_id: binding.contextId,
        workspace_id: binding.workspaceId,
        session_id: binding.sessionId,
        binding_status: binding.status,
        dsh_instance_id: binding.instanceId,
        archived: ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),
        request_id: id,
      })
    } catch (error) { writeError(res, error, id) }
  }))

  return {
    store,
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
      store.close()
    },
  }
}
