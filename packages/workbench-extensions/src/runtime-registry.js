import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkbenchExtensionError } from './errors.js'

function fail(message) {
  throw new WorkbenchExtensionError('CONFIG_INVALID', { message })
}

function requiredString(value, label, max = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(`${label} 必须是 1..${max} 字符的字符串`)
  return value
}

function exactOrigin(value, label) {
  const raw = requiredString(value, label)
  let url
  try { url = new URL(raw) } catch { fail(`${label} 必须是 HTTP(S) origin`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname
    || !['', '/'].includes(url.pathname) || url.search || url.hash) fail(`${label} 必须是无路径、查询、片段和凭据的 HTTP(S) origin`)
  return url.origin
}

/** Control-plane registry. Unknown subjects fail; there is no shared fallback. */
export function loadRuntimeRegistry(pathValue = process.env.WORKBENCH_RUNTIME_REGISTRY) {
  if (!pathValue) fail('多用户模式必须配置 WORKBENCH_RUNTIME_REGISTRY')
  let input
  try { input = JSON.parse(readFileSync(resolve(pathValue), 'utf8')) } catch { fail(`无法读取 runtime registry: ${pathValue}`) }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('runtime registry 必须是对象')
  if (input.schema_version !== '1.0' && input.schema_version !== 1) fail('runtime registry schema_version 必须为 1.0')
  const hostInstanceId = requiredString(input.host_instance_id, 'host_instance_id', 128)
  if (!Array.isArray(input.runtimes) || input.runtimes.length === 0) fail('runtime registry runtimes 不能为空')
  const subjects = new Set(); const runtimeIds = new Set()
  const runtimes = input.runtimes.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail(`runtimes[${index}] 必须是对象`)
    const subject = requiredString(item.subject, `runtimes[${index}].subject`, 256)
    const runtimeId = requiredString(item.runtime_id, `runtimes[${index}].runtime_id`, 128)
    if (subjects.has(subject)) fail(`runtime subject 重复: ${subject}`)
    if (runtimeIds.has(runtimeId)) fail(`runtime_id 重复: ${runtimeId}`)
    subjects.add(subject); runtimeIds.add(runtimeId)
    const status = item.status ?? 'ready'
    if (!['ready', 'provisioning', 'disabled'].includes(status)) fail(`runtime 状态不合法: ${runtimeId}`)
    const controlSecretFile = item.control_secret_file === undefined
      ? undefined
      : requiredString(item.control_secret_file, `runtimes[${index}].control_secret_file`, 1024)
    return Object.freeze({ subject, runtimeId, internalOrigin: exactOrigin(item.internal_origin, `runtimes[${index}].internal_origin`), status, controlSecretFile })
  })
  return Object.freeze({ schemaVersion: '1.0', hostInstanceId, runtimes: Object.freeze(runtimes) })
}

export function runtimeForSubject(registry, subject) {
  const row = registry.runtimes.find(item => item.subject === subject)
  if (row === undefined || row.status !== 'ready') throw new WorkbenchExtensionError('RUNTIME_NOT_PROVISIONED')
  return row
}
