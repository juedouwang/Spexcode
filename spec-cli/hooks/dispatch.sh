#!/usr/bin/env bash
# @@@ dispatch - the SINGLE hook entry point for ALL harness lifecycle events. The shim (.claude/settings.json
# / .codex/hooks.json, written by each [[harness-adapter]]) binds one line per event to
# `dispatch.sh <harness> <Event>` — the harness id is BAKED IN by the adapter that wrote the shim, so this is
# the deterministic harness DETECTOR for the shell side: we export SPEXCODE_HARNESS (read by harness.sh, the
# adapter's shell mirror, which the hook handlers source) without ever sniffing the payload shape. ONE job:
#   DISPATCH — run every handler bound to <Event> from the persistent manifest, in order, feeding each the
#   ORIGINAL stdin. Reproduces the native parallel multi-hook contract DETERMINISTICALLY: all handlers run
#   (side effects preserved), their stdout (decision/additionalContext) is folded into ONE payload, and a
#   block:true handler that exits 2 makes the dispatch exit 2 with that handler's stderr — the one signal
#   the harness propagates. Pure bash, no node boot on the hot path. cwd = the project/worktree. $SPEX (abs
#   tsx+cli) is inherited from the shim env.
#
# The old (1) GATE — an auto-materialize when the config content-hash moved — is RETIRED ([[commit-surgery]]):
# a harness event is never a materialize trigger; the materialize anchors are git-native only (spex verbs,
# session-worktree creation, and the pre-commit/post-checkout/post-merge hooks). .plugins edits are
# git-transactional: they take effect at the commit/checkout/merge that carries them, like any other source.
set -u
# args: `<harness> <Event>`. The harness id is explicit. `plugin` is the bundle form ([[plugin-harness]]),
# `opencode` the generated event-bus plugin
# ([[opencode-harness]]), `pi` the generated extension ([[pi-harness]]), and `zcode` the native adapter: all four
# carry Claude-shaped payloads (Claude tool names + file_path), so they join the claude branch in harness.sh via
# the default case — no parse arm of their own.
harness=claude
case "${1:-}" in claude|codex|opencode|pi|zcode|plugin) harness="$1"; shift ;; *)
  printf 'dispatch.sh: missing or unknown harness id\n' >&2
  exit 64
;; esac
event="${1:?usage: dispatch.sh <harness> <Event>}"
export SPEXCODE_HARNESS="$harness"
# the harness.sh path (the adapter's shell mirror) — sibling of this script; hook handlers source it, and we
# source it here too for hp_runtime_dir (the per-project store dir).
hook_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SPEXCODE_HARNESS_LIB="$hook_root/harness.sh"
. "$SPEXCODE_HARNESS_LIB"
proj="${CLAUDE_PROJECT_DIR:-$PWD}"
# the manifest lives in THIS tree's materialize slot of the GLOBAL per-project store (mirrors layout.treeSlotDir),
# NOT the worktree — and per tree, so a dispatch can only read the manifest of the tree it fires in
# ([[hook-dispatch]]). Slot key = this cwd's rev-parse --show-toplevel through hp_tree_dir. Empty if git
# can't resolve.
# resolved in THIS shell (not a subshell) so hp_resolve_dirs can export them to the handlers below
rt=""; slot=""
if cd "$proj" 2>/dev/null; then
  hp_resolve_dirs && { rt="$SPEXCODE_HP_RUNTIME_DIR"; slot="$SPEXCODE_HP_TREE_DIR"; }
  cd "$OLDPWD" || exit 1
fi

# A project transport can outlive the tree that installed it. The current tree's last successful materialize
# is the authority for whether its events are active. A tree without a published selection is inert.
allowed="$slot/harnesses"
if [ -f "$allowed" ]; then
  grep -Fxq "$harness" "$allowed" || exit 0
elif [ -f "$rt/harness-selection-v1" ]; then
  exit 0
fi

# --- dispatch ---------------------------------------------------------------------------------------------
manifest="${SPEX_HOOK_MANIFEST:-$slot/hooks-manifest}"
[ -f "$manifest" ] || { printf 'dispatch.sh: current tree has no hook manifest\n' >&2; exit 78; }
input="$(cat 2>/dev/null || true)"    # capture stdin ONCE; each handler gets its own copy
# @@@ the ledger - every handler run leaves two lines in <runtime>/hook-ledger/<day>.tsv: `start` before it
# runs and `done` after, so a run the harness killed mid-way is a start with no done rather than nothing. This
# is the ONLY place that sees every hook run on every event in every tree of the project, which is what makes
# the count exact: the dispatcher is not sampling, it is the thing that runs them. One appended line per
# write, far under a page, so concurrent sessions never interleave inside a line. A ledger that cannot be
# written is reported once on stderr and never changes the verdict; SPEX_HOOK_LEDGER=off silences it.
ledger=""
if [ "${SPEX_HOOK_LEDGER:-on}" != off ] && [ -n "$rt" ]; then
  ledger_dir="$rt/hook-ledger"
  printf -v ledger_day '%(%Y-%m-%d)T' -1
  { [ -d "$ledger_dir" ] || mkdir -p "$ledger_dir" 2>/dev/null; } && ledger="$ledger_dir/$ledger_day.tsv" \
    || printf 'dispatch.sh: hook ledger unwritable at %s\n' "$ledger_dir" >&2
fi
# the session column is the id the PAYLOAD names, raw — never the resolved SpexCode record id. Resolving that
# means store lookups, and each one spawns git ([[hook-ledger]]): two per dispatch on the hottest path in the
# product, paid on every tool call, to write a column no count needs. The hot path records what it was handed
# and the reader resolves aliases once, where it is free. Filled on the first handler, so an event with no
# bound handlers pays nothing at all.
ledger_session=unset
# builtins only (no subshell, no cut/tr/date): each fork is ~30ms under Git Bash and these run twice per handler
now_ms() { local v; if [ -n "${EPOCHREALTIME:-}" ]; then v=${EPOCHREALTIME/./}; printf -v "$1" '%s' "${v:0:13}"; else printf -v "$1" '%(%s)T000' -1; fi; }
# one TSV line: ts_ms phase session harness event hook order code block ms reason — reason flattened to one line
ledger_write() {
  [ -n "$ledger" ] || return 0
  [ "$ledger_session" != unset ] || ledger_session="$(hp_field "$input" session_id 2>/dev/null || true)"
  [ -n "$ledger_session" ] || ledger_session="${SPEXCODE_SESSION_ID:-}"
  local reason="${8//[$'\t\n\r']/ }"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$ledger_session" "$harness" "$event" "$3" "$4" "$5" "$6" "$7" \
    "${reason:0:300}" >>"$ledger" 2>/dev/null \
    || { printf 'dispatch.sh: hook ledger append failed: %s\n' "$ledger" >&2; ledger=""; }
}
err="/tmp/.spex-hook-$$.err"          # per-dispatch (pid-unique) stderr capture; no cross-session race
cleanup() { rm -f "$err"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
rc=0
# @@@ collect, then emit ONCE - handler stdout used to be written through the moment each handler returned.
# That is correct for the "at most one handler speaks JSON" arrangement the core hooks happen to have, and
# silently wrong the moment a second one does: two JSON documents end up concatenated, which is not a
# document with a losing field but an unparseable one, so BOTH decisions are lost. Collect instead, and fold
# at the end. The fold is only reached when two handlers actually emitted JSON, so the ordinary dispatch pays
# nothing for it. See [[dispatcher-runtime]].
outs=()
block_re='"decision"[[:space:]]*:[[:space:]]*"block"'
json_count=0
first_json=
# manifest line: event<TAB>order<TAB>block<TAB>script  (pre-sorted by event,order,script)
while IFS=$'\t' read -r ev order block script; do
  [ "$ev" = "$event" ] || continue
  handler="$proj/$script"
  hook_name="${script%/*}"; hook_name="${hook_name##*/}"   # the node is the script's own folder
  now_ms t0; ledger_write "$t0" start "$hook_name" "$order" "" "" "" ""
  out="$(printf '%s' "$input" | bash "$handler" 2>"$err")"; code=$?
  now_ms t1
  outs+=("$out")
  # cheap shape test only; the merger does the real parse. A handler whose stdout starts with `{` is claiming
  # to speak the structured contract.
  trimmed=${out#"${out%%[![:space:]]*}"}
  case "$trimmed" in
    '{'*) json_count=$((json_count + 1)); [ -n "$first_json" ] || first_json="$out" ;;
  esac
  blocked=0
  if [ "$block" = "true" ] && { [ "$code" = "2" ] || [[ $out =~ $block_re ]]; }; then
    blocked=1
    cat "$err" >&2
    # codex reads a Stop block's continuation prompt from STDERR (+ exit 2), NOT the claude-style
    # decision:block JSON a handler writes to stdout. So when we block on the JSON path under codex and the
    # handler left stderr empty, extract its "reason" and forward it to stderr — else codex sees exit 2 with
    # no stderr ("Stop hook exited with code 2 but did not write a continuation prompt"). Claude is unchanged
    # (it keeps reading the stdout JSON). The reason is the JSON's last field, so capture to the final `"}`.
    if [ "$SPEXCODE_HARNESS" = codex ] && [ ! -s "$err" ]; then
      printf '%s' "$out" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\(.*\)"[[:space:]]*}[[:space:]]*$/\1/p' \
        | sed 's/\\"/"/g; s/\\\\/\\/g' >&2
    fi
    rc=2
  fi
  # FAIL LOUD. A non-blocking handler's failure used to vanish completely: its exit code was dropped and its
  # stderr was overwritten by the next handler and deleted on exit, so a lifecycle hook that could not write
  # left NO trace anywhere — the board kept whatever state it last held and the reader had to guess whether
  # the hook had run at all. That silence is what let a whole fleet's mark-active and stop-gate die unnoticed.
  # Reporting is all this does: a non-blocking hook must not change the dispatch verdict, so `rc` stays the
  # blocking handlers' to set, and a noisy hook can never turn into a gate.
  if [ "$code" != 0 ] && [ "$block" != "true" ]; then
    printf 'dispatch.sh: %s handler %s exited %s\n' "$event" "$script" "$code" >&2
    [ -s "$err" ] && cat "$err" >&2
  fi
  # the reason of a refusal is what a reader will want later: the handler's stderr, else the JSON reason
  reason=""
  if [ "$blocked" = 1 ]; then
    reason="$(cat "$err" 2>/dev/null)"
    [ -n "$reason" ] || reason="$(printf '%s' "$out" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\(.*\)"[[:space:]]*}[[:space:]]*$/\1/p')"
  fi
  ledger_write "$t1" done "$hook_name" "$order" "$code" "$blocked" "$((t1 - t0))" "$reason"
done < "$manifest"

# ONE payload for the harness. Zero or one JSON document is exactly the old behaviour, byte for byte, and
# needs no CLI. Two or more must be folded, and folding JSON is not a job for shell — hand the parts to the
# CLI, which owns the merge rules. If the CLI cannot be reached in that case, emit the FIRST document alone
# and say so: a valid document that lost a handler is recoverable, an unparseable one loses every handler.
if [ "$json_count" -le 1 ]; then
  for out in ${outs[@]+"${outs[@]}"}; do [ -n "$out" ] && printf '%s' "$out"; done
else
  merged=""
  if [ -n "${SPEX:-}" ] || command -v spex >/dev/null 2>&1; then
    merged="$(printf '%s\0' "${outs[@]}" | ${SPEX:-spex} internal hook-merge 2>>"$err")" || merged=""
  fi
  if [ -n "$merged" ]; then
    printf '%s' "$merged"
  else
    printf 'dispatch.sh: %s had %s handlers emit JSON and the merge was unavailable; emitting the first only\n' \
      "$event" "$json_count" >&2
    printf '%s' "$first_json"
  fi
  [ -s "$err" ] && cat "$err" >&2
fi
exit "$rc"
