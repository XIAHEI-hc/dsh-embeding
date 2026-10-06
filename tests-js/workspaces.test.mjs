import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspacePolicy } from '@dsh-workbench/extensions/workspaces'

class Registry {
  constructor() { this.items = [] }
  get(id) { return this.items.find(item => item.id === id) }
  list() { return [...this.items] }
  async resolveByPath(path) { return this.items.find(item => item.path === path) }
  async create(path, title) {
    const existing = await this.resolveByPath(path)
    if (existing) return existing
    const item = { id: `workspace-${this.items.length + 1}`, path, title, sessionIds: [] }
    this.items.push(item)
    return item
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workspaces-'))
  const project = join(root, 'project')
  mkdirSync(project)
  const registry = new Registry()
  const config = {
    allowedRoots: [root], defaultAlias: 'project',
    workspaces: [{ alias: 'project', path: project, title: 'Project', mode: 'read_write', writeProbe: false }],
  }
  return { root, project, registry, config, close() { rmSync(root, { recursive: true, force: true }) } }
}

test('configured directory receives one durable official workspace id', async () => {
  const f = fixture()
  try {
    const policy = new WorkspacePolicy(f.registry, f.config)
    await policy.initialize()
    const first = await policy.checkAlias('project')
    const second = await policy.checkAlias('project', { register: true })
    assert.equal(first.workspace_id, second.workspace_id)
    assert.equal(f.registry.items.length, 1)
    assert.equal(first.state, 'ready')
  } finally { f.close() }
})

test('missing, non-directory, and outside-root paths are distinct', async () => {
  const f = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
  try {
    const policy = new WorkspacePolicy(f.registry, f.config)
    await assert.rejects(policy.inspectPath(join(f.root, 'missing')), { code: 'WORKSPACE_DIRECTORY_MISSING' })
    const file = join(f.root, 'file.txt')
    writeFileSync(file, 'x')
    await assert.rejects(policy.inspectPath(file), { code: 'WORKSPACE_NOT_DIRECTORY' })
    await assert.rejects(policy.inspectPath(outside), { code: 'WORKSPACE_OUTSIDE_ALLOWED_ROOT' })
  } finally { f.close(); rmSync(outside, { recursive: true, force: true }) }
})

test('preview-only blocks create and prompt through the server policy', async () => {
  const f = fixture()
  try {
    f.config.workspaces[0].mode = 'preview_only'
    const policy = new WorkspacePolicy(f.registry, f.config)
    await policy.initialize()
    const workspace = await policy.checkAlias('project')
    f.registry.get(workspace.workspace_id).sessionIds.push('session-1')
    await assert.rejects(policy.admitCreate({ workspaceId: workspace.workspace_id }), { code: 'WORKSPACE_READ_ONLY' })
    await assert.rejects(policy.admitPrompt({ sessionId: 'session-1' }), { code: 'WORKSPACE_READ_ONLY' })
    await assert.rejects(policy.admitAgentStep({ session: { header: { cwd: f.project } } }), { code: 'WORKSPACE_READ_ONLY' })
  } finally { f.close() }
})

test('configured preview-only policy survives a missing directory at startup', async () => {
  const f = fixture()
  try {
    f.config.workspaces[0].mode = 'preview_only'
    const workspace = await f.registry.create(f.project, 'Project')
    workspace.sessionIds.push('session-1')
    rmSync(f.project, { recursive: true, force: true })

    const policy = new WorkspacePolicy(f.registry, f.config)
    await policy.initialize()
    mkdirSync(f.project)

    assert.equal((await policy.checkWorkspaceId(workspace.id)).mode, 'preview_only')
    await assert.rejects(policy.admitPrompt({ sessionId: 'session-1' }), { code: 'WORKSPACE_READ_ONLY' })
    await assert.rejects(policy.admitAgentStep({ session: { header: { cwd: f.project } } }), { code: 'WORKSPACE_READ_ONLY' })
  } finally { f.close() }
})

test('cwd create uses configured policy and canonical workspace binding', async () => {
  const f = fixture()
  try {
    const policy = new WorkspacePolicy(f.registry, f.config)
    await policy.initialize()
    const request = { cwd: f.project }
    await policy.admitCreate(request)
    assert.equal(request.cwd, undefined)
    assert.equal(request.workspaceId, (await policy.checkAlias('project')).workspace_id)

    f.config.workspaces[0].mode = 'preview_only'
    const readOnlyPolicy = new WorkspacePolicy(f.registry, f.config)
    await readOnlyPolicy.initialize()
    await assert.rejects(readOnlyPolicy.admitCreate({ cwd: f.project }), { code: 'WORKSPACE_READ_ONLY' })
  } finally { f.close() }
})

test('default alias becomes the official create workspace id', async () => {
  const f = fixture()
  try {
    const policy = new WorkspacePolicy(f.registry, f.config)
    await policy.initialize()
    const request = {}
    await policy.admitCreate(request)
    assert.equal(request.workspaceId, (await policy.checkAlias('project')).workspace_id)
  } finally { f.close() }
})

test('unconfigured workspace policy never defaults to writable', async () => {
  const f = fixture()
  try {
    const other = join(f.root, 'other')
    mkdirSync(other)
    const unknown = await f.registry.create(other, 'Other')
    const policy = new WorkspacePolicy(f.registry, f.config)
    await policy.initialize()
    await assert.rejects(policy.checkWorkspaceId(unknown.id), { code: 'WORKSPACE_NOT_FOUND' })
    await assert.rejects(policy.admitCreate({ cwd: other }), { code: 'WORKSPACE_NOT_FOUND' })
  } finally { f.close() }
})

test('session mismatch never falls back to another workspace', async () => {
  const f = fixture()
  try {
    const second = join(f.root, 'second')
    mkdirSync(second)
    f.config.workspaces.push({ alias: 'second', path: second, title: 'Second', mode: 'read_write', writeProbe: false })
    const policy = new WorkspacePolicy(f.registry, f.config)
    await policy.initialize()
    const first = await policy.checkAlias('project')
    const other = await policy.checkAlias('second')
    f.registry.get(other.workspace_id).sessionIds.push('session-other')
    assert.throws(() => policy.requireSession(first.workspace_id, 'session-other'), { code: 'SESSION_WORKSPACE_MISMATCH' })
    assert.throws(() => policy.requireSession(first.workspace_id, 'missing'), { code: 'SESSION_NOT_FOUND' })
  } finally { f.close() }
})
