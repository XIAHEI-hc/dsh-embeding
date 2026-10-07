import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { getDomain } from 'tldts'
import { WorkbenchExtensionError } from './errors.js'

function configError(message, cause) {
  return new WorkbenchExtensionError('CONFIG_INVALID', { message, cause })
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(`${label} 必须是 JSON 对象`)
  }
  return value
}

function string(value, label, { max = 4096, optional = false } = {}) {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw configError(`${label} 必须是 1..${max} 字符的字符串`)
  }
  return value
}

function stringArray(value, label, { min = 1 } = {}) {
  if (!Array.isArray(value) || value.length < min) throw configError(`${label} 必须是非空字符串数组`)
  const parsed = value.map((item, index) => string(item, `${label}[${index}]`))
  if (new Set(parsed).size !== parsed.length) throw configError(`${label} 不能包含重复值`)
  return parsed
}

function integer(value, label, fallback, min, max) {
  const parsed = value ?? fallback
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw configError(`${label} 必须是 ${min}..${max} 的整数`)
  }
  return parsed
}

function readJson(path, label) {
  try {
    return record(JSON.parse(readFileSync(path, 'utf8')), label)
  } catch (error) {
    if (error instanceof WorkbenchExtensionError) throw error
    throw configError(`无法读取 ${label}: ${path}`, error)
  }
}

export function exactOrigin(value, label) {
  const raw = string(value, label)
  let url
  try { url = new URL(raw) } catch (error) { throw configError(`${label} 必须是 HTTP(S) origin`, error) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !url.hostname || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw configError(`${label} 必须是无路径、查询、片段和凭据的 HTTP(S) origin`)
  }
  return url.origin
}

function siteLabel(origin) {
  const url = new URL(origin)
  const domain = getDomain(url.hostname)
  return `${url.protocol}//${domain ?? url.hostname}`
}

function existingRoot(value, label) {
  const raw = string(value, label)
  if (!isAbsolute(raw)) throw configError(`${label} 必须是绝对路径`)
  try { return realpathSync(raw) } catch (error) { throw configError(`${label} 不存在或不可访问`, error) }
}

export function loadWorkspaceConfig(path) {
  if (!path) return undefined
  const input = readJson(resolve(path), '工作区配置')
  if (input.schema_version !== 1) throw configError('工作区配置 schema_version 必须为 1')
  if (input.auto_create_user_directories !== false) {
    throw configError('auto_create_user_directories 必须显式为 false')
  }
  const allowedRoots = stringArray(input.allowed_roots, 'allowed_roots')
    .map((root, index) => existingRoot(root, `allowed_roots[${index}]`))
  if (!Array.isArray(input.workspaces)) throw configError('workspaces 必须是数组')
  const aliases = new Set()
  const workspaces = input.workspaces.map((value, index) => {
    const item = record(value, `workspaces[${index}]`)
    const alias = string(item.alias, `workspaces[${index}].alias`, { max: 128 })
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(alias)) throw configError(`工作区别名不合法: ${alias}`)
    if (aliases.has(alias)) throw configError(`工作区别名重复: ${alias}`)
    aliases.add(alias)
    const pathValue = string(item.path, `workspaces[${index}].path`)
    if (!isAbsolute(pathValue)) throw configError(`工作区路径必须是绝对路径: ${alias}`)
    const mode = item.mode ?? 'read_write'
    if (!['read_write', 'preview_only'].includes(mode)) throw configError(`工作区 mode 不合法: ${alias}`)
    return {
      alias,
      path: resolve(pathValue),
      title: string(item.title ?? alias, `workspaces[${index}].title`, { max: 256 }),
      mode,
      writeProbe: item.write_probe === true,
    }
  })
  const defaultAlias = string(input.default_alias, 'default_alias', { max: 128, optional: true })
  if (defaultAlias !== undefined && !aliases.has(defaultAlias)) throw configError('default_alias 未出现在 workspaces 中')
  return { schemaVersion: 1, allowedRoots, defaultAlias, workspaces }
}

function clientSecret(item, index) {
  const envName = string(item.secret_env, `clients[${index}].secret_env`, { max: 256, optional: true })
  const file = string(item.secret_file, `clients[${index}].secret_file`, { optional: true })
  if ((envName === undefined) === (file === undefined)) {
    throw configError(`clients[${index}] 必须且只能配置 secret_env 或 secret_file`)
  }
  let value
  try { value = envName === undefined ? readFileSync(file, 'utf8').trim() : process.env[envName] } catch (error) {
    throw configError(`无法读取客户端 secret: clients[${index}]`, error)
  }
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096) {
    throw configError(`clients[${index}] 的 secret 必须为 32..4096 字符`)
  }
  return value
}

function environmentSecret(envName, fileName, label) {
  const fromEnv = process.env[envName]
  const file = process.env[fileName]
  if ((fromEnv === undefined) === (file === undefined)) {
    throw configError(`${label} 必须且只能通过 ${envName} 或 ${fileName} 配置`)
  }
  let value
  try { value = fromEnv ?? readFileSync(file, 'utf8').trim() } catch (error) {
    throw configError(`无法读取 ${label}`, error)
  }
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096) {
    throw configError(`${label} 必须为 32..4096 字符`)
  }
  return value
}

export function loadEmbedConfig(path, enabled) {
  if (!enabled) return undefined
  if (!path) throw configError('启用嵌入时必须设置 WORKBENCH_EMBED_CONFIG')
  const input = readJson(resolve(path), '嵌入配置')
  if (input.schema_version !== 1) throw configError('嵌入配置 schema_version 必须为 1')
  const publicOrigin = exactOrigin(input.public_origin, 'public_origin')
  if (process.env.WORKBENCH_PUBLIC_URL !== undefined
    && exactOrigin(process.env.WORKBENCH_PUBLIC_URL, 'WORKBENCH_PUBLIC_URL') !== publicOrigin) {
    throw configError('public_origin 必须与 WORKBENCH_PUBLIC_URL 完全一致')
  }
  const allowedParentOrigins = stringArray(input.allowed_parent_origins, 'allowed_parent_origins')
    .map((origin, index) => exactOrigin(origin, `allowed_parent_origins[${index}]`))
  for (const origin of allowedParentOrigins) {
    if (siteLabel(origin) !== siteLabel(publicOrigin)) {
      throw new WorkbenchExtensionError('EMBED_CROSS_SITE_UNSUPPORTED')
    }
  }
  if (input.deployment_mode !== 'trusted_shared_account') {
    throw configError('deployment_mode 当前必须为 trusted_shared_account')
  }
  if (!Array.isArray(input.clients) || input.clients.length === 0) throw configError('clients 必须是非空数组')
  const ids = new Set()
  const clients = input.clients.map((value, index) => {
    const item = record(value, `clients[${index}]`)
    const clientId = string(item.client_id, `clients[${index}].client_id`, { max: 128 })
    if (ids.has(clientId)) throw configError(`client_id 重复: ${clientId}`)
    ids.add(clientId)
    const origins = stringArray(item.allowed_parent_origins, `clients[${index}].allowed_parent_origins`)
      .map((origin, originIndex) => exactOrigin(origin, `clients[${index}].allowed_parent_origins[${originIndex}]`))
    if (origins.some(origin => !allowedParentOrigins.includes(origin))) {
      throw configError(`客户端 ${clientId} 的 origin 超出全局 allowed_parent_origins`)
    }
    const mode = item.mode ?? 'read_write'
    if (!['read_write', 'preview_only'].includes(mode)) throw configError(`客户端 mode 不合法: ${clientId}`)
    if (mode === 'preview_only') {
      throw configError(`客户端 ${clientId} 的 preview_only 无法在 trusted_shared_account 模式下持续约束`)
    }
    return {
      clientId,
      secret: clientSecret(item, index),
      allowedParentOrigins: origins,
      workspaceAliases: stringArray(item.workspace_aliases, `clients[${index}].workspace_aliases`),
      mode,
    }
  })
  return {
    schemaVersion: 1,
    publicOrigin,
    allowedParentOrigins,
    ticketTtlSeconds: integer(input.ticket_ttl_seconds, 'ticket_ttl_seconds', 60, 1, 120),
    ticketMaxTtlSeconds: integer(input.ticket_max_ttl_seconds, 'ticket_max_ttl_seconds', 120, 1, 120),
    readyTimeoutMs: integer(input.ready_timeout_ms, 'ready_timeout_ms', 15000, 1000, 120000),
    initTimeoutMs: integer(input.init_timeout_ms, 'init_timeout_ms', 30000, 1000, 120000),
    clients,
  }
}

export function embedEnabled(value = process.env.WORKBENCH_EMBED_ENABLED) {
  if (value === undefined || value === '' || value === 'false' || value === '0') return false
  if (value === 'true' || value === '1') return true
  throw configError('WORKBENCH_EMBED_ENABLED 必须是 true/false 或 1/0')
}

export function integrationEnabled(value = process.env.PROBE_AI_INTEGRATION_ENABLED) {
  if (value === undefined || value === '' || value === 'false' || value === '0') return false
  if (value === 'true' || value === '1') return true
  throw configError('PROBE_AI_INTEGRATION_ENABLED 必须是 true/false 或 1/0')
}

export function loadIntegrationConfig(enabled = integrationEnabled()) {
  if (!enabled) return undefined
  const instanceId = string(process.env.PROBE_AI_DSH_INSTANCE_ID, 'PROBE_AI_DSH_INSTANCE_ID', { max: 128 })
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(instanceId)) {
    throw configError('PROBE_AI_DSH_INSTANCE_ID 只允许字母、数字、点、下划线和连字符')
  }
  return {
    instanceId,
    probeApiOrigin: exactOrigin(process.env.PROBE_AI_API_ORIGIN, 'PROBE_AI_API_ORIGIN'),
    toolSecret: environmentSecret('PROBE_AI_TOOL_SECRET', 'PROBE_AI_TOOL_SECRET_FILE', 'Probe 工具服务 secret'),
    verifyTimeoutMs: integer(
      Number(process.env.PROBE_AI_VERIFY_TIMEOUT_MS || 5000),
      'PROBE_AI_VERIFY_TIMEOUT_MS',
      5000,
      100,
      30000,
    ),
  }
}
