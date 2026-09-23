import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { isLoopbackHost, loopbackHttpAgent, fetchBypassingLoopbackProxy } from './loopback-transport.js'

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  })
}

test('isLoopbackHost names exactly this machine', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.5', '127.255.0.1', '[::1]', '::1']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  // ::ffff: dotted forms never arrive from a URL (whatwg normalizes them to hex), so they are not
  // loopback here — the URL-normalized ::ffff:7f00:1 spelling of 127.0.0.1 is named as the boundary.
  for (const host of ['10.0.0.1', '192.168.1.2', '0.0.0.0', 'example.com', '[::2]', '::ffff:10.0.0.1', '::ffff:7f00:1', '127.0.0.1.evil.com']) {
    assert.equal(isLoopbackHost(host), false, host)
  }
  assert.equal(isLoopbackHost(new URL('http://[::1]:8787/').hostname.replace(/^\[|\]$/g, '')), true)
})

test('fetchBypassingLoopbackProxy fetches a loopback service', async () => {
  const server = http.createServer((q, r) => r.end('pong:' + q.url))
  const port = await listen(server)
  try {
    const response = await fetchBypassingLoopbackProxy(`http://127.0.0.1:${port}/check`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'pong:/check')
  } finally { server.close() }
})

// The contract that matters only exists on a runtime that actually routes loopback through the
// environment proxy (measured: Node 24.15 and 26.5 with --use-env-proxy do; 22 has no env proxying at
// all). So the proof runs a child under the real flag with HTTP_PROXY pointed at a port where nothing
// listens: a hop that rides the proxy dies there, a direct hop answers. On runtimes without the flag
// (bad option) or without loopback routing (the control fetch succeeds) the test skips honestly.
// The rule must not depend on memory: every fetch this CLI opens to its own services rides the helper,
// so a bare `fetch(` in a non-test source is a loopback hop waiting to be swallowed by environment
// proxying. Only the files named below may contain one, each for its stated reason.
const ALLOWED_BARE_FETCH: Record<string, string> = {
  // the helper itself — its non-loopback passthrough IS the global fetch, proxy and all
  'loopback-transport.ts': 'the helper itself; the non-loopback passthrough keeps the user proxy',
  // guide.ts embeds browser-side example code in the rendered docs; this runtime never executes it
  'guide.ts': 'browser-side doc example string, never executed by the CLI',
}

test('no bare fetch call sites outside the loopback helper', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const offenders: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    if (entry.name in ALLOWED_BARE_FETCH) continue
    if (readFileSync(join(dir, entry.name), 'utf8').includes('fetch(')) offenders.push(entry.name)
  }
  assert.deepEqual(offenders, [], `bare fetch( in ${offenders.join(', ')} — route loopback targets through fetchBypassingLoopbackProxy (loopback-transport.ts), or name the file in ALLOWED_BARE_FETCH with a reason`)
})

test('loopback hops stay direct under environment proxying', { timeout: 60_000 }, (t) => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const require = createRequire(import.meta.url)
  const tsx = pathToFileURL(require.resolve('tsx/esm')).href
  const fixture = join(mkdtempSync(join(tmpdir(), 'loopback-transport-')), 'fixture.mjs')
  writeFileSync(fixture, `
import http from 'node:http'
import { loopbackHttpAgent, fetchBypassingLoopbackProxy } from ${JSON.stringify(pathToFileURL(join(here, 'loopback-transport.js')).href)}
import { proxyHttp } from ${JSON.stringify(pathToFileURL(join(here, 'gateway.js')).href)}
const upstream = http.createServer((q, r) => r.end('upstream:' + q.url))
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const port = upstream.address().port
const report = async (label, run) => { try { await run(); console.log(label + ':ok') } catch (e) { console.log(label + ':fail:' + (e.cause?.code ?? e.code ?? e.message)) } }
const deadProxy = 'http://127.0.0.1:9'
console.log('proxy=' + (process.env.HTTP_PROXY ?? '') + ' node=' + process.version)
await report('agent', () => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/agent', agent: loopbackHttpAgent }, (r) => { r.resume(); r.on('end', resolve); r.on('error', reject) })
  req.on('error', reject); req.end()
}))
await report('fetch', async () => {
  const r = await fetchBypassingLoopbackProxy('http://127.0.0.1:' + port + '/fetch')
  if (!r.ok) throw new Error('HTTP ' + r.status)
  await r.text()
})
await report('proxyHttp', () => new Promise((resolve, reject) => {
  const gate = http.createServer((q, r) => proxyHttp(q, r, port))
  gate.listen(0, '127.0.0.1', async () => {
    const gp = gate.address().port
    try {
      const body = await new Promise((res2, rej2) => {
        const req = http.request({ host: '127.0.0.1', port: gp, path: '/proxied', agent: loopbackHttpAgent }, (r2) => { let d = ''; r2.on('data', (c) => d += c); r2.on('end', () => res2(d)); r2.on('error', rej2) })
        req.on('error', rej2); req.end()
      })
      if (body !== 'upstream:/proxied') throw new Error('wrong body: ' + body)
      gate.close(); resolve()
    } catch (e) { gate.close(); reject(e) }
  })
}))
await report('control-global-fetch', async () => { const r = await fetch('http://127.0.0.1:' + port + '/control'); await r.text() })
upstream.close()
process.exit(0)
`)
  try {
    const env = { ...process.env }
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete env[key]
    env.HTTP_PROXY = 'http://127.0.0.1:9'
    env.HTTPS_PROXY = 'http://127.0.0.1:9'
    const child = spawnSync(process.execPath, ['--import', tsx, '--use-env-proxy', fixture], { encoding: 'utf8', timeout: 45_000, env })
    const lines = child.stdout.split('\n').filter(Boolean)
    const result = Object.fromEntries(lines.map((line) => [line.split(':')[0], line]))
    if (/bad option|not allowed/i.test(child.stderr)) {
      return t.skip('this runtime has no --use-env-proxy; the plain-runtime tests above carry the rest')
    }
    assert.equal(child.status, 0, 'fixture crashed\nstderr: ' + child.stderr)
    if (!result['control-global-fetch']?.includes(':fail:')) {
      return t.skip('this runtime does not route loopback through the env proxy; nothing to bypass here')
    }
    assert.match(lines.find((line) => line.startsWith('proxy=')) ?? '', /^proxy=http:\/\/127\.0\.0\.1:9 node=/, 'fixture ran without the proxy env')
    for (const hop of ['agent', 'fetch', 'proxyHttp']) {
      assert.ok(result[hop]?.endsWith(':ok'), `${hop} stayed direct under env proxying — got: ${result[hop]}`)
    }
  } finally { rmSync(join(fixture, '..'), { recursive: true, force: true }) }
})
