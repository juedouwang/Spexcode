#!/usr/bin/env node
// E2E stand-in for a TUI agent: it binds the session rendezvous (so SpexCode reads it online), reads its terminal
// in RAW mode like Claude/Codex do, and appends every input chunk as hex to KEY_AGENT_LEDGER — the byte-exact
// record of what reached the agent through the whole host → pane → console path.
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:net'

const socketPath = process.env.CLAUDE_BG_RENDEZVOUS_SOCK
const ledger = process.env.KEY_AGENT_LEDGER
const write = (line) => process.stdout.write(`${line}\r\n`)

createServer((connection) => {
  connection.on('error', () => {})
  let buffer = ''
  connection.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const message = JSON.parse(line)
      if (message.type === 'reply') write(`KEY-AGENT REPLY ${message.text.replace(/\s+/g, ' ').slice(0, 200)}`)
      if (message.type === 'ping') connection.write(`${JSON.stringify({ type: 'pong' })}\n`)
    }
  })
}).listen(socketPath, () => write(`KEY-AGENT READY ${process.env.SPEXCODE_SESSION_ID}`))

process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  appendFileSync(ledger, `${chunk.toString('hex')}\n`)
  write(`KEY-AGENT GOT ${chunk.toString('hex')}`)
})
