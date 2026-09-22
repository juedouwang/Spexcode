import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'

import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The archive panel names an archived session by its wire title; opening that row must put the SAME name
// on the session tab, not the raw id. The board's session projection is live-only, so the name reaches the
// strip through the document's own report ([[document-actions]]) and then rides the tab record across a
// reload. SPEXCODE_E2E_DASHBOARD_ROOT serves another checkout's prebuilt dist, so the same flow can be run
// against the pre-fix dashboard for the fail side of the pair.
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const cliRoot = join(root, 'spec-cli')
const dashboardRoot = process.env.SPEXCODE_E2E_DASHBOARD_ROOT ? resolve(process.env.SPEXCODE_E2E_DASHBOARD_ROOT) : join(root, 'spec-dashboard')
const sharedRoot = resolve(root, '..', '..')
const dependencyRoot = existsSync(join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')) ? root : sharedRoot
const tsxCli = join(dependencyRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const viteEntry = join(dependencyRoot, 'node_modules', 'vite', 'dist', 'node', 'index.js')
const backendEntry = join(cliRoot, 'src', 'index.ts')
const fakeLauncher = join(cliRoot, 'test', 'fixtures', 'fake-claude')
const playwrightPath = process.env.SPEXCODE_PLAYWRIGHT_PATH
  || '/home/jeffry/studio-harness/node_modules/playwright/index.mjs'
const chromiumPath = process.env.CHROMIUM || '/snap/bin/chromium'
const out = resolve(process.env.OUT || join(root, '.artifacts', 'archived-session-tab-name'))

const freePort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close((error) => error ? reject(error) : resolvePort(port))
  })
})

const waitFor = async (read, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((done) => setTimeout(done, 80))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const stopChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((done) => setTimeout(() => done(false), 3_000)),
  ])
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
}

if (!existsSync(playwrightPath)) throw new Error(`Playwright is missing: ${playwrightPath}`)
if (!existsSync(chromiumPath)) throw new Error(`Chromium is missing: ${chromiumPath}`)
if (!existsSync(join(dashboardRoot, 'dist', 'index.html'))) throw new Error(`prebuilt dist is required in ${dashboardRoot}; run npm run build first`)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const fixture = mkdtempSync(join(tmpdir(), 'spex-archived-tab-name-'))
const project = join(fixture, 'project')
const home = join(fixture, 'home')
const tmux = `spex-archived-tab-name-${process.pid}`
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' })
let backend
let ui
let browser
let archivedId
let failure
let backendLog = ''

try {
  mkdirSync(join(project, '.spec', 'fixture'), { recursive: true })
  writeFileSync(join(project, '.spec', 'fixture', 'spec.md'), '---\ntitle: fixture\nstatus: active\n---\n\n# fixture\n\nArchived tab name browser fixture.\n')
  writeFileSync(join(project, 'README.md'), 'archived tab name fixture\n')
  writeFileSync(join(project, '.spec/spexcode.json'), `${JSON.stringify({
    harnesses: ['claude'],
    sessions: { launchers: { fake: { harness: 'claude', cmd: fakeLauncher } }, defaultLauncher: 'fake' },
  }, null, 2)}\n`)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'fixture@example.test')
  git('config', 'user.name', 'fixture')
  git('add', '.')
  git('commit', '-qm', 'seed')

  const apiPort = await freePort()
  const uiPort = await freePort()
  const api = `http://127.0.0.1:${apiPort}`
  const base = `http://127.0.0.1:${uiPort}`
  const env = {
    ...process.env,
    PORT: String(apiPort),
    SPEXCODE_HOME: home,
    SPEXCODE_TMUX: tmux,
    SPEXCODE_API_URL: '',
    FAKE_HARNESS_INTERVAL_MS: '80',
  }
  backend = spawn(process.execPath, [tsxCli, backendEntry], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  backend.stdout.on('data', (chunk) => { backendLog += String(chunk) })
  backend.stderr.on('data', (chunk) => { backendLog += String(chunk) })
  await waitFor(() => fetch(`${api}/health`).then((response) => response.ok).catch(() => false), 'isolated backend')

  const { preview } = await import(pathToFileURL(viteEntry).href)
  ui = await preview({
    root: dashboardRoot,
    configFile: false,
    preview: {
      host: '127.0.0.1', port: uiPort, strictPort: true,
      proxy: { '/api': { target: api, ws: true } },
    },
  })
  await waitFor(() => fetch(base).then((response) => response.ok).catch(() => false), 'prebuilt dashboard server')

  const json = async (url, init) => {
    const response = await fetch(`${api}${url}`, init)
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* fail below with the response bytes */ }
    assert.equal(response.ok, true, `${url} failed: ${response.status} ${text}`)
    return body
  }
  const post = (url, body = {}) => json(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  // One real session, archived before the browser ever loads: the workspace has NEVER held this id while
  // live, so no persisted tab title exists — the exact shape that used to fall to the raw id.
  const created = await post('/api/sessions', { prompt: 'archive tab naming proof', launcher: 'fake' })
  assert.ok(created.id, `session creation returned no id: ${JSON.stringify(created)}`)
  await waitFor(async () => {
    const row = await json(`/api/sessions/${created.id}`)
    return row.liveness === 'online' ? row : null
  }, `${created.id} online`)
  await post(`/api/sessions/${created.id}/close`)
  const archived = await waitFor(async () => {
    const row = (await json('/api/sessions?all=1')).find((session) => session.id === created.id)
    return row?.archived && typeof row.closedAt === 'string' ? row : null
  }, 'archived row with closedAt')
  archivedId = created.id
  const wireTitle = archived.title
  assert.ok(wireTitle && wireTitle.trim(), 'archived row carries no wire title')
  const rawIdSlice = archivedId.slice(0, 8)

  const { chromium } = await import(pathToFileURL(playwrightPath).href)
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
  const page = await context.newPage()
  const pageErrors = []
  const consoleLines = []
  page.on('pageerror', (error) => { pageErrors.push(String(error)); writeFileSync(join(out, 'page-errors.log'), pageErrors.join('\n')) })
  page.on('console', (message) => {
    consoleLines.push(`${message.type()}: ${message.text()}`)
    writeFileSync(join(out, 'console.log'), consoleLines.join('\n'))
  })

  await page.goto(`${base}/#/sessions`, { waitUntil: 'domcontentloaded' })
  const archiveDoor = page.locator('.si-pill.archive')
  await archiveDoor.waitFor({ state: 'visible', timeout: 30_000 })
  await archiveDoor.click()
  const archivePage = page.locator('[data-archive-page]')
  await archivePage.waitFor({ state: 'visible' })
  const panelName = (await archivePage.locator('.si-archive-row-title').first().innerText()).trim()
  await page.screenshot({ path: join(out, 'archive-panel-names-the-row.png'), fullPage: true })

  await archivePage.locator(`.si-archive-page-row[data-sid="${archivedId}"]`).click()
  await page.locator('.tl-chat:visible').waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('.tab-face').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.screenshot({ path: join(out, 'tab-after-archive-open.png'), fullPage: true })

  // the money assertions: the tab wears the panel's name, not the id
  const tabLabel = (await page.locator('.tab-face').first().getAttribute('data-tip') || '').trim()
  assert.equal(tabLabel, wireTitle.trim(), `session tab wore "${tabLabel}" instead of the wire title "${wireTitle}"`)
  assert.equal(tabLabel, panelName, `tab label "${tabLabel}" disagrees with the archive panel's "${panelName}"`)
  assert.notEqual(tabLabel, rawIdSlice, 'session tab still shows the raw id slice')

  // the name persists on the tab record: a reload restores the tab before any document reports again
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.tab-face').first().waitFor({ state: 'visible', timeout: 10_000 })
  const reloadedLabel = (await page.locator('.tab-face').first().getAttribute('data-tip') || '').trim()
  await page.screenshot({ path: join(out, 'tab-after-reload.png'), fullPage: true })
  assert.equal(reloadedLabel, wireTitle.trim(), `after reload the tab wore "${reloadedLabel}" instead of the persisted "${wireTitle}"`)

  assert.deepEqual(pageErrors, [], 'the browser reported page errors')
  console.log(`archived session tab name: PASS (title "${wireTitle}", id slice would have been "${rawIdSlice}")`)
} catch (error) {
  failure = error
  console.error(error)
} finally {
  await ui?.close().catch(() => {})
  await stopChild(backend)
  if (browser) await browser.close().catch(() => {})
  try { execFileSync('tmux', ['-L', tmux, 'kill-server'], { stdio: 'ignore' }) } catch { /* already gone */ }
  rmSync(fixture, { recursive: true, force: true })
}
if (failure) process.exit(1)
