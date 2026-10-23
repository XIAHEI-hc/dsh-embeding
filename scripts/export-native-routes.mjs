import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Only generated official Remote descriptors enter the ingress allowlist.
const root = resolve(import.meta.dirname, '..')
const sources = []
const endpoints = new Set(['$events/result'])
for (const name of readdirSync(resolve(root, 'node_modules/@deepseek-ai')).sort()) {
  const path = `node_modules/@deepseek-ai/${name}/lib/typert.remote-client.js`
  let text
  try { text = readFileSync(resolve(root, path), 'utf8') } catch { continue }
  sources.push({ path, sha256: createHash('sha256').update(text).digest('hex') })
  for (const match of text.matchAll(/namespace: '([^']+)',\s+method: '([^']+)'/gu)) {
    endpoints.add(`${match[1]}/${match[2]}`)
  }
}
const manifest = {
  protocol: 'dsh-native-rc.2', sources,
  routes: Object.fromEntries([
    ...[...endpoints].sort().map(endpoint => [`rpc/${endpoint}`, { method: 'POST', path: `/api/${endpoint}` }]),
    ['upload', { method: 'POST', path: '/api/session/uploadFileBinary' }],
    ['file', { method: 'GET', path: '/api/file' }],
    ['stream', { method: 'GET', path: '/api/remote.mux', upgrade: true }],
  ]),
}
writeFileSync(resolve(root, 'packages/workbench-runtime-gateway/src/native-routes.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Exported ${Object.keys(manifest.routes).length} native routes from ${sources.length} pinned descriptors`)
