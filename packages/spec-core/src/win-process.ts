// Native Windows process facts straight from kernel32 (via koffi FFI): the start-time token that makes a pid an
// identity, and the whole-machine pid → (ppid, image) table that POSIX reads from /proc or `ps -eo`. Both are
// polled on liveness paths, so they must cost microseconds — not a PowerShell spawn per question.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

type ProcRow = { ppid: number; comm: string }
type Api = {
  startToken(pid: number): string | null
  table(): Map<number, ProcRow>
  hasConsole(): boolean
  attachConsole(pid: number): boolean
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const STILL_ACTIVE = 259
const TH32CS_SNAPPROCESS = 0x2

let api: Api | undefined

function load(): Api {
  if (api) return api
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const koffi = createRequire(import.meta.url)('koffi') as any
  const kernel32 = koffi.load('kernel32.dll')
  const FILETIME = koffi.struct('SPEX_FILETIME', { lo: 'uint32', hi: 'uint32' })
  const PROCESSENTRY32W = koffi.struct('SPEX_PROCESSENTRY32W', {
    dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr_t', th32ModuleID: 'uint32',
    cntThreads: 'uint32', th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32',
    szExeFile: koffi.array('char16_t', 260, 'String'),
  })
  const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)')
  const CloseHandle = kernel32.func('int __stdcall CloseHandle(void* handle)')
  const GetExitCodeProcess = kernel32.func('int __stdcall GetExitCodeProcess(void* handle, _Out_ uint32* code)')
  const GetProcessTimes = kernel32.func('int __stdcall GetProcessTimes(void* handle, _Out_ SPEX_FILETIME* created, _Out_ SPEX_FILETIME* exited, _Out_ SPEX_FILETIME* kernel, _Out_ SPEX_FILETIME* user)')
  const CreateToolhelp32Snapshot = kernel32.func('void* __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)')
  const Process32FirstW = kernel32.func('int __stdcall Process32FirstW(void* snapshot, _Inout_ SPEX_PROCESSENTRY32W* entry)')
  const Process32NextW = kernel32.func('int __stdcall Process32NextW(void* snapshot, _Inout_ SPEX_PROCESSENTRY32W* entry)')
  const entrySize = koffi.sizeof(PROCESSENTRY32W)
  const GetConsoleProcessList = kernel32.func('uint32 __stdcall GetConsoleProcessList(_Out_ uint32* list, uint32 count)')
  const AttachConsole = kernel32.func('int __stdcall AttachConsole(uint32 pid)')

  api = {
    hasConsole: () => GetConsoleProcessList([0], 1) > 0,
    attachConsole: (pid) => AttachConsole(pid) !== 0,
    // The creation FILETIME of a LIVE process. An exited process whose handle someone still holds keeps its
    // times readable, so the exit code gates the answer: a dead pid has no token.
    startToken(pid) {
      const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (!handle) return null
      try {
        const code = [0]
        if (!GetExitCodeProcess(handle, code) || code[0] !== STILL_ACTIVE) return null
        const created = { lo: 0, hi: 0 }
        if (!GetProcessTimes(handle, created, {}, {}, {})) return null
        return ((BigInt(created.hi) << 32n) | BigInt(created.lo)).toString()
      } finally { CloseHandle(handle) }
    },
    table() {
      const rows = new Map<number, ProcRow>()
      const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
      const entry = { dwSize: entrySize } as Record<string, unknown>
      try {
        if (Process32FirstW(snapshot, entry)) {
          do {
            rows.set(entry.th32ProcessID as number, {
              ppid: entry.th32ParentProcessID as number,
              comm: String(entry.szExeFile).replace(/\.exe$/i, ''),
            })
          } while (Process32NextW(snapshot, entry))
        }
      } finally { CloseHandle(snapshot) }
      return rows
    },
  }
  return api
}

export function winProcessStartToken(pid: number): string | null {
  return load().startToken(pid)
}

export function winProcessTable(): Map<number, ProcRow> {
  return load().table()
}

// A Windows process with no console (started detached, or by a GUI such as the desktop app) makes every console
// child it spawns — git, bash — allocate a console of its own: ~0.5s per git call instead of ~40ms, and a window
// flash when the spawn is not hidden. SpexCode processes therefore always own a console: one that no terminal
// gave them is borrowed, windowless, from a hidden helper (a CREATE_NO_WINDOW console outlives the helper once
// attached), so children inherit it exactly as they would inherit a terminal's.
export function ensureWindowsConsole(): void {
  if (process.platform !== 'win32' || load().hasConsole()) return
  const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  const attached = !!helper.pid && load().attachConsole(helper.pid)
  helper.kill()
  if (!attached) throw new Error(`could not attach a console from helper process ${helper.pid}`)
}
