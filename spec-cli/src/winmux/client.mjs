// winmux client - the in-process replacement for spawning the `tmux` binary. `exec` behaves like execFile on
// `tmux -L <socket> ...`: it resolves {stdout, stderr} on exit 0 and rejects with the exit code otherwise, and a
// timeout rejects with killed/ETIMEDOUT so session-tmux's probeTimedOut reads it exactly as a killed tmux probe.
// Like tmux, only new-session starts a server; every other command against no server fails "no server running".
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { frameReader, pipePath, send } from './protocol.mjs'

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))
const START_TIMEOUT_MS = 15_000

function open(socket) {
  return new Promise((resolve, reject) => {
    const conn = connect(pipePath(socket))
    conn.once('connect', () => { conn.removeListener('error', reject); resolve(conn) })
    conn.once('error', reject)
  })
}

async function openOrStart(socket) {
  try { return await open(socket) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  spawn(process.execPath, [SERVER, '--daemonize', socket], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    try { return await open(socket) } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const STARTS_SERVER = new Set(['new-session', 'new', 'start-server'])

export async function run(socket, argv, { timeoutMs, env = process.env, cwd = process.cwd() } = {}) {
  let conn
  try {
    conn = STARTS_SERVER.has(argv[0]) ? await openOrStart(socket) : await open(socket)
  } catch (error) {
    if (error.code === 'ENOENT') return { code: 1, stdout: '', stderr: `no server running on ${pipePath(socket)}\n` }
    throw error
  }
  conn.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = timeoutMs ? setTimeout(() => {
      settled = true
      conn.destroy()
      reject(Object.assign(new Error(`winmux ${argv.join(' ')} timed out after ${timeoutMs}ms`), { killed: true, signal: 'SIGKILL', code: 'ETIMEDOUT' }))
    }, timeoutMs) : null
    conn.on('data', frameReader((reply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(reply)
    }))
    conn.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })
    conn.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`winmux server closed the connection during ${argv.join(' ')}`))
    })
    send(conn, { op: 'cmd', argv, env, cwd })
  })
}

export async function exec(socket, argv, options) {
  const reply = await run(socket, argv, options)
  if (reply.code === 0) return { stdout: reply.stdout, stderr: reply.stderr }
  throw Object.assign(new Error(`Command failed: tmux -L ${socket} ${argv.join(' ')}\n${reply.stderr}`), {
    code: reply.code, stdout: reply.stdout, stderr: reply.stderr, killed: false, signal: null,
  })
}

// An attached client: output(data) receives the pane stream, exited(reason) fires once when the server ends it.
export async function attach(socket, { target, cols, rows, pid = process.pid }, { output, exited }) {
  const conn = await open(socket)
  conn.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let ready = false
    let ended = false
    const end = (reason) => { if (!ended) { ended = true; exited(reason) } }
    conn.on('data', frameReader((frame) => {
      if (!ready) {
        if (frame.error) { reject(new Error(frame.error)); conn.destroy(); return }
        ready = true
        resolve({
          tty: frame.tty,
          input: (data) => send(conn, { t: 'i', d: data }),
          resize: (c, r) => send(conn, { t: 'r', c, r }),
          detach: () => send(conn, { t: 'd' }),
          close: () => conn.destroy(),
        })
        return
      }
      if (frame.t === 'o') output(frame.d)
      else if (frame.t === 'x') end(frame.reason)
    }))
    conn.on('error', (error) => { if (!ready) reject(error) })
    conn.on('close', () => { if (ready) end('lost server') })
    send(conn, { op: 'attach', target, cols, rows, pid })
  })
}
