import { constants } from 'node:fs'
import { access, open, realpath, stat, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { WorkbenchExtensionError } from './errors.js'

function pathInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function filesystemError(error) {
  const code = error?.code
  if (code === 'ENOENT') return new WorkbenchExtensionError('WORKSPACE_DIRECTORY_MISSING', { cause: error })
  if (code === 'EACCES' || code === 'EPERM') return new WorkbenchExtensionError('WORKSPACE_READ_DENIED', { cause: error })
  return new WorkbenchExtensionError('WORKSPACE_IO_ERROR', { cause: error })
}

async function writeProbe(path) {
  const probe = resolve(path, `.dsh-write-probe-${process.pid}-${randomUUID()}`)
  try {
    const handle = await open(probe, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    throw new WorkbenchExtensionError('WORKSPACE_READ_ONLY', { cause: error })
  } finally {
    try { await unlink(probe) } catch (error) { if (error?.code !== 'ENOENT') throw filesystemError(error) }
  }
}

export class WorkspacePolicy {
  constructor(registry, config) {
    this.registry = registry
    this.config = config
    this.aliases = new Map(config.workspaces.map(item => [item.alias, { config: item, workspaceId: undefined }]))
    this.ready = false
  }

  async initialize() {
    for (const alias of this.aliases.keys()) {
      try { await this.checkAlias(alias, { register: true }) } catch (error) {
        if (!(error instanceof WorkbenchExtensionError) || error.code === 'CONFIG_INVALID') throw error
      }
    }
    this.ready = true
  }

  async inspectPath(path, mode = 'read_write', writeProbeEnabled = false) {
    let canonical
    let info
    try {
      canonical = await realpath(path)
      info = await stat(canonical)
    } catch (error) { throw filesystemError(error) }
    if (!info.isDirectory()) throw new WorkbenchExtensionError('WORKSPACE_NOT_DIRECTORY')
    if (!this.config.allowedRoots.some(root => pathInside(root, canonical))) {
      throw new WorkbenchExtensionError('WORKSPACE_OUTSIDE_ALLOWED_ROOT')
    }
    try { await access(canonical, constants.R_OK | constants.X_OK) } catch (error) {
      throw new WorkbenchExtensionError('WORKSPACE_READ_DENIED', { cause: error })
    }
    if (mode === 'preview_only') {
      return { canonical, mode: 'preview_only', state: 'read_only' }
    }
    try { await access(canonical, constants.W_OK) } catch (error) {
      throw new WorkbenchExtensionError('WORKSPACE_READ_ONLY', { cause: error })
    }
    if (writeProbeEnabled) await writeProbe(canonical)
    return { canonical, mode: 'read_write', state: 'ready' }
  }

  async checkAlias(alias, { register = false } = {}) {
    if (!this.ready && !register) throw new WorkbenchExtensionError('WORKSPACE_SERVICE_UNAVAILABLE')
    const record = this.aliases.get(alias)
    if (record === undefined) throw new WorkbenchExtensionError('WORKSPACE_NOT_FOUND')
    const inspected = await this.inspectPath(record.config.path, record.config.mode, record.config.writeProbe)
    let workspace = record.workspaceId === undefined ? undefined : this.registry.get(record.workspaceId)
    if (workspace === undefined) workspace = await this.registry.resolveByPath(inspected.canonical)
    if (workspace === undefined && register) {
      workspace = await this.registry.create(inspected.canonical, record.config.title)
    }
    if (workspace === undefined) throw new WorkbenchExtensionError('WORKSPACE_NOT_FOUND')
    record.workspaceId = workspace.id
    return this.publicValue(workspace, record.config, inspected)
  }

  async checkWorkspaceId(workspaceId) {
    if (!this.ready) throw new WorkbenchExtensionError('WORKSPACE_SERVICE_UNAVAILABLE')
    const workspace = this.registry.get(workspaceId)
    if (workspace === undefined) throw new WorkbenchExtensionError('WORKSPACE_NOT_FOUND')
    const record = [...this.aliases.values()].find(value => value.workspaceId === workspace.id)
    const mode = record?.config.mode ?? 'read_write'
    const inspected = await this.inspectPath(workspace.path, mode, record?.config.writeProbe ?? false)
    return this.publicValue(workspace, record?.config, inspected)
  }

  publicValue(workspace, configured, inspected) {
    return {
      workspace_id: workspace.id,
      alias: configured?.alias ?? null,
      title: workspace.title,
      state: inspected.state,
      mode: inspected.mode,
    }
  }

  configuredWorkspaceId(alias) {
    return this.aliases.get(alias)?.workspaceId
  }

  aliasForWorkspace(workspaceId) {
    for (const [alias, value] of this.aliases) if (value.workspaceId === workspaceId) return alias
    return undefined
  }

  async listConfigured() {
    const values = []
    for (const alias of this.aliases.keys()) {
      try { values.push(await this.checkAlias(alias, { register: true })) } catch (error) {
        const known = this.aliases.get(alias)
        if (!(error instanceof WorkbenchExtensionError)) throw error
        values.push({
          workspace_id: known.workspaceId ?? null,
          alias,
          title: known.config.title,
          state: error.code,
          mode: known.config.mode,
        })
      }
    }
    return values
  }

  requireSession(workspaceId, sessionId) {
    const workspace = this.registry.get(workspaceId)
    if (workspace === undefined) throw new WorkbenchExtensionError('WORKSPACE_NOT_FOUND')
    if (workspace.sessionIds.includes(sessionId)) return
    const owner = this.registry.list().find(value => value.sessionIds.includes(sessionId))
    throw new WorkbenchExtensionError(owner === undefined ? 'SESSION_NOT_FOUND' : 'SESSION_WORKSPACE_MISMATCH')
  }

  async admitCreate(request) {
    if (request.workspaceId !== undefined) {
      await this.requireWritable(await this.checkWorkspaceId(request.workspaceId))
      return
    }
    if (request.cwd !== undefined) {
      await this.requireWritable(await this.inspectPath(request.cwd))
      return
    }
    if (this.config.defaultAlias === undefined) throw new WorkbenchExtensionError('WORKSPACE_NOT_FOUND')
    await this.requireWritable(await this.checkAlias(this.config.defaultAlias, { register: true }))
  }

  async admitPrompt(request) {
    const workspace = this.registry.list().find(value => value.sessionIds.includes(request.sessionId))
    if (workspace === undefined) throw new WorkbenchExtensionError('SESSION_NOT_FOUND')
    await this.requireWritable(await this.checkWorkspaceId(workspace.id))
  }

  async admitAgentStep(agent) {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string') throw new WorkbenchExtensionError('SESSION_NOT_FOUND')
    const located = await this.inspectPath(cwd, 'preview_only')
    const workspace = await this.registry.resolveByPath(located.canonical)
    const record = workspace === undefined
      ? undefined
      : [...this.aliases.values()].find(value => value.workspaceId === workspace.id)
    await this.requireWritable(await this.inspectPath(
      located.canonical,
      record?.config.mode ?? 'read_write',
      record?.config.writeProbe ?? false,
    ))
  }

  async requireWritable(status) {
    if (status.mode === 'preview_only' || status.state === 'read_only') {
      throw new WorkbenchExtensionError('WORKSPACE_READ_ONLY')
    }
    return status
  }

  asRemote(error) {
    if (!(error instanceof WorkbenchExtensionError)) throw error
    return new RemoteError(`workbench/${error.code.toLowerCase().replaceAll('_', '-')}`, error.message, {
      code: error.code,
      retryable: error.retryable,
      action: error.action,
    })
  }
}
