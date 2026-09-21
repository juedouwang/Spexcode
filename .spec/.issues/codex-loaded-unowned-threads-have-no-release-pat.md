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

<!-- reply: 7f306063-2ecd-4628-ac26-6077f2d75a89 @ 2026-09-21T03:10:37.033Z -->
Spec: codex-runtime, host-resource-budget, archive, cli-surface, spec-cli

现场夹具已纳入实现边界：close 只释放 rollout parent 链落在本次 target subtree 的 loaded-only subagent；foreign loaded-only subagents remain protective siblings. The cold plan now carries the parent edge and a typed native membership distinction, and a loaded-only owned child is archived/released as part of the same cold close. A truly absent member remains a distinct blocker. The porcelain escape hatch `spex session release <native-thread>` is also wired through the adapter, backend route, client, CLI, and help for standalone loaded orphan recovery.

Local fixture proof now covers one target, one owned loaded-only child, and one foreign loaded-only child: the target and owned child are archived/unloaded while the foreign child remains loaded. Existing absent/duplicate/reassigned cold-proof cases still run against the changed model.

<!-- reply: 7f306063-2ecd-4628-ac26-6077f2d75a89 @ 2026-09-21T03:49:38.368Z -->
Spec: codex-runtime, host-resource-budget, archive, cli-surface, spec-cli

Committed as 6140739ea71a98ac3e00d9d979bab0f092c0f7fa.

The close plan now separates native membership and parent ownership. It auto-releases loaded-only descendants whose rollout parent is in the closing subtree, leaves foreign loaded-only siblings untouched and tolerant of independent disappearance, and rejects new unexplained sibling references. A true absent native member remains a distinct blocker. The exact-thread `spex session release <native-thread>` route proves owner-free, idle, descendant-free, generation-fenced release for standalone recovery. The current rollout-missing blind spot is recorded in [[use-thread-read-cwd-to-close-the-codex-rollout-b]].

Validation: Codex harness suite 121/121; TypeScript check; ESLint; CLI help tests; `spex spec lint` 0 errors (52 existing warnings); workspace build passed. The synthetic fixture covers owned and foreign loaded-only children in one close and verifies the foreign child remains loaded.

<!-- reply: 7f306063-2ecd-4628-ac26-6077f2d75a89 @ 2026-09-21T03:54:48.908Z -->
Spec: codex-runtime, host-resource-budget, archive, cli-surface, spec-cli

Implementation is committed in 6140739ea71a98ac3e00d9d979bab0f092c0f7fa and ready for merge. Review evidence: [[file:review.html]]. The separate rollout-missing cwd witness follow-up is [[use-thread-read-cwd-to-close-the-codex-rollout-b]].
