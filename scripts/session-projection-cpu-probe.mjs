#!/usr/bin/env node
/*
 * Controlled, read-only CPU probe for the session projection path.
 *
 * This is intentionally a script rather than a product test: it creates its own
 * temporary git project and SPEXCODE_HOME, then imports the real graph/session
 * modules against that fixture. No worker, user store, or production source is
 * touched. Run after a build with `node scripts/session-projection-cpu-probe.mjs`.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const self = fileURLToPath(import.meta.url)

if (!process.argv.includes('--child')) {
  const outputs = []
  for (const [label, total, active] of [['roster-682', 682, 15], ['roster-15', 15, 15]]) {
    const child = spawnSync(process.execPath, [...process.execArgv, self, '--child', '--total', String(total), '--active', String(active)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    })
    if (child.status !== 0) {
      process.stderr.write(child.stderr)
      process.exit(child.status ?? 1)
    }
    const line = child.stdout.trim().split('\n').at(-1)
    assert.ok(line, `${label}: child emitted no JSON result\nstderr=${child.stderr}`)
    outputs.push({ label, ...JSON.parse(line) })
  }
  const large = outputs.find((item) => item.label === 'roster-682')
  const small = outputs.find((item) => item.label === 'roster-15')
  const ratio = (a, b) => b ? Math.round((a / b) * 100) / 100 : null
  const report = {
    generatedAt: new Date().toISOString(),
    cases: outputs,
    scaling: {
      recordReadsRatio682Over15: ratio(large?.cases?.oneHook?.recordReads, small?.cases?.oneHook?.recordReads),
      cpuRatio682Over15: ratio(large?.cases?.oneHook?.cpuPercent, small?.cases?.oneHook?.cpuPercent),
      projectionBuildsRatio682Over15: ratio(large?.cases?.oneHook?.projectionBuilds, small?.cases?.oneHook?.projectionBuilds),
    },
    acceptance: {
      oneHook: 'one lifecycle change should cause one projection build and at most one liveness census; warm evidence reuse may make the incremental census zero',
      burst: 'a burst should have one coalesced projection build per settled wave; affected session ids may repeat but roster reads must not scale with archived count',
      archive: 'clean archived rows stay in the archive index and do not cause tmux capture/liveness calls in the working projection',
      fail: 'set SPEX_PROBE_ASSERT=1 for a pass/fail gate on the 682-record partial one-hook case; without it the script emits evidence only',
    },
  }
  if (process.env.SPEX_PROBE_ASSERT === '1') {
    const oneHook = large?.cases?.oneHook
    assert.equal(oneHook?.projectionBuilds, 1, 'partial one-hook refresh must build exactly once')
    assert.equal(oneHook?.rosterEnumerations, 0, 'partial one-hook refresh must not enumerate the roster')
    assert.ok((oneHook?.recordReads ?? Infinity) <= 1, `partial one-hook refresh read ${oneHook?.recordReads} records; expected <= 1 affected row`)
    assert.ok((oneHook?.tmux?.listPanes ?? Infinity) <= 1, `partial one-hook refresh used ${oneHook?.tmux?.listPanes} liveness censuses; expected at most one (warm evidence may make it zero)`)
    assert.equal(oneHook?.tmux?.capturePane, 0, 'partial one-hook refresh must not capture panes')
    assert.equal(oneHook?.projectedRows, 15, 'clean archives stay out of the working projection')
    process.stdout.write('session-projection-cpu-probe: PASS\n')
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const total = arg('--total', 682)
const activeCount = arg('--active', Math.min(total, 15))
assert.ok(Number.isInteger(total) && total > 0)
assert.ok(Number.isInteger(activeCount) && activeCount > 0 && activeCount <= total)

// Patch builtin fs before loading any product module. The ESM bindings are
// refreshed below so named imports in the product see the counters too.
let sessionsPath = null
const counters = {
  rosterEnumerations: 0,
  recordReads: 0,
  promptReads: 0,
  projectionBuilds: 0,
  projectionBuildMs: 0,
}
const under = (candidate, root) => {
  if (!root) return false
  const path = String(candidate)
  return path === root || path.startsWith(`${root}/`)
}
const originalReadDir = fs.readdirSync
const originalReadFile = fs.readFileSync
fs.readdirSync = function patchedReadDir(path, ...rest) {
  if (sessionsPath && String(path) === sessionsPath) counters.rosterEnumerations++
  return originalReadDir.call(this, path, ...rest)
}
fs.readFileSync = function patchedReadFile(path, ...rest) {
  if (under(path, sessionsPath)) {
    const value = String(path)
    if (value.endsWith('/runtime.json')) counters.recordReads++
    if (value.endsWith('/prompt')) counters.promptReads++
  }
  return originalReadFile.call(this, path, ...rest)
}
syncBuiltinESMExports()

const fixture = mkdtempSync(join(tmpdir(), `spex-session-projection-${total}-`))
const project = join(fixture, 'project')
const home = join(fixture, 'home')
const fakeBin = join(fixture, 'bin')
const tmuxLog = join(fixture, 'tmux.jsonl')
const paneFile = join(fixture, 'panes.txt')
mkdirSync(project, { recursive: true })
mkdirSync(home, { recursive: true })
mkdirSync(fakeBin, { recursive: true })

const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'probe@example.invalid')
git('config', 'user.name', 'session projection probe')
mkdirSync(join(project, '.spec', 'probe'), { recursive: true })
writeFileSync(join(project, '.spec', 'probe', 'spec.md'), '---\ntitle: Probe\nstatus: active\n---\n\nProbe fixture.\n')
writeFileSync(join(project, 'README.md'), '# session projection probe\n')
git('add', '-A')
git('commit', '-qm', 'probe fixture')

const paneSeparator = String.fromCharCode(31)
const activeIds = Array.from({ length: activeCount }, (_, i) => `probe-active-${String(i).padStart(4, '0')}`)
writeFileSync(paneFile, activeIds.map((id, i) => `${id}${paneSeparator}${process.pid}${paneSeparator}probe ${i}`).join('\n') + '\n')
const tmux = join(fakeBin, 'tmux')
writeFileSync(tmux, `#!/bin/sh
if [ "$1" = "-V" ]; then printf 'tmux 3.5\\n'; exit 0; fi
if [ "$1" = "list-panes" ]; then cat "$SPEXCODE_TMUX_PANES_FILE"; exit 0; fi
exit 1
`)
chmodSync(tmux, 0o755)

process.env.SPEXCODE_HOME = home
process.env.SPEX_SESSION_DATABASE_PATH = join(home, 'sessions.sqlite')
process.env.SPEXCODE_TMUX = `probe-${process.pid}`
process.env.SPEXCODE_TMUX_RECORD = tmuxLog
process.env.SPEXCODE_TMUX_PANES_FILE = paneFile
process.env.PATH = `${fakeBin}:${process.env.PATH || ''}`
process.chdir(project)

// Dist is the default so this probe runs with plain Node after `npm run build`.
// `SPEX_PROBE_SOURCE=1 node --import tsx ...` is useful on a branch whose
// unrelated type errors prevent build-dist from publishing a fresh dist tree.
const modulePath = (name, extension) => new URL(
  `../spec-cli/${process.env.SPEX_PROBE_SOURCE === '1' ? 'src' : 'dist'}/${name}.${process.env.SPEX_PROBE_SOURCE === '1' ? 'ts' : extension}`,
  import.meta.url,
).href
const layout = await import('@spexcode/spec-core')
const applicationModule = await import(modulePath('session-application', 'js'))
await import(modulePath('sessions', 'js'))
const graph = await import(modulePath('graphSnapshot', 'js'))
const { warmSignature } = await import(modulePath('session-liveness', 'js'))
const { configuredSessionApplication } = applicationModule
const application = configuredSessionApplication()
sessionsPath = layout.sessionsRoot()

const rawRecord = (id, archived) => ({
  session_id: id,
  governed: true,
  worktree_path: project,
  branch: `node/${id}`,
  title: `probe ${id}`,
  name: '',
  parent: '',
  status: archived ? 'idle' : 'active',
  proposal: '',
  merges: 0,
  note: archived ? 'archived fixture' : 'active fixture',
  sortkey: '',
  createdAt: 1700000000000,
  harness: 'claude',
  harness_session_id: '',
  stopped: archived,
  archived,
  closed_at: archived ? '2026-01-01T00:00:00.000Z' : '',
  cold_proof: archived ? `cold-v1|claude|${id}|no-resident-ref` : '',
  adapter_recovery: '',
  launcher: 'reclaude',
  launch_cmd: 'reclaude',
  launch_owner: '',
  create_request_id: '',
  create_payload_hash: '',
})

for (let i = 0; i < total; i++) {
  const id = i < activeCount ? activeIds[i] : `probe-archived-${String(i - activeCount).padStart(4, '0')}`
  const archived = i >= activeCount
  application.createSession({ sessionId: id, status: archived ? 'idle' : 'active', updatedAtMs: 1700000000000 + i })
  const dir = layout.sessionStoreDir(id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(layout.sessionRecordPath(id), `${JSON.stringify(rawRecord(id, archived), null, 2)}\n`)
}

const resetCounters = () => {
  counters.rosterEnumerations = 0
  counters.recordReads = 0
  counters.promptReads = 0
  counters.projectionBuilds = 0
  counters.projectionBuildMs = 0
  try { rmSync(tmuxLog) } catch {}
}
const tmuxCalls = () => {
  let rows = []
  try { rows = readFileSync(tmuxLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch {}
  return {
    total: rows.length,
    listPanes: rows.filter(row => row.args?.[0] === 'list-panes').length,
    capturePane: rows.filter(row => row.args?.[0] === 'capture-pane').length,
  }
}
const cpuWindow = async (fn) => {
  const before = process.cpuUsage()
  const started = process.hrtime.bigint()
  const value = await fn()
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const usage = process.cpuUsage(before)
  const cpuPercent = elapsedMs > 0 ? ((usage.user + usage.system) / 1000) / elapsedMs * 100 : 0
  return { value, elapsedMs, cpuPercent }
}
const runProjection = async (previous, affectedIds) => {
  const before = performance.now()
  counters.projectionBuilds++
  // The request is ignored by the old one-argument API and consumed by the
  // proposed local-projection API. Keeping one call shape makes the before /
  // after measurement a controlled experiment.
  const board = await graph.spliceSessions(previous, { scope: 'partial', affectedSessionIds: affectedIds })
  counters.projectionBuildMs += performance.now() - before
  return board
}
const measure = async (name, operation) => {
  const before = await graph.buildBoard()
  // Model the production owner explicitly: the warm poll has already completed one global evidence census.
  // The controlled sample starts after that owner has published, so only a consumer that cannot reuse the
  // snapshot pays for another list-panes/rendezvous pass.
  await warmSignature()
  resetCounters()
  const sample = await cpuWindow(() => operation(before))
  return {
    name,
    cpuPercent: Math.round(sample.cpuPercent * 100) / 100,
    wallMs: Math.round(sample.elapsedMs * 100) / 100,
    projectionBuilds: counters.projectionBuilds,
    projectionBuildMs: Math.round(counters.projectionBuildMs * 100) / 100,
    rosterEnumerations: counters.rosterEnumerations,
    recordReads: counters.recordReads,
    promptReads: counters.promptReads,
    tmux: tmuxCalls(),
    projectedRows: sample.value.sessions.length,
  }
}

const target = activeIds[0]
const idle = await measure('idle', async before => runProjection(before, [target]))
application.transitionSession(target, { status: 'idle', note: 'one-hook', reason: 'cpu-probe' })
const oneHook = await measure('oneHook', async before => runProjection(before, [target]))
for (let i = 0; i < 10; i++) {
  application.transitionSession(target, { status: i % 2 ? 'active' : 'idle', note: `burst-${i}`, reason: 'cpu-probe' })
}
const burstOneBuild = await measure('burstOneBuild', async before => runProjection(before, [target]))

// A naive per-hook comparison is useful evidence when reviewing a coalescer:
// ten commits followed by ten independent projection calls must be visibly
// more expensive than the one settled wave above.
const burstNaive = await measure('burstNaive10Builds', async before => {
  let current = before
  for (let i = 0; i < 10; i++) current = await runProjection(current, [target])
  return current
})

const result = {
  fixture: { total, active: activeCount, archived: total - activeCount, project, sessionsPath },
  cases: { idle, oneHook, burstOneBuild, burstNaive },
}
application.close?.()
rmSync(fixture, { recursive: true, force: true })
process.stdout.write(`${JSON.stringify(result)}\n`)
