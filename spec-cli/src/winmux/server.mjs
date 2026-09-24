// winmux server - the native-Windows session holder behind SpexCode's tmux command surface. It is what the
// tmux server is to Linux: a process that outlives the backend and owns one pseudo-terminal per session (ConPTY
// via node-pty), plus a headless xterm mirror of each screen so capture-pane / list-panes #{pane_title} /
// refresh-client answer from real terminal state. The command grammar is the tmux subset SpexCode issues.
// One server per `-L` label; it exits a few seconds after its last session goes, like tmux's exit-empty.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { frameReader, pipePath, send } from './protocol.mjs'
import { keyBytes } from './keys.mjs'
import { gitBashPath } from './git-bash.mjs'

// `--daemonize`: start the real server and exit at once, so the server's parent is gone and it stands outside the
// starter's process tree (tmux's double fork). A tree kill of the backend must never take the sessions with it.
if (process.argv[2] === '--daemonize') {
  spawn(process.execPath, [fileURLToPath(import.meta.url), process.argv[3]], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  process.exit(0)
}
const socketName = process.argv[2]
// node-pty and the xterm mirror live with the dashboard package, the daemon runtime's home ([[packaging]]).
const dashboard = dirname(createRequire(import.meta.url).resolve('@spexcode/spec-dashboard/package.json'))
const pty = await import(pathToFileURL(join(dashboard, 'daemon-pty.mjs')).href)
const { Terminal, SerializeAddon } = await import(pathToFileURL(join(dashboard, 'daemon-xterm.mjs')).href)

const SCROLLBACK = 10000
const EMPTY_EXIT_MS = 3000
const PANE_SHELL = ['powershell.exe', ['-NoLogo']]
const logFile = join(tmpdir(), `spexcode-winmux-${socketName}.log`)
const log = (line) => appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${line}\n`)
const crash = (error) => { log(`CRASH ${error?.stack ?? error}`); process.exit(70) }
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)

class CommandError extends Error {}
const fail = (message) => { throw new CommandError(message) }

const sessions = new Map()
let paneSeq = 0
let clientSeq = 0
let emptyTimer = null

// ---------------------------------------------------------------- sessions

function createSession(name, { cols, rows, cwd, env, command }) {
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)
  const session = {
    name, term, serializer, cols, rows, cwd,
    paneId: `%${paneSeq++}`,
    created: Math.floor(Date.now() / 1000),
    title: hostname(),
    clients: new Set(),
    proc: null,
  }
  term.onTitleChange((title) => { session.title = title })
  term.onData((reply) => session.proc?.write(reply))
  sessions.set(name, session)
  clearTimeout(emptyTimer)
  spawnPane(session, { cwd, env, command })
  log(`new-session ${name} ${cols}x${rows} pid=${session.proc.pid} cwd=${cwd}`)
  return session
}

// A pane with no command runs the interactive shell SpexCode types its launch line into; a pane given a command
// runs it the way tmux does (`default-shell -c command`), and SpexCode's commands are POSIX shell text.
function spawnPane(session, { cwd, env, command }) {
  const [file, args] = command ? [gitBashPath(), ['-c', command]] : PANE_SHELL
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: session.cols, rows: session.rows, cwd, env, useConptyDll: true })
  session.proc = proc
  session.exited = new Promise((resolve) => proc.onExit(resolve))
  proc.onData((data) => {
    session.term.write(data)
    // ConPTY opens with a Device Attributes query and holds the pane's output until a terminal answers. The
    // mirror is the pane's terminal (as tmux is), so it answers; viewers must not answer it a second time.
    const shown = data.replaceAll('\x1b[c', '')
    if (shown) for (const client of session.clients) client.output(shown)
  })
  proc.onExit(({ exitCode }) => {
    log(`pane exit ${session.name} pid=${proc.pid} code=${exitCode}`)
    if (session.proc === proc) destroy(session, 'exited')
  })
}

function destroy(session, reason) {
  if (sessions.get(session.name) !== session) return
  sessions.delete(session.name)
  const proc = session.proc
  session.proc = null
  for (const client of session.clients) client.end(reason)
  try { proc?.kill() } catch { /* the pane process already exited */ }
  session.term.dispose()
  log(`${reason} ${session.name}`)
  if (sessions.size === 0) emptyTimer = setTimeout(() => { if (sessions.size === 0) process.exit(0) }, EMPTY_EXIT_MS)
}

function resizeSession(session, cols, rows) {
  if (session.cols === cols && session.rows === rows) return
  session.cols = cols
  session.rows = rows
  session.proc.resize(cols, rows)
  session.term.resize(cols, rows)
}

// window-size latest: the grid follows the client that most recently attached or typed.
function applySize(session) {
  let latest = null
  for (const client of session.clients) if (!latest || client.activity > latest.activity) latest = client
  if (latest) resizeSession(session, latest.cols, latest.rows)
}

const flush = (session) => new Promise((resolve) => session.term.write('', resolve))

// One atomic full repaint (DEC 2026) of the mirrored screen, for attach and refresh-client.
function repaint(session) {
  const core = session.term._core
  const body = session.serializer.serialize({ scrollback: 0 })
  const mouse = core.coreMouseService.activeEncoding === 'SGR' ? '\x1b[?1006h' : ''
  const cursor = core.coreService.isCursorHidden ? '\x1b[?25l' : '\x1b[?25h'
  return `\x1b[?2026h\x1b[?1049l\x1b[0m\x1b[H\x1b[2J${body}${mouse}${cursor}\x1b[?2026l`
}

function target(value) {
  if (!value) fail('no target given (-t)')
  if (value.startsWith('%')) {
    for (const session of sessions.values()) if (session.paneId === value) return session
    fail(`can't find pane: ${value}`)
  }
  const name = value.replace(/^=/, '').replace(/:.*$/, '')
  const session = sessions.get(name)
  if (!session) fail(`can't find session: ${name}`)
  return session
}

function paneEnv(base, assignments = []) {
  const env = { ...base }
  for (const assignment of assignments) {
    const eq = assignment.indexOf('=')
    if (eq <= 0) fail(`bad environment assignment: ${assignment}`)
    env[assignment.slice(0, eq)] = assignment.slice(eq + 1)
  }
  return env
}

// ---------------------------------------------------------------- formats

function sessionVars(session) {
  return {
    session_name: session.name,
    session_created: session.created,
    session_attached: session.clients.size,
    session_windows: 1,
    window_index: 0,
    window_width: session.cols,
    window_height: session.rows,
    pane_index: 0,
    pane_id: session.paneId,
    pane_pid: session.proc?.pid ?? 0,
    pane_title: session.title,
    pane_width: session.cols,
    pane_height: session.rows,
    pane_current_path: session.cwd,
    pane_dead: 0,
    pane_in_mode: 0,
  }
}

function clientVars(client) {
  return {
    ...sessionVars(client.session),
    client_pid: client.pid,
    client_tty: client.tty,
    client_name: client.tty,
    client_session: client.session.name,
    client_width: client.cols,
    client_height: client.rows,
  }
}

function format(template, vars) {
  return template.replace(/#\{([a-z_]+)\}/g, (_, name) => {
    if (!(name in vars)) fail(`unsupported format variable: ${name}`)
    return String(vars[name])
  })
}

// ---------------------------------------------------------------- capture

function sgr(cell) {
  const p = []
  if (cell.isBold()) p.push(1)
  if (cell.isDim()) p.push(2)
  if (cell.isItalic()) p.push(3)
  if (cell.isUnderline()) p.push(4)
  if (cell.isBlink()) p.push(5)
  if (cell.isInverse()) p.push(7)
  if (cell.isInvisible()) p.push(8)
  if (cell.isStrikethrough()) p.push(9)
  const color = (rgb, palette, value, base, bright, extended) => {
    if (rgb) p.push(`${extended};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`)
    else if (palette) p.push(value < 8 ? base + value : value < 16 ? bright + value - 8 : `${extended};5;${value}`)
  }
  color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 30, 90, 38)
  color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 40, 100, 48)
  return p.join(';')
}

function styledLine(line, cols, cell) {
  let last = -1
  for (let x = 0; x < cols; x++) {
    line.getCell(x, cell)
    if ((cell.getChars() && cell.getChars() !== ' ') || sgr(cell)) last = x
  }
  let out = ''
  let current = ''
  for (let x = 0; x <= last; x++) {
    line.getCell(x, cell)
    if (cell.getWidth() === 0) continue
    const style = sgr(cell)
    if (style !== current) { out += style ? `\x1b[0;${style}m` : '\x1b[0m'; current = style }
    out += cell.getChars() || ' '
  }
  return current ? `${out}\x1b[0m` : out
}

async function capturePane(o) {
  if (!o.p) fail('capture-pane without -p (paste buffers) is not supported')
  const session = target(o.t)
  await flush(session)
  const buffer = session.term.buffer.active
  const base = buffer.baseY
  const rows = session.term.rows
  const start = o.S === undefined ? 0 : o.S === '-' ? -base : Number(o.S)
  const end = o.E === undefined || o.E === '-' ? rows - 1 : Number(o.E)
  const from = Math.max(0, base + start)
  const to = Math.min(buffer.length - 1, base + end)
  const cell = buffer.getNullCell()
  const lines = []
  for (let y = from; y <= to; y++) {
    const line = buffer.getLine(y)
    const text = o.e ? styledLine(line, session.term.cols, cell) : line.translateToString(!o.N && !o.J)
    if (o.J && line.isWrapped && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  if (o.J) for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\s+$/, '')
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------- commands

function getopt(argv, spec) {
  const o = {}
  let i = 0
  for (; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { i++; break }
    if (!arg.startsWith('-') || arg === '-') break
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]
      const at = spec.indexOf(flag)
      if (at < 0) fail(`unknown flag -${flag}`)
      if (spec[at + 1] !== ':') { o[flag] = true; continue }
      const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i]
      if (value === undefined) fail(`-${flag} expects an argument`)
      if (flag === 'e') (o.e ||= []).push(value)
      else o[flag] = value
      break
    }
  }
  o.args = argv.slice(i)
  return o
}

const sortedSessions = () => [...sessions.values()].sort((a, b) => a.name.localeCompare(b.name))
const lines = (rows) => rows.length ? `${rows.join('\n')}\n` : ''

const COMMANDS = {
  'new-session': ['AdPs:x:y:c:e:n:F:', (o, req) => {
    const name = o.s
    if (!name) fail('new-session needs -s <name>')
    if (sessions.has(name)) fail(`duplicate session: ${name}`)
    const session = createSession(name, {
      cols: o.x ? Number(o.x) : 80,
      rows: o.y ? Number(o.y) : 24,
      cwd: o.c || req.cwd,
      env: paneEnv(req.env, o.e),
      command: o.args.length ? o.args.join(' ') : null,
    })
    return o.P ? `${format(o.F || '#{session_name}:', sessionVars(session))}\n` : ''
  }],
  'has-session': ['t:', (o) => { target(o.t); return '' }],
  'kill-session': ['t:', (o) => { destroy(target(o.t), 'killed'); return '' }],
  // The panes' processes die asynchronously (node-pty kills the console's process list); the server outlives them
  // so none is left to die later by console close, still holding its directory.
  'kill-server': ['', async () => {
    const panes = [...sessions.values()]
    for (const session of panes) destroy(session, 'killed')
    await Promise.all(panes.map((session) => session.exited))
    setTimeout(() => process.exit(0), 50)
    return ''
  }],
  'start-server': ['', () => ''],
  'list-sessions': ['F:', (o) => lines(sortedSessions().map((s) =>
    o.F ? format(o.F, sessionVars(s)) : `${s.name}: 1 windows (created ${new Date(s.created * 1000).toString()})${s.clients.size ? ' (attached)' : ''}`))],
  'list-panes': ['ast:F:', (o) => {
    const scope = o.a || !o.t ? sortedSessions() : [target(o.t)]
    return lines(scope.map((s) => o.F ? format(o.F, sessionVars(s)) : `0: [${s.cols}x${s.rows}] ${s.paneId} (active)`))
  }],
  'list-clients': ['t:F:', (o) => {
    const scope = o.t ? [target(o.t)] : sortedSessions()
    return lines(scope.flatMap((s) => [...s.clients].map((c) =>
      o.F ? format(o.F, clientVars(c)) : `${c.tty}: ${s.name} [${c.cols}x${c.rows}]`)))
  }],
  'capture-pane': ['aepPqCJNt:S:E:', capturePane],
  'send-keys': ['lt:', (o) => {
    const session = target(o.t)
    const bytes = o.args.map((arg) => o.l ? arg : keyBytes(arg) ?? arg).join('')
    if (bytes) session.proc.write(bytes)
    return ''
  }],
  'refresh-client': ['St:', (o) => {
    if (o.S) return ''
    for (const session of sessions.values()) {
      for (const client of session.clients) if (client.tty === o.t) { client.repaint(); return '' }
    }
    fail(`can't find client: ${o.t}`)
  }],
  'respawn-pane': ['kt:c:e:', (o, req) => {
    const session = target(o.t)
    if (!o.k) fail(`pane ${session.paneId} still active`)
    const previous = session.proc
    session.proc = null
    previous.kill()
    spawnPane(session, { cwd: o.c || session.cwd, env: paneEnv(req.env, o.e), command: o.args.length ? o.args.join(' ') : null })
    log(`respawn-pane ${session.name} pid=${session.proc.pid}`)
    return ''
  }],
  'display-message': ['pt:', (o) => {
    const session = o.t ? target(o.t) : sortedSessions()[0]
    if (!session) fail('no current session')
    return o.p ? `${format(o.args.join(' '), sessionVars(session))}\n` : ''
  }],
}
const ALIASES = { new: 'new-session', has: 'has-session', ls: 'list-sessions', send: 'send-keys', capturep: 'capture-pane', lsp: 'list-panes', lsc: 'list-clients', refresh: 'refresh-client', respawnp: 'respawn-pane', display: 'display-message' }

async function runCommand(req) {
  const [name, ...rest] = req.argv
  const command = COMMANDS[ALIASES[name] ?? name]
  if (!command) fail(`unknown command: ${name}`)
  return command[1](getopt(rest, command[0]), req)
}

// ---------------------------------------------------------------- clients

function attach(conn, req) {
  const session = target(req.target)
  const client = {
    session,
    conn,
    cols: req.cols,
    rows: req.rows,
    pid: req.pid,
    tty: `winmux-${socketName}-${++clientSeq}`,
    activity: Date.now(),
    held: null,
    output(data) {
      if (client.held) client.held.push(data)
      else send(conn, { t: 'o', d: data })
    },
    // Live output is held while the mirror catches up, so the repaint and the stream never reorder.
    repaint() {
      if (client.held) return
      client.held = []
      void flush(session).then(() => {
        const held = client.held
        client.held = null
        if (!session.clients.has(client)) return
        send(conn, { t: 'o', d: repaint(session) })
        for (const data of held) send(conn, { t: 'o', d: data })
      })
    },
    end(reason) {
      session.clients.delete(client)
      send(conn, { t: 'x', reason })
      conn.end()
    },
  }
  session.clients.add(client)
  applySize(session)
  send(conn, { ok: true, tty: client.tty })
  client.repaint()
  conn.on('close', () => {
    if (!session.clients.delete(client)) return
    applySize(session)
  })
  return (frame) => {
    if (!session.clients.has(client)) return
    if (frame.t === 'i') {
      client.activity = Date.now()
      applySize(session)
      session.proc.write(frame.d)
    } else if (frame.t === 'r') {
      client.cols = frame.c
      client.rows = frame.r
      applySize(session)
    } else if (frame.t === 'd') {
      client.end('detached')
    }
  }
}

// ---------------------------------------------------------------- server

const server = createServer((conn) => {
  conn.setEncoding('utf8')
  conn.on('error', () => {})
  let handle = null
  conn.on('data', frameReader((frame) => {
    if (handle) return handle(frame)
    if (frame.op === 'attach') {
      try { handle = attach(conn, frame) } catch (error) {
        send(conn, { error: error.message })
        conn.end()
        handle = () => {}
      }
      return
    }
    handle = () => {}
    runCommand(frame).then(
      (stdout) => { send(conn, { code: 0, stdout, stderr: '' }); conn.end() },
      (error) => {
        if (!(error instanceof CommandError)) log(`command ${JSON.stringify(frame.argv)} crashed: ${error.stack}`)
        send(conn, { code: 1, stdout: '', stderr: `${error.message}\n` })
        conn.end()
      },
    )
  }))
})
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') process.exit(0)   // another server already owns this label
  throw error
})
server.listen(pipePath(socketName), () => log(`listening on ${pipePath(socketName)}`))
emptyTimer = setTimeout(() => { if (sessions.size === 0) process.exit(0) }, 30_000)
