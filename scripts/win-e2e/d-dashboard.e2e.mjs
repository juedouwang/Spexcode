// E2E group D — the dashboard's live terminal against the platform session host (winmux on Windows, tmux on
// Linux): first paint, typed input reaching a raw-mode agent byte-exactly (keys + an IME commit), keystroke latency,
// two viewers sharing one pane (latest-active sizing), and a surface switch that must repaint.
// Run: SPEXCODE_PLAYWRIGHT_PATH=<playwright-core>/index.mjs node --test scripts/win-e2e/d-dashboard.e2e.mjs
// (CHROMIUM=<browser exe> to pick a browser; default is the installed Chrome channel.)
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { createWorld, fakeClaude, keyAgent, waitFor } from './fixture.mjs'

const report = { platform: process.platform, scenarios: {} }
const note = (id, data) => { report.scenarios[id] = { ...report.scenarios[id], ...data } }
const VISIBLE = '.si-term-layer[style*="visibility: visible"]'

let world, browser, ledger, fakeId, keysId
const ledgerHex = () => readFileSync(ledger, 'utf8').replace(/\s+/g, '')

before(async () => {
  ledger = join(process.env.TEMP || process.env.TMPDIR || '/tmp', `spex-e2e-dash-${process.pid}.ledger`)
  writeFileSync(ledger, '')
  world = await createWorld('d', {
    launchers: { fake: { harness: 'claude', cmd: fakeClaude }, keys: { harness: 'claude', cmd: keyAgent } },
    env: { KEY_AGENT_LEDGER: ledger },
  })
  await world.start()
  await world.startUi()
  const { chromium } = await import(pathToFileURL(process.env.SPEXCODE_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM, headless: true } : { channel: 'chrome', headless: true })
  const online = (id) => waitFor(`${id} online`, async () => (await world.session(id))?.liveness === 'online', 60_000)
  fakeId = JSON.parse(world.spex(['session', 'new', 'D dashboard terminal', '--launcher', 'fake'])).id
  keysId = JSON.parse(world.spex(['session', 'new', 'D dashboard keys', '--launcher', 'keys'])).id
  await online(fakeId)
  await online(keysId)
})

after(async () => {
  await browser?.close()
  await world?.dispose()
  if (process.env.SPEX_E2E_REPORT) writeFileSync(process.env.SPEX_E2E_REPORT, `${JSON.stringify(report, null, 2)}\n`)
})

async function openTerminal(id, viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const t0 = Date.now()
  await page.goto(`${world.ui}/#/sessions/${id}?surface=terminal`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction((selector) => (document.querySelector(`${selector} .xterm-rows`)?.textContent || '').trim().length > 20, VISIBLE, { timeout: 30_000 })
  return { page, errors, paintMs: Date.now() - t0 }
}
const rows = (page) => page.evaluate((selector) => document.querySelector(`${selector} .xterm-rows`)?.textContent || '', VISIBLE)

test('D1 the terminal surface paints the live pane', async () => {
  const { page, errors, paintMs } = await openTerminal(fakeId)
  await page.waitForFunction((selector) => /FAKE-HARNESS TICK \d+/.test(document.querySelector(`${selector} .xterm-rows`)?.textContent || ''), VISIBLE, { timeout: 15_000 })
  const first = (await rows(page)).match(/FAKE-HARNESS TICK (\d+)/g)?.pop()
  await page.waitForTimeout(1500)
  const later = (await rows(page)).match(/FAKE-HARNESS TICK (\d+)/g)?.pop()
  note('D1', { paintMs, first, later })
  assert.notEqual(first, later, 'the terminal keeps streaming')
  assert.deepEqual(errors, [])
  await page.close()
})

// browser keystroke → xterm encoding → socket → bridge → session host → console → raw-mode agent
const TYPED = [
  ['type', 'hello', '68656c6c6f'],
  ['press', 'Enter', '0d'],
  ['press', 'ArrowUp', '1b5b41'],
  ['press', 'ArrowLeft', '1b5b44'],
  ['press', 'Tab', '09'],
  ['press', 'Shift+Tab', '1b5b5a'],
  ['press', 'Escape', '1b'],
  ['press', 'Backspace', '7f'],
  ['press', 'Control+c', '03'],
  ['insertText', '你好', 'e4bda0e5a5bd'],
]

test('D2 typed input reaches a raw-mode agent byte-exactly and fast', async () => {
  const { page, errors } = await openTerminal(keysId)
  await page.click(`${VISIBLE} .xterm-screen`)
  const latencies = []
  for (const [how, what, hex] of TYPED) {
    const before = ledgerHex().length
    const t0 = Date.now()
    if (how === 'type') await page.keyboard.type(what)
    else if (how === 'press') await page.keyboard.press(what)
    else await page.keyboard.insertText(what)
    const got = await waitFor(`${what} in ledger`, () => {
      const now = ledgerHex()
      return now.length - before >= hex.length ? now.slice(before) : null
    }, 5_000, 5)
    latencies.push(Date.now() - t0)
    assert.equal(got, hex, `${how} ${what}`)
  }
  latencies.sort((a, b) => a - b)
  note('D2', { keystrokeMsP50: latencies[Math.floor(latencies.length / 2)], keystrokeMsMax: latencies.at(-1) })
  assert.deepEqual(errors, [])
  await page.close()
})

test('D3 two viewers share one pane; the one typing sets the grid', async () => {
  const big = await openTerminal(keysId, { width: 1400, height: 900 })
  const small = await openTerminal(keysId, { width: 700, height: 500 })
  const width = () => Number(world.mux(['display-message', '-p', '-t', keysId, '#{window_width}']).trim())
  const clients = () => world.mux(['list-clients', '-t', keysId, '-F', '#{client_tty} #{client_width}x#{client_height}']).trim().replace(/\n/g, ' | ')
  await small.page.click(`${VISIBLE} .xterm-screen`)
  await small.page.keyboard.type('s')
  const smallCols = await waitFor('grid follows the small viewer', () => { const w = width(); return w < 100 ? w : null }, 10_000, 100)
    .catch((error) => { throw new Error(`${error.message}; grid ${width()} cols; clients: ${clients()}`) })
  await big.page.click(`${VISIBLE} .xterm-screen`)
  await big.page.keyboard.type('b')
  const bigCols = await waitFor('grid follows the big viewer', () => { const w = width(); return w > smallCols ? w : null }, 10_000, 100)
  note('D3', { smallCols, bigCols })
  assert.deepEqual([...big.errors, ...small.errors], [])
  await big.page.close()
  await small.page.close()
})

test('D4 leaving the terminal surface and coming back repaints it', async () => {
  const { page } = await openTerminal(fakeId)
  await page.goto(`${world.ui}/#/sessions/${fakeId}?surface=conversation`)
  await page.waitForTimeout(1500)
  const t0 = Date.now()
  await page.goto(`${world.ui}/#/sessions/${fakeId}?surface=terminal`)
  await page.waitForFunction((selector) => /FAKE-HARNESS TICK \d+/.test(document.querySelector(`${selector} .xterm-rows`)?.textContent || ''), VISIBLE, { timeout: 15_000 })
  note('D4', { repaintMs: Date.now() - t0 })
  await page.close()
})
