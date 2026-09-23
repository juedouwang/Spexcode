import http from 'node:http'
import { Agent } from 'undici'

// @@@loopback-transport - hops to our own loopback services carry a pool with no proxy configuration, so
// environment proxying (--use-env-proxy + HTTP_PROXY) never swallows them; other targets keep the user's
// proxy. The contract lives in [[loopback-transport]].

// Callers pass URL.hostname, which is already normalized: IPv6 keeps brackets, IPv4 is dotted-quad.
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

// new http.Agent() never consults the environment, unlike the default agent.
export const loopbackHttpAgent = new http.Agent({ keepAlive: true })

const directDispatcher = new Agent()

export function fetchBypassingLoopbackProxy(url: string, init?: RequestInit): Promise<Response> {
  if (!isLoopbackHost(new URL(url).hostname)) return fetch(url, init)
  return fetch(url, { ...init, dispatcher: directDispatcher } as RequestInit)
}
