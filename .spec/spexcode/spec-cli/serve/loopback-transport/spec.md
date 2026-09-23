---
title: loopback-transport
hue: 120
desc: A hop to this product's own loopback service never rides the environment proxy — the pool it rides carries no proxy to consult, on any runtime.
code:
  - spec-cli/src/loopback-transport.ts
related:
  - spec-cli/src/loopback-transport.test.ts
  - spec-cli/src/gateway.ts
  - spec-cli/src/supervise.ts
  - spec-cli/src/client.ts
  - spec-cli/src/sessions.ts
  - spec-cli/src/doctor.ts
  - spec-cli/src/host.ts
  - spec-cli/src/evidence.ts
---

# loopback-transport

Environment proxying (`NODE_OPTIONS=--use-env-proxy` / `NODE_USE_ENV_PROXY=1` plus `HTTP_PROXY`/`HTTPS_PROXY`)
is not an exotic configuration to be worked around — on many developer machines it is simply on, so the
product treats "a proxy is configured" as the default state it must be correct under. Under that state a
runtime routes even requests to `127.0.0.1` through the proxy (measured on Node 24.15 and 26.5: no loopback
exclusion exists; only `NO_PROXY` suppresses it), and two things break. A proxy on another machine cannot
reach THIS host's loopback at all — the hop dies in the proxy. And a proxy in between replaces the direct
`ECONNREFUSED` that [[remote-client]]'s owner-proof and health probes read with the proxy's own failure, so
"no owner listening" becomes indistinguishable from "proxy refused".

**The rule: a hop to our own loopback service is always direct; every other target keeps the user's proxy
settings.** There is no legitimate use for proxying a loopback hop — `127.0.0.1` resolved at a proxy names
the proxy's machine, not ours. The rule is transport-level and per-hop, never an environment rewrite:
writing `NO_PROXY` would leak to launched agents and child processes and only takes effect if read before
the runtime caches its proxy config, so it is not written anywhere.

Mechanically, a hop is direct because the connection pool it rides was constructed without any proxy
configuration to consult — this stays true whatever a future runtime makes of the environment:

- **node:http hops** ([[public-mode]]'s `proxyHttp` upstreams — supervisor, project backends, hub legs,
  session-web previews — and [[serve]]'s child health probe) pass one shared `http.Agent` that never
  consulted the environment. A runtime's proxying lives on the agent-level proxy config of the default
  agent; an explicit plain agent has none, so the hop is direct regardless of flags.
- **fetch hops** ([[remote-client]]'s CLI/backend requests to the resolved base, the peer leg,
  [[host-gateway]]'s reconciler probe of recorded backends, and evidence retrieval from the backend base)
  name a plain undici dispatcher for the one request when the target's host is loopback, leaving the global
  dispatcher — and with it the user's proxying for every non-loopback target — untouched. Requests to a
  remote `--api` endpoint or any external URL keep global behavior exactly. A source-scan test guards this
  half: no non-test source in the CLI may open a bare `fetch(` — a loopback hop must name the helper, so
  it cannot come back by forgetting.

Loopback means the host names this machine: `localhost`, the whole `127.0.0.0/8`, and `::1`. (`::ffff:`
dotted forms never arrive from a URL — whatwg normalizes them to hex — and are not recognized.) A runtime
without environment proxying is unaffected — a plain pool is what the default already was.
