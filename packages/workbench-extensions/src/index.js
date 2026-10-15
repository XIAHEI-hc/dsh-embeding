import { resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  embedEnabled,
  loadEmbedConfig,
  loadIntegrationConfig,
  loadWorkspaceConfig,
} from './config.js'
import { WorkbenchExtensionError } from './errors.js'
import { GrantStore } from './grants.js'
import { bearer, method, readJson, requestId, secretEqual, writeError, writeJson } from './http.js'
import { associateRemoteFork, registerIntegrationRoutes, rollbackRemoteFork } from './integration.js'
import { loadRuntimeRegistry } from './runtime-registry.js'
import { WorkspacePolicy } from './workspaces.js'
import { enrichPagePrompt } from './page-context.js'
import { createRemoteProvider } from '@dsh-workbench/memorylab-skill-provider'
import { admitInvocation, recordUsage, synchronizeRemoteProvider } from '@dsh-workbench/memorylab-skill-provider'

export const name = 'workbench-extensions'
export const inject = ['connection', 'sessionController', 'webServer', 'workspaceRegistry', 'skills']

const PROTOCOL = 'dsh.embed'
const VERSION = '1.0'
const BASE_CAPABILITIES = Object.freeze(['workspace_open', 'session_open', 'draft_prompt'])

function capabilities(integration, multiUser = false, pageContextEnabled = false) {
  return integration === undefined
    ? BASE_CAPABILITIES
    : Object.freeze([...BASE_CAPABILITIES, 'integration_context', 'session_navigation_events', 'session_lifecycle_events',
      ...(multiUser ? ['scoped_runtime'] : []), ...(pageContextEnabled ? ['page_context_v1', 'compact_chat_v1'] : [])])
}

function oneString(value, label, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new WorkbenchExtensionError('EMBED_PROTOCOL_UNSUPPORTED', { message: `${label} 不合法` })
  }
  return value
}

function findClient(config, req) {
  const token = bearer(req)
  const matches = config.clients.filter(client => secretEqual(token, client.secret))
  if (matches.length !== 1) throw new WorkbenchExtensionError('EMBED_CLIENT_UNAUTHORIZED')
  return matches[0]
}

function remoteSkillNames(content) {
  const names = []
  for (const part of content ?? []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    for (const match of part.text.matchAll(/(?:^|\s)\/(ml-[a-z0-9]+(?:-[a-z0-9]+)*)\b/gu)) names.push(match[1])
  }
  return [...new Set(names)]
}

function providerScope(integration, sessionId) {
  const binding = integration.store.requireActive(sessionId)
  if (binding.accessGrantId === undefined || binding.runtimeId === undefined) {
    throw new WorkbenchExtensionError('CONTEXT_REVOKED', { message: 'session 没有精确运行授权' })
  }
  return { binding, scope: { context_id: binding.contextId, session_id: binding.sessionId, access_grant_id: binding.accessGrantId } }
}

function sameProviderBinding(left, right) {
  return left !== undefined && right !== undefined
    && left.sessionId === right.sessionId
    && left.contextId === right.contextId
    && left.accessGrantId === right.accessGrantId
    && left.runtimeId === right.runtimeId
    && left.instanceId === right.instanceId
}

async function admitRemotePrompt(integration, config, request, admittedPrompts, getProvider) {
  const names = remoteSkillNames(request.content)
  if (names.length === 0) return
  if (names.length > 1) throw new WorkbenchExtensionError('SKILL_MULTIPLE')
  const { binding, scope } = providerScope(integration, request.sessionId)
  const controller = new AbortController()
  const provider = getProvider(request.sessionId, controller.signal)
  try {
    const candidate = (await provider.list({ signal: controller.signal })).find(item => item.name === names[0])
    if (candidate === undefined) throw new WorkbenchExtensionError('SKILL_NOT_ENABLED')
    await admitInvocation({
      baseUrl: config.apiOrigin, serviceSecret: config.toolSecret, instanceId: config.instanceId,
      runtimeId: binding.runtimeId, scope, locator: candidate.locator,
      invocationId: request.requestId, nativeRequestId: request.requestId, signal: controller.signal,
    })
    const queue = admittedPrompts.get(request.sessionId) ?? []
    queue.push({ invocationId: request.requestId, nativeRequestId: request.requestId, skillName: names[0], locator: candidate.locator })
    admittedPrompts.set(request.sessionId, queue)
  } catch (error) {
    if (error instanceof WorkbenchExtensionError) throw error
    if (error?.code === 'SKILL_NOT_ENABLED' || error?.code === 'SKILL_VERSION_CHANGED') {
      throw new WorkbenchExtensionError('SKILL_VERSION_CHANGED', { cause: error })
    }
    throw new WorkbenchExtensionError('SKILL_PROVIDER_UNAVAILABLE', { cause: error })
  } finally { controller.abort() }
}

/**
 * Keep usage facts durable across a broker outage or runner restart.  The
 * event id is generated before the first request and is persisted with the
 * redacted protocol payload, so a later retry remains idempotent at Memory
 * Lab.  `required` is used for loaded: without an accepted loaded fact the
 * native turn must not proceed as if the instruction had been observed.
 */
export function durableUsagePayload(payload, eventId = payload.eventId ?? randomUUID(), occurredAt = new Date().toISOString()) {
  // Persist the complete idempotency body together with event_id. Memory Lab
  // fingerprints occurred_at on replay; generating a fresh default timestamp
  // during every drain would turn a retry into an idempotency conflict.
  return { ...payload, eventId, occurredAt: payload.occurredAt ?? occurredAt }
}

export async function recordUsageDurably(integration, config, payload, { signal, required = false } = {}) {
  const durable = durableUsagePayload(payload)
  try {
    const result = await recordUsage({
      ...durable, baseUrl: config.apiOrigin, serviceSecret: config.toolSecret,
      instanceId: config.instanceId, signal,
    })
    integration.store.markUsageDelivered(durable.eventId)
    return result
  } catch (error) {
    integration.store.enqueueUsage(durable.eventId, durable)
    if (required) throw error
    return undefined
  }
}

export async function drainUsageOutbox(integration, config) {
  if (integration === undefined || config.integrationKind !== 'memorylab') return
  for (const item of integration.store.pendingUsage()) {
    try {
      await recordUsage({
        ...item.payload, baseUrl: config.apiOrigin, serviceSecret: config.toolSecret,
        instanceId: config.instanceId,
      })
      integration.store.markUsageDelivered(item.eventId)
    } catch (error) {
      // A transient broker/authorization failure must remain durable.  The
      // next synchronizer tick retries with the same event_id.  Invalid
      // phase transitions are permanent and would otherwise poison the queue.
      // These responses are authoritative permanent outcomes for the exact
      // event. Retrying an old scope after revoke or replay conflict would
      // retain stale grant payloads forever and cannot become valid later.
      if (['USAGE_TERMINAL', 'USAGE_PHASE_INVALID', 'SCOPE_DENIED',
        'CONTEXT_REVOKED', 'IDEMPOTENCY_CONFLICT'].includes(error?.code)) {
        integration.store.markUsageDelivered(item.eventId)
      } else {
        integration.store.rescheduleUsage(item.eventId)
      }
    }
  }
}

function clientAllows(client, parentOrigin, alias) {
  if (!client.allowedParentOrigins.includes(parentOrigin)) throw new WorkbenchExtensionError('EMBED_ORIGIN_DENIED')
  if (!client.workspaceAliases.includes(alias)) throw new WorkbenchExtensionError('EMBED_SCOPE_DENIED')
}

function csp(config, nonce) {
  const ancestors = config.allowedParentOrigins.join(' ')
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function embedHtml(config, channelId, nonce, advertisedCapabilities) {
  const settings = safeJson({
    protocol: PROTOCOL,
    version: VERSION,
    channelId,
    allowedParentOrigins: config.allowedParentOrigins,
    capabilities: advertisedCapabilities,
    initTimeoutMs: config.initTimeoutMs,
  })
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 工作台</title><style nonce="${nonce}">html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f5f7fa;color:#24324a;font:15px system-ui,sans-serif}.state{max-width:520px;padding:24px;text-align:center}.spinner{width:24px;height:24px;margin:0 auto 16px;border:3px solid #d8deea;border-top-color:#285ec7;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}h1{font-size:18px;margin:0 0 8px}p{line-height:1.6;color:#5d687a}</style></head><body><main class="state"><div class="spinner" aria-hidden="true"></div><h1 id="title">正在连接工作台</h1><p id="detail">等待父系统完成可信授权。</p></main><script nonce="${nonce}">(()=>{'use strict';const cfg=${settings};const title=document.getElementById('title');const detail=document.getElementById('detail');let settled=false,timer;const send=(origin,type,requestId,payload)=>parent.postMessage({protocol:cfg.protocol,version:cfg.version,type,channel_id:cfg.channelId,request_id:requestId,payload},origin);const fail=(origin,requestId,code,message,retryable=false,action='retry')=>{settled=true;clearTimeout(timer);title.textContent='无法打开工作台';detail.textContent=message;send(origin,'error',requestId,{code,message,retryable,action})};for(const origin of cfg.allowedParentOrigins)send(origin,'ready',cfg.channelId,{capabilities:cfg.capabilities,auth_required:true});addEventListener('message',async event=>{if(settled||event.source!==parent||!cfg.allowedParentOrigins.includes(event.origin))return;const m=event.data;if(!m||typeof m!=='object'||m.protocol!==cfg.protocol||m.version!==cfg.version||m.type!=='init'||m.channel_id!==cfg.channelId||typeof m.request_id!=='string'||!m.payload||typeof m.payload!=='object'||typeof m.payload.ticket!=='string'||m.payload.ticket.length<32)return;settled=true;title.textContent='正在验证工作区';detail.textContent='授权成功后将打开完整 DSH Web。';timer=setTimeout(()=>fail(event.origin,m.request_id,'EMBED_INIT_TIMEOUT','初始化超时，请申请新授权后重试。',true,'request_ticket'),cfg.initTimeoutMs);try{const response=await fetch('/embed/bootstrap/redeem',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-request-id':m.request_id},body:JSON.stringify({protocol:cfg.protocol,version:cfg.version,channel_id:cfg.channelId,request_id:m.request_id,parent_origin:event.origin,ticket:m.payload.ticket,initial_prompt:typeof m.payload.initial_prompt==='string'?m.payload.initial_prompt:undefined})});const body=await response.json();if(!response.ok)throw body;const state={...body,parent_origin:event.origin,channel_id:cfg.channelId,request_id:m.request_id,session_binding:typeof body.session_id==='string'?'grant':'workspace',prompt_applied:false};sessionStorage.setItem('dsh.embed.pending.v1',JSON.stringify(state));clearTimeout(timer);location.replace('/?dsh_embed=1')}catch(error){const payload=error&&error.error;fail(event.origin,m.request_id,payload?.code??'EMBED_AUTH_UNAVAILABLE',payload?.message??'无法完成工作台登录。',payload?.retryable===true,payload?.action??'retry')}},{passive:true})})();</script></body></html>`
}

function verifyAuthenticated(connection, req) {
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return
  throw new WorkbenchExtensionError(rejection === 401 ? 'EMBED_CLIENT_UNAUTHORIZED' : 'EMBED_ORIGIN_DENIED')
}

function registerRoutes(ctx, config, policy, store, integration, runtimeRegistry, pageContextEnabled = false) {
  const route = (path, handler) => ctx.webServer.register({ kind: 'exact', path, handler })
  const disposers = []
  const advertisedCapabilities = capabilities(integration, runtimeRegistry !== undefined, pageContextEnabled)

  disposers.push(route('/embed/health/ready', (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['GET', 'HEAD'])) return
    const ready = policy.ready
    writeJson(res, ready ? 200 : 503, {
      status: ready ? 'ready' : 'pending',
      runtime_mode: runtimeRegistry === undefined ? 'trusted_shared_account' : 'embedded_multi_user',
      provisioned_runtimes: runtimeRegistry?.runtimes.filter(item => item.status === 'ready').length ?? 0,
      request_id: id,
    })
  }))

  disposers.push(route('/embed/control/grants', async (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['POST'])) return
    try {
      const client = findClient(config, req)
      const body = await readJson(req)
      const parentOrigin = oneString(body.parent_origin, 'parent_origin', 2048)
      const workspaceId = oneString(body.workspace_id, 'workspace_id')
      const subject = oneString(body.subject, 'subject', 512)
      const workspace = await policy.checkWorkspaceId(workspaceId)
      if (workspace.alias === null) throw new WorkbenchExtensionError('EMBED_SCOPE_DENIED')
      clientAllows(client, parentOrigin, workspace.alias)
      if (body.session_id !== undefined) policy.requireSession(workspaceId, oneString(body.session_id, 'session_id'))
      const contextId = body.context_id === undefined ? undefined : oneString(body.context_id, 'context_id')
      if (contextId !== undefined) {
        if (integration === undefined || body.session_id === undefined) throw new WorkbenchExtensionError('CONTEXT_NOT_BOUND')
        const binding = integration.store.requireActive(body.session_id)
        if (binding.contextId !== contextId || binding.workspaceId !== workspaceId
          || binding.clientId !== client.clientId) {
          throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH')
        }
      }
      const mode = workspace.mode === 'preview_only' || client.mode === 'preview_only' ? 'preview_only' : 'read_write'
      const ttlSeconds = Math.min(config.ticketTtlSeconds, config.ticketMaxTtlSeconds)
      const issued = store.issue({
        clientId: client.clientId,
        subject,
        parentOrigin,
        scope: { workspaceId, sessionId: body.session_id, contextId, mode },
        ttlSeconds,
        requestId: id,
      })
      writeJson(res, 201, {
        ticket: issued.token,
        expires_at: new Date(issued.expiresAt).toISOString(),
        entry_url: '/embed',
        protocol_version: VERSION,
      })
    } catch (error) { writeError(res, error, id) }
  }))

  disposers.push(route('/embed/control/grants/revoke', async (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['POST'])) return
    try {
      const client = findClient(config, req)
      const body = await readJson(req)
      const revoked = store.revoke(oneString(body.ticket, 'ticket', 4096), client.clientId, id)
      writeJson(res, 200, { revoked, request_id: id })
    } catch (error) { writeError(res, error, id) }
  }))

  disposers.push(route('/embed/bootstrap/redeem', async (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['POST'])) return
    try {
      const body = await readJson(req)
      if (body.protocol !== PROTOCOL || body.version !== VERSION) throw new WorkbenchExtensionError('EMBED_PROTOCOL_UNSUPPORTED')
      oneString(body.channel_id, 'channel_id')
      const initRequestId = oneString(body.request_id, 'request_id')
      const parentOrigin = oneString(body.parent_origin, 'parent_origin', 2048)
      const ticket = oneString(body.ticket, 'ticket', 4096)
      const initialPrompt = body.initial_prompt === undefined ? undefined : oneString(body.initial_prompt, 'initial_prompt', 8000)
      const inspected = store.inspect(ticket)
      if (inspected.parentOrigin !== parentOrigin) throw new WorkbenchExtensionError('EMBED_ORIGIN_DENIED')
      const workspace = await policy.checkWorkspaceId(inspected.scope.workspaceId)
      if (inspected.scope.sessionId !== undefined) policy.requireSession(workspace.workspace_id, inspected.scope.sessionId)
      if (inspected.scope.mode === 'read_write') await policy.requireWritable(workspace)
      const issued = ctx.connection.issueBrowserSession(req)
      if ('rejection' in issued) throw new WorkbenchExtensionError('EMBED_ORIGIN_DENIED')
      const grant = store.consume(ticket, initRequestId)
      const result = {
        protocol: PROTOCOL,
        version: VERSION,
        workspace_id: workspace.workspace_id,
        session_id: grant.scope.sessionId ?? null,
        mode: grant.scope.mode,
        capabilities: advertisedCapabilities,
        ...(grant.scope.contextId === undefined ? {} : { context_id: grant.scope.contextId }),
        ...(initialPrompt === undefined ? {} : { initial_prompt: initialPrompt }),
      }
      store.saveResult(grant.grantId, result)
      writeJson(res, 200, result, { 'set-cookie': issued.setCookie })
    } catch (error) { writeError(res, error, id) }
  }))

  disposers.push(route('/embed/control/workspaces', async (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['GET'])) return
    try {
      verifyAuthenticated(ctx.connection, req)
      writeJson(res, 200, { items: await policy.listConfigured(), request_id: id })
    } catch (error) { writeError(res, error, id) }
  }))

  disposers.push(route('/embed/control/workspaces/check', async (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['POST'])) return
    try {
      verifyAuthenticated(ctx.connection, req)
      const body = await readJson(req)
      writeJson(res, 200, { ...(await policy.checkWorkspaceId(oneString(body.workspace_id, 'workspace_id'))), request_id: id })
    } catch (error) { writeError(res, error, id) }
  }))

  disposers.push(route('/embed', (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['GET', 'HEAD'])) return
    const url = new URL(req.url ?? '/embed', config.publicOrigin)
    const channelId = url.searchParams.get('channel_id')
    const nonce = randomBytes(18).toString('base64url')
    const headers = {
      'cache-control': 'no-store',
      'content-security-policy': csp(config, nonce),
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    }
    if (channelId === null || channelId.length === 0 || channelId.length > 256 || url.searchParams.size !== 1) {
      const error = new WorkbenchExtensionError('EMBED_PROTOCOL_UNSUPPORTED', { message: 'channel_id 不合法' })
      const body = Buffer.from(`<h1>${error.message}</h1><p>${id}</p>`, 'utf8')
      res.writeHead(error.status, { ...headers, 'content-length': String(body.length) })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    const body = Buffer.from(embedHtml(config, channelId, nonce, advertisedCapabilities), 'utf8')
    res.writeHead(200, { ...headers, 'content-length': String(body.length) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }))

  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export async function apply(ctx) {
  const workspaceConfig = loadWorkspaceConfig(process.env.WORKBENCH_WORKSPACE_CONFIG)
  const enabled = embedEnabled()
  const embedConfig = loadEmbedConfig(process.env.WORKBENCH_EMBED_CONFIG, enabled)
  const integrationConfig = loadIntegrationConfig()
  if (workspaceConfig === undefined) {
    if (enabled) throw new WorkbenchExtensionError('CONFIG_INVALID', { message: '嵌入功能需要 WORKBENCH_WORKSPACE_CONFIG' })
    return
  }
  const runtimeRegistry = embedConfig?.deploymentMode === 'embedded_multi_user' ? loadRuntimeRegistry() : undefined
  const policy = new WorkspacePolicy(ctx.workspaceRegistry, workspaceConfig)
  await policy.initialize()

  ctx.on('api-session/create-admission', async (request, next) => {
    try { await policy.admitCreate(request) } catch (error) { throw policy.asRemote(error) }
    return next()
  }, { global: true })
  // The native fork command creates its child inside the session controller,
  // so a normal create-admission hook cannot protect the gap between child
  // allocation and the first prompt.  Bind the child before agents.create()
  // runs, using the live parent lease and the same trusted context.
  if (integrationConfig !== undefined) {
    ctx.on('api-session/fork-admission', async (request, next) => {
      try {
        const parent = integration?.store.requireActive(request.sourceSessionId)
        if (parent === undefined) throw new WorkbenchExtensionError('CONTEXT_NOT_BOUND')
        policy.requireSession(parent.workspaceId, request.sourceSessionId)
        if (request.workspaceId !== undefined && request.workspaceId !== parent.workspaceId) {
          throw new WorkbenchExtensionError('SESSION_WORKSPACE_MISMATCH')
        }
        const metadata = await verifyContext(
          integrationConfig,
          parent.contextId,
          undefined,
          runtimeRegistry,
          parent.accessGrantId,
        )
        if (metadata.runtime_id !== undefined && parent.runtimeId !== undefined
          && metadata.runtime_id !== parent.runtimeId) {
          throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH')
        }
        if (integrationConfig.integrationKind === 'memorylab') {
          await associateRemoteFork(integrationConfig, {
            requestId: request.childSessionId,
            contextId: parent.contextId,
            childSessionId: request.childSessionId,
            sourceSessionId: request.sourceSessionId,
            workspaceId: parent.workspaceId,
            accessGrantId: parent.accessGrantId,
            runtimeId: parent.runtimeId ?? metadata.runtime_id,
          })
        }
        integration.store.bind({
          clientId: parent.clientId,
          contextId: parent.contextId,
          workspaceId: parent.workspaceId,
          sessionId: request.childSessionId,
          instanceId: integrationConfig.instanceId,
          metadata,
        })
      } catch (error) { throw policy.asRemote(error) }
      return next()
    }, { global: true })
    ctx.on('api-session/fork-failed', async (request, next) => {
      const parent = integration?.store.binding(request.sourceSessionId)
      if (parent !== undefined) {
        if (integrationConfig.integrationKind === 'memorylab') {
          try {
            await rollbackRemoteFork(integrationConfig, {
              requestId: request.childSessionId,
              contextId: parent.contextId,
              childSessionId: request.childSessionId,
              sourceSessionId: request.sourceSessionId,
              workspaceId: parent.workspaceId,
              accessGrantId: parent.accessGrantId,
              runtimeId: parent.runtimeId,
            })
          } catch { /* preserve native fork failure */ }
        }
        integration.store.removeUnmaterializedBinding(request.childSessionId, {
          contextId: parent.contextId,
          clientId: parent.clientId,
        })
      }
      return next()
    }, { global: true })
  }
  ctx.on('api-session/prompt-admission', async (request, next) => {
    try { await policy.admitPrompt(request) } catch (error) { throw policy.asRemote(error) }
    return next()
  }, { global: true })
  ctx.on('agent/pre-step', async (payload, next) => {
    try { await policy.admitAgentStep(payload.agent) } catch (error) { throw policy.asRemote(error) }
    return next()
  }, { global: true })

  if (embedConfig === undefined) {
    if (integrationConfig !== undefined) {
      throw new WorkbenchExtensionError('CONFIG_INVALID', { message: '宿主集成需要同时启用 iframe 嵌入' })
    }
    return
  }
  const statePath = resolve(process.env.WORKBENCH_EMBED_STATE
    ?? resolve(process.env.DSH_HOME ?? process.cwd(), 'extensions/embed.sqlite3'))
  const store = new GrantStore(statePath)
  const integration = integrationConfig === undefined
    ? undefined
    : registerIntegrationRoutes(ctx, integrationConfig, policy, req => findClient(embedConfig, req), runtimeRegistry)
  if (integrationConfig?.integrationKind === 'memorylab' && integrationConfig.pageContextEnabled === true) {
    ctx.on('api-session/prompt-enrichment', async (request, next) => {
      const enriched = await enrichPagePrompt(integration, integrationConfig, request)
      if (enriched !== undefined) request.content = enriched.content
      return next()
    }, { global: true })
  }
  const agentProviders = new WeakMap()
  const agentInvocations = new WeakMap()
  // Terminal usage must be claimed before the async broker call.  Otherwise
  // `agent/turn-stopping` and `agent/error` can observe the same list and race
  // to report completed plus failed/cancelled for one receipt.
  const takeAgentInvocations = agent => {
    const invocations = agentInvocations.get(agent) ?? []
    agentInvocations.delete(agent)
    return invocations
  }
  const admittedPrompts = new Map()
  const sessionProviders = new Map()
  const registeredProviders = new WeakSet()
  const providerRegistrationFibers = new WeakMap()
  const ensureRemoteProvider = (agent, signal) => {
    const sessionId = agent.session.id
    const existing = sessionProviders.get(sessionId)
    const currentBinding = existing === undefined ? undefined : integration.store.requireActive(sessionId)
    if (existing !== undefined && sameProviderBinding(existing.binding, currentBinding)) {
      agentProviders.set(agent, existing)
      return existing
    }
    if (existing !== undefined) sessionProviders.delete(sessionId)
    const { binding, scope } = providerScope(integration, sessionId)
    const provider = createRemoteProvider({
      baseUrl: integrationConfig.apiOrigin,
      serviceSecret: integrationConfig.toolSecret,
      instanceId: integrationConfig.instanceId,
      runtimeId: binding.runtimeId,
      scope,
      control: { signal, invalidate() {} },
    })
    const installed = { provider, binding, scope }
    sessionProviders.set(sessionId, installed)
    agentProviders.set(agent, installed)
    return installed
  }
  const registerAgentProvider = (agent, installed) => {
    if (registeredProviders.has(agent)) return
    const pending = providerRegistrationFibers.get(agent)
    if (pending !== undefined) return pending
    // Agent contexts are scoped Cordis children.  Services are intentionally
    // only readable after an explicit injection, even when the host context
    // already has the service.  Registering through the injected child keeps
    // the provider in the agent's scope and prevents a per-session provider
    // from becoming global.
    const fiber = agent.ctx.inject(['skills'], (skillsCtx) => {
      skillsCtx.skills.registerProvider(() => installed.provider)
      registeredProviders.add(agent)
    })
    providerRegistrationFibers.set(agent, fiber)
    void fiber.then(() => {
      providerRegistrationFibers.delete(agent)
    }, () => {
      providerRegistrationFibers.delete(agent)
    })
    return fiber
  }
  const agentSyncTimers = new WeakMap()
  const agentSyncControllers = new WeakMap()
  const backgroundSyncInFlight = new Map()
  const syncBoundRuntimes = async () => {
    if (integration === undefined || integrationConfig.integrationKind !== 'memorylab') return
    await drainUsageOutbox(integration, integrationConfig)
    for (const binding of integration.store.activeBindings()) {
      if (binding.runtimeId === undefined || binding.accessGrantId === undefined) continue
      if (backgroundSyncInFlight.has(binding.sessionId)) continue
      const controller = new AbortController()
      backgroundSyncInFlight.set(binding.sessionId, controller)
      void synchronizeRemoteProvider({
        baseUrl: integrationConfig.apiOrigin,
        serviceSecret: integrationConfig.toolSecret,
        instanceId: integrationConfig.instanceId,
        runtimeId: binding.runtimeId,
        scope: {
          context_id: binding.contextId,
          session_id: binding.sessionId,
          access_grant_id: binding.accessGrantId,
        },
        signal: controller.signal,
      }).catch(() => {
        // Keep the durable pending/unreachable projection; the next interval
        // retries after the online authorization check.
      }).finally(() => {
        backgroundSyncInFlight.delete(binding.sessionId)
      })
    }
  }
  await syncBoundRuntimes()
  const backgroundSync = setInterval(() => { void syncBoundRuntimes() }, 30_000)
  backgroundSync.unref?.()
  if (integration !== undefined && integrationConfig.integrationKind === 'memorylab') {
    ctx.on('agent/created', async ({ agent, signal }) => {
      let installed
      try { installed = ensureRemoteProvider(agent, signal) } catch (error) {
        if (error?.code === 'CONTEXT_NOT_BOUND') return
        throw error
      }
      await registerAgentProvider(agent, installed)
      const { binding, scope } = installed
      try {
        await synchronizeRemoteProvider({
          baseUrl: integrationConfig.apiOrigin, serviceSecret: integrationConfig.toolSecret,
          instanceId: integrationConfig.instanceId, runtimeId: binding.runtimeId, scope,
          signal,
        })
      } catch {
        // A disconnected broker leaves the activation pending; ordinary DSH
        // prompts remain usable and the 30s synchronizer retries.
      }
      const syncController = new AbortController()
      agentSyncControllers.set(agent, syncController)
      const timer = setInterval(() => {
        synchronizeRemoteProvider({
          baseUrl: integrationConfig.apiOrigin, serviceSecret: integrationConfig.toolSecret,
          instanceId: integrationConfig.instanceId, runtimeId: binding.runtimeId, scope,
          signal: syncController.signal,
        }).catch(() => {})
      }, 30_000)
      timer.unref?.()
      agentSyncTimers.set(agent, timer)
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      const timer = agentSyncTimers.get(agent)
      if (timer !== undefined) clearInterval(timer)
      agentSyncControllers.get(agent)?.abort()
      agentSyncTimers.delete(agent)
      agentSyncControllers.delete(agent)
      agentProviders.delete(agent)
      agentInvocations.delete(agent)
      admittedPrompts.delete(agent.session.id)
      sessionProviders.delete(agent.session.id)
      providerRegistrationFibers.delete(agent)
    }, { global: true })
    const providerForSession = (sessionId, signal) => {
      const existing = sessionProviders.get(sessionId)
      const binding = integration.store.requireActive(sessionId)
      if (existing !== undefined && sameProviderBinding(existing.binding, binding)) return existing.provider
      if (existing !== undefined) sessionProviders.delete(sessionId)
      const scope = { context_id: binding.contextId, session_id: binding.sessionId, access_grant_id: binding.accessGrantId }
      const provider = createRemoteProvider({
        baseUrl: integrationConfig.apiOrigin, serviceSecret: integrationConfig.toolSecret,
        instanceId: integrationConfig.instanceId, runtimeId: binding.runtimeId,
        scope, control: { signal, invalidate() {} },
      })
      sessionProviders.set(sessionId, { provider, binding, scope })
      return provider
    }
    ctx.on('api-session/prompt-admission', async (request, next) => {
      try {
        await admitRemotePrompt(integration, integrationConfig, request, admittedPrompts, providerForSession)
        return next()
      } catch (error) { throw policy.asRemote(error) }
    }, { global: true })
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const names = remoteSkillNames(payload.messages.flatMap(message => message.content ?? []))
        if (names.length > 1) throw new WorkbenchExtensionError('SKILL_MULTIPLE')
        if (names.length === 1) {
          const installed = agentProviders.get(payload.agent) ?? ensureRemoteProvider(payload.agent, payload.signal)
          await registerAgentProvider(payload.agent, installed)
          const candidate = (await installed.provider.list({ signal: payload.signal })).find(item => item.name === names[0])
          const queue = admittedPrompts.get(payload.agent.session.id) ?? []
          const queuedIndex = queue.findIndex(item => item.skillName === names[0])
          const settleQueued = async (queued, phase, errorCode) => {
            if (queued === undefined) return
          await recordUsageDurably(integration, integrationConfig, {
            runtimeId: installed.binding.runtimeId, scope: installed.scope,
            locator: queued.locator, invocationId: queued.invocationId,
            nativeRequestId: queued.nativeRequestId, phase, errorCode,
          }, { signal: payload.signal })
          }
          if (candidate === undefined) {
            const queued = queuedIndex < 0 ? undefined : queue.splice(queuedIndex, 1)[0]
            if (queue.length === 0) admittedPrompts.delete(payload.agent.session.id)
            else admittedPrompts.set(payload.agent.session.id, queue)
            await settleQueued(queued, 'failed', 'SKILL_VERSION_CHANGED')
            throw new WorkbenchExtensionError('SKILL_VERSION_CHANGED')
          }
          const index = queue.findIndex(item => item.locator.activation_id === candidate.locator.activation_id
            && item.locator.version_id === candidate.locator.version_id
            && item.locator.generation === candidate.locator.generation
            && item.locator.archive_sha256 === candidate.locator.archive_sha256)
          if (index < 0) {
            // A catalog refresh can expose a newer locator while an older
            // admitted prompt is still waiting for pre-step. Consume that
            // stale receipt and write its terminal fact; otherwise it would
            // remain admitted forever and be retried against the wrong
            // version after a switch, disable, or revoke.
            const stale = queuedIndex < 0 ? undefined : queue.splice(queuedIndex, 1)[0]
            if (queue.length === 0) admittedPrompts.delete(payload.agent.session.id)
            else admittedPrompts.set(payload.agent.session.id, queue)
            await settleQueued(stale, 'failed', 'SKILL_VERSION_CHANGED')
            throw new WorkbenchExtensionError('SKILL_VERSION_CHANGED')
          }
          const admitted = queue.splice(index, 1)[0]
          if (queue.length === 0) admittedPrompts.delete(payload.agent.session.id)
          else admittedPrompts.set(payload.agent.session.id, queue)
          try {
            const definition = await installed.provider.get(candidate, { signal: payload.signal })
            if (definition === undefined) throw new WorkbenchExtensionError('SKILL_VERSION_CHANGED')
            await recordUsageDurably(integration, integrationConfig, {
              runtimeId: installed.binding.runtimeId, scope: installed.scope,
              locator: candidate.locator, invocationId: admitted.invocationId,
              nativeRequestId: admitted.nativeRequestId, phase: 'loaded',
            }, { signal: payload.signal, required: true })
          } catch (error) {
            const cancelled = error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
            await settleQueued(admitted, cancelled ? 'cancelled' : 'failed', error?.code ?? 'SKILL_LOAD_FAILED')
            throw error
          }
          const invocations = agentInvocations.get(payload.agent) ?? []
          invocations.push({ locator: candidate.locator, invocationId: admitted.invocationId, nativeRequestId: admitted.nativeRequestId })
          agentInvocations.set(payload.agent, invocations)
        }
        return next()
      } catch (error) { throw policy.asRemote(error) }
    }, { global: true })
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      const invocations = takeAgentInvocations(agent)
      const installed = agentProviders.get(agent)
      if (invocations.length === 0 || installed === undefined) return
      try {
        for (const invocation of invocations) await recordUsageDurably(integration, integrationConfig, {
          runtimeId: installed.binding.runtimeId, scope: installed.scope, locator: invocation.locator,
          invocationId: invocation.invocationId, nativeRequestId: invocation.nativeRequestId, phase: 'completed',
        }, { signal })
      } catch { /* usage outbox/retry is owned by the runtime bridge */ }
    }, { global: true })
    ctx.on('agent/error', ({ agent, error }) => {
      const invocations = takeAgentInvocations(agent)
      const installed = agentProviders.get(agent)
      if (invocations.length === 0 || installed === undefined) return
      const cancelled = error?.name === 'AbortError'
        || error?.code === 'ABORT_ERR'
        || error?.code === 'gateway/cancelled'
        || error?.code === 'CANCELLED'
      void Promise.all(invocations.map(invocation => recordUsageDurably(integration, integrationConfig, {
        runtimeId: installed.binding.runtimeId, scope: installed.scope, locator: invocation.locator,
        invocationId: invocation.invocationId, nativeRequestId: invocation.nativeRequestId,
        phase: cancelled ? 'cancelled' : 'failed', errorCode: error?.code,
      }))).catch(() => {})
    }, { global: true })
  }
  const disposeRoutes = registerRoutes(
    ctx, embedConfig, policy, store, integration, runtimeRegistry,
    integrationConfig?.pageContextEnabled === true,
  )
  const cleanup = setInterval(() => store.cleanup(), 60_000)
  cleanup.unref()
  ctx.effect(() => () => {
    clearInterval(cleanup)
    clearInterval(backgroundSync)
    for (const controller of backgroundSyncInFlight.values()) controller.abort()
    backgroundSyncInFlight.clear()
    disposeRoutes()
    integration?.dispose()
    store.close()
  }, 'workbench-extensions lifecycle')
}
