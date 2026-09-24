// tmux key names → the bytes an xterm-compatible terminal sends for them. Covers the names SpexCode's raw-key
// channel emits (sessions.ts TMUX_KEY + BTab + C-/M-/S- combos) plus the ordinary navigation/function keys.
// A string that is not a key name is not a key: `keyBytes` returns null and send-keys types it literally, which
// is exactly tmux's own rule for an unrecognised send-keys argument.

const CSI = '\x1b['
const CURSOR = { Up: 'A', Down: 'B', Right: 'C', Left: 'D', Home: 'H', End: 'F' }
const TILDE = { IC: 2, Insert: 2, DC: 3, Delete: 3, PPage: 5, PageUp: 5, PgUp: 5, NPage: 6, PageDown: 6, PgDn: 6 }
const FUNCTION = {
  F1: 'OP', F2: 'OQ', F3: 'OR', F4: 'OS',
  F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
}
const PLAIN = { Enter: '\r', Escape: '\x1b', Tab: '\t', BTab: `${CSI}Z`, Space: ' ', BSpace: '\x7f' }

function ctrl(char) {
  if (char === ' ' || char === '@' || char === '2') return '\x00'
  if (char === '?') return '\x7f'
  const code = char.toUpperCase().charCodeAt(0)
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f)
  return char
}

export function keyBytes(name) {
  let rest = name
  let shift = false, meta = false, control = false
  while (rest.length > 2 && rest[1] === '-' && 'CMS'.includes(rest[0])) {
    if (rest[0] === 'C') control = true
    else if (rest[0] === 'M') meta = true
    else shift = true
    rest = rest.slice(2)
  }
  const modifier = 1 + (shift ? 1 : 0) + (meta ? 2 : 0) + (control ? 4 : 0)
  // unmodified Home/End as tmux sends them (ESC[1~ / ESC[4~), so an agent reads the same bytes as on Linux
  if (modifier === 1 && (rest === 'Home' || rest === 'End')) return `${CSI}${rest === 'Home' ? 1 : 4}~`
  if (CURSOR[rest]) return modifier === 1 ? `${CSI}${CURSOR[rest]}` : `${CSI}1;${modifier}${CURSOR[rest]}`
  if (TILDE[rest]) return modifier === 1 ? `${CSI}${TILDE[rest]}~` : `${CSI}${TILDE[rest]};${modifier}~`
  if (FUNCTION[rest] !== undefined) {
    const code = FUNCTION[rest]
    if (typeof code === 'string') return modifier === 1 ? `\x1b${code}` : `${CSI}1;${modifier}${code[1]}`
    return modifier === 1 ? `${CSI}${code}~` : `${CSI}${code};${modifier}~`
  }
  if (PLAIN[rest] !== undefined) {
    if (rest === 'Tab' && shift) return `${meta ? '\x1b' : ''}${CSI}Z`
    return `${meta ? '\x1b' : ''}${PLAIN[rest]}`
  }
  if ([...rest].length === 1 && name !== rest) {
    let char = shift ? rest.toUpperCase() : rest
    if (control) char = ctrl(char)
    return `${meta ? '\x1b' : ''}${char}`
  }
  return null
}
