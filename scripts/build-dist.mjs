import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const packageRoot = process.cwd()
const dist = join(packageRoot, 'dist')
const nonce = `${process.pid}-${Date.now()}`
const next = join(packageRoot, `.dist-next-${nonce}`)
const previous = join(packageRoot, `.dist-previous-${nonce}`)
const require = createRequire(join(packageRoot, 'package.json'))
const tsc = require.resolve('typescript/bin/tsc')

rmSync(next, { recursive: true, force: true })
const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', next], {
  cwd: packageRoot,
  stdio: 'inherit',
})
if (build.status !== 0) {
  rmSync(next, { recursive: true, force: true })
  process.exit(build.status ?? 1)
}

try {
  if (process.platform === 'win32' && existsSync(dist)) {
    // Windows refuses to rename a directory an editor or type server is watching; swap its contents instead.
    for (const entry of readdirSync(dist)) rmSync(join(dist, entry), { recursive: true, force: true })
    cpSync(next, dist, { recursive: true })
  } else {
    if (existsSync(dist)) renameSync(dist, previous)
    renameSync(next, dist)
  }
  rmSync(previous, { recursive: true, force: true })
} catch (error) {
  if (!existsSync(dist) && existsSync(previous)) renameSync(previous, dist)
  throw error
} finally {
  rmSync(next, { recursive: true, force: true })
}
