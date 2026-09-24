// The headless xterm mirror + serializer for spec-cli's winmux server (the native-Windows session holder), kept
// beside daemon-pty.mjs so the daemon runtime's terminal dependencies resolve from this package's own tree.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const { Terminal } = require('@xterm/headless')
export const { SerializeAddon } = require('@xterm/addon-serialize')
