// E2E group B — the session runtime with deterministic stand-in agents (fake-harness for the lifecycle, key-agent
// for byte-exact input). Every scenario drives SpexCode through its public CLI / HTTP API, the way a user does.
// Run: node --test scripts/win-e2e/b-session.e2e.mjs   (writes timings to SPEX_E2E_REPORT when set)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createWorld, fakeClaude, keyAgent, sleep, spexArgs, waitFor, windows } from './fixture.mjs'

const report = { platform: process.platform, scenarios: {} }
const note = (id, data) => { report.scenarios[id] = { ...report.scenarios[id], ...data } }
const since = (t0) => Date.now() - t0

let world
let ledger
let fakeId
let keysId
let keysLaunchedAt = 0

before(async () => {
  ledger = join(process.env.TEMP || process.env.TMPDIR || '/tmp', `spex-e2e-keys-${process.pid}.ledger`)
  world = await createWorld('b', {
    launchers: {
      fake: { harness: 'claude', cmd: fakeClaude },
      keys: { harness: 'claude', cmd: keyAgent },
      failfast: { harness: 'claude', cmd: 'bash -c "echo launcher-down; exit 3"' },
      fatal: { harness: 'claude', cmd: 'bash -c "echo No conversation found with session ID abc; exit 1"' },
    },
    env: { KEY_AGENT_LEDGER: ledger },
  })
  const t0 = Date.now()
  await world.start()
  note('B1', { backendReadyMs: since(t0) })
})

after(async () => {
  await world?.dispose()
  if (process.env.SPEX_E2E_REPORT) writeFileSync(process.env.SPEX_E2E_REPORT, `${JSON.stringify(report, null, 2)}\n`)
})

const online = (id, timeoutMs = 60_000) => waitFor(`session ${id} online`, async () => (await world.session(id))?.liveness === 'online', timeoutMs, 100)
const create = (prompt, launcher) => JSON.parse(world.spex(['session', 'new', prompt, '--launcher', launcher])).id
const alivePid = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
// the session store: <SPEXCODE_HOME>/projects/<project key>/sessions/<id>/agent.pid
const agentPid = (id) => Number(readFileSync(join(world.home, 'projects', readdirSync(join(world.home, 'projects'))[0], 'sessions', id, 'agent.pid'), 'utf8'))

test('B1 spex serve comes up with the native session host', () => {
  assert.ok(report.scenarios.B1.backendReadyMs > 0)
})

test('B2 session new creates a worktree + branch and the agent comes online', async () => {
  const t0 = Date.now()
  fakeId = create('B2 create a session', 'fake')
  await online(fakeId)
  note('B2', { createToOnlineMs: since(t0) })
  const row = await world.session(fakeId)
  assert.ok(existsSync(row.path), `worktree ${row.path} exists`)
  assert.match(world.git('branch', '--list', row.branch), new RegExp(row.branch.replace(/[/.]/g, '\\$&')))
  assert.match(world.mux(['list-panes', '-a', '-F', '#{session_name}']), new RegExp(fakeId))
})

test('B3 session show --capture returns the live pane', async () => {
  const out = world.spex(['session', 'show', fakeId, '--capture'])
  assert.match(out, /FAKE-HARNESS READY/)
  assert.match(out, /FAKE-HARNESS TICK \d+/)
})

test('B4 session send reaches the agent through the rendezvous', async () => {
  const t0 = Date.now()
  world.spex(['session', 'send', fakeId, 'hello from windows e2e'])
  // the fake agent ticks every 120ms, so the reply line is searched in the pane history, not just the screen
  await waitFor('reply in pane', () => world.mux(['capture-pane', '-p', '-S', '-2000', '-t', fakeId]).includes('FAKE-HARNESS REPLY hello from windows e2e'), 30_000)
  note('B4', { sendToPaneMs: since(t0) })
})

// tmux key names SpexCode's raw-key channel emits → what a raw-mode agent reads
const KEYS = ['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Delete', 'Backspace', 'Tab', 'S-Tab', 'Escape', 'Enter', 'C-r', 'M-b', 'a', 'Z', '中']

test('B5 raw keys reach a raw-mode agent in order', async () => {
  writeFileSync(ledger, '')
  keysLaunchedAt = Date.now()
  keysId = create('B5 key ledger', 'keys')
  await online(keysId)
  const observed = {}
  for (const key of KEYS) {
    const before = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length
    const t0 = Date.now()
    const sent = await world.api('POST', `/api/sessions/${keysId}/input`, { kind: 'keys', keys: [key] })
    assert.equal(sent.status, 200, `${key}: ${sent.text}`)
    const lines = await waitFor(`${key} in ledger`, () => {
      const all = readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
      return all.length > before ? all : null
    }, 5_000, 20)
    observed[key] = { hex: lines.slice(before).join(' '), ms: since(t0) }
  }
  note('B5', { observed })
  // Ordering: one batch of several keys lands in strike order.
  const before = readFileSync(ledger, 'utf8')
  await world.api('POST', `/api/sessions/${keysId}/input`, { kind: 'keys', keys: ['x', 'y', 'z'] })
  await waitFor('batch in ledger', () => readFileSync(ledger, 'utf8').slice(before.length).replace(/\n/g, '').includes('78797a'), 5_000, 20)
})

test('B6 interrupt delivers C-c to an active pane-backed agent', async () => {
  const before = readFileSync(ledger, 'utf8').length
  const result = await world.api('POST', `/api/sessions/${keysId}/interrupt`)
  note('B6', { status: result.status, body: result.json })
  assert.equal(result.status, 200, result.text)
  await waitFor('C-c in ledger', () => readFileSync(ledger, 'utf8').slice(before).includes('03'), 5_000, 20)
})

test('B7 spex session attach renders the pane in a real console and detaches cleanly', async () => {
  // The attaching CLI runs inside its own session-host pane: a real console it can put in raw mode.
  const host = `attach-host-${process.pid}`
  world.mux(['new-session', '-d', '-s', host, '-x', '100', '-y', '30', '-c', world.project])
  await sleep(2500)
  const vars = { SPEXCODE_API_URL: world.base, SPEXCODE_HOME: world.home, SPEXCODE_TMUX: world.socket }
  const argv = [process.execPath, ...spexArgs(['session', 'attach', fakeId])]
  const line = windows   // the Windows pane shell is PowerShell
    ? `${Object.entries(vars).map(([k, v]) => `$env:${k}='${v}'`).join('; ')}; & ${argv.map((a) => `'${a}'`).join(' ')}`
    : `${Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join(' ')} ${argv.map((a) => `'${a}'`).join(' ')}`
  world.mux(['send-keys', '-t', host, '-l', '--', line])
  world.mux(['send-keys', '-t', host, 'Enter'])
  const screen = await waitFor('attached pane shows the agent', () => {
    const pane = world.mux(['capture-pane', '-p', '-t', host])
    return /FAKE-HARNESS TICK \d+/.test(pane) ? pane : null
  }, 30_000, 250)
  assert.match(screen, /FAKE-HARNESS/)
  world.mux(['send-keys', '-t', host, 'C-b'])
  world.mux(['send-keys', '-t', host, '-l', 'd'])
  await waitFor('detached', () => /detached/.test(world.mux(['capture-pane', '-p', '-t', host])), 15_000, 250)
  assert.equal((await world.session(fakeId)).liveness, 'online', 'the session keeps running after detach')
  world.mux(['kill-session', '-t', host])
})

test('B8 a backend restart leaves sessions running and re-adopts them', async () => {
  const pidBefore = agentPid(fakeId)
  await world.stop()
  assert.ok(alivePid(pidBefore), 'agent survives the backend')
  assert.match(world.mux(['list-panes', '-a', '-F', '#{session_name}']), new RegExp(fakeId))
  const t0 = Date.now()
  await world.start()
  await online(fakeId)
  note('B8', { restartToOnlineMs: since(t0) })
  assert.match(await world.capture(fakeId), /FAKE-HARNESS TICK/)
})

test('B10 a killed agent is reported offline', async () => {
  // The boot grace window reads a fresh launch as `starting`; death detection is measured past it.
  const pid = agentPid(keysId)
  await sleep(Math.max(0, 46_000 - (Date.now() - keysLaunchedAt)))
  const t0 = Date.now()
  if (windows) execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
  else process.kill(pid, 'SIGKILL')
  await waitFor('offline', async () => (await world.session(keysId))?.liveness === 'offline', 30_000, 50)
  note('B10', { killToOfflineMs: since(t0) })
})

test('B9 close tears down the pane, the agent tree and the worktree', async () => {
  const row = await world.session(fakeId)
  const pid = agentPid(fakeId)
  const t0 = Date.now()
  const closed = await world.api('POST', `/api/sessions/${fakeId}/close`, {})
  note('B9', { closeMs: since(t0), status: closed.status })
  assert.equal(closed.status, 200, `${closed.text}\n--- backend log tail:\n${world.log.split('\n').filter((l) => !l.includes('session-create {')).slice(-25).join('\n')}`)
  assert.doesNotMatch(world.mux(['list-panes', '-a', '-F', '#{session_name}']), new RegExp(fakeId))
  assert.equal(alivePid(pid), false, 'agent process is gone')
  await waitFor('worktree removed', () => !existsSync(row.path), 15_000)
})

test('B11 a fast-exiting launcher is retried three times; a settled failure is not retried', async () => {
  // a queued session has no pane yet; the probe reads the host directly and keeps waiting until one exists
  const pane = (id) => { try { return world.mux(['capture-pane', '-p', '-J', '-S', '-200', '-t', id]) } catch { return '' } }
  const failing = create('B11 failfast', 'failfast')
  await waitFor('three attempts', () => /attempt 3 exited/.test(pane(failing)), 60_000, 250)
  const fatal = create('B11 fatal', 'fatal')
  const text = await waitFor('fatal classified', () => /not retrying/.test(pane(fatal)) && pane(fatal), 60_000, 250)
  note('B11', { fatalPane: text.split('\n').filter((line) => line.includes('[spex launch]')) })
  assert.doesNotMatch(text, /attempt 2 start/)
})
