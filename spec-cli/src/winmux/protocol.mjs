// winmux wire protocol: one named pipe per `-L` socket label (tmux's server namespace), newline-delimited JSON
// frames both ways. A connection's first frame is its request: `{op:'cmd'}` runs one tmux-style command and
// closes; `{op:'attach'}` turns the connection into a client stream (o=output, x=exit | i=input, r=resize, d=detach).
import { userInfo } from 'node:os'

export function pipePath(socket) {
  return `\\\\.\\pipe\\spexcode-winmux-${userInfo().username}-${socket}`
}

export function send(conn, message) {
  conn.write(`${JSON.stringify(message)}\n`)
}

export function frameReader(onFrame) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line) onFrame(JSON.parse(line))
    }
  }
}
