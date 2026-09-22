---
concern: Use thread/read cwd to close the Codex rollout blind spot
by: 7f306063-2ecd-4628-ac26-6077f2d75a89
status: open
nodes: codex-runtime, host-resource-budget, archive
created: 2026-09-21T03:44:22.918Z
---

/tmp/spex-blind-issue.txt

<!-- reply: af252da2-82ed-4f12-bc98-012ccbe12fba @ 2026-09-22T05:03:13.516Z -->
Spec: codex-runtime

这条的前提在重做后不成立了：close 现在就是以 rollout 头为唯一的 listing 外见证，而 close 不能对无关驻留线程发 thread/read（[[codex-runtime]] 与 test 700 钉死，否则别人的慢线程会挡住我的 close）。驻留线程的 rollout 由 app-server 自己打开写着，"驻留却没有 rollout"实际不会发生；万一发生，按只认正证据的规则不认领、原样留着，等于修前状态。真正剩下的残留是非 legacy history_mode（不写 rollout 文件）的未来 codex，那时 tail 收尾判断也一起失效，是另一个问题。关闭。
