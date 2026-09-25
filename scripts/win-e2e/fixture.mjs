// Windows-native E2E fixture: an isolated SpexCode world (own SPEXCODE_HOME, own session-host socket, a git project
// whose default launcher is the repo's fake agent) plus a live backend, driven through the same HTTP API and CLI a
// user drives. The same suites run on Linux against tmux, which is the reference behaviour Windows is held to.
// SPEX_E2E_MODE=dist runs the compiled CLI (the shipped path); the default runs the TypeScript source.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const windows = process.platform === 'win32'
export const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const specCli = join(repo, 'spec-cli')
// A launcher `cmd` is bash text, so a Windows path in it is written with forward slashes.
const slash = (path) => path.replaceAll('\\', '/')
export const fakeClaude = slash(join(specCli, 'test', 'fixtures', 'fake-claude'))
export const keyAgent = `node ${slash(join(repo, 'scripts', 'win-e2e', 'key-agent.mjs'))}`
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
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(everyMs)
  }
}

export const spexArgs = (args) => mode === 'dist'
  ? [join(specCli, 'bin', 'spex.mjs'), ...args]
  : [tsx, join(specCli, 'src', 'cli.ts'), ...args]

export async function createWorld(label, { launchers, config = {}, env: extraEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), `spex-e2e-${label}-`))
  const project = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(join(project, '.spec', 'project'), { recursive: true })
  mkdirSync(home, { recursive: true })
  const configured = launchers ?? { fake: { harness: 'claude', cmd: fakeClaude } }
  writeFileSync(join(project, '.spec', 'spexcode.json'), `${JSON.stringify({
    harnesses: ['claude'],
    sessions: { launchers: configured, defaultLauncher: Object.keys(configured)[0] },
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
  const env = { ...process.env, SPEXCODE_HOME: home, SPEXCODE_TMUX: socket, FAKE_HARNESS_INTERVAL_MS: '120', ...extraEnv }
  // The world is a user's own shell: no inherited SpexCode or agent identity (the runner may itself be an agent).
  for (const name of ['SPEXCODE_API_URL', 'SPEXCODE_SESSION_ID', 'SPEX_SESSION_DATABASE_PATH', 'SPEX_SESSION_CONFIG', 'TMUX', 'TMUX_PANE',
    'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'OPENCODE_SESSION_ID', 'PI_SESSION_ID', 'ZCODE_SESSION_ID', 'CLAUDECODE']) delete env[name]
  const world = { root, project, home, socket, env, git, backend: null, base: null, log: '' }

  world.spex = (args, options = {}) => execFileSync(process.execPath, spexArgs(args), {
    cwd: options.cwd ?? project, env: { ...env, ...(world.base ? { SPEXCODE_API_URL: world.base } : {}), ...options.env },
    encoding: 'utf8', timeout: options.timeoutMs ?? 60_000, input: options.input ?? '',
  })
  // the session host's own command line: winmux on Windows, tmux elsewhere (the Linux reference run)
  world.mux = (args) => windows
    ? execFileSync(process.execPath, [join(specCli, 'src', 'winmux', 'cli.mjs'), '-L', socket, ...args], { encoding: 'utf8', env })
    : execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', env })

  world.start = async () => {
    const port = await freePort()
    world.base = `http://127.0.0.1:${port}`
    world.backend = spawn(process.execPath, spexArgs(['serve', '--port', String(port)]), {
      cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows,
    })
    world.backend.stdout.on('data', (chunk) => { world.log += chunk })
    world.backend.stderr.on('data', (chunk) => { world.log += chunk })
    await waitFor('backend health', async () => {
      if (world.backend.exitCode !== null) throw new Error(`backend exited ${world.backend.exitCode}:\n${world.log}`)
      try { return (await fetch(`${world.base}/health`)).ok } catch { return false }
    }, 90_000, 250)
    return world
  }

  // the dashboard gateway (`spex serve ui`) in front of this world's backend
  world.startUi = async () => {
    const port = await freePort()
    world.ui = `http://127.0.0.1:${port}`
    world.uiProcess = spawn(process.execPath, spexArgs(['serve', 'ui', '--port', String(port), '--api-port', new URL(world.base).port]), {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows,
    })
    world.uiProcess.stdout.on('data', (chunk) => { world.log += chunk })
    world.uiProcess.stderr.on('data', (chunk) => { world.log += chunk })
    await waitFor('dashboard gateway', async () => { try { return (await fetch(world.ui)).ok } catch { return false } }, 60_000, 250)
    return world.ui
  }

  world.stop = async () => {
    if (world.uiProcess && world.uiProcess.exitCode === null) {
      const closedUi = new Promise((resolve) => world.uiProcess.once('close', resolve))
      if (windows) execFileSync('taskkill', ['/PID', String(world.uiProcess.pid), '/T', '/F'], { stdio: 'ignore' })
      else process.kill(-world.uiProcess.pid, 'SIGKILL')
      await closedUi
    }
    if (!world.backend || world.backend.exitCode !== null) return
    const closed = new Promise((resolve) => world.backend.once('close', resolve))
    if (windows) execFileSync('taskkill', ['/PID', String(world.backend.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-world.backend.pid, 'SIGKILL')
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

  world.session = async (id) => ((await world.api('GET', '/api/sessions')).json || []).find((row) => row.id === id)
  // GET /api/sessions/:id/capture answers the pane as text/plain
  world.capture = async (id) => {
    const response = await world.api('GET', `/api/sessions/${id}/capture`)
    if (response.status !== 200) throw new Error(`capture ${id} -> ${response.status} ${response.text}`)
    return response.text
  }

  world.dispose = async () => {
    await world.stop()
    try { world.mux(['kill-server']) } catch { /* no server left */ }
    // The Windows Search indexer briefly holds freshly written files; cleanup of a scratch world is best-effort.
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) }
    catch (error) { console.warn(`[win-e2e] could not remove ${root}: ${error.code}`) }
  }
  return world
}
