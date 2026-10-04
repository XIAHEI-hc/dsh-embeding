import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WorkbenchExtensionError } from './errors.js'

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export class GrantStore {
  constructor(path, now = () => Date.now()) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.now = now
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS embed_grants (
        token_hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        parent_origin TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        revoked_at INTEGER,
        init_request_id TEXT,
        result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS embed_grants_expiry ON embed_grants(expires_at);
      CREATE TABLE IF NOT EXISTS embed_audit (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `)
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)').run(this.now())
  }

  issue({ clientId, subject, parentOrigin, scope, ttlSeconds, requestId }) {
    const token = randomBytes(32).toString('base64url')
    const grantId = `grant_${randomUUID()}`
    const expiresAt = this.now() + ttlSeconds * 1000
    this.db.prepare(`INSERT INTO embed_grants(
      token_hash, grant_id, client_id, subject, parent_origin, scope_json, expires_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
      tokenHash(token), grantId, clientId, subject, parentOrigin, JSON.stringify(scope), expiresAt,
    )
    this.audit({ requestId, clientId, subject, scope, action: 'grant.issued', result: 'success' })
    return { token, grantId, expiresAt }
  }

  inspect(token) {
    const row = this.db.prepare('SELECT * FROM embed_grants WHERE token_hash = ?').get(tokenHash(token))
    if (row === undefined || row.expires_at <= this.now()) throw new WorkbenchExtensionError('EMBED_TICKET_EXPIRED')
    if (row.revoked_at !== null) throw new WorkbenchExtensionError('EMBED_TICKET_REVOKED')
    if (row.consumed_at !== null) throw new WorkbenchExtensionError('EMBED_TICKET_REPLAYED')
    return {
      grantId: row.grant_id,
      clientId: row.client_id,
      subject: row.subject,
      parentOrigin: row.parent_origin,
      scope: JSON.parse(row.scope_json),
      expiresAt: row.expires_at,
    }
  }

  consume(token, requestId) {
    const hash = tokenHash(token)
    const now = this.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM embed_grants WHERE token_hash = ?').get(hash)
      if (row === undefined) throw new WorkbenchExtensionError('EMBED_TICKET_EXPIRED')
      if (row.revoked_at !== null) throw new WorkbenchExtensionError('EMBED_TICKET_REVOKED')
      if (row.consumed_at !== null) throw new WorkbenchExtensionError('EMBED_TICKET_REPLAYED')
      if (row.expires_at <= now) throw new WorkbenchExtensionError('EMBED_TICKET_EXPIRED')
      const result = this.db.prepare(`UPDATE embed_grants
        SET consumed_at = ?, init_request_id = ?
        WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
      ).run(now, requestId, hash, now)
      if (result.changes !== 1) throw new WorkbenchExtensionError('EMBED_TICKET_REPLAYED')
      this.db.exec('COMMIT')
      return {
        grantId: row.grant_id,
        clientId: row.client_id,
        subject: row.subject,
        parentOrigin: row.parent_origin,
        scope: JSON.parse(row.scope_json),
        expiresAt: row.expires_at,
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  saveResult(grantId, value) {
    this.db.prepare('UPDATE embed_grants SET result_json = ? WHERE grant_id = ?').run(JSON.stringify(value), grantId)
  }

  revoke(token, clientId, requestId) {
    const row = this.db.prepare('SELECT * FROM embed_grants WHERE token_hash = ?').get(tokenHash(token))
    if (row === undefined || row.client_id !== clientId) return false
    const result = this.db.prepare(`UPDATE embed_grants SET revoked_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL`).run(this.now(), tokenHash(token))
    if (result.changes === 1) {
      this.audit({ requestId, clientId, subject: row.subject, scope: JSON.parse(row.scope_json), action: 'grant.revoked', result: 'success' })
    }
    return result.changes === 1
  }

  audit({ requestId, clientId, subject, scope, action, result }) {
    this.db.prepare(`INSERT INTO embed_audit(
      event_id, request_id, client_id, subject, workspace_id, session_id, action, result, timestamp
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `audit_${randomUUID()}`, requestId, clientId, subject, scope.workspaceId,
      scope.sessionId ?? null, action, result, this.now(),
    )
  }

  cleanup() {
    const cutoff = this.now() - 24 * 60 * 60 * 1000
    this.db.prepare(`DELETE FROM embed_grants
      WHERE expires_at < ? AND (consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < ?)`
    ).run(cutoff, cutoff)
  }

  close() { this.db.close() }
}
