import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const roots = [
  resolve('packages/workbench-extensions/src'),
  resolve('packages/workbench-extensions/lib'),
  resolve('packages/probe-data-tools/src'),
]

function files(root) {
  const result = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) result.push(...files(path))
    else if (path.endsWith('.js')) result.push(path)
  }
  return result
}

for (const path of roots.flatMap(files)) {
  const checked = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' })
  if (checked.status !== 0) process.exit(checked.status ?? 1)
}
console.log('PASS extension JavaScript syntax')
