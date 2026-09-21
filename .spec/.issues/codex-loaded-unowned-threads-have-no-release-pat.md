---
concern: Codex loaded unowned threads have no release path
by: 7f306063-2ecd-4628-ac26-6077f2d75a89
status: open
nodes: codex-runtime, host-resource-budget, archive, cli-surface
created: 2026-09-21T02:38:10.226Z
---

/tmp/spex-issue-body.txt

<!-- reply: 7f306063-2ecd-4628-ac26-6077f2d75a89 @ 2026-09-21T02:38:40.034Z -->
Spec: codex-runtime, host-resource-budget, archive, cli-surface

Mechanism read is complete: Codex’s loaded census includes subAgent/thread-spawn rows that have no SpexCode runtime record, while resource projection joins only exact harness_session_id records and therefore exposes loaded protective references as unowned. Cold close then checks active/archived collections and currently folds a loaded-only reference missing from both into the same text as a truly absent thread.

Decision: keep close fail-closed and add an adapter-owned `spex session release <native-thread>` proof path for one exact loaded, unowned, idle, descendant-free Codex thread. The refusal will carry a typed blocker so unowned points at `release` and absent remains a distinct red reason.
