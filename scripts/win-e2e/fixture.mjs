// Windows-native E2E fixture: an isolated SpexCode world (own SPEXCODE_HOME, own winmux socket, a git project whose
// default launcher is the repo's fake agent) plus a live backend, driven through the same HTTP API and CLI a user
// drives. SPEX_E2E_MODE=dist runs the compiled CLI (the shipped path); the default runs the TypeScript source.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const specCli = join(repo, 'spec-cli')
// A launcher `cmd` is bash text, so a Windows path in it is written with forward slashes.
export const fakeClaude = join(specCli, 'test', 'fixtures', 'fake-claude').replaceAll('\\', '/')
const tsx = join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const mode = process.env.SPEX_E2E_MODE === 'dist' ? 'dist' : 'source'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function freePort() {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

export async function waitFor(what, probe, timeoutMs = 20_000, everyMs = 100) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await probe()
    if (last) return last
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(everyMs)
  }
}

const spexArgs = (args) => mode === 'dist'
  ? [join(specCli, 'bin', 'spex.mjs'), ...args]
  : [tsx, join(specCli, 'src', 'cli.ts'), ...args]

export async function createWorld(label, { launchers, config = {}, projectName = 'project' } = {}) {
  const root = mkdtempSync(join(tmpdir(), `spex-e2e-${label}-`))
  const project = join(root, projectName)
  const home = join(root, 'home')
  mkdirSync(join(project, '.spec', 'project'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(project, '.spec', 'spexcode.json'), `${JSON.stringify({
    harnesses: ['claude'],
    sessions: { launchers: launchers ?? { fake: { harness: 'claude', cmd: fakeClaude } }, defaultLauncher: Object.keys(launchers ?? { fake: 1 })[0] },
    ...config,
  }, null, 2)}\n`)
  writeFileSync(join(project, '.spec', 'project', 'spec.md'), '---\ntitle: project\nstatus: active\n---\n\n# project\n\nfixture project\n')
  writeFileSync(join(project, 'README.md'), '# fixture\n')
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@example.test')
  git('config', 'user.name', 'e2e')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  const socket = `spex-e2e-${label}-${process.pid}-${Date.now()}`
  const env = { ...process.env, SPEXCODE_HOME: home, SPEXCODE_TMUX: socket, FAKE_HARNESS_INTERVAL_MS: '120' }
  for (const name of ['SPEXCODE_API_URL', 'SPEXCODE_SESSION_ID', 'SPEX_SESSION_DATABASE_PATH', 'SPEX_SESSION_CONFIG']) delete env[name]
  const world = { root, project, home, socket, env, git, backend: null, base: null, log: '' }

  world.spex = (args, options = {}) => execFileSync(process.execPath, spexArgs(args), {
    cwd: options.cwd ?? project, env: { ...env, ...(world.base ? { SPEXCODE_API_URL: world.base } : {}), ...options.env },
    encoding: 'utf8', timeout: options.timeoutMs ?? 60_000, input: options.input ?? '',
  })
  world.winmux = (args) => execFileSync(process.execPath, [join(specCli, 'src', 'winmux', 'cli.mjs'), '-L', socket, ...args], { encoding: 'utf8', env })

  world.start = async () => {
    const port = await freePort()
    world.base = `http://127.0.0.1:${port}`
    world.backend = spawn(process.execPath, spexArgs(['serve', '--port', String(port)]), { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    world.backend.stdout.on('data', (chunk) => { world.log += chunk })
    world.backend.stderr.on('data', (chunk) => { world.log += chunk })
    await waitFor('backend health', async () => {
      if (world.backend.exitCode !== null) throw new Error(`backend exited ${world.backend.exitCode}:\n${world.log}`)
      try { return (await fetch(`${world.base}/health`)).ok } catch { return false }
    }, 90_000, 250)
    return world
  }

  world.stop = async () => {
    if (!world.backend || world.backend.exitCode !== null) return
    const closed = new Promise((resolve) => world.backend.once('close', resolve))
    execFileSync('taskkill', ['/PID', String(world.backend.pid), '/T', '/F'], { stdio: 'ignore' })
    await closed
  }

  world.api = async (method, path, body) => {
    const response = await fetch(`${world.base}${path}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: response.status, json, text }
  }

  world.dispose = async () => {
    await world.stop()
    try { world.winmux(['kill-server']) } catch { /* no server left */ }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  return world
}
