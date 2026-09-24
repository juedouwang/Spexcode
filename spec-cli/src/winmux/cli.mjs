#!/usr/bin/env node
// `tmux`-compatible command line for winmux: `node cli.mjs [-L socket] <command> [args]`. Used by launch.sh's
// in-pane capture, by `spex session attach`, and by hand for debugging. attach-session is the interactive
// client: raw keyboard in, pane out, C-b d detaches (C-b C-b sends a literal C-b), like tmux's default prefix.
import { attach, run } from './client.mjs'

const argv = process.argv.slice(2)
let socket = process.env.SPEXCODE_TMUX || 'spexcode'
while (argv.length && argv[0].startsWith('-')) {
  const flag = argv.shift()
  if (flag === '-L') socket = argv.shift()
  else if (flag === '-V') { console.log('tmux 3.6 (winmux)'); process.exit(0) }
  else if (flag === '-u' || flag === '-2') continue
  else { console.error(`winmux: unknown option ${flag}`); process.exit(1) }
}
if (!argv.length) { console.error('usage: winmux [-L socket] <command> [args]'); process.exit(1) }

if (['attach-session', 'attach', 'a', 'at'].includes(argv[0])) {
  const at = argv.indexOf('-t')
  const target = at >= 0 ? argv[at + 1] : undefined
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('winmux: attach needs a terminal'); process.exit(1) }
  const size = () => [process.stdout.columns, process.stdout.rows]
  const restore = () => {
    process.stdin.setRawMode(false)
    process.stdout.write('\x1b[?1049l\x1b[?25h')
  }
  let client
  try {
    client = await attach(socket, { target, cols: size()[0], rows: size()[1] }, {
      output: (data) => process.stdout.write(data),
      exited: (reason) => {
        restore()
        process.stdout.write(reason === 'detached' ? `[detached (from session ${target})]\n` : `[${reason}]\n`)
        process.exit(0)
      },
    })
  } catch (error) {
    console.error(`winmux: ${error.message}`)
    process.exit(1)
  }
  process.stdout.write('\x1b[?1049h')
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  let prefix = false
  process.stdin.on('data', (data) => {
    let out = ''
    for (const ch of data) {
      if (prefix) {
        prefix = false
        if (ch === 'd') { if (out) client.input(out); client.detach(); return }
        out += ch === '\x02' ? '\x02' : `\x02${ch}`
      } else if (ch === '\x02') prefix = true
      else out += ch
    }
    if (out) client.input(out)
  })
  process.stdout.on('resize', () => client.resize(...size()))
} else {
  const reply = await run(socket, argv)
  process.stdout.write(reply.stdout)
  process.stderr.write(reply.stderr)
  process.exit(reply.code)
}
