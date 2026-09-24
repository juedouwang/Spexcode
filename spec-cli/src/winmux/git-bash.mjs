// SpexCode's shell scripts (launch.sh, hooks, plugins) are bash. On Windows git is already a hard requirement,
// and Git for Windows ships bash plus coreutils — so the bash that runs them is the one beside the git on PATH.
// `bin\bash.exe` is Git's wrapper that puts its /usr/bin tools on PATH before starting usr\bin\bash.exe.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

let cached

export function gitBashPath() {
  if (cached) return cached
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim()
  // <git root>/<mingw64|clangarm64>/libexec/git-core
  const bash = join(resolve(execPath, '..', '..', '..'), 'bin', 'bash.exe')
  if (!existsSync(bash)) throw new Error(`Git Bash not found at ${bash} (from git --exec-path ${execPath})`)
  return (cached = bash)
}
