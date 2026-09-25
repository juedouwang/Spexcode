// Run SpexCode's shell-text commands natively on Windows. A launcher command is bash text (`VAR=x claude --flag`,
// `-u NAME` unsets as `env` takes them); bash only PARSES it into words, then the command is spawned directly:
// an .exe as itself, an npm .cmd shim as `node <script>` (cmd.exe would mangle multi-line/quoted arguments), any
// other .cmd/.bat through cmd.exe, and `bash`/`sh` or an extensionless (shebang) script through Git's bash.
// Spawning natively keeps MSYS argument rewriting away from prompt text and gives the caller the real pid.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { gitBashPath } from './git-bash.mjs'

// Windows environment names are case-insensitive; a plain object copy is not.
const keyOf = (env, name) => Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase()) ?? name

// words exactly as `exec env <text>` would receive them
export function shellWords(text, env = process.env) {
  return execFileSync(gitBashPath(), ['-c', `eval "set -- $SPEX_INVOCATION" && printf '%s\\0' "$@"`], {
    env: { ...env, SPEX_INVOCATION: text }, encoding: 'utf8', windowsHide: true,
  }).split('\0').slice(0, -1)
}

// env's own grammar over the leading words: -u NAME unsets, NAME=value sets; the rest is the command line
export function applyEnvWords(words, baseEnv) {
  const env = { ...baseEnv }
  let at = 0
  for (; at < words.length; at++) {
    const word = words[at]
    if (word === '-u') { delete env[keyOf(env, words[++at])]; continue }
    const eq = word.indexOf('=')
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, eq))) { env[keyOf(env, word.slice(0, eq))] = word.slice(eq + 1); continue }
    break
  }
  return { env, argv: words.slice(at) }
}

const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }

export function which(name, env) {
  const extensions = (env[keyOf(env, 'PATHEXT')] || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
  const candidates = (base) => [...extensions.map((e) => base + e), base]
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const found = candidates(resolve(name)).find(isFile)
    if (found) return found
  } else {
    for (const dir of (env[keyOf(env, 'PATH')] || '').split(';')) {
      const found = dir && candidates(join(dir, name)).find(isFile)
      if (found) return found
    }
  }
  throw new Error(`${name}: command not found`)
}

function npmShim(file, env) {
  const match = /"%~?dp0%?\\([^"]+\.[cm]?js)"\s+%\*/i.exec(readFileSync(file, 'utf8'))
  if (!match) return null
  const local = join(dirname(file), 'node.exe')
  return { node: isFile(local) ? local : which('node', env), script: join(dirname(file), match[1]) }
}

const META = /([()\][%!^"`<>&|;, *?])/g
const cmdArg = (arg) => `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(META, '^$1').replace(META, '^$1')

// argv[0] resolved and spawned the Windows way; options are child_process.spawn options (env required)
export function spawnArgv([command, ...args], options) {
  const { env } = options
  // SpexCode's own `bash -lc <script>` launchers hand their native agent only Windows paths and the prompt, so
  // MSYS path rewriting (which turns a leading-slash prompt into a Git install path) is switched off for them.
  if (command === 'bash' || command === 'sh') return spawn(gitBashPath(), args, { ...options, env: { ...env, MSYS_NO_PATHCONV: '1' } })
  const file = which(command, env)
  const extension = extname(file).toLowerCase()
  if (extension === '.exe' || extension === '.com') return spawn(file, args, options)
  if (extension === '.cmd' || extension === '.bat') {
    const shim = npmShim(file, env)
    if (shim) return spawn(shim.node, [shim.script, ...args], options)
    const line = [file.replace(META, '^$1'), ...args.map(cmdArg)].join(' ')
    return spawn(env[keyOf(env, 'ComSpec')] || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true })
  }
  // A script runs under the interpreter it names: node for JS files and node shebangs (spex.mjs itself); Git's
  // bash for shell scripts (a user's wrapper, test fixtures), with its usual path conversion, which such scripts
  // rely on to hand POSIX paths to native programs.
  const shebang = readFileSync(file, 'utf8').split('\n', 1)[0]
  if (/^\.[cm]?js$/.test(extension) || /^#!.*\bnode\b/.test(shebang)) return spawn(which('node', env), [file, ...args], options)
  return spawn(gitBashPath(), [file, ...args], options)
}

// `exec env <text>` without the shell: parse, apply the env words, spawn natively
export function spawnShellCommand(text, options) {
  const baseEnv = { ...(options.env ?? process.env) }
  delete baseEnv[keyOf(baseEnv, 'MSYS_NO_PATHCONV')]
  const { env, argv } = applyEnvWords(shellWords(text, baseEnv), baseEnv)
  if (!argv.length) throw new Error(`empty command: ${text}`)
  return spawnArgv(argv, { ...options, env })
}

// Windows has no process groups: a teardown takes the process and everything it started.
export function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) }
  catch (error) { if (error.status !== 128) throw error }   // 128: the process is already gone
}
