import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  embedEnabled,
  loadEmbedConfig,
  loadIntegrationConfig,
  loadWorkspaceConfig,
} from './config.js'
import { WorkbenchExtensionError } from './errors.js'
import { GrantStore } from './grants.js'
import { bearer, method, readJson, requestId, secretEqual, writeError, writeJson } from './http.js'
import { registerIntegrationRoutes } from './integration.js'
import { WorkspacePolicy } from './workspaces.js'

export const name = 'workbench-extensions'
export const inject = ['connection', 'sessionController', 'webServer', 'workspaceRegistry']

const PROTOCOL = 'dsh.embed'
const VERSION = '1.0'
const BASE_CAPABILITIES = Object.freeze(['workspace_open', 'session_open', 'draft_prompt'])

function capabilities(integration) {
  return integration === undefined
    ? BASE_CAPABILITIES
    : Object.freeze([...BASE_CAPABILITIES, 'integration_context', 'session_navigation_events', 'session_lifecycle_events'])
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

function registerRoutes(ctx, config, policy, store, integration) {
  const route = (path, handler) => ctx.webServer.register({ kind: 'exact', path, handler })
  const disposers = []
  const advertisedCapabilities = capabilities(integration)

  disposers.push(route('/embed/health/ready', (req, res) => {
    const id = requestId(req)
    if (!method(req, res, ['GET', 'HEAD'])) return
    const ready = policy.ready
    writeJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'pending', request_id: id })
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
  const policy = new WorkspacePolicy(ctx.workspaceRegistry, workspaceConfig)
  await policy.initialize()

  ctx.on('api-session/create-admission', async (request, next) => {
    try { await policy.admitCreate(request) } catch (error) { throw policy.asRemote(error) }
    return next()
  }, { global: true })
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
    : registerIntegrationRoutes(ctx, integrationConfig, policy, req => findClient(embedConfig, req))
  const disposeRoutes = registerRoutes(ctx, embedConfig, policy, store, integration)
  const cleanup = setInterval(() => store.cleanup(), 60_000)
  cleanup.unref()
  ctx.effect(() => () => {
    clearInterval(cleanup)
    disposeRoutes()
    integration?.dispose()
    store.close()
  }, 'workbench-extensions lifecycle')
}
