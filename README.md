<div align="center">

<img src="docs/banner.png" alt="SpexCode — Specs govern. Agents build." width="720">

<p>
  <a href="https://www.npmjs.com/package/spexcode"><img alt="npm" src="https://img.shields.io/npm/v/spexcode?logo=npm&logoColor=white&color=cb3837"></a>
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-2f81f7">
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2022-3fb950?logo=nodedotjs&logoColor=white">
  <a href="https://spexcode.net"><img alt="documentation" src="https://img.shields.io/badge/docs-spexcode.net-8957e5"></a>
</p>

English · [中文](docs/README.zh-CN.md)

</div>

SpexCode is a Git-backed spec tree and session manager for coding agents.

You define what the software should do, let agents work on it, and review their changes against that intent.

Each spec can point to the file or function it governs. When a later commit changes that target without updating the spec, SpexCode reports it for review. Sessions give agents isolated branches, worktrees, and a record of what they handed back.

A spec node is a `spec.md` under `.spec/`. Its `code:` field names the implementation:

```yaml
---
title: Webhook security
code:
  - src/ingest/webhookVerifier.ts#verifyWebhook
---
Only a push signed with the configured SHA-256 secret may change a release stream.
```

The `code:` line is the binding. When a later commit changes `verifyWebhook`, SpexCode can name the node that needs review instead of leaving the change buried in the history.

## Start from the agent you already use

You can try SpexCode from Claude Code or Codex before installing the CLI. The **atlas** plugin reads a repository, writes an initial spec tree, checks its diagrams and hands back one page you can open.

**Claude Code**

```sh
claude plugin marketplace add shuxueshuxue/spexcode-plugins
claude plugin install atlas@spexcode
```

**Codex**

```sh
codex plugin marketplace add shuxueshuxue/spexcode-plugins
codex plugin add atlas@spexcode
```

Then, inside any repository:

```text
Draw the spec atlas of this repository, and give me the page I can open.
```

The plugin uses `spex init --pure` for the first adoption: plain `.spec/` files in git, no hooks and no agent configuration. You can add the session layer later with the CLI below.

## A changed function becomes a review item

A later commit changes lines inside `verifyWebhook`. The test suite can still be green. SpexCode turns the commit into a named item for review:

<img src="docs/readme/term-spec-lint.svg" alt="spex spec lint reports anchor-drift on src/ingest/webhookVerifier.ts#verifyWebhook since spec webhook-security v3." width="900">

A change elsewhere in the file is advisory. A change inside `verifyWebhook` is blocking. SpexCode is not deciding whether the new verifier is better; it makes the exact function and commit impossible to lose in the review queue.

<img src="docs/readme/drift-history.svg" alt="Commit cbe53ee changes line 6 of webhookVerifier.ts, inside verifyWebhook (lines 5 to 13), after spec webhook-security v3; the overlap is anchor-drift." width="900">

The spec's last version opens the window. Every later commit is checked against the lines of the anchored function as they were at that commit. Any overlap is an error until the spec moves or someone signs off.

```sh
spex spec lint
```

With the installed hooks, an anchored hit rejects a new candidate commit. Update the spec with the code, or record why an implementation-only change still satisfies the contract:

```sh
git commit --trailer "Spec-OK: webhook-security"
```

For a change that is already committed:

```sh
spex spec ack webhook-security --reason "the contract still holds; this refactor preserves it"
```


## The product surface

<img src="docs/readme/product.png" alt="The SpexCode dashboard: a review session on the desktop and the webhook-security spec on a phone." width="900">

## Quick start from a shell

Requires **Node ≥ 22** and **git**.

```sh
npm i -g spexcode
cd your-repo
spex init --harness claude,codex,opencode,pi,zcode,claude-headless,opencode-headless,pi-headless,codex-headless
```

The example lists every built-in harness; keep the ones you use (any one id or a comma-separated subset). `spex init` seeds the spec tree, installs hooks and materializes workflow instructions into the files your agent already reads. Existing configuration is preserved; `spex uninstall` removes SpexCode's additions.

<details>
<summary><strong>Adopt less</strong></summary>

| Command | Result |
| :--- | :--- |
| `spex init --pure` | Root spec and project config; no hooks. |
| `spex init --harness none` | Spec workflow and hooks; no agent configuration. |
| `spex init --harness …` | Spec workflow plus instructions for selected agents. |

Add `--title "Your Project"` to name the root spec and dashboard.

</details>

<details>
<summary><strong>Run isolated sessions</strong></summary>

Session management requires **tmux**; on Windows use **WSL2**.

```sh
spex session new "[[webhook-security]] verify signatures behind a reverse proxy"
spex session ls
spex session review <session-id>
spex session merge <session-id>
```

Workers propose. You decide when to request the gated merge.

</details>

<details>
<summary><strong>Open the dashboard</strong></summary>

```sh
npm i -g @spexcode/spec-dashboard
spex serve
spex dashboard
```

Each project has a backend; one dashboard serves all projects on the machine. Spec, session and terminal views have shareable URLs.

</details>

## Three layers

<img src="docs/readme/layers.svg" alt="Three layers: L0 the spec-code graph in git, L1 agent sessions in isolated worktrees on top of it, L2 the dashboard reading L1." width="900">

SpexCode does not supply a coding model or decide whether a change is correct. It records intent, measures code movement against that intent, and gives the resulting work a place to be reviewed.

[Setup guide](https://spexcode.net/getting-started/) · [Working with agents](https://spexcode.net/working-with-agents/) · [Contributing](docs/CONTRIBUTING.md)

First introduced on [LINUX DO](https://linux.do). Licensed under [MIT](LICENSE).
