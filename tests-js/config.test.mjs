import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadEmbedConfig, loadWorkspaceConfig } from '@dsh-workbench/extensions/config'

test('configuration validates same-site origins and server-only secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const workspacePath = join(root, 'workspaces.json')
  const embedPath = join(root, 'embed.json')
  const old = process.env.TEST_DSH_EMBED_SECRET
  process.env.TEST_DSH_EMBED_SECRET = 'a'.repeat(32)
  try {
    writeFileSync(workspacePath, JSON.stringify({ schema_version: 1, allowed_roots: [root],
      default_alias: 'project', auto_create_user_directories: false,
      workspaces: [{ alias: 'project', path: workspace, title: 'Project', mode: 'read_write' }] }))
    writeFileSync(embedPath, JSON.stringify({ schema_version: 1, enabled: true,
      public_origin: 'https://dsh.example.test', allowed_parent_origins: ['https://portal.example.test'],
      deployment_mode: 'trusted_shared_account', clients: [{ client_id: 'portal',
        secret_env: 'TEST_DSH_EMBED_SECRET', allowed_parent_origins: ['https://portal.example.test'],
        workspace_aliases: ['project'], mode: 'read_write' }] }))
    assert.equal(loadWorkspaceConfig(workspacePath).defaultAlias, 'project')
    assert.equal(loadEmbedConfig(embedPath, true).clients[0].secret.length, 32)
  } finally {
    if (old === undefined) delete process.env.TEST_DSH_EMBED_SECRET
    else process.env.TEST_DSH_EMBED_SECRET = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('cross-site configuration is explicitly rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-'))
  const path = join(root, 'embed.json')
  const old = process.env.TEST_DSH_EMBED_SECRET
  process.env.TEST_DSH_EMBED_SECRET = 'b'.repeat(32)
  try {
    writeFileSync(path, JSON.stringify({ schema_version: 1, public_origin: 'https://dsh.example.test',
      allowed_parent_origins: ['https://portal.other.test'], deployment_mode: 'trusted_shared_account',
      clients: [{ client_id: 'portal', secret_env: 'TEST_DSH_EMBED_SECRET',
        allowed_parent_origins: ['https://portal.other.test'], workspace_aliases: ['project'] }] }))
    assert.throws(() => loadEmbedConfig(path, true), { code: 'EMBED_CROSS_SITE_UNSUPPORTED' })
  } finally {
    if (old === undefined) delete process.env.TEST_DSH_EMBED_SECRET
    else process.env.TEST_DSH_EMBED_SECRET = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('embed public origin must match the launcher public origin', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-'))
  const path = join(root, 'embed.json')
  const oldSecret = process.env.TEST_DSH_EMBED_SECRET
  const oldPublic = process.env.WORKBENCH_PUBLIC_URL
  process.env.TEST_DSH_EMBED_SECRET = 'c'.repeat(32)
  process.env.WORKBENCH_PUBLIC_URL = 'https://actual.example.test'
  try {
    writeFileSync(path, JSON.stringify({ schema_version: 1, public_origin: 'https://dsh.example.test',
      allowed_parent_origins: ['https://portal.example.test'], deployment_mode: 'trusted_shared_account',
      clients: [{ client_id: 'portal', secret_env: 'TEST_DSH_EMBED_SECRET',
        allowed_parent_origins: ['https://portal.example.test'], workspace_aliases: ['project'] }] }))
    assert.throws(() => loadEmbedConfig(path, true), { code: 'CONFIG_INVALID' })
  } finally {
    if (oldSecret === undefined) delete process.env.TEST_DSH_EMBED_SECRET
    else process.env.TEST_DSH_EMBED_SECRET = oldSecret
    if (oldPublic === undefined) delete process.env.WORKBENCH_PUBLIC_URL
    else process.env.WORKBENCH_PUBLIC_URL = oldPublic
    rmSync(root, { recursive: true, force: true })
  }
})

test('public suffixes do not make unrelated co.uk domains same-site', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-'))
  const path = join(root, 'embed.json')
  const old = process.env.TEST_DSH_EMBED_SECRET
  process.env.TEST_DSH_EMBED_SECRET = 'd'.repeat(32)
  try {
    writeFileSync(path, JSON.stringify({ schema_version: 1, public_origin: 'https://dsh.example.co.uk',
      allowed_parent_origins: ['https://portal.other.co.uk'], deployment_mode: 'trusted_shared_account',
      clients: [{ client_id: 'portal', secret_env: 'TEST_DSH_EMBED_SECRET',
        allowed_parent_origins: ['https://portal.other.co.uk'], workspace_aliases: ['project'] }] }))
    assert.throws(() => loadEmbedConfig(path, true), { code: 'EMBED_CROSS_SITE_UNSUPPORTED' })
  } finally {
    if (old === undefined) delete process.env.TEST_DSH_EMBED_SECRET
    else process.env.TEST_DSH_EMBED_SECRET = old
    rmSync(root, { recursive: true, force: true })
  }
})
