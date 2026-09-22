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

<!-- reply: 7f306063-2ecd-4628-ac26-6077f2d75a89 @ 2026-09-21T17:41:04.091Z -->
Spec: codex-runtime, host-resource-budget, archive, cli-surface

Reimplemented from clean origin/main. Commits: a53557bd7 and 9e45f075d.

The adapter now distinguishes loaded-only children from truly absent members, releases only loaded-only children whose rollout parent belongs to the closing subtree, leaves foreign loaded references outside the close plan, and exposes exact-thread release. Parentless subagents fail closed; a completely missing rollout remains the documented blind spot because loaded/list returns ids only.

Verification: Codex harness 120/120, TypeScript, ESLint, CLI help tests, workspace build, and spec lint 0 errors. Review evidence: [[file:review.html]].

<!-- reply: af252da2-82ed-4f12-bc98-012ccbe12fba @ 2026-09-22T05:03:10.718Z -->
Spec: codex-runtime, host-resource-budget

由 af252da2 接手（旧会话 7f306063 的两版实现按 human 要求整个重置，不复用）。

**机制，一句话**：Codex 的 `thread/list` 对 `preview` 为空的行一律不列（codex-rs `state/runtime/threads.rs`，`threads.preview <> ''`；0.146.0 对所有 listing 含 lineage 过滤都加，0.153.4 只对 plain/cwd listing 加）。`thread_spawn` 出来的子代理可以从生到死没有 preview，于是它驻留、可读、但列不出来。0.146 上 close 看不见它 → 静默泄漏（本机 7 条"无主"里 01a0b293、01a0bff4 就是）；0.153（macmini）上 lineage 读把它列进 subtree、cwd 读却见证不到 → 永远拒绝。所谓"absent vs unowned"其实是同一根因的两个症状，那些线程一直都有主。

**修法**（只在 Codex adapter 内；没有新动词、没有 blocker 类型、没有 CLI/路由改动）：rollout 是 listing 给不了的见证。冷证明按 rollout 头的父链走驻留集合，父链通到本 subtree 的就是成员；scoped listing 不返回的成员用 rollout 见证（头里的 cwd、所在目录即 collection、尾部即收尾）；归档后与补偿按同一见证重读。只认正证据，驻留却没 rollout 的线程原样留着。删掉了全表兜底读。retirement 不扫驻留集合（spec 与 test 700 钉死 close 不 thread/read 无关线程）。resources 探针从同一 rollout 头读父线程，投影把子代理归到祖先所属 session——本机 7 条里 6 条已归位，剩下 01a0b293 的父 01a0b26c 没有记录（rebind 前驱线程的泄漏，另一件事）。

**三条判据**：复现——本机真实记录 921806b1 上算冷证明计划，main 只归档根、本分支把 01a0bff4 作为 unlisted 成员先归档；阴控——066c9149 / 7690d008 / 7f306063 计划前后一致，且 7f306063 已用本分支后端真实 `session close` 成功（线程归档卸载、记录 cold_proof、worktree 移除）；阳控——lineage 列出但 cwd 与 rollout 都见证不到的成员仍拒绝，措辞同时说明两件事。四格夹具：一次 close 归档自己的隐藏子线程、不碰别人的隐藏子线程、不发全表读、补偿一起 unarchive。

commit 8247227d4（+ ack 90d77e91a）；证据 `/home/jeffry/spexcode-evidence/codex-hidden-subagent-close-af25/hidden-subagent-close-review.html`。macmini 自然夹具（04987322 的 01a0beef/01a0bf58 归档、01a0bf13 留下、refCount 降 2）等 release 后按四格读。foreign sibling 中途消失导致补偿的竞态没动。
