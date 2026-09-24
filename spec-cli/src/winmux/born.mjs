// The Windows twin of launch.sh's birth registration `sh -c 'printf %s "$$" > agent.pid; exec env <invocation>'`.
// Under Git Bash `$$` is an MSYS pid, not a Windows one, and MSYS exec does not replace the process, so the
// POSIX trick cannot name the agent. Here bash only PARSES the invocation (same words `exec env` would get);
// the words are then applied with env's own grammar (-u NAME unsets, NAME=value sets, the rest is the command)
// and the agent is spawned directly, so agent.pid holds the real Windows pid of the process that lives exactly
// as long as the agent. Spawning natively also keeps MSYS argument rewriting away from the prompt text
// (a prompt like "/atlas ..." would otherwise reach the agent as "C:/Program Files/Git/atlas ...").
// usage: node born.mjs <agent.pid path> <agent.identity.json path> <invocation>
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { gitBashPath } from './git-bash.mjs'

const [pidPath, receiptPath, invocation] = process.argv.slice(2)
rmSync(receiptPath, { force: true })

// Windows environment names are case-insensitive; a plain object copy is not.
const env = { ...process.env }
const keyOf = (name) => Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase()) ?? name
const unset = (name) => { delete env[keyOf(name)] }
unset('MSYS_NO_PATHCONV')

const words = execFileSync(gitBashPath(), ['-c', `eval "set -- $SPEX_INVOCATION" && printf '%s\\0' "$@"`], {
  env: { ...process.env, SPEX_INVOCATION: invocation }, encoding: 'utf8', windowsHide: true,
}).split('\0').slice(0, -1)

let at = 0
for (; at < words.length; at++) {
  const word = words[at]
  if (word === '-u') { unset(words[++at]); continue }
  const eq = word.indexOf('=')
  if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, eq))) { env[keyOf(word.slice(0, eq))] = word.slice(eq + 1); continue }
  break
}
const [command, ...args] = words.slice(at)
if (!command) { console.error('[spex launch] empty launch invocation'); process.exit(127) }

const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }
function which(name) {
  const extensions = (env[keyOf('PATHEXT')] || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
  const inDir = (dir) => [...extensions.map((e) => join(dir, name + e)), join(dir, name)].find(isFile)
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const found = [...extensions.map((e) => resolve(name + e)), resolve(name)].find(isFile)
    if (found) return found
  } else {
    for (const dir of (env[keyOf('PATH')] || '').split(delimiter)) {
      const found = dir && inDir(dir)
      if (found) return found
    }
  }
  console.error(`[spex launch] ${name}: command not found`)
  process.exit(127)
}

// npm's .cmd shims only run `node <script> %*`; running that pair directly keeps multi-line and quoted
// prompts intact, which a trip through cmd.exe cannot.
function npmShim(file) {
  const match = /"%~?dp0%?\\([^"]+\.[cm]?js)"\s+%\*/i.exec(readFileSync(file, 'utf8'))
  if (!match) return null
  const local = join(dirname(file), 'node.exe')
  return { node: isFile(local) ? local : which('node'), script: join(dirname(file), match[1]) }
}

const META = /([()\][%!^"`<>&|;, *?])/g
const cmdArg = (arg) => `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(META, '^$1').replace(META, '^$1')

function start() {
  // SpexCode's own `bash -lc <script>` launchers hand their native agent only Windows paths and the prompt, so
  // MSYS path rewriting (which turns a leading-slash prompt into a Git install path) is switched off for them.
  if (command === 'bash' || command === 'sh') return spawn(gitBashPath(), args, { stdio: 'inherit', env: { ...env, MSYS_NO_PATHCONV: '1' } })
  const file = which(command)
  const extension = extname(file).toLowerCase()
  if (extension === '.exe' || extension === '.com') return spawn(file, args, { stdio: 'inherit', env })
  if (extension === '.cmd' || extension === '.bat') {
    const shim = npmShim(file)
    if (shim) return spawn(shim.node, [shim.script, ...args], { stdio: 'inherit', env })
    const line = [file.replace(META, '^$1'), ...args.map(cmdArg)].join(' ')
    return spawn(env[keyOf('ComSpec')] || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { stdio: 'inherit', env, windowsVerbatimArguments: true })
  }
  // an extensionless file is a shebang script (a user's wrapper, test fixtures): Git Bash runs it with its usual
  // path conversion, which such scripts rely on to hand POSIX paths to native programs
  return spawn(gitBashPath(), [file, ...args], { stdio: 'inherit', env })
}

// Ctrl-C in the pane is the agent's key (interrupt); this parent must not die of it and orphan the agent.
process.on('SIGINT', () => {})
process.on('SIGBREAK', () => {})
const child = start()
child.on('error', (error) => { console.error(`[spex launch] ${error.message}`); process.exit(127) })
if (child.pid) writeFileSync(pidPath, String(child.pid))
child.on('exit', (code) => process.exit(code ?? 1))
