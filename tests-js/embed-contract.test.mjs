import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const schema = JSON.parse(readFileSync(join(process.cwd(), 'contracts', 'embed-message.schema.json'), 'utf8'))

test('embed contract declares the session lifecycle event emitted by the client', () => {
  assert.ok(schema.properties.type.enum.includes('session.lifecycle'))
  const branch = schema.allOf.find(item => item.if?.properties?.type?.const === 'session.lifecycle')
  assert.ok(branch)
  assert.deepEqual(branch.then.properties.payload.required, ['action', 'session_id'])
  assert.deepEqual(branch.then.properties.payload.properties.action.enum,
    ['forked', 'deleted', 'archived', 'unarchived'])
})

test('embed contract declares the skill selection notice and immediate sync messages', () => {
  assert.ok(schema.properties.type.enum.includes('selected_skills'))
  assert.ok(schema.properties.type.enum.includes('sync_skills'))
  assert.ok(schema.properties.type.enum.includes('skills.synced'))
})
