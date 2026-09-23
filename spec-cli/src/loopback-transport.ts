import http from 'node:http'
import { Agent } from 'undici'

// @@@loopback-transport - one rule for every hop this product opens to its OWN services: the target is on
// this host's loopback, and a loopback hop never rides the environment proxy. Environment proxying
// (NODE_OPTIONS=--use-env-proxy / NODE_USE_ENV_PROXY=1) is becoming default infrastructure on dev
// machines, and under it a runtime routes even 127.0.0.1 requests through HTTP_PROXY — where a proxy on
// another machine cannot reach THIS host's loopback at all, and a proxy in between replaces the direct
// ECONNREFUSED that [[remote-client]]'s owner-proof depends on with the proxy's own failure. External
// targets keep the user's proxy settings; only our own loopback hops go direct, by carrying a connection
// pool that has no proxy configuration to consult.

const LOOPBACK_NAMES = new Set(['localhost', '::1', '::ffff:127.0.0.1'])

export function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase()   // URL.hostname keeps IPv6 brackets
  if (LOOPBACK_NAMES.has(bare)) return true
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)   // the whole 127/8 is loopback,
  return !!v4 && Number(v4[1]) === 127 && v4.slice(2).every((o) => Number(o) <= 255)  // as an IP, not a prefix
}

// A plain node:http pool: an agent constructed without proxyEnv never consults the environment, so
// gateway and supervisor hops through it are direct on every runtime, proxying enabled or not.
export const loopbackHttpAgent = new http.Agent({ keepAlive: true })

// A plain undici pool for fetch(): global fetch under environment proxying dispatches through the
// proxy-aware global dispatcher, so a loopback target must name a dispatcher of its own.
const directDispatcher = new Agent()

export function fetchBypassingLoopbackProxy(url: string, init?: RequestInit): Promise<Response> {
  try {
    if (!isLoopbackHost(new URL(url).hostname)) return fetch(url, init)
  } catch {
    return fetch(url, init)   // a malformed URL is fetch's error to raise, in fetch's words
  }
  return fetch(url, { ...init, dispatcher: directDispatcher } as RequestInit)
}
