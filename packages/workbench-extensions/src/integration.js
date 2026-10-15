import { WorkbenchExtensionError } from './errors.js'
import { method, readJson, requestId, writeError, writeJson } from './http.js'
import {
  IntegrationStore,
  newIntegrationSessionId,
  requestHash,
} from './integration-store.js'
import { runtimeForSubject } from './runtime-registry.js'
import { normalizePageSurface } from './page-surface.js'

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

export async function verifyContext(config, contextId, signal, runtimeRegistry, accessGrantId) {
  // Memory Lab scopes are grant-bound end to end.  Do not allow a caller to
  // reach the upstream verifier without carrying the exact browser grant;
  // otherwise the upstream may be asked to infer identity from a mutable
  // session association after login rotation.
  if (config.integrationKind === 'memorylab' && accessGrantId === undefined) {
    throw new WorkbenchExtensionError('CONTEXT_REVOKED')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('verify timeout')), config.verifyTimeoutMs)
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    const response = await fetch(`${config.apiOrigin}/api/ai/contexts/${encodeURIComponent(contextId)}/verify`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.toolSecret}`,
        'x-dsh-instance-id': config.instanceId,
        ...(config.runtimeId === undefined ? {} : { 'x-dsh-runtime-id': config.runtimeId }),
        ...(accessGrantId === undefined ? {} : { 'x-dsh-access-grant-id': accessGrantId }),
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
    const scopeIdentity = config.integrationKind === 'memorylab'
      ? body.context.user_id
      : body.context.project_id
    if (body.context.dsh_instance_id !== config.instanceId
      || !config.allowedFunctionTypes.includes(body.context.function_type)
      || typeof scopeIdentity !== 'string'
      || (config.integrationKind === 'memorylab' && body.context.access_grant_id !== accessGrantId)) {
      throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH')
    }
    if (runtimeRegistry !== undefined) {
      const runtime = runtimeForSubject(runtimeRegistry, scopeIdentity)
      return { ...body.context, runtime_id: runtime.runtimeId, runtime_origin: runtime.internalOrigin }
    }
    // A private runner has a single runtime identity. The upstream verify
    // request was already authenticated with that runtime id above, so carry
    // the identity into the binding metadata even though there is no
    // multi-user registry loaded inside the runner process.
    if (config.runtimeId !== undefined) {
      return { ...body.context, runtime_id: config.runtimeId }
    }
    return body.context
  } catch (error) {
    if (error instanceof WorkbenchExtensionError) throw error
    throw new WorkbenchExtensionError('INTEGRATION_UPSTREAM_UNAVAILABLE', { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

export async function verifySessionContext(config, contextId, sessionId, accessGrantId, signal) {
  if (config.integrationKind === 'memorylab'
    && (typeof accessGrantId !== 'string' || accessGrantId.length === 0)) {
    throw new WorkbenchExtensionError('CONTEXT_REVOKED')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('session verify timeout')), config.verifyTimeoutMs)
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    const response = await fetch(`${config.apiOrigin}/api/ai/contexts/${encodeURIComponent(contextId)}/sessions/${encodeURIComponent(sessionId)}/verify`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.toolSecret}`,
        'x-dsh-instance-id': config.instanceId,
        'x-dsh-access-grant-id': accessGrantId,
        ...(config.runtimeId === undefined ? {} : { 'x-dsh-runtime-id': config.runtimeId }),
      },
      method: 'GET',
      signal: combined,
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok || body?.ok !== true || body.scope?.context_id !== contextId
      || body.scope?.session_id !== sessionId || body.scope?.access_grant_id !== accessGrantId
      || body.scope?.dsh_instance_id !== config.instanceId) {
      if (response.status === 401 || response.status === 403 || body?.error?.code === 'CONTEXT_REVOKED') {
        throw new WorkbenchExtensionError('CONTEXT_REVOKED')
      }
      throw new WorkbenchExtensionError('INTEGRATION_UPSTREAM_UNAVAILABLE')
    }
    return body.scope
  } catch (error) {
    if (error instanceof WorkbenchExtensionError) throw error
    throw new WorkbenchExtensionError('INTEGRATION_UPSTREAM_UNAVAILABLE', { cause: error })
  } finally { clearTimeout(timeout) }
}

async function rebindOnlyAfterGrantRevocation(store, config, clientId, sessionId, accessGrantId) {
  if (config.integrationKind !== 'memorylab' || accessGrantId === undefined) return
  const existing = store.binding(sessionId)
  if (existing === undefined || existing.clientId !== clientId
    || existing.accessGrantId === undefined || existing.accessGrantId === accessGrantId
    || existing.status !== 'active') return
  let oldGrantStillValid = false
  try {
    await verifySessionContext(config, existing.contextId, sessionId, existing.accessGrantId)
    oldGrantStillValid = true
  } catch (error) {
    if (error?.code !== 'CONTEXT_REVOKED') throw error
  }
  if (oldGrantStillValid) throw new WorkbenchExtensionError('CONTEXT_REVOKED')
  store.revokeBinding(sessionId, clientId)
}

async function remoteForkRequest(config, path, body, signal) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('fork association timeout')), config.verifyTimeoutMs)
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    const response = await fetch(`${config.apiOrigin}${path}`, {
      method: 'POST', signal: combined,
      headers: {
        accept: 'application/json', 'content-type': 'application/json',
        authorization: `Bearer ${config.toolSecret}`,
        'x-dsh-instance-id': config.instanceId,
        ...(body.runtime_id === undefined ? (config.runtimeId === undefined ? {} : { 'x-dsh-runtime-id': config.runtimeId }) : { 'x-dsh-runtime-id': body.runtime_id }),
        'x-dsh-access-grant-id': body.access_grant_id,
      },
      body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'runtime_id'))),
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok || payload?.accepted !== true) {
      if (response.status === 401 || response.status === 403 || payload?.detail?.code === 'CONTEXT_REVOKED') {
        throw new WorkbenchExtensionError('CONTEXT_REVOKED')
      }
      throw new WorkbenchExtensionError('INTEGRATION_UPSTREAM_UNAVAILABLE')
    }
    return payload
  } catch (error) {
    if (error instanceof WorkbenchExtensionError) throw error
    throw new WorkbenchExtensionError('INTEGRATION_UPSTREAM_UNAVAILABLE', { cause: error })
  } finally { clearTimeout(timeout) }
}

export async function associateRemoteFork(config, request, signal) {
  if (config.integrationKind !== 'memorylab') return undefined
  return remoteForkRequest(config, '/api/ai/runtime-session-associations', {
    protocol_version: '1.0', request_id: request.requestId,
    context_id: request.contextId, session_id: request.childSessionId,
    parent_session_id: request.sourceSessionId, workspace_id: request.workspaceId,
    access_grant_id: request.accessGrantId, runtime_id: request.runtimeId,
  }, signal)
}

export async function rollbackRemoteFork(config, request, signal) {
  if (config.integrationKind !== 'memorylab') return undefined
  return remoteForkRequest(config, '/api/ai/runtime-session-associations/rollback', {
    protocol_version: '1.0', request_id: request.requestId,
    context_id: request.contextId, session_id: request.childSessionId,
    parent_session_id: request.sourceSessionId, workspace_id: request.workspaceId,
    access_grant_id: request.accessGrantId, runtime_id: request.runtimeId,
  }, signal)
}

export function isBindableInspection(inspection, parentSessionId) {
  if (parentSessionId !== undefined) return inspection.meta.parentSession === parentSessionId
  return inspection.meta.parentSession === undefined
    && !inspection.events.some(event => event.type === 'turn/start')
}

async function requireBindableSession(
  ctx, policy, workspaceId, sessionId, contextId, clientId, store, parentSessionId, pageSurface,
) {
  policy.requireSession(workspaceId, sessionId)
  const bound = store.binding(sessionId)
  if (bound !== undefined) {
    if (bound.contextId !== contextId || bound.clientId !== clientId) {
      throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH')
    }
    if (bound.status !== 'active') throw new WorkbenchExtensionError('CONTEXT_REVOKED')
    if (pageSurface !== undefined && (bound.pageSurfaceId !== pageSurface.surface_id
      || bound.conversationSlot !== pageSurface.conversation_slot
      || bound.pageKind !== pageSurface.page_kind
      || bound.datasetId !== pageSurface.dataset_id
      || bound.displayMode !== pageSurface.display_mode)) {
      throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH', { message: 'session 的 page_surface 不可变' })
    }
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

export function registerIntegrationRoutes(ctx, config, policy, findClient, runtimeRegistry) {
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
      exactKeys(body, ['context_id', 'workspace_alias', 'session_id', 'access_grant_id', 'request_id', 'page_surface'])
      const contextId = oneString(body.context_id, 'context_id')
      const alias = oneString(body.workspace_alias, 'workspace_alias', 128)
      integrationRequestId = oneString(body.request_id, 'request_id', 128)
      const accessGrantId = oneString(body.access_grant_id, 'access_grant_id', 36)
      const pageSurface = normalizePageSurface(body.page_surface)
      if (!client.workspaceAliases.includes(alias)) throw new WorkbenchExtensionError('EMBED_SCOPE_DENIED')
      const workspace = await policy.requireWritable(await policy.checkAlias(alias, { register: true }))
      const requestedSessionId = body.session_id === undefined
        ? undefined
        : oneString(body.session_id, 'session_id')
      const hash = requestHash({
        context_id: contextId,
        workspace_id: workspace.workspace_id,
        session_id: requestedSessionId ?? null,
        page_surface: pageSurface ?? null,
      })
      const reserved = store.reservePrepare({
        clientId: client.clientId,
        requestId: integrationRequestId,
        hash,
        contextId,
        workspaceId: workspace.workspace_id,
        sessionId: requestedSessionId ?? newIntegrationSessionId(),
        pageSurface,
      })
      if (reserved.state === 'complete') {
        writeJson(res, 200, { ...reserved.response, request_id: id })
        return
      }
      const metadata = await verifyContext(config, contextId, undefined, runtimeRegistry, accessGrantId)
      const sessionId = reserved.sessionId
      if (requestedSessionId === undefined) {
        await ctx.sessionController.create({ workspaceId: workspace.workspace_id, sessionId })
      }
      await requireBindableSession(
        ctx, policy, workspace.workspace_id, sessionId, contextId, client.clientId, store, undefined, pageSurface,
      )
      await rebindOnlyAfterGrantRevocation(store, config, client.clientId, sessionId, accessGrantId)
      const result = store.completePrepare({
        clientId: client.clientId,
        requestId: integrationRequestId,
        contextId,
        workspaceId: workspace.workspace_id,
        sessionId,
        instanceId: config.instanceId,
        metadata,
        pageSurface,
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
      exactKeys(body, ['context_id', 'workspace_id', 'session_id', 'parent_session_id', 'access_grant_id', 'request_id'])
      const contextId = oneString(body.context_id, 'context_id')
      const workspaceId = oneString(body.workspace_id, 'workspace_id')
      const sessionId = oneString(body.session_id, 'session_id')
      const parentSessionId = body.parent_session_id === undefined
        ? undefined
        : oneString(body.parent_session_id, 'parent_session_id')
      oneString(body.request_id, 'request_id', 128)
      const accessGrantId = oneString(body.access_grant_id, 'access_grant_id', 36)
      const workspace = await policy.requireWritable(await policy.checkWorkspaceId(workspaceId))
      if (workspace.alias === null || !client.workspaceAliases.includes(workspace.alias)) {
        throw new WorkbenchExtensionError('EMBED_SCOPE_DENIED')
      }
      const metadata = await verifyContext(config, contextId, undefined, runtimeRegistry, accessGrantId)
      await requireBindableSession(
        ctx, policy, workspaceId, sessionId, contextId, client.clientId, store, parentSessionId,
      )
      await rebindOnlyAfterGrantRevocation(store, config, client.clientId, sessionId, accessGrantId)
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
        ...(binding.runtimeId === undefined ? {} : { runtime_id: binding.runtimeId }),
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
      if (config.integrationKind === 'memorylab') {
        if (binding.accessGrantId === undefined) throw new WorkbenchExtensionError('CONTEXT_REVOKED')
        await verifySessionContext(config, binding.contextId, sessionId, binding.accessGrantId)
      }
      writeJson(res, 200, {
        context_id: binding.contextId,
        workspace_id: binding.workspaceId,
        session_id: binding.sessionId,
        binding_status: binding.status,
        dsh_instance_id: binding.instanceId,
        ...(binding.runtimeId === undefined ? {} : { runtime_id: binding.runtimeId }),
        archived: ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),
        request_id: id,
      })
    } catch (error) { writeError(res, error, id) }
  }))

  return {
    store,
    config,
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
      store.close()
    },
  }
}
