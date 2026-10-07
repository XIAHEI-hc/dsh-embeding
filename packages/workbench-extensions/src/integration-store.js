import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WorkbenchExtensionError } from './errors.js'

export function integrationStatePath(value = process.env.PROBE_AI_INTEGRATION_STATE) {
  return resolve(value ?? resolve(process.env.DSH_HOME ?? process.cwd(), 'extensions/probe-integration.sqlite3'))
}

export function requestHash(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

export class IntegrationStore {
  constructor(path = integrationStatePath(), now = () => Date.now()) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.now = now
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_bindings (
        session_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        dsh_instance_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        function_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS integration_bindings_context
        ON integration_bindings(context_id, status);
      CREATE TABLE IF NOT EXISTS integration_prepare_requests (
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        context_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved', 'complete', 'failed')),
        response_json TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(client_id, request_id)
      );
    `)
    this.db.prepare(`INSERT OR IGNORE INTO integration_schema_migrations(version, applied_at)
      VALUES(1, ?)`).run(this.now())
  }

  reservePrepare({ clientId, requestId, hash, contextId, workspaceId, sessionId }) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare(`SELECT * FROM integration_prepare_requests
        WHERE client_id = ? AND request_id = ?`).get(clientId, requestId)
      if (existing !== undefined) {
        if (existing.request_hash !== hash) throw new WorkbenchExtensionError('INTEGRATION_REQUEST_CONFLICT')
        this.db.exec('COMMIT')
        return {
          created: false,
          state: existing.state,
          sessionId: existing.session_id,
          response: existing.response_json === null ? undefined : JSON.parse(existing.response_json),
          errorCode: existing.error_code ?? undefined,
        }
      }
      const now = this.now()
      this.db.prepare(`INSERT INTO integration_prepare_requests(
        client_id, request_id, request_hash, context_id, workspace_id, session_id,
        state, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(
        clientId, requestId, hash, contextId, workspaceId, sessionId, now, now,
      )
      this.db.exec('COMMIT')
      return { created: true, state: 'reserved', sessionId }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  completePrepare({ clientId, requestId, contextId, workspaceId, sessionId, instanceId, metadata }) {
    const now = this.now()
    const response = {
      session_id: sessionId,
      workspace_id: workspaceId,
      context_id: contextId,
      binding_status: 'active',
      dsh_instance_id: instanceId,
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.bindImmutable({
        sessionId,
        contextId,
        workspaceId,
        clientId,
        instanceId,
        projectId: metadata.project_id,
        functionType: metadata.function_type,
      })
      const updated = this.db.prepare(`UPDATE integration_prepare_requests
        SET state = 'complete', response_json = ?, error_code = NULL, updated_at = ?
        WHERE client_id = ? AND request_id = ? AND session_id = ?`).run(
        JSON.stringify(response), now, clientId, requestId, sessionId,
      )
      if (updated.changes !== 1) throw new WorkbenchExtensionError('INTEGRATION_REQUEST_CONFLICT')
      this.db.exec('COMMIT')
      return response
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  failPrepare(clientId, requestId, code) {
    this.db.prepare(`UPDATE integration_prepare_requests
      SET state = 'failed', error_code = ?, updated_at = ?
      WHERE client_id = ? AND request_id = ? AND state != 'complete'`
    ).run(code, this.now(), clientId, requestId)
  }

  bind({ clientId, contextId, workspaceId, sessionId, instanceId, metadata }) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = this.bindImmutable({
        sessionId,
        contextId,
        workspaceId,
        clientId,
        instanceId,
        projectId: metadata.project_id,
        functionType: metadata.function_type,
      })
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  bindImmutable({ sessionId, contextId, workspaceId, clientId, instanceId, projectId, functionType }) {
    const existing = this.db.prepare('SELECT * FROM integration_bindings WHERE session_id = ?').get(sessionId)
    if (existing !== undefined) {
      if (existing.context_id !== contextId || existing.workspace_id !== workspaceId
        || existing.client_id !== clientId || existing.dsh_instance_id !== instanceId
        || existing.project_id !== projectId || existing.function_type !== functionType) {
        throw new WorkbenchExtensionError('SESSION_CONTEXT_MISMATCH')
      }
      if (existing.status === 'revoked') throw new WorkbenchExtensionError('CONTEXT_REVOKED')
      return this.binding(sessionId)
    }
    const now = this.now()
    this.db.prepare(`INSERT INTO integration_bindings(
      session_id, context_id, workspace_id, client_id, dsh_instance_id,
      project_id, function_type, status, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
      sessionId, contextId, workspaceId, clientId, instanceId,
      projectId, functionType, now, now,
    )
    return this.binding(sessionId)
  }

  binding(sessionId) {
    const row = this.db.prepare('SELECT * FROM integration_bindings WHERE session_id = ?').get(sessionId)
    if (row === undefined) return undefined
    return {
      sessionId: row.session_id,
      contextId: row.context_id,
      workspaceId: row.workspace_id,
      clientId: row.client_id,
      instanceId: row.dsh_instance_id,
      projectId: row.project_id,
      functionType: row.function_type,
      status: row.status,
    }
  }

  requireActive(sessionId) {
    const value = this.binding(sessionId)
    if (value === undefined) throw new WorkbenchExtensionError('CONTEXT_NOT_BOUND')
    if (value.status !== 'active') throw new WorkbenchExtensionError('CONTEXT_REVOKED')
    return value
  }

  revokeContext(contextId, clientId) {
    const result = this.db.prepare(`UPDATE integration_bindings
      SET status = 'revoked', updated_at = ?
      WHERE context_id = ? AND client_id = ? AND status = 'active'`
    ).run(this.now(), contextId, clientId)
    return result.changes
  }

  close() { this.db.close() }
}

export function newIntegrationSessionId() {
  return `session-${randomUUID()}`
}
