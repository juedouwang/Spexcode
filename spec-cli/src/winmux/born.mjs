// The Windows twin of launch.sh's birth registration `sh -c 'printf %s "$$" > agent.pid; exec env <invocation>'`.
// Under Git Bash `$$` is an MSYS pid, not a Windows one, and MSYS exec does not replace the process, so the
// POSIX trick cannot name the agent. Here the invocation is spawned natively (native-spawn.mjs), so agent.pid
// holds the real Windows pid of the process that lives exactly as long as the agent, and MSYS argument
// rewriting never touches the prompt (a prompt like "/atlas ..." would otherwise become "C:/Program Files/Git/atlas").
// usage: node born.mjs <agent.pid path> <agent.identity.json path> <invocation>
import { rmSync, writeFileSync } from 'node:fs'
import { spawnShellCommand } from './native-spawn.mjs'

const [pidPath, receiptPath, invocation] = process.argv.slice(2)
rmSync(receiptPath, { force: true })

// Ctrl-C in the pane is the agent's key (interrupt); this parent must not die of it and orphan the agent.
process.on('SIGINT', () => {})
process.on('SIGBREAK', () => {})
let child
try { child = spawnShellCommand(invocation, { stdio: 'inherit', env: process.env }) } catch (error) {
  console.error(`[spex launch] ${error.message}`)
  process.exit(127)
}
child.on('error', (error) => { console.error(`[spex launch] ${error.message}`); process.exit(127) })
if (child.pid) writeFileSync(pidPath, String(child.pid))
child.on('exit', (code) => process.exit(code ?? 1))
