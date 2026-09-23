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
import { isLoopbackHost, fetchBypassingLoopbackProxy } from './loopback-transport.js'

test('isLoopbackHost names exactly this machine, as URL.hostname spells it', () => {
  const host = (url: string) => isLoopbackHost(new URL(url).hostname)
  for (const url of ['http://localhost:1/', 'http://LOCALHOST:1/', 'http://127.0.0.1:1/', 'http://127.1:1/', 'http://127.255.0.1:1/', 'http://[::1]:1/']) {
    assert.equal(host(url), true, url)
  }
  for (const url of ['http://10.0.0.1/', 'http://0.0.0.0/', 'http://example.com/', 'http://[::2]/', 'http://[::ffff:127.0.0.1]/', 'http://127.0.0.1.evil.com/']) {
    assert.equal(host(url), false, url)
  }
})

test('fetchBypassingLoopbackProxy fetches a loopback service', async () => {
  const server = http.createServer((q, r) => r.end('pong:' + q.url))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetchBypassingLoopbackProxy(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/check`)
    assert.equal(await response.text(), 'pong:/check')
  } finally { server.close() }
})

// A bare fetch( is a loopback hop waiting to be swallowed by environment proxying; only these files may hold one.
const ALLOWED_BARE_FETCH: Record<string, string> = {
  'loopback-transport.ts': 'the helper itself; its non-loopback passthrough keeps the user proxy',
  'guide.ts': 'browser-side doc example string, never executed by the CLI',
}

test('no bare fetch call sites outside the loopback helper', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const offenders = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') &&
    !(name in ALLOWED_BARE_FETCH) && readFileSync(join(dir, name), 'utf8').includes('fetch('))
  assert.deepEqual(offenders, [], 'route loopback targets through fetchBypassingLoopbackProxy, or allow the file with a reason')
})

// Only a runtime that routes loopback through the env proxy can prove the rule (Node 24.15/26.5 do; 22 has
// no --use-env-proxy). The child points HTTP_PROXY at a dead port: a proxied hop dies there, a direct one answers.
test('loopback hops stay direct under environment proxying', { timeout: 60_000 }, (t) => {
  const here = (file: string) => JSON.stringify(pathToFileURL(fileURLToPath(new URL(file, import.meta.url))).href)
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
  const fixture = join(mkdtempSync(join(tmpdir(), 'loopback-transport-')), 'fixture.mjs')
  writeFileSync(fixture, `
import http from 'node:http'
import { fetchBypassingLoopbackProxy } from ${here('./loopback-transport.js')}
import { proxyHttp } from ${here('./gateway.js')}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const port = await listen(http.createServer((q, r) => r.end('upstream:' + q.url)))
const gate = await listen(http.createServer((q, r) => proxyHttp(q, r, port)))
const report = async (label, url, get) => { try { console.log(label + ':' + await (await get(url)).text()) } catch (e) { console.log(label + ':fail:' + (e.cause?.code ?? e.message)) } }
await report('fetch', 'http://127.0.0.1:' + port + '/fetch', fetchBypassingLoopbackProxy)
await report('proxyHttp', 'http://127.0.0.1:' + gate + '/proxied', fetchBypassingLoopbackProxy)
await report('control', 'http://127.0.0.1:' + port + '/control', fetch)
process.exit(0)
`)
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' }
    for (const key of ['http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete env[key]
    const child = spawnSync(process.execPath, ['--import', tsx, '--use-env-proxy', fixture], { encoding: 'utf8', timeout: 45_000, env })
    if (/bad option|not allowed/i.test(child.stderr)) return t.skip('this runtime has no --use-env-proxy')
    assert.equal(child.status, 0, 'fixture crashed\nstderr: ' + child.stderr)
    const result = Object.fromEntries(child.stdout.split('\n').filter(Boolean).map((line) => [line.split(':')[0], line]))
    if (!result.control?.includes(':fail:')) return t.skip('this runtime does not route loopback through the env proxy')
    assert.equal(result.fetch, 'fetch:upstream:/fetch')
    assert.equal(result.proxyHttp, 'proxyHttp:upstream:/proxied')
  } finally { rmSync(join(fixture, '..'), { recursive: true, force: true }) }
})
