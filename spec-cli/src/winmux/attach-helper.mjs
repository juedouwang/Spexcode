// The Windows twin of pty-helper.mjs for pty-bridge: the same process contract (argv id cols rows; pane bytes on
// stdout; READY <client pid> / RESIZED c r / ERROR on stderr; JSON resize/input lines on stdin), but the client
// is a winmux attach stream instead of `tmux attach-session` inside a native PTY. READY carries this process's
// pid, which is the #{client_pid} winmux lists, so pty-bridge's list-clients → refresh-client lookup is unchanged.
import { attach } from './client.mjs'

const [id, colsArg, rowsArg] = process.argv.slice(2)
const cols = Number(colsArg)
const rows = Number(rowsArg)
const socket = process.env.SPEXCODE_TMUX || 'spexcode'

if (!id || !(cols > 0 && rows > 0)) {
  process.stderr.write('ERROR invalid helper arguments\n')
  process.exit(2)
}

let client
try {
  client = await attach(socket, { target: id, cols, rows, pid: process.pid }, {
    output: (data) => process.stdout.write(Buffer.from(data, 'utf8')),
    exited: (reason) => process.exit(reason === 'detached' ? 0 : 1),
  })
} catch (error) {
  process.stderr.write(`ERROR ${String(error.message).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 500)}\n`)
  process.exit(1)
}
process.stderr.write(`READY ${process.pid}\n`)

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.t === 'resize' && message.cols > 0 && message.rows > 0) {
      const nextCols = Math.floor(message.cols)
      const nextRows = Math.floor(message.rows)
      client.resize(nextCols, nextRows)
      process.stderr.write(`RESIZED ${nextCols} ${nextRows}\n`)
    } else if (message.t === 'input' && typeof message.data === 'string' && Buffer.byteLength(message.data, 'utf8') <= 64 * 1024) {
      client.input(message.data)
    }
  }
})
process.stdin.on('end', () => { client.close(); process.exit(0) })
