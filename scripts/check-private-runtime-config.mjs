#!/usr/bin/env node

// Validate the two deployment-owned sources of truth without printing any
// credential material. The DSH registry selects a runner by immutable subject;
// Memory Lab must contain the same runtime_id -> subject mapping and a
// runtime-scoped secret for every row.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const registryPath = resolve(process.env.RUNTIME_REGISTRY ?? 'examples/deploy/private/runtime-registry.json')
const memoryLabEnvPath = resolve(process.env.MEMORYLAB_RUNTIME_ENV ?? '../private_MEM_LAB/deploy/private/runtime-secrets.env')

function fail(message) {
  console.error(JSON.stringify({ result: 'FAIL', code: 'CONFIG_INVALID', message }, null, 2))
  process.exitCode = 1
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function readEnvFile(path) {
  const values = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`invalid env line in ${path}`)
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return values
}

try {
  const registry = object(JSON.parse(readFileSync(registryPath, 'utf8')), 'runtime registry')
  if (!Array.isArray(registry.runtimes) || registry.runtimes.length === 0) throw new Error('runtime registry runtimes is empty')
  const registryRows = registry.runtimes.map((row, index) => {
    object(row, `runtime[${index}]`)
    for (const key of ['runtime_id', 'subject', 'internal_origin', 'control_secret_file']) {
      if (typeof row[key] !== 'string' || row[key].trim() === '') throw new Error(`runtime[${index}].${key} is required`)
    }
    if (!['ready', 'provisioning', 'disabled'].includes(row.status ?? 'ready')) throw new Error(`runtime[${index}] has invalid status`)
    return { runtimeId: row.runtime_id, subject: row.subject, status: row.status ?? 'ready' }
  })
  const registryIds = new Set()
  for (const row of registryRows) {
    if (registryIds.has(row.runtimeId)) throw new Error(`duplicate runtime_id: ${row.runtimeId}`)
    registryIds.add(row.runtimeId)
  }

  const env = readEnvFile(memoryLabEnvPath)
  const secrets = object(JSON.parse(env.AI_TOOL_RUNTIME_SECRETS_JSON ?? ''), 'AI_TOOL_RUNTIME_SECRETS_JSON')
  const subjects = object(JSON.parse(env.AI_TOOL_RUNTIME_SUBJECTS_JSON ?? ''), 'AI_TOOL_RUNTIME_SUBJECTS_JSON')
  const secretIds = Object.keys(secrets).sort()
  const subjectIds = Object.keys(subjects).sort()
  const registrySorted = registryRows.map(row => row.runtimeId).sort()
  if (JSON.stringify(secretIds) !== JSON.stringify(registrySorted)) throw new Error('runtime secret IDs do not match registry')
  if (JSON.stringify(subjectIds) !== JSON.stringify(registrySorted)) throw new Error('runtime subject IDs do not match registry')

  const mismatches = registryRows.filter(row => subjects[row.runtimeId] !== row.subject)
  if (mismatches.length > 0) throw new Error(`runtime subject mismatch: ${mismatches.map(row => row.runtimeId).join(', ')}`)
  const shortSecrets = registryRows.filter(row => typeof secrets[row.runtimeId] !== 'string' || Buffer.byteLength(secrets[row.runtimeId]) < 32)
  if (shortSecrets.length > 0) throw new Error(`runtime secret is missing or shorter than 32 bytes: ${shortSecrets.map(row => row.runtimeId).join(', ')}`)

  const ready = registryRows.filter(row => row.status === 'ready').map(row => row.runtimeId)
  console.log(JSON.stringify({
    result: 'PASS',
    registry: registryPath,
    memorylab_env: memoryLabEnvPath,
    runtime_ids: registrySorted,
    ready_runtime_ids: ready,
    subject_bindings_verified: registryRows.length,
    secret_lengths_verified: registryRows.length,
  }, null, 2))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
