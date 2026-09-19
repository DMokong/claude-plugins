#!/usr/bin/env bash
# tests/herdr-jutsu/run.sh — behavioral suite for jutsu-spawn.sh, against a STUB herdr.
#
# Plain bash, no framework — stays inside the bash 3.2 subset (indexed arrays only; no
# bash-4-only builtins or parameter-expansion forms). Each test runs in its own
# `mktemp -d` scratch repo/HOME/registry. Every test
# name/comment carries the finding id (H3, H4, M1, ...) and/or spec AC id (AC-13, ...) it
# proves. Those ids are labels from the review and acceptance list that drove this suite;
# the behaviour each one stands for is spelled out in the comment above its cases.
#
# SAFETY: this script must NEVER let jutsu-spawn.sh see the real herdr. It asserts the
# stub is first on PATH before running any case, and only ever invokes the real `herdr`
# (outside PATH override) for nothing — read-only discovery already happened by hand
# while writing this suite, not at runtime here.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SPAWN="$REPO_ROOT/plugins/herdr-jutsu/skills/herdr-jutsu/scripts/jutsu-spawn.sh"
STUB_DIR="$HERE/stub"

PASS=0
FAIL=0
CURRENT_TEST=""
ORIGINAL_PATH="$PATH"

ok() {
  PASS=$((PASS + 1))
  echo "ok $1"
}

not_ok() {
  FAIL=$((FAIL + 1))
  echo "not ok $1: $2"
}

fail_case() {
  not_ok "$CURRENT_TEST" "$1"
}

# --- SAFETY gate: herdr on PATH must resolve inside the stub dir before any case runs ---
assert_stub_on_path() {
  local resolved
  export PATH="$STUB_DIR:$PATH"
  resolved="$(command -v herdr 2>/dev/null || true)"
  case "$resolved" in
    "$STUB_DIR"/*) ;;
    *)
      echo "FATAL: herdr on PATH resolves to '${resolved:-<not found>}', not $STUB_DIR — refusing to run any case" >&2
      exit 99
      ;;
  esac
}
assert_stub_on_path

if [ ! -x "$SPAWN" ]; then
  echo "FATAL: jutsu-spawn.sh not found or not executable at $SPAWN" >&2
  exit 99
fi

# --- scratch-case plumbing -------------------------------------------------------------

SCRATCH=""
REPO_DIR=""

setup_case() {
  SCRATCH="$(mktemp -d)"
  REPO_DIR="$SCRATCH/repo"
  mkdir -p "$REPO_DIR"
  git -C "$REPO_DIR" init -q
  git -C "$REPO_DIR" -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m init

  STUB_LOG="$SCRATCH/stub.log"
  : >"$STUB_LOG"
  export STUB_LOG
  STUB_HERDR_JSON_LOG="$SCRATCH/herdr.jsonl"
  : >"$STUB_HERDR_JSON_LOG"
  export STUB_HERDR_JSON_LOG
  STUB_CODEX_LOG="$SCRATCH/codex.log"
  : >"$STUB_CODEX_LOG"
  export STUB_CODEX_LOG

  unset JUTSU_STATE_DIR XDG_STATE_HOME STUB_FAIL STUB_AGENT_START_ERROR STUB_VERSION \
    STUB_PROCESS_INFO STUB_AGENTS STUB_PANE_LABEL STUB_PANE_CWD STUB_AGENT_LIST_EPERM \
    STUB_CODEX_DECISION STUB_CODEX_RULES_OVERRIDE_SET STUB_CODEX_RULES_OVERRIDE \
    STUB_AGENT_START_HOLD_NAME STUB_AGENT_START_READY STUB_AGENT_START_RELEASE \
    STUB_AGENT_START_ERROR_NAME \
    STUB_INTERRUPT_MKDIR_TARGET STUB_INTERRUPT_MKDIR_READY JUTSU_POLICY_LOCK_TIMEOUT_MS \
    CODEX_SANDBOX 2>/dev/null

  export HOME="$SCRATCH/home"
  mkdir -p "$HOME"
  export PATH="$STUB_DIR:$REPO_ROOT_ORIG_PATH"
  export HERDR_ENV=1
  export HERDR_PANE_ID="w0:p1"
  export HERDR_WORKSPACE_ID="w0"

  OUT_FILE="$SCRATCH/out.json"
  ERR_FILE="$SCRATCH/err.json"
}

teardown_case() {
  [ -n "$SCRATCH" ] || return 0
  chmod -R u+rwx "$SCRATCH" 2>/dev/null || true
  rm -rf "$SCRATCH" 2>/dev/null || true
}

REPO_ROOT_ORIG_PATH="$ORIGINAL_PATH"

run_spawn() {
  : >"$OUT_FILE"
  : >"$ERR_FILE"
  "$SPAWN" "$@" >"$OUT_FILE" 2>"$ERR_FILE"
  CODE=$?
}

stat_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

stderr_error_code() {
  jq -r '.error.code // empty' "$ERR_FILE" 2>/dev/null | head -n1
}

stdout_field() {
  jq -r "$1 // empty" "$OUT_FILE" 2>/dev/null
}

# "nothing was created" as an ALLOWLIST over the stub log: prints the first logged herdr
# invocation that is not one of the read-only calls the brief's SAFETY section permits
# (`herdr --version`, `pane process-info`, `pane get`, `agent list`, `agent get`, any
# `--help` — exactly the list in the brief's SAFETY section). Strictly stronger than
# blacklisting the five nouns: any invocation that is not provably read-only fails,
# including ones that begin with no noun at all.
nonreadonly_stub_call() {
  grep -vE '^(--version|--help|-h|pane get( |$)|pane process-info( |$)|agent list( |$)|agent get( |$))' "$STUB_LOG" 2>/dev/null | head -n1
}

# =========================================================================================
# AC-13 / H3 — EXIT trap: resource tracking + cleanup on failure after creation.
# =========================================================================================

test_ac13_pane_closed_on_failure_after_split() {
  CURRENT_TEST="ac13_pane_closed_on_failure_after_split"
  setup_case
  STUB_FAIL="pane rename"
  export STUB_FAIL
  run_spawn --name ac13a --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -ne 0 ] || { fail_case "expected nonzero exit when pane rename fails after split, got 0"; teardown_case; return; }
  local pane_id
  pane_id="$(grep -m1 '^pane rename ' "$STUB_LOG" | awk '{print $3}')"
  [ -n "$pane_id" ] || { fail_case "no 'pane rename' call was logged; cannot identify the created pane"; teardown_case; return; }
  grep -q "^pane close $pane_id\$" "$STUB_LOG" || { fail_case "STUB_LOG has no 'pane close $pane_id' after the injected failure: $(cat "$STUB_LOG")"; teardown_case; return; }
  [ -n "$(stderr_error_code)" ] || { fail_case "stderr is not jq-parseable JSON with .error.code: $(cat "$ERR_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac13_worktree_orphaned_never_removed() {
  CURRENT_TEST="ac13_worktree_orphaned_never_removed"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  STUB_FAIL="tab rename"
  export STUB_FAIL
  run_spawn --name ac13b-role --kind shell --cwd "$REPO_DIR" --worktree ac13b-branch
  [ "$CODE" -ne 0 ] || { fail_case "expected nonzero exit when tab rename fails after worktree create, got 0"; teardown_case; return; }

  grep -q '"recovery"' "$ERR_FILE" || { fail_case "no recovery JSON line on stderr: $(cat "$ERR_FILE")"; teardown_case; return; }
  local recovery_line wt_path
  recovery_line="$(grep -m1 '"recovery"' "$ERR_FILE")"
  echo "$recovery_line" | jq -e '.recovery.status == "orphaned"' >/dev/null 2>&1 \
    || { fail_case "recovery JSON does not have .recovery.status == orphaned: $recovery_line"; teardown_case; return; }
  wt_path="$(echo "$recovery_line" | jq -r '.recovery.worktree // empty')"
  [ -n "$wt_path" ] || { fail_case "recovery JSON has no .recovery.worktree path: $recovery_line"; teardown_case; return; }
  [ -d "$wt_path" ] || { fail_case "worktree path from recovery JSON does not exist on disk: $wt_path"; teardown_case; return; }
  git -C "$REPO_DIR" worktree list | grep -qF "$wt_path" \
    || { fail_case "git worktree list (in $REPO_DIR) does not show $wt_path"; teardown_case; return; }
  grep -q 'worktree remove' "$STUB_LOG" && { fail_case "STUB_LOG shows 'worktree remove' — a worktree must never be auto-removed: $(cat "$STUB_LOG")"; teardown_case; return; }

  [ -d "$JUTSU_STATE_DIR" ] || { fail_case "registry dir $JUTSU_STATE_DIR was not created even though registry should still be written"; teardown_case; return; }
  local regfile last_status
  regfile="$(find "$JUTSU_STATE_DIR" -name '*.jsonl' | head -n1)"
  [ -n "$regfile" ] || { fail_case "no registry .jsonl file found under $JUTSU_STATE_DIR"; teardown_case; return; }
  last_status="$(tail -n1 "$regfile" | jq -r '.status // empty' 2>/dev/null)"
  [ "$last_status" = "orphaned" ] || { fail_case "registry row status is '$last_status', expected 'orphaned': $(tail -n1 "$regfile")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac13_in_pane_never_closed_rename_reverted() {
  CURRENT_TEST="ac13_in_pane_never_closed_rename_reverted"
  setup_case
  export STUB_PANE_LABEL="original-shell-label"
  export STUB_AGENT_START_ERROR="agent_launch_exploded"
  run_spawn --name ac13c --kind claude --cwd "$REPO_DIR" --in-pane w0:p9
  [ "$CODE" -ne 0 ] || { fail_case "expected nonzero exit when agent start fails in an --in-pane run, got 0"; teardown_case; return; }
  grep -q '^pane close w0:p9$' "$STUB_LOG" && { fail_case "an --in-pane pane must never be closed by the trap, but STUB_LOG shows 'pane close w0:p9': $(cat "$STUB_LOG")"; teardown_case; return; }
  local rename_calls last_rename
  rename_calls="$(grep -c '^pane rename w0:p9' "$STUB_LOG")"
  [ "$rename_calls" -ge 2 ] || { fail_case "expected at least 2 'pane rename w0:p9' calls (apply + revert), got $rename_calls: $(cat "$STUB_LOG")"; teardown_case; return; }
  last_rename="$(grep '^pane rename w0:p9' "$STUB_LOG" | tail -n1)"
  case "$last_rename" in
    *original-shell-label*) ;;
    *) fail_case "the revert rename did not restore the original label 'original-shell-label': $last_rename"; teardown_case; return ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-14 / H4 — --in-pane occupancy check.
# =========================================================================================

test_ac14_in_pane_refuses_vim_foreground() {
  CURRENT_TEST="ac14_in_pane_refuses_vim_foreground"
  setup_case
  export STUB_PROCESS_INFO='{"result":{"process_info":{"foreground_process_group_id":1,"foreground_processes":[{"argv":["vim","f.txt"],"argv0":"vim","cmdline":"vim f.txt","cwd":"/tmp","name":"vim","pid":9}],"pane_id":"w0:p9","shell_pid":9}}}'
  run_spawn --name ac14a --kind shell --cwd "$REPO_DIR" --in-pane w0:p9
  [ "$CODE" -eq 5 ] || { fail_case "expected exit 5 (refused) for a vim-occupied pane, got $CODE"; teardown_case; return; }
  [ "$(stderr_error_code)" = "pane_not_idle_shell" ] || { fail_case "expected .error.code pane_not_idle_shell, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q 'pane rename' "$STUB_LOG" && { fail_case "must refuse before any pane rename; STUB_LOG: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac14_in_pane_refuses_agent_occupied() {
  CURRENT_TEST="ac14_in_pane_refuses_agent_occupied"
  setup_case
  export STUB_AGENTS='{"result":{"agents":[{"name":"someone","kind":"claude","pane_id":"w0:p9","agent_status":"idle"}]}}'
  run_spawn --name ac14b --kind shell --cwd "$REPO_DIR" --in-pane w0:p9
  [ "$CODE" -eq 5 ] || { fail_case "expected exit 5 for a pane already occupied by a live agent, got $CODE"; teardown_case; return; }
  [ "$(stderr_error_code)" = "pane_not_idle_shell" ] || { fail_case "expected .error.code pane_not_idle_shell, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q 'pane rename' "$STUB_LOG" && { fail_case "must refuse before any pane rename; STUB_LOG: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac14_in_pane_refuses_unparseable_process_info() {
  CURRENT_TEST="ac14_in_pane_refuses_unparseable_process_info"
  setup_case
  export STUB_PROCESS_INFO='not json at all, this is garbage <<<'
  run_spawn --name ac14c --kind shell --cwd "$REPO_DIR" --in-pane w0:p9
  [ "$CODE" -eq 5 ] || { fail_case "expected exit 5 when process-info is unparseable, got $CODE"; teardown_case; return; }
  [ "$(stderr_error_code)" = "pane_not_idle_shell" ] || { fail_case "expected .error.code pane_not_idle_shell, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q 'pane rename' "$STUB_LOG" && { fail_case "must refuse before any pane rename; STUB_LOG: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac14_in_pane_accepts_idle_shell() {
  CURRENT_TEST="ac14_in_pane_accepts_idle_shell"
  setup_case
  # default STUB_PROCESS_INFO (idle zsh) and default STUB_AGENTS (empty) apply.
  run_spawn --name ac14d --kind shell --cwd "$REPO_DIR" --in-pane w0:p9
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 for a demonstrably idle shell pane, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^pane rename w0:p9' "$STUB_LOG" || { fail_case "expected 'pane rename w0:p9' to have been called: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-15 / M1 / L2 — agent start error branching, arity, jq-built error JSON.
# =========================================================================================

test_ac15_agent_not_ready_retained_exit3() {
  CURRENT_TEST="ac15_agent_not_ready_retained_exit3"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  export STUB_AGENT_START_ERROR="agent_not_ready"
  run_spawn --name ac15a --kind claude --cwd "$REPO_DIR"
  [ "$CODE" -eq 3 ] || { fail_case "expected exit 3 for agent_not_ready, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^pane close' "$STUB_LOG" && { fail_case "agent_not_ready must retain (not close) the pane: $(cat "$STUB_LOG")"; teardown_case; return; }
  local regfile last_status
  regfile="$(find "$JUTSU_STATE_DIR" -name '*.jsonl' 2>/dev/null | head -n1)"
  [ -n "$regfile" ] || { fail_case "no registry file written even though the member should be retained+registered"; teardown_case; return; }
  last_status="$(tail -n1 "$regfile" | jq -r '.status // empty' 2>/dev/null)"
  [ "$last_status" = "agent_not_ready" ] || { fail_case "registry row status is '$last_status', expected 'agent_not_ready'"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac15_other_start_error_cleaned_up_exit1() {
  CURRENT_TEST="ac15_other_start_error_cleaned_up_exit1"
  setup_case
  export STUB_AGENT_START_ERROR="invalid_arguments"
  run_spawn --name ac15b --kind claude --cwd "$REPO_DIR"
  [ "$CODE" -eq 1 ] || { fail_case "expected exit 1 for a non-agent_not_ready start error, got $CODE"; teardown_case; return; }
  [ "$(stderr_error_code)" = "agent_start_failed" ] || { fail_case "expected .error.code agent_start_failed, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q 'invalid_arguments' "$ERR_FILE" || { fail_case "error message should name the upstream code invalid_arguments: $(cat "$ERR_FILE")"; teardown_case; return; }
  local pane_id
  pane_id="$(grep -m1 '^pane rename ' "$STUB_LOG" | awk '{print $3}')"
  [ -n "$pane_id" ] || { fail_case "no pane was renamed; cannot verify cleanup"; teardown_case; return; }
  grep -q "^pane close $pane_id\$" "$STUB_LOG" || { fail_case "expected 'pane close $pane_id' cleanup for a non-agent_not_ready error: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

VALUE_OPTIONS="--name --kind --where --worktree --base --in-pane --beside --direction --ratio --cwd --stream --issue --cmd --timeout"

test_ac15_missing_value_for_every_option() {
  CURRENT_TEST="ac15_missing_value_for_every_option"
  setup_case
  local opt
  for opt in $VALUE_OPTIONS; do
    run_spawn --name arity-probe --kind shell --cwd "$REPO_DIR" "$opt"
    if [ "$CODE" -ne 2 ]; then
      fail_case "option $opt with a missing value: expected exit 2, got $CODE: $(cat "$ERR_FILE")"
      teardown_case
      return
    fi
    if [ "$(stderr_error_code)" != "missing_argument" ]; then
      fail_case "option $opt with a missing value: expected .error.code missing_argument, got '$(stderr_error_code)': $(cat "$ERR_FILE")"
      teardown_case
      return
    fi
    if grep -qi 'unbound variable' "$ERR_FILE"; then
      fail_case "option $opt with a missing value leaked a raw bash 'unbound variable' error instead of JSON: $(cat "$ERR_FILE")"
      teardown_case
      return
    fi
  done
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac15_unknown_option_rejected() {
  CURRENT_TEST="ac15_unknown_option_rejected"
  setup_case
  run_spawn --name ac15d --kind shell --cwd "$REPO_DIR" --this-flag-does-not-exist
  [ "$CODE" -eq 2 ] || { fail_case "expected exit 2 for an unknown option, got $CODE"; teardown_case; return; }
  [ "$(stderr_error_code)" = "unknown_option" ] || { fail_case "expected .error.code unknown_option, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-16 / M2 — Claude dangerous flags need an override; isolated Codex uses an allowlist.
# =========================================================================================

test_ac16_claude_dangerous_flags_refused() {
  CURRENT_TEST="ac16_claude_dangerous_flags_refused"
  setup_case
  local flag_args
  local i=0
  # Each entry is one full "-- ..." tail to try.
  local FORMS=(
    "--dangerously-skip-permissions"
    "--allow-dangerously-skip-permissions"
    "--permission-mode bypassPermissions"
    "--permission-mode dontAsk"
    "--permission-mode=bypassPermissions"
    "--permission-mode=dontAsk"
  )
  for flag_args in "${FORMS[@]}"; do
    i=$((i + 1))
    run_spawn --name "ac16c$i" --kind claude --cwd "$REPO_DIR" -- $flag_args
    if [ "$CODE" -ne 5 ]; then
      fail_case "claude flag form '$flag_args': expected exit 5, got $CODE: $(cat "$ERR_FILE")"
      teardown_case
      return
    fi
    if [ "$(stderr_error_code)" != "dangerous_agent_flag" ]; then
      fail_case "claude flag form '$flag_args': expected .error.code dangerous_agent_flag, got '$(stderr_error_code)': $(cat "$ERR_FILE")"
      teardown_case
      return
    fi
    if grep -q '^agent start' "$STUB_LOG"; then
      fail_case "claude flag form '$flag_args': agent start must never be invoked when a dangerous flag is refused: $(cat "$STUB_LOG")"
      teardown_case
      return
    fi
  done
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac16_codex_dangerous_flags_refused() {
  CURRENT_TEST="ac16_codex_dangerous_flags_refused"
  setup_case
  local flag_args
  local i=0 expected
  local FORMS=(
    "--dangerously-bypass-approvals-and-sandbox"
    "--yolo"
    "-s danger-full-access"
    "--sandbox danger-full-access"
    "-c sandbox_mode=danger-full-access"
    "--config sandbox_mode=danger-full-access"
  )
  for flag_args in "${FORMS[@]}"; do
    i=$((i + 1))
    run_spawn --name "ac16x$i" --kind codex --cwd "$REPO_DIR" -- $flag_args
    if [ "$CODE" -ne 5 ]; then
      fail_case "codex flag form '$flag_args': expected exit 5, got $CODE: $(cat "$ERR_FILE")"
      teardown_case
      return
    fi
    expected=isolation_unsupported_agent_arg
    if [ "$(stderr_error_code)" != "$expected" ]; then
      fail_case "codex flag form '$flag_args': expected .error.code $expected, got '$(stderr_error_code)': $(cat "$ERR_FILE")"
      teardown_case
      return
    fi
    if grep -q '^agent start' "$STUB_LOG"; then
      fail_case "codex flag form '$flag_args': agent start must never be invoked when a dangerous flag is refused: $(cat "$STUB_LOG")"
      teardown_case
      return
    fi
  done
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac16_override_accepted_and_recorded() {
  CURRENT_TEST="ac16_override_accepted_and_recorded"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  run_spawn --name ac16ov --kind claude --cwd "$REPO_DIR" --allow-dangerous-agent-flags -- --dangerously-skip-permissions
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 when the dangerous-flag override is given, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^agent start' "$STUB_LOG" || { fail_case "expected agent start to run with the override: $(cat "$STUB_LOG")"; teardown_case; return; }
  local override
  override="$(stdout_field '.dangerous_override')"
  [ "$override" = "true" ] || { fail_case "expected stdout JSON .dangerous_override == true, got '$override': $(cat "$OUT_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-17 / M3 / R1 — registry perms + sandbox fallback (home vs workspace vs none).
# =========================================================================================

test_ac17_registry_modes_0700_0600() {
  CURRENT_TEST="ac17_registry_modes_0700_0600"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  run_spawn --name ac17a --kind shell --cwd "$REPO_DIR" --stream ac17a
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ -d "$JUTSU_STATE_DIR" ] || { fail_case "registry dir $JUTSU_STATE_DIR was not created"; teardown_case; return; }
  local dmode fmode regfile
  dmode="$(stat_mode "$JUTSU_STATE_DIR")"
  [ "$dmode" = "700" ] || { fail_case "registry dir mode is $dmode, expected 700"; teardown_case; return; }
  regfile="$(find "$JUTSU_STATE_DIR" -name '*.jsonl' | head -n1)"
  [ -n "$regfile" ] || { fail_case "no registry .jsonl found under $JUTSU_STATE_DIR"; teardown_case; return; }
  fmode="$(stat_mode "$regfile")"
  [ "$fmode" = "600" ] || { fail_case "registry file mode is $fmode, expected 600"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac17_sandbox_readonly_registry_none() {
  CURRENT_TEST="ac17_sandbox_readonly_registry_none"
  setup_case
  chmod 555 "$HOME"
  chmod 555 "$REPO_DIR"
  run_spawn --name ac17b --kind shell --cwd "$REPO_DIR"
  local code="$CODE"
  chmod 755 "$REPO_DIR"
  chmod 755 "$HOME"
  [ "$code" -eq 0 ] || { fail_case "expected spawn to still succeed with registry degraded to none, got exit $code: $(cat "$ERR_FILE")"; teardown_case; return; }
  local registry_field
  registry_field="$(stdout_field '.registry')"
  [ "$registry_field" = "none" ] || { fail_case "expected stdout .registry == none, got '$registry_field': $(cat "$OUT_FILE")"; teardown_case; return; }
  grep -q 'registry_unavailable' "$ERR_FILE" || { fail_case "expected a registry_unavailable warning on stderr: $(cat "$ERR_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac17_sandbox_workspace_write_registry_workspace() {
  CURRENT_TEST="ac17_sandbox_workspace_write_registry_workspace"
  setup_case
  chmod 555 "$HOME"
  run_spawn --name ac17c --kind shell --cwd "$REPO_DIR" --stream ac17c
  local code="$CODE"
  chmod 755 "$HOME"
  [ "$code" -eq 0 ] || { fail_case "expected spawn to succeed with the workspace-local registry fallback, got exit $code: $(cat "$ERR_FILE")"; teardown_case; return; }
  local registry_field
  registry_field="$(stdout_field '.registry')"
  [ "$registry_field" = "workspace" ] || { fail_case "expected stdout .registry == workspace, got '$registry_field': $(cat "$OUT_FILE")"; teardown_case; return; }
  [ -f "$REPO_DIR/.jutsu/state/ac17c.jsonl" ] || { fail_case "expected the registry row at $REPO_DIR/.jutsu/state/ac17c.jsonl"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-18 / M4 / M5 / M3(redaction) — agent_args array, resume_args, redaction, --stream.
# =========================================================================================

test_ac18_agent_args_roundtrip_as_json_array() {
  CURRENT_TEST="ac18_agent_args_roundtrip_as_json_array"
  setup_case
  run_spawn --name ac18a --kind claude --cwd "$REPO_DIR" -- --append-system-prompt "two words" ""
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local len el0 el1 el2
  len="$(stdout_field '.agent_args | length')"
  [ "$len" = "3" ] || { fail_case "expected agent_args to be a 3-element array, got length '$len': $(cat "$OUT_FILE")"; teardown_case; return; }
  el0="$(jq -r '.agent_args[0]' "$OUT_FILE")"
  el1="$(jq -r '.agent_args[1]' "$OUT_FILE")"
  el2="$(jq -r '.agent_args[2]' "$OUT_FILE")"
  [ "$el0" = "--append-system-prompt" ] || { fail_case "agent_args[0] = '$el0', expected --append-system-prompt"; teardown_case; return; }
  [ "$el1" = "two words" ] || { fail_case "agent_args[1] = '$el1', expected 'two words' (space preserved)"; teardown_case; return; }
  [ "$el2" = "" ] || { fail_case "agent_args[2] = '$el2', expected empty string preserved"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac18_resume_args_per_kind() {
  CURRENT_TEST="ac18_resume_args_per_kind"
  setup_case
  run_spawn --name ac18b --kind claude --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "claude spawn: expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local sid resume
  sid="$(stdout_field '.session_id')"
  [ -n "$sid" ] || { fail_case "claude spawn produced no session_id"; teardown_case; return; }
  resume="$(jq -c '.resume_args' "$OUT_FILE" 2>/dev/null)"
  [ "$resume" = "[\"--resume\",\"$sid\"]" ] || { fail_case "claude resume_args = $resume, expected [\"--resume\",\"$sid\"]"; teardown_case; return; }

  run_spawn --name ac18c --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "codex spawn: expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  sid="$(stdout_field '.session_id')"
  [ -n "$sid" ] || { fail_case "codex spawn produced no session_id"; teardown_case; return; }
  resume="$(jq -c '.resume_args' "$OUT_FILE" 2>/dev/null)"
  [ "$resume" = "[\"resume\",\"$sid\"]" ] || { fail_case "codex resume_args = $resume, expected [\"resume\",\"$sid\"]"; teardown_case; return; }

  run_spawn --name ac18d --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "shell spawn: expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  resume="$(jq -c '.resume_args' "$OUT_FILE" 2>/dev/null)"
  [ "$resume" = "[]" ] || { fail_case "shell resume_args = $resume, expected [] (no session id, kind shell)"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac18_redaction_in_output_not_in_real_argv() {
  CURRENT_TEST="ac18_redaction_in_output_not_in_real_argv"
  setup_case
  run_spawn --name ac18e --kind claude --cwd "$REPO_DIR" -- --api-key SECRET123 --token=SECRET456
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local args_json
  args_json="$(jq -c '.agent_args' "$OUT_FILE")"
  case "$args_json" in
    *SECRET123*) fail_case "SECRET123 leaked into the registry/output agent_args: $args_json"; teardown_case; return ;;
  esac
  case "$args_json" in
    *SECRET456*) fail_case "SECRET456 leaked into the registry/output agent_args: $args_json"; teardown_case; return ;;
  esac
  case "$args_json" in
    *'<redacted>'*) ;;
    *) fail_case "expected '<redacted>' placeholders in agent_args: $args_json"; teardown_case; return ;;
  esac
  grep -q 'SECRET123' "$STUB_LOG" || { fail_case "the real agent start call must still receive SECRET123 (only the registry/output copy is redacted): $(cat "$STUB_LOG")"; teardown_case; return; }
  grep -q 'SECRET456' "$STUB_LOG" || { fail_case "the real agent start call must still receive SECRET456: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac18_stream_rejects_path_traversal_and_slash() {
  CURRENT_TEST="ac18_stream_rejects_path_traversal_and_slash"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  run_spawn --name ac18f --kind shell --cwd "$REPO_DIR" --stream "../x"
  if [ "$CODE" -eq 0 ]; then fail_case "--stream '../x' must be refused, got exit 0"; teardown_case; return; fi
  [ "$(stderr_error_code)" = "unsafe_registry_path" ] || { fail_case "--stream '../x': expected .error.code unsafe_registry_path, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  [ ! -e "$SCRATCH/x.jsonl" ] || { fail_case "--stream '../x' wrote outside the registry dir: $SCRATCH/x.jsonl exists"; teardown_case; return; }

  run_spawn --name ac18g --kind shell --cwd "$REPO_DIR" --stream "a/b"
  if [ "$CODE" -eq 0 ]; then fail_case "--stream 'a/b' must be refused, got exit 0"; teardown_case; return; fi
  [ "$(stderr_error_code)" = "unsafe_registry_path" ] || { fail_case "--stream 'a/b': expected .error.code unsafe_registry_path, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac18_registry_symlink_refused() {
  CURRENT_TEST="ac18_registry_symlink_refused"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  mkdir -p "$JUTSU_STATE_DIR"
  local target="$SCRATCH/elsewhere.jsonl"
  ln -s "$target" "$JUTSU_STATE_DIR/ac18h.jsonl"
  run_spawn --name ac18h-role --kind shell --cwd "$REPO_DIR" --stream ac18h
  if [ "$CODE" -eq 0 ]; then fail_case "a pre-existing symlink registry file must be refused, got exit 0"; teardown_case; return; fi
  [ "$(stderr_error_code)" = "unsafe_registry_path" ] || { fail_case "expected .error.code unsafe_registry_path, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  [ ! -e "$target" ] || { fail_case "the symlink target $target was written through the link: $(cat "$target" 2>/dev/null)"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-19 / R2 — preflight.
# =========================================================================================

test_ac19_preflight_flag_reports_ok() {
  CURRENT_TEST="ac19_preflight_flag_reports_ok"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  run_spawn --preflight --name ac19a --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 for a passing --preflight, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local ok_field ver_field reg_field
  ok_field="$(stdout_field '.ok')"
  ver_field="$(stdout_field '.herdr_version')"
  reg_field="$(stdout_field '.registry')"
  [ "$ok_field" = "true" ] || { fail_case "expected .ok == true, got '$ok_field': $(cat "$OUT_FILE")"; teardown_case; return; }
  [ -n "$ver_field" ] || { fail_case "expected .herdr_version present: $(cat "$OUT_FILE")"; teardown_case; return; }
  case "$reg_field" in home|workspace|none) ;; *) fail_case "expected .registry in home|workspace|none, got '$reg_field'"; teardown_case; return ;; esac
  local stray
  stray="$(nonreadonly_stub_call)"
  [ -z "$stray" ] || { fail_case "--preflight must create nothing; STUB_LOG shows a call that is not read-only: $stray"; teardown_case; return; }
  # ...and the session-state checks the brief lists as preflight checks must have run:
  grep -qE '^agent list( |$)' "$STUB_LOG" || { fail_case "--preflight must run the name-not-already-live check and the parent lookup (herdr agent list); STUB_LOG: $(cat "$STUB_LOG")"; teardown_case; return; }
  # NB: jq's `// empty` swallows `false`, so this reads the field with an explicit test.
  jq -e '.name_in_use == false' "$OUT_FILE" >/dev/null 2>&1 || { fail_case "expected .name_in_use == false in the --preflight line: $(cat "$OUT_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# Brief item 2 lists "name not already live" and "the parent lookup" among the preflight
# checks; --preflight must run them (read-only) and report, not defer them.
test_ac19_preflight_runs_name_and_parent_checks() {
  CURRENT_TEST="ac19_preflight_runs_name_and_parent_checks"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  export STUB_AGENTS='{"result":{"agents":[{"name":"ac19d","kind":"claude","pane_id":"w0:p7","agent_status":"idle"},{"name":"the-parent","kind":"claude","pane_id":"w0:p1","agent_status":"idle"}]}}'
  # (a) the parent lookup: HERDR_PANE_ID is w0:p1, so the parent is "the-parent".
  run_spawn --preflight --name ac19e --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 for a passing --preflight, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local parent stray
  parent="$(stdout_field '.parent')"
  [ "$parent" = "the-parent" ] || { fail_case "expected the parent lookup to report 'the-parent', got '$parent': $(cat "$OUT_FILE")"; teardown_case; return; }
  # (b) the name-not-already-live check: ac19d IS live -> preflight fails, exit 4.
  run_spawn --preflight --name ac19d --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 4 ] || { fail_case "expected exit 4 when --name is already a live agent, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "name_in_use" ] || { fail_case "expected .error.code name_in_use, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  stray="$(nonreadonly_stub_call)"
  [ -z "$stray" ] || { fail_case "--preflight must create nothing; STUB_LOG shows a call that is not read-only: $stray"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# `--help` says --preflight "creates nothing": proving the registry is writable must not
# leave a <stream>.jsonl behind for a stream that was never spawned, and must not touch a
# pre-existing registry file (content or mode). Creating the state directory is fine.
test_ac19_preflight_leaves_no_registry_residue() {
  CURRENT_TEST="ac19_preflight_leaves_no_registry_residue"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  # (a) a stream that was never spawned gets no registry file
  run_spawn --preflight --name ac19f --kind shell --cwd "$REPO_DIR" --stream ac19f
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 for a passing --preflight, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stdout_field '.registry')" = "home" ] || { fail_case "expected .registry == home so the writability proof actually ran: $(cat "$OUT_FILE")"; teardown_case; return; }
  [ ! -e "$JUTSU_STATE_DIR/ac19f.jsonl" ] || { fail_case "--preflight left a registry file behind: $JUTSU_STATE_DIR/ac19f.jsonl"; teardown_case; return; }
  local residue
  residue="$(find "$JUTSU_STATE_DIR" -type f 2>/dev/null | head -n1)"
  [ -z "$residue" ] || { fail_case "--preflight left a file in the state dir: $residue"; teardown_case; return; }
  # (b) a pre-existing registry file is untouched — content and mode
  local regfile before_mode before_sum
  regfile="$JUTSU_STATE_DIR/ac19g.jsonl"
  printf '%s\n' '{"name":"ac19g-old","status":"idle"}' >"$regfile"
  chmod 640 "$regfile"
  before_mode="$(stat_mode "$regfile")"
  before_sum="$(cksum <"$regfile")"
  run_spawn --preflight --name ac19g --kind shell --cwd "$REPO_DIR" --stream ac19g
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 for --preflight with a pre-existing registry file, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stat_mode "$regfile")" = "$before_mode" ] || { fail_case "--preflight changed the mode of a pre-existing registry file: $before_mode -> $(stat_mode "$regfile")"; teardown_case; return; }
  [ "$(cksum <"$regfile")" = "$before_sum" ] || { fail_case "--preflight changed the content of a pre-existing registry file: $(cat "$regfile")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac19_version_too_old_fails_preflight() {
  CURRENT_TEST="ac19_version_too_old_fails_preflight"
  setup_case
  export STUB_VERSION="0.8.1"
  run_spawn --name ac19b --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 4 ] || { fail_case "expected exit 4 for herdr 0.8.1 (< 0.8.2), got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local stray
  stray="$(nonreadonly_stub_call)"
  [ -z "$stray" ] || { fail_case "a failed preflight must create nothing; STUB_LOG shows a call that is not read-only: $stray"; teardown_case; return; }
  [ -n "$(stderr_error_code)" ] || { fail_case "expected jq-parseable .error.code naming the failed check: $(cat "$ERR_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac19_version_ok_passes_preflight() {
  CURRENT_TEST="ac19_version_ok_passes_preflight"
  setup_case
  export STUB_VERSION="0.10.0"
  export JUTSU_STATE_DIR="$SCRATCH/state"
  run_spawn --preflight --name ac19c --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 for --preflight against herdr 0.10.0 (numeric >= 0.8.2), got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local ver_field
  ver_field="$(stdout_field '.herdr_version')"
  case "$ver_field" in
    *0.10.0*) ;;
    *) fail_case "expected .herdr_version to reflect 0.10.0, got '$ver_field': $(cat "$OUT_FILE")"; teardown_case; return ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-19 / T1 / T4 — preflight proves a real herdr round-trip; no more silent empty parent.
# Preflight must prove reachability; the fixture quotes the real EPERM text a sandboxed
# agent gets from herdr.
# =========================================================================================

test_ac19_t4_preflight_reports_herdr_unreachable_on_eperm() {
  CURRENT_TEST="ac19_t4_preflight_reports_herdr_unreachable_on_eperm"
  setup_case
  export STUB_AGENT_LIST_EPERM=1
  run_spawn --preflight --name t4a --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 4 ] || { fail_case "expected exit 4 when 'herdr agent list' exits nonzero (EPERM), got $CODE: $(cat "$OUT_FILE") $(cat "$ERR_FILE")"; teardown_case; return; }
  local code_field msg_field lines
  # NB: `.ok // empty` swallows a JSON `false`, so the boolean is read with an explicit test.
  jq -e '.ok == false' "$OUT_FILE" >/dev/null 2>&1 \
    || { fail_case "expected the --preflight line to carry \"ok\":false: $(cat "$OUT_FILE")"; teardown_case; return; }
  code_field="$(stdout_field '.code')"
  [ "$code_field" = "herdr_unreachable" ] || { fail_case "expected \"code\":\"herdr_unreachable\" on the --preflight line, got '$code_field': $(cat "$OUT_FILE")"; teardown_case; return; }
  msg_field="$(stdout_field '.message')"
  case "$msg_field" in
    *"Operation not permitted"*) ;;
    *) fail_case "expected herdr's own EPERM text in .message, got '$msg_field'"; teardown_case; return ;;
  esac
  lines="$(printf '%s' "$msg_field" | wc -l | tr -d ' ')"
  [ "$lines" = 0 ] || { fail_case ".message must be trimmed to one line, found $lines embedded newline(s): $msg_field"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac19_t4_preflight_reports_herdr_unreachable_on_non_json() {
  CURRENT_TEST="ac19_t4_preflight_reports_herdr_unreachable_on_non_json"
  setup_case
  export STUB_AGENTS='not valid json at all <<<'
  run_spawn --preflight --name t4b --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 4 ] || { fail_case "expected exit 4 when 'herdr agent list' prints non-JSON, got $CODE: $(cat "$OUT_FILE") $(cat "$ERR_FILE")"; teardown_case; return; }
  local code_field
  # NB: `.ok // empty` swallows a JSON `false`, so the boolean is read with an explicit test.
  jq -e '.ok == false' "$OUT_FILE" >/dev/null 2>&1 \
    || { fail_case "expected \"ok\":false for non-JSON 'agent list' output: $(cat "$OUT_FILE")"; teardown_case; return; }
  code_field="$(stdout_field '.code')"
  [ "$code_field" = "herdr_unreachable" ] || { fail_case "expected \"code\":\"herdr_unreachable\" for non-JSON 'agent list' output, got '$code_field': $(cat "$OUT_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac19_t4_real_spawn_creates_nothing_when_herdr_unreachable() {
  CURRENT_TEST="ac19_t4_real_spawn_creates_nothing_when_herdr_unreachable"
  setup_case
  export STUB_AGENT_LIST_EPERM=1
  run_spawn --name t4c --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 4 ] || { fail_case "expected a real (non-preflight) spawn to exit 4 when herdr is unreachable, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "herdr_unreachable" ] || { fail_case "expected .error.code herdr_unreachable on stderr, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -qE '^(pane split|tab create|workspace create|worktree create)' "$STUB_LOG" \
    && { fail_case "a spawn must create nothing when herdr is unreachable; STUB_LOG: $(cat "$STUB_LOG")"; teardown_case; return; }
  teardown_case

  setup_case
  export STUB_AGENTS='garbage, not json'
  run_spawn --name t4c2 --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 4 ] || { fail_case "expected a real spawn to exit 4 when 'agent list' output is non-JSON, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -qE '^(pane split|tab create|workspace create|worktree create)' "$STUB_LOG" \
    && { fail_case "a spawn must create nothing when 'agent list' output is non-JSON; STUB_LOG: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac19_sandbox_hint_reported_both_ok_and_failing() {
  CURRENT_TEST="ac19_sandbox_hint_reported_both_ok_and_failing"
  setup_case
  export CODEX_SANDBOX=seatbelt
  run_spawn --preflight --name t4d --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 for a passing --preflight with CODEX_SANDBOX set, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stdout_field '.sandbox')" = "seatbelt" ] || { fail_case "expected .sandbox == seatbelt on a passing --preflight, got '$(stdout_field '.sandbox')': $(cat "$OUT_FILE")"; teardown_case; return; }
  teardown_case

  setup_case
  # CODEX_SANDBOX left unset by setup_case.
  run_spawn --preflight --name t4e --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 for a passing --preflight, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stdout_field '.sandbox')" = "" ] || { fail_case "expected .sandbox == '' when CODEX_SANDBOX is unset, got '$(stdout_field '.sandbox')': $(cat "$OUT_FILE")"; teardown_case; return; }
  teardown_case

  setup_case
  export CODEX_SANDBOX=seatbelt
  export STUB_AGENT_LIST_EPERM=1
  run_spawn --preflight --name t4f --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 4 ] || { fail_case "expected exit 4, got $CODE"; teardown_case; return; }
  [ "$(stdout_field '.sandbox')" = "seatbelt" ] || { fail_case "expected .sandbox == seatbelt even on a failing --preflight, got '$(stdout_field '.sandbox')': $(cat "$OUT_FILE")"; teardown_case; return; }
  case "$(stdout_field '.message')" in
    *"outside the sandbox"*|*"outside its sandbox"*) ;;
    *) fail_case "expected the sandbox hint (\"...outside the sandbox\") in .message when CODEX_SANDBOX is set and herdr is unreachable, got: $(stdout_field '.message')"; teardown_case; return ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac19_reachable_with_unnamed_parent_still_ok() {
  CURRENT_TEST="ac19_reachable_with_unnamed_parent_still_ok"
  setup_case
  # default empty STUB_AGENTS -> HERDR_PANE_ID matches nobody -> parent resolves empty.
  run_spawn --preflight --name t4g --kind shell --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0: an empty parent alone must not fail preflight, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stdout_field '.ok')" = "true" ] || { fail_case "expected .ok == true with an unnamed parent, got '$(stdout_field '.ok')': $(cat "$OUT_FILE")"; teardown_case; return; }
  [ "$(stdout_field '.parent')" = "" ] || { fail_case "expected .parent == '' (empty parent is not a failure), got '$(stdout_field '.parent')': $(cat "$OUT_FILE")"; teardown_case; return; }
  jq -e 'has("sandbox")' "$OUT_FILE" >/dev/null 2>&1 || { fail_case "expected a \"sandbox\" key on the --preflight line (even when empty), got: $(cat "$OUT_FILE")"; teardown_case; return; }
  [ "$(stdout_field '.sandbox')" = "" ] || { fail_case "expected .sandbox == '' with CODEX_SANDBOX unset, got '$(stdout_field '.sandbox')': $(cat "$OUT_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_ac19_help_documents_herdr_unreachable() {
  CURRENT_TEST="ac19_help_documents_herdr_unreachable"
  local help_out
  help_out="$("$SPAWN" --help 2>&1)"
  case "$help_out" in
    *"herdr_unreachable"*) ;;
    *) fail_case "--help does not document herdr_unreachable in the exit-4 list: $help_out"; return ;;
  esac
  ok "$CURRENT_TEST"
}

# =========================================================================================
# T8 / T9 — --record-session: record a session id after the fact for a member that started
# behind a dialog (T8) or was resumed (T9, herdr reports agent_session.value: null then).
# =========================================================================================

record_session_setup_initial_row() { # record_session_setup_initial_row <kind> <name> <stream>
  # Creates a retained-but-not-ready member (agent_not_ready), matching T8: registry row
  # with session_id "" and resume_args []. Leaves JUTSU_STATE_DIR/<stream>.jsonl behind.
  export STUB_AGENT_START_ERROR="agent_not_ready"
  run_spawn --name "$2" --kind "$1" --cwd "$REPO_DIR" --stream "$3"
  unset STUB_AGENT_START_ERROR
  # The setup spawn legitimately splits/renames a pane and starts an agent. Truncate the
  # stub log here so the "--record-session creates nothing" assertions below see only the
  # calls made by the --record-session run under test.
  : >"$STUB_LOG"
}

test_t8_record_session_appends_row_claude() {
  CURRENT_TEST="t8_record_session_appends_row_claude"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  record_session_setup_initial_row claude t8a-role t8a
  [ "$CODE" -eq 3 ] || { fail_case "setup: expected exit 3 (agent_not_ready) for the initial row, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local regfile before_first
  regfile="$JUTSU_STATE_DIR/t8a.jsonl"
  [ -f "$regfile" ] || { fail_case "setup: no registry file at $regfile"; teardown_case; return; }
  before_first="$(head -n1 "$regfile")"
  echo "$before_first" | jq -e '.session_id == "" and .resume_args == []' >/dev/null 2>&1 \
    || { fail_case "setup: initial row lacks the empty session_id/resume_args T8 describes: $before_first"; teardown_case; return; }

  run_spawn --record-session --name t8a-role --stream t8a --session-id sess-recorded-abc
  [ "$CODE" -eq 0 ] || { fail_case "--record-session: expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -qE '^(pane split|pane rename|tab create|workspace create|worktree create|agent start)' "$STUB_LOG" \
    && { fail_case "--record-session must create no pane and start nothing: $(cat "$STUB_LOG")"; teardown_case; return; }

  local after_first nlines new_line printed
  after_first="$(head -n1 "$regfile")"
  [ "$after_first" = "$before_first" ] || { fail_case "the original row changed; the registry must stay append-only. before=$before_first after=$after_first"; teardown_case; return; }
  nlines="$(wc -l <"$regfile" | tr -d ' ')"
  [ "$nlines" = 2 ] || { fail_case "expected exactly 2 rows after --record-session, got $nlines: $(cat "$regfile")"; teardown_case; return; }
  new_line="$(tail -n1 "$regfile")"
  echo "$new_line" | jq -e '.session_id == "sess-recorded-abc"' >/dev/null 2>&1 \
    || { fail_case "appended row session_id != sess-recorded-abc: $new_line"; teardown_case; return; }
  echo "$new_line" | jq -e '.resume_args == ["--resume","sess-recorded-abc"]' >/dev/null 2>&1 \
    || { fail_case "appended row resume_args wrong for kind=claude (want [\"--resume\",\"sess-recorded-abc\"]): $new_line"; teardown_case; return; }
  printed="$(cat "$OUT_FILE")"
  [ "$printed" = "$new_line" ] || { fail_case "--record-session must print the new row on stdout: stdout=$printed row=$new_line"; teardown_case; return; }
  [ "$(stat_mode "$regfile")" = "600" ] || { fail_case "registry file mode after --record-session is $(stat_mode "$regfile"), expected 600"; teardown_case; return; }
  [ "$(stat_mode "$JUTSU_STATE_DIR")" = "700" ] || { fail_case "registry dir mode after --record-session is $(stat_mode "$JUTSU_STATE_DIR"), expected 700"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_t8_record_session_appends_row_codex() {
  CURRENT_TEST="t8_record_session_appends_row_codex"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  record_session_setup_initial_row codex t8b-role t8b
  [ "$CODE" -eq 3 ] || { fail_case "setup: expected exit 3 (agent_not_ready), got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  run_spawn --record-session --name t8b-role --stream t8b --session-id sess-recorded-xyz
  [ "$CODE" -eq 0 ] || { fail_case "--record-session: expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local new_line
  new_line="$(tail -n1 "$JUTSU_STATE_DIR/t8b.jsonl")"
  echo "$new_line" | jq -e '.resume_args == ["resume","sess-recorded-xyz"]' >/dev/null 2>&1 \
    || { fail_case "appended row resume_args wrong for kind=codex (want [\"resume\",\"sess-recorded-xyz\"]): $new_line"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_t9_record_session_uses_herdr_when_session_id_omitted() {
  CURRENT_TEST="t9_record_session_uses_herdr_when_session_id_omitted"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  record_session_setup_initial_row claude t9a-role t9a
  [ "$CODE" -eq 3 ] || { fail_case "setup: expected exit 3, got $CODE"; teardown_case; return; }
  export STUB_AGENTS='{"result":{"agents":[{"name":"t9a-role","kind":"claude","agent_session":{"value":"sess-from-herdr"},"agent_status":"idle"}]}}'
  run_spawn --record-session --name t9a-role --stream t9a
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0 when herdr agent get returns a real session id, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^agent get t9a-role' "$STUB_LOG" || { fail_case "expected 'herdr agent get t9a-role' to run when --session-id is omitted: $(cat "$STUB_LOG")"; teardown_case; return; }
  local new_line
  new_line="$(tail -n1 "$JUTSU_STATE_DIR/t9a.jsonl")"
  echo "$new_line" | jq -e '.session_id == "sess-from-herdr"' >/dev/null 2>&1 \
    || { fail_case "expected the herdr-supplied session id to be recorded: $new_line"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_t9_record_session_null_herdr_session_no_flag_fails() {
  CURRENT_TEST="t9_record_session_null_herdr_session_no_flag_fails"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  record_session_setup_initial_row codex t9b-role t9b
  [ "$CODE" -eq 3 ] || { fail_case "setup: expected exit 3, got $CODE"; teardown_case; return; }
  # T9: a resumed Codex session reports agent_session.value: null.
  export STUB_AGENTS='{"result":{"agents":[{"name":"t9b-role","kind":"codex","agent_session":{"value":null},"agent_status":"idle"}]}}'
  run_spawn --record-session --name t9b-role --stream t9b
  [ "$CODE" -eq 1 ] || { fail_case "expected exit 1 when herdr's session id is null and no --session-id was given, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "no_session_id" ] || { fail_case "expected .error.code no_session_id, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -qi -- '--session-id' "$ERR_FILE" || { fail_case "expected the error message to say to pass --session-id: $(cat "$ERR_FILE")"; teardown_case; return; }
  local nlines
  nlines="$(wc -l <"$JUTSU_STATE_DIR/t9b.jsonl" | tr -d ' ')"
  [ "$nlines" = 1 ] || { fail_case "a failed --record-session must not append a row, but the registry now has $nlines lines"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_t8_record_session_unknown_member_rejected() {
  CURRENT_TEST="t8_record_session_unknown_member_rejected"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  # (a) the stream registry file does not exist at all.
  run_spawn --record-session --name ghost-role --stream never-spawned --session-id abc
  [ "$CODE" -eq 2 ] || { fail_case "expected exit 2 for a member with no registry file, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "unknown_member" ] || { fail_case "expected .error.code unknown_member, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }

  # (b) the stream registry exists but has no row for this name.
  record_session_setup_initial_row shell t8c-real t8c
  [ "$CODE" -eq 0 ] || { fail_case "setup: expected exit 0 for a kind=shell spawn, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  run_spawn --record-session --name t8c-does-not-exist --stream t8c --session-id abc
  [ "$CODE" -eq 2 ] || { fail_case "expected exit 2 for a name absent from an existing stream registry, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "unknown_member" ] || { fail_case "expected .error.code unknown_member, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_t8_record_session_symlinked_registry_refused() {
  CURRENT_TEST="t8_record_session_symlinked_registry_refused"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  mkdir -p "$JUTSU_STATE_DIR"
  local target before_sum after_sum
  target="$SCRATCH/elsewhere-record.jsonl"
  printf '%s\n' '{"name":"sym-role","stream":"symstream","session_id":"","resume_args":[],"status":"agent_not_ready"}' >"$target"
  chmod 600 "$target"
  before_sum="$(cksum <"$target")"
  ln -s "$target" "$JUTSU_STATE_DIR/symstream.jsonl"
  run_spawn --record-session --name sym-role --stream symstream --session-id abc
  [ "$CODE" -eq 5 ] || { fail_case "expected exit 5 for a symlinked registry file, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "unsafe_registry_path" ] || { fail_case "expected .error.code unsafe_registry_path, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  after_sum="$(cksum <"$target")"
  [ "$after_sum" = "$before_sum" ] || { fail_case "the symlink target was written through the link: before=$before_sum after=$after_sum"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_t8_record_session_preflight_conflict_refused() {
  CURRENT_TEST="t8_record_session_preflight_conflict_refused"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  record_session_setup_initial_row claude t8d-role t8d
  [ "$CODE" -eq 3 ] || { fail_case "setup: expected exit 3 (agent_not_ready), got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local before after
  before="$(wc -l <"$JUTSU_STATE_DIR/t8d.jsonl" | tr -d ' ')"
  # --preflight promises to create nothing; --record-session appends a row. The pair must
  # be refused as a usage error rather than letting one of them silently win.
  run_spawn --preflight --record-session --name t8d-role --stream t8d --session-id conflict-1
  [ "$CODE" -eq 2 ] || { fail_case "expected exit 2 for --preflight with --record-session, got $CODE: $(cat "$OUT_FILE") $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "conflicting_options" ] || { fail_case "expected .error.code conflicting_options, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  [ ! -s "$OUT_FILE" ] || { fail_case "a refused --preflight --record-session must print nothing on stdout, got: $(cat "$OUT_FILE")"; teardown_case; return; }
  after="$(wc -l <"$JUTSU_STATE_DIR/t8d.jsonl" | tr -d ' ')"
  [ "$after" = "$before" ] || { fail_case "--preflight --record-session must append no row, but the registry went from $before to $after lines"; teardown_case; return; }
  [ ! -s "$STUB_LOG" ] || { fail_case "a refused --preflight --record-session must make no herdr call, got: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_t8_record_session_help_documents_contract() {
  CURRENT_TEST="t8_record_session_help_documents_contract"
  local help_out missing token
  help_out="$("$SPAWN" --help 2>&1)"
  missing=""
  for token in "--record-session" "--session-id" "unknown_member" "no_session_id"; do
    case "$help_out" in
      *"$token"*) ;;
      *) missing="$missing [$token]" ;;
    esac
  done
  case "$help_out" in
    *[Ll]atest*[Rr]ow*|*latest-row*) ;;
    *) missing="$missing [latest-row-wins rule]" ;;
  esac
  case "$help_out" in
    *jq*) ;;
    *) missing="$missing [jq one-liner]" ;;
  esac
  if [ -n "$missing" ]; then
    fail_case "--help is missing documentation for:$missing"
    return
  fi
  ok "$CURRENT_TEST"
}

test_record_session_status_is_current_never_stale() {
  # A recorded session proves the member got past the dialog it started behind, so the new
  # row must NOT repeat the spawn-time agent_not_ready: it carries the member's current herdr
  # status when herdr answers, and the literal "recorded" when it does not.
  CURRENT_TEST="record_session_status_is_current_never_stale"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  record_session_setup_initial_row claude rs1-role rs1
  [ "$CODE" -eq 3 ] || { fail_case "setup: expected exit 3 (agent_not_ready), got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local regfile first_row new_line
  regfile="$JUTSU_STATE_DIR/rs1.jsonl"
  first_row="$(head -n1 "$regfile")"
  echo "$first_row" | jq -e '.status == "agent_not_ready"' >/dev/null 2>&1 \
    || { fail_case "setup: the initial row should carry status agent_not_ready: $first_row"; teardown_case; return; }

  # (a) herdr has no status for this member (agent get fails) -> the literal "recorded",
  #     never the stale agent_not_ready sitting in the row being extended.
  run_spawn --record-session --name rs1-role --stream rs1 --session-id sess-rs1-a
  [ "$CODE" -eq 0 ] || { fail_case "--record-session: expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  new_line="$(tail -n1 "$regfile")"
  echo "$new_line" | jq -e '.status == "recorded"' >/dev/null 2>&1 \
    || { fail_case "with no herdr status, the appended row's status must be \"recorded\": $new_line"; teardown_case; return; }
  [ "$(head -n1 "$regfile")" = "$first_row" ] \
    || { fail_case "the first row must stay byte-identical: before=$first_row after=$(head -n1 "$regfile")"; teardown_case; return; }

  # (b) herdr answers with a current status -> that status is what gets recorded.
  export STUB_AGENTS='{"result":{"agents":[{"name":"rs1-role","kind":"claude","agent_session":{"value":"sess-live"},"agent_status":"idle"}]}}'
  run_spawn --record-session --name rs1-role --stream rs1 --session-id sess-rs1-b
  [ "$CODE" -eq 0 ] || { fail_case "--record-session with a live status: expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  new_line="$(tail -n1 "$regfile")"
  echo "$new_line" | jq -e '.status == "idle"' >/dev/null 2>&1 \
    || { fail_case "expected the appended row to carry herdr's current status (idle): $new_line"; teardown_case; return; }
  [ "$(head -n1 "$regfile")" = "$first_row" ] \
    || { fail_case "the first row must stay byte-identical after the second --record-session"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# L1 — --beside resolution order: live agent name -> registered shell name -> literal pane id.
# =========================================================================================

test_l1_beside_resolves_live_agent_name() {
  CURRENT_TEST="l1_beside_resolves_live_agent_name"
  setup_case
  export STUB_AGENTS='{"result":{"agents":[{"name":"builder","kind":"claude","pane_id":"w0:p2","agent_status":"idle"}]}}'
  run_spawn --name l1a --kind shell --cwd "$REPO_DIR" --beside builder
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^pane split w0:p2' "$STUB_LOG" || { fail_case "expected the split to anchor on w0:p2 (builder's pane): $(cat "$STUB_LOG")"; teardown_case; return; }
  grep -q '^pane get w0:p2' "$STUB_LOG" || { fail_case "expected the resolved anchor w0:p2 to be verified with 'pane get' before splitting: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_l1_beside_resolves_registered_shell_name() {
  CURRENT_TEST="l1_beside_resolves_registered_shell_name"
  setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  mkdir -p "$JUTSU_STATE_DIR"
  echo '{"name":"scratch-shell","kind":"shell","stream":"l1b","pane_id":"w0:p5","status":"shell"}' >"$JUTSU_STATE_DIR/l1b.jsonl"
  run_spawn --name l1b-two --kind shell --cwd "$REPO_DIR" --stream l1b --beside scratch-shell
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^pane split w0:p5' "$STUB_LOG" || { fail_case "expected the split to anchor on w0:p5 (scratch-shell's registered pane): $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_l1_beside_resolves_literal_pane_id() {
  CURRENT_TEST="l1_beside_resolves_literal_pane_id"
  setup_case
  run_spawn --name l1c --kind shell --cwd "$REPO_DIR" --beside w0:p9
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^pane get w0:p9' "$STUB_LOG" || { fail_case "expected the anchor to be verified with 'pane get w0:p9' before splitting: $(cat "$STUB_LOG")"; teardown_case; return; }
  grep -q '^pane split w0:p9' "$STUB_LOG" || { fail_case "expected the split to anchor on the literal pane id w0:p9: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_l1_beside_unknown_anchor_refused() {
  CURRENT_TEST="l1_beside_unknown_anchor_refused"
  setup_case
  run_spawn --name l1d --kind shell --cwd "$REPO_DIR" --beside totally-unresolvable-anchor
  [ "$CODE" -eq 2 ] || { fail_case "expected exit 2 for an unresolvable --beside anchor, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "unknown_anchor" ] || { fail_case "expected .error.code unknown_anchor, got '$(stderr_error_code)': $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^pane split' "$STUB_LOG" && { fail_case "must not split anything for an unresolvable anchor: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# Item 10 — --help documents the new flags/exit codes/registry resolution order.
# =========================================================================================

test_item10_help_documents_new_contract() {
  CURRENT_TEST="item10_help_documents_new_contract"
  local help_out
  help_out="$("$SPAWN" --help 2>&1)"
  local missing=""
  for token in "--preflight" "--allow-dangerous-agent-flags" "--in-pane" "--beside" "JUTSU_STATE_DIR" "XDG_STATE_HOME"; do
    case "$help_out" in
      *"$token"*) ;;
      *) missing="$missing $token" ;;
    esac
  done
  if [ -n "$missing" ]; then
    fail_case "--help is missing documentation for:$missing"
    return
  fi
  ok "$CURRENT_TEST"
}

# =========================================================================================
# Stage 0 / W1-W3 — outbound isolation is installed and reported by the launcher.
# =========================================================================================

test_stage0_codex_layer_written_with_resolved_herdr_path() {
  CURRENT_TEST="stage0_codex_layer_written_with_resolved_herdr_path"
  setup_case
  run_spawn --name stage0-layer --kind codex --cwd "$REPO_DIR" -- -s read-only
  [ "$CODE" -eq 0 ] || { fail_case "expected exit 0, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  local rules resolved
  rules="$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules"
  resolved="$(command -v herdr)"
  [ -f "$REPO_DIR/.codex/config.toml" ] || { fail_case "missing .codex/config.toml"; teardown_case; return; }
  [ -f "$rules" ] || { fail_case "missing $rules"; teardown_case; return; }
  grep -Fq "host_executable(name=\"herdr\", paths=[\"$resolved\"])" "$rules" \
    || { fail_case "rules file does not contain resolved herdr path $resolved: $(cat "$rules")"; teardown_case; return; }
  grep -Fq 'prefix_rule(pattern=["herdr"], decision="forbidden", justification="Crew members do not drive herdr; the parent pulls from this pane.")' "$rules" \
    || { fail_case "rules file lacks the broad forbidden prefix rule: $(cat "$rules")"; teardown_case; return; }
  [ -s "$STUB_CODEX_LOG" ] \
    || { fail_case "the written rule was not statically checked with codex execpolicy"; teardown_case; return; }
  [ "$(stdout_field '.outbound_isolation')" = "enforced_if_trusted" ] \
    || { fail_case "spawn JSON outbound_isolation is not enforced_if_trusted: $(cat "$OUT_FILE")"; teardown_case; return; }
  [ -n "$(stdout_field '.isolation_detail')" ] \
    || { fail_case "spawn JSON lacks isolation_detail: $(cat "$OUT_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_stage0_differing_rules_refused_without_overwrite() {
  CURRENT_TEST="stage0_differing_rules_refused_without_overwrite"
  setup_case
  mkdir -p "$REPO_DIR/.codex/rules"
  printf '%s\n' 'user-owned different policy' >"$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules"
  local before after
  before="$(cksum <"$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules")"
  run_spawn --name stage0-conflict --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 5 ] || { fail_case "expected exit 5 for a differing existing rules file, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "isolation_policy_conflict" ] \
    || { fail_case "expected isolation_policy_conflict, got $(stderr_error_code): $(cat "$ERR_FILE")"; teardown_case; return; }
  after="$(cksum <"$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules")"
  [ "$after" = "$before" ] || { fail_case "existing rules file was overwritten"; teardown_case; return; }
  grep -q '^agent start' "$STUB_LOG" && { fail_case "agent start ran after policy conflict: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_stage0_info_exclude_normal_checkout_idempotent() {
  CURRENT_TEST="stage0_info_exclude_normal_checkout_idempotent"
  setup_case
  run_spawn --name stage0-ex1 --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "first spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  run_spawn --name stage0-ex2 --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "second spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  local exclude
  exclude="$REPO_DIR/$(git -C "$REPO_DIR" rev-parse --git-path info/exclude)"
  [ "$(grep -Fxc '.codex/rules/herdr-jutsu-deny.rules' "$exclude")" -eq 1 ] \
    || { fail_case "rules exclusion is not present exactly once: $(cat "$exclude")"; teardown_case; return; }
  [ "$(grep -Fxc '.codex/config.toml' "$exclude")" -eq 1 ] \
    || { fail_case "created config exclusion is not present exactly once: $(cat "$exclude")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_stage0_info_exclude_linked_worktree_idempotent() {
  CURRENT_TEST="stage0_info_exclude_linked_worktree_idempotent"
  setup_case
  local linked exclude
  linked="$SCRATCH/linked"
  git -C "$REPO_DIR" worktree add -q -b linked-test "$linked" HEAD
  run_spawn --name stage0-lw1 --kind codex --cwd "$linked"
  [ "$CODE" -eq 0 ] || { fail_case "first linked-worktree spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  run_spawn --name stage0-lw2 --kind codex --cwd "$linked"
  [ "$CODE" -eq 0 ] || { fail_case "second linked-worktree spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  exclude="$(git -C "$linked" rev-parse --git-path info/exclude)"
  case "$exclude" in /*) ;; *) exclude="$linked/$exclude" ;; esac
  [ "$(grep -Fxc '.codex/rules/herdr-jutsu-deny.rules' "$exclude")" -eq 1 ] \
    || { fail_case "linked worktree's shared exclude lacks one rules entry: $(cat "$exclude")"; teardown_case; return; }
  [ "$(grep -Fxc '.codex/config.toml' "$exclude")" -eq 1 ] \
    || { fail_case "linked worktree's shared exclude lacks one config entry: $(cat "$exclude")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_stage0_codex_requires_never_and_injects_when_absent() {
  CURRENT_TEST="stage0_codex_requires_never_and_injects_when_absent"
  setup_case
  run_spawn --name stage0-ap1 --kind codex --cwd "$REPO_DIR" -- -a on-request
  [ "$CODE" -eq 5 ] || { fail_case "expected exit 5 for -a on-request, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = "isolation_unsupported_agent_arg" ] \
    || { fail_case "expected isolation_unsupported_agent_arg, got $(stderr_error_code): $(cat "$ERR_FILE")"; teardown_case; return; }
  : >"$STUB_LOG"
  run_spawn --name stage0-ap2 --kind codex --cwd "$REPO_DIR" -- -s read-only
  [ "$CODE" -eq 0 ] || { fail_case "spawn without -a failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -qE '^agent start .* -- -s read-only -a never$' "$STUB_LOG" \
    || { fail_case "agent start did not inject '-a never': $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_stage0_no_isolation_writes_nothing_and_reports_none() {
  CURRENT_TEST="stage0_no_isolation_writes_nothing_and_reports_none"
  setup_case
  run_spawn --name stage0-none --kind codex --cwd "$REPO_DIR" --no-isolation -- -a on-request
  [ "$CODE" -eq 0 ] || { fail_case "--no-isolation spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.codex/config.toml" ] || { fail_case "--no-isolation wrote config.toml"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules" ] || { fail_case "--no-isolation wrote a deny rule"; teardown_case; return; }
  [ "$(stdout_field '.outbound_isolation')" = "none" ] \
    || { fail_case "--no-isolation did not report outbound_isolation none: $(cat "$OUT_FILE")"; teardown_case; return; }
  grep -qE '^agent start .* -- -a on-request$' "$STUB_LOG" \
    || { fail_case "--no-isolation did not preserve caller approval args: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_stage0_claude_disallowed_tools_merged_once() {
  CURRENT_TEST="stage0_claude_disallowed_tools_merged_once"
  setup_case
  run_spawn --name stage0-claude --kind claude --cwd "$REPO_DIR" -- \
    --permission-mode acceptEdits --disallowedTools WebFetch CustomTool
  [ "$CODE" -eq 0 ] || { fail_case "Claude spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  local start_line count
  start_line="$(grep '^agent start ' "$STUB_LOG" | tail -n1)"
  count="$(printf '%s\n' "$start_line" | grep -o -- '--disallowedTools' | wc -l | tr -d ' ')"
  [ "$count" -eq 1 ] || { fail_case "expected one merged --disallowedTools flag, got $count: $start_line"; teardown_case; return; }
  case "$start_line" in
    *WebFetch*CustomTool*'Bash(*herdr*)'*SendMessage*ListAgents*) ;;
    *) fail_case "merged deny list is incomplete or reordered unexpectedly: $start_line"; teardown_case; return ;;
  esac
  [ "$(stdout_field '.outbound_isolation')" = "partial" ] \
    || { fail_case "Claude spawn did not report partial isolation: $(cat "$OUT_FILE")"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in *acceptEdits*) ;;
    *) fail_case "Claude isolation_detail does not state permission mode: $(cat "$OUT_FILE")"; teardown_case; return ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

test_stage0_preflight_reports_isolation_without_writing_layer() {
  CURRENT_TEST="stage0_preflight_reports_isolation_without_writing_layer"
  setup_case
  run_spawn --preflight --name stage0-pre --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "preflight failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stdout_field '.outbound_isolation')" = "enforced_if_trusted" ] \
    || { fail_case "preflight outbound_isolation is wrong: $(cat "$OUT_FILE")"; teardown_case; return; }
  [ -n "$(stdout_field '.isolation_detail')" ] \
    || { fail_case "preflight lacks isolation_detail: $(cat "$OUT_FILE")"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.codex" ] || { fail_case "preflight wrote a .codex layer"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_stage0_failure_cleanup_removes_written_policy_layer() {
  CURRENT_TEST="stage0_failure_cleanup_removes_written_policy_layer"
  setup_case
  export STUB_AGENT_START_ERROR="invalid_arguments"
  run_spawn --name stage0-clean --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 1 ] || { fail_case "expected start failure exit 1, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ -s "$STUB_CODEX_LOG" ] \
    || { fail_case "test setup never installed and checked a policy layer"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules" ] \
    || { fail_case "cleanup left the rules file behind"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.codex/config.toml" ] \
    || { fail_case "cleanup left the launcher-created config behind"; teardown_case; return; }
  local exclude
  exclude="$REPO_DIR/$(git -C "$REPO_DIR" rev-parse --git-path info/exclude)"
  grep -Fq '.codex/rules/herdr-jutsu-deny.rules' "$exclude" \
    && { fail_case "cleanup left the rules exclusion behind: $(cat "$exclude")"; teardown_case; return; }
  grep -Fq '.codex/config.toml' "$exclude" \
    && { fail_case "cleanup left the config exclusion behind: $(cat "$exclude")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_stage0_in_pane_uses_actual_pane_cwd() {
  CURRENT_TEST="stage0_in_pane_uses_actual_pane_cwd"
  setup_case
  local pane_repo
  pane_repo="$SCRATCH/pane-repo"
  mkdir -p "$pane_repo"
  git -C "$pane_repo" init -q
  git -C "$pane_repo" -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m init
  export STUB_PANE_CWD="$pane_repo"
  run_spawn --name stage0-pane --kind codex --cwd "$REPO_DIR" --in-pane w0:p9
  [ "$CODE" -eq 0 ] || { fail_case "--in-pane spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stdout_field '.cwd')" = "$pane_repo" ] \
    || { fail_case "spawn JSON recorded caller cwd instead of pane cwd: $(cat "$OUT_FILE")"; teardown_case; return; }
  [ -f "$pane_repo/.codex/rules/herdr-jutsu-deny.rules" ] \
    || { fail_case "policy layer was not written in the pane's cwd"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules" ] \
    || { fail_case "policy layer was incorrectly written in the caller cwd"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# Fix round 1 / F1-F7 — no false isolation labels; ownership-safe policy files.
# =========================================================================================

assert_refusal_result() { # assert_refusal_result <expected-code> <label>
  local expected="$1" label="$2" got
  [ "$CODE" -eq 5 ] || { fail_case "$label: expected exit 5, got $CODE: $(cat "$ERR_FILE")"; return 1; }
  got="$(stderr_error_code)"
  [ "$got" = "$expected" ] \
    || { fail_case "$label: expected $expected, got $got: $(cat "$ERR_FILE")"; return 1; }
  grep -q '^agent start' "$STUB_LOG" \
    && { fail_case "$label: agent start ran despite refusal: $(cat "$STUB_LOG")"; return 1; }
  return 0
}

test_f1_three_resolved_execpolicy_checks() {
  CURRENT_TEST="f1_three_resolved_execpolicy_checks"
  setup_case
  run_spawn --name f1-checks --kind codex --cwd "$REPO_DIR" -- -s read-only
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  local resolved
  resolved="$(command -v herdr)"
  jq -se --arg h "$resolved" '
    length == 3 and
    all(.[]; index("--resolve-host-executables") != null) and
    (map(. as $a | $a[(($a | index("--")) + 1):]) == [
      ["herdr","agent","prompt","x","y"],
      [$h,"agent","prompt","x","y"],
      ["herdr","workspace","list"]
    ])' "$STUB_CODEX_LOG" >/dev/null 2>&1 \
    || { fail_case "expected three ordered resolved-host checks, got: $(cat "$STUB_CODEX_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_f1_null_execpolicy_answer_downgrades_with_probe_reason() {
  CURRENT_TEST="f1_null_execpolicy_answer_downgrades_with_probe_reason"
  setup_case
  export STUB_CODEX_RULES_OVERRIDE_SET=1
  export STUB_CODEX_RULES_OVERRIDE='host_executable(name="herdr", paths=["/not/the/stub"])'
  run_spawn --name f1-null --kind codex --cwd "$REPO_DIR" -- -s read-only
  [ "$CODE" -eq 0 ] || { fail_case "spawn should continue with isolation none, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stdout_field '.outbound_isolation')" = none ] \
    || { fail_case "null decision did not downgrade isolation: $(cat "$OUT_FILE")"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in *"bare herdr invocation"*) ;;
    *) fail_case "downgrade reason does not identify the failed bare-herdr probe: $(cat "$OUT_FILE")"; teardown_case; return ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

test_f2_all_sandbox_removal_spellings_refused() {
  CURRENT_TEST="f2_all_sandbox_removal_spellings_refused"
  local form label i=0
  local FORMS=(
    '-s danger-full-access'
    '-sdanger-full-access'
    '-s=danger-full-access'
    '--sandbox danger-full-access'
    '--sandbox=danger-full-access'
    '--dangerously-bypass-approvals-and-sandbox'
    '-c sandbox_mode="read-only"'
    '-csandbox_mode="read-only"'
    '-c=sandbox_mode="read-only"'
    '--config sandbox_mode="read-only"'
    '--config=sandbox_mode="read-only"'
    '-c sandbox_permissions=["disk-full-read-access"]'
  )
  for form in "${FORMS[@]}"; do
    i=$((i + 1)); setup_case; label="form $i: $form"
    # Deliberate word splitting: each matrix entry is the argv spelling under test.
    run_spawn --name "f2-$i" --kind codex --cwd "$REPO_DIR" \
      --allow-dangerous-agent-flags -- $form
    assert_refusal_result isolation_unsupported_agent_arg "$label" \
      || { teardown_case; return; }
    teardown_case
  done
  ok "$CURRENT_TEST"
}

test_f3_all_approval_flag_spellings_refused() {
  CURRENT_TEST="f3_all_approval_flag_spellings_refused"
  local form label i=0
  local FORMS=(
    '-a on-request'
    '-aon-request'
    '-a=on-request'
    '--ask-for-approval on-request'
    '--ask-for-approval=on-request'
  )
  for form in "${FORMS[@]}"; do
    i=$((i + 1)); setup_case; label="form $i: $form"
    run_spawn --name "f3a-$i" --kind codex --cwd "$REPO_DIR" -- $form
    assert_refusal_result isolation_unsupported_agent_arg "$label" \
      || { teardown_case; return; }
    teardown_case
  done
  ok "$CURRENT_TEST"
}

test_f3_all_approval_config_spellings_refused() {
  CURRENT_TEST="f3_all_approval_config_spellings_refused"
  local form label i=0
  local FORMS=(
    '-c approval_policy="on-request"'
    '-capproval_policy="on-request"'
    '-c=approval_policy="on-request"'
    '--config approval_policy="on-request"'
    '--config=approval_policy="on-request"'
    '-a never -c approval_policy="never"'
  )
  for form in "${FORMS[@]}"; do
    i=$((i + 1)); setup_case; label="form $i: $form"
    run_spawn --name "f3c-$i" --kind codex --cwd "$REPO_DIR" -- $form
    assert_refusal_result isolation_unsupported_agent_arg "$label" \
      || { teardown_case; return; }
    teardown_case
  done
  ok "$CURRENT_TEST"
}

test_f3_profiles_require_explicit_safe_sandbox_and_are_reported() {
  CURRENT_TEST="f3_profiles_require_explicit_safe_sandbox_and_are_reported"
  local form label i=0
  local FORMS=('-p review' '-preview' '--profile review' '--profile=review')
  for form in "${FORMS[@]}"; do
    i=$((i + 1)); setup_case; label="form $i: $form"
    run_spawn --name "f3p-$i" --kind codex --cwd "$REPO_DIR" -- $form
    assert_refusal_result isolation_unsupported_agent_arg "$label" \
      || { teardown_case; return; }
    teardown_case
  done
  setup_case
  run_spawn --name f3p-safe --kind codex --cwd "$REPO_DIR" -- -p review -s read-only
  [ "$CODE" -eq 0 ] || { fail_case "profile with explicit safe sandbox failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in *profile*review*) ;;
    *) fail_case "isolation_detail does not report the active profile: $(cat "$OUT_FILE")"; teardown_case; return ;;
  esac
  teardown_case
  ok "$CURRENT_TEST"
}

test_f3_approve_for_me_refused() {
  CURRENT_TEST="f3_approve_for_me_refused"
  setup_case
  run_spawn --name f3-auto --kind codex --cwd "$REPO_DIR" -- --approve-for-me
  assert_refusal_result isolation_unsupported_agent_arg '--approve-for-me' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_f4_all_policy_path_symlinks_refused_before_creation() {
  CURRENT_TEST="f4_all_policy_path_symlinks_refused_before_creation"
  local variant stray i=0
  for variant in codex_dir rules_dir rules_file dangling_config; do
    i=$((i + 1)); setup_case
    case "$variant" in
      codex_dir)
        mkdir -p "$SCRATCH/codex-target"
        ln -s "$SCRATCH/codex-target" "$REPO_DIR/.codex"
        ;;
      rules_dir)
        mkdir -p "$REPO_DIR/.codex" "$SCRATCH/rules-target"
        ln -s "$SCRATCH/rules-target" "$REPO_DIR/.codex/rules"
        ;;
      rules_file)
        mkdir -p "$REPO_DIR/.codex/rules"
        printf '%s\n' different >"$SCRATCH/rules-target-file"
        ln -s "$SCRATCH/rules-target-file" "$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules"
        ;;
      dangling_config)
        mkdir -p "$REPO_DIR/.codex"
        ln -s "$SCRATCH/missing-config-target" "$REPO_DIR/.codex/config.toml"
        ;;
    esac
    run_spawn --name "f4-$i" --kind codex --cwd "$REPO_DIR"
    assert_refusal_result isolation_policy_conflict "$variant" \
      || { teardown_case; return; }
    stray="$(nonreadonly_stub_call)"
    [ -z "$stray" ] || { fail_case "$variant: refusal occurred after creating a resource: $stray"; teardown_case; return; }
    teardown_case
  done
  ok "$CURRENT_TEST"
}

test_f4_identical_preexisting_rules_survive_rollback() {
  CURRENT_TEST="f4_identical_preexisting_rules_survive_rollback"
  setup_case
  local rules resolved before after checks
  rules="$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules"
  resolved="$(command -v herdr)"
  mkdir -p "$(dirname "$rules")"
  printf '%s\n%s\n' \
    "host_executable(name=\"herdr\", paths=[\"$resolved\"])" \
    'prefix_rule(pattern=["herdr"], decision="forbidden", justification="Crew members do not drive herdr; the parent pulls from this pane.")' >"$rules"
  before="$(cksum <"$rules")"
  export STUB_AGENT_START_ERROR=invalid_arguments
  run_spawn --name f4-identical --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 1 ] || { fail_case "expected post-policy start failure, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ -f "$rules" ] || { fail_case "pre-existing identical rules file was deleted"; teardown_case; return; }
  after="$(cksum <"$rules")"
  [ "$after" = "$before" ] || { fail_case "pre-existing identical rules file changed"; teardown_case; return; }
  checks="$(wc -l <"$STUB_CODEX_LOG" | tr -d ' ')"
  [ "$checks" -eq 3 ] || { fail_case "setup did not exercise all three policy checks; got $checks"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_f4_preexisting_empty_codex_dir_survives_rollback() {
  CURRENT_TEST="f4_preexisting_empty_codex_dir_survives_rollback"
  setup_case
  mkdir -p "$REPO_DIR/.codex"
  export STUB_AGENT_START_ERROR=invalid_arguments
  run_spawn --name f4-empty --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 1 ] || { fail_case "expected start failure, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ -d "$REPO_DIR/.codex" ] || { fail_case "pre-existing empty .codex directory was deleted"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.codex/config.toml" ] || { fail_case "launcher-created config survived rollback"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_f5_exclude_without_trailing_newline_is_not_glued() {
  CURRENT_TEST="f5_exclude_without_trailing_newline_is_not_glued"
  setup_case
  local exclude expected
  exclude="$REPO_DIR/$(git -C "$REPO_DIR" rev-parse --git-path info/exclude)"
  printf '%s' 'custom-pattern' >"$exclude"
  run_spawn --name f5-newline --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  expected="$(printf '%s\n%s\n%s' 'custom-pattern' '.codex/rules/herdr-jutsu-deny.rules' '.codex/config.toml')"
  [ "$(cat "$exclude")" = "$expected" ] \
    || { fail_case "exclude entries were glued to the prior pattern: $(cat "$exclude")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_f5_preexisting_exclude_line_is_not_owned_or_removed() {
  CURRENT_TEST="f5_preexisting_exclude_line_is_not_owned_or_removed"
  setup_case
  local exclude count checks
  exclude="$REPO_DIR/$(git -C "$REPO_DIR" rev-parse --git-path info/exclude)"
  printf '%s\n' '.codex/rules/herdr-jutsu-deny.rules' >>"$exclude"
  export STUB_AGENT_START_ERROR=invalid_arguments
  run_spawn --name f5-owned --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 1 ] || { fail_case "expected start failure, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  count="$(grep -Fxc '.codex/rules/herdr-jutsu-deny.rules' "$exclude")"
  [ "$count" -eq 1 ] || { fail_case "pre-existing exclude line was removed or duplicated: $(cat "$exclude")"; teardown_case; return; }
  checks="$(wc -l <"$STUB_CODEX_LOG" | tr -d ' ')"
  [ "$checks" -eq 3 ] || { fail_case "setup did not exercise all three policy checks; got $checks"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_f6_tracked_conflict_in_base_refused_before_worktree_creation() {
  CURRENT_TEST="f6_tracked_conflict_in_base_refused_before_worktree_creation"
  setup_case
  mkdir -p "$REPO_DIR/.codex/rules"
  printf '%s\n' 'tracked different policy' >"$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules"
  git -C "$REPO_DIR" add .codex/rules/herdr-jutsu-deny.rules
  git -C "$REPO_DIR" -c user.email=test@example.com -c user.name=test commit -q -m policy
  run_spawn --name f6-base --kind codex --cwd "$REPO_DIR" --worktree f6-branch
  [ "$CODE" -eq 5 ] || { fail_case "expected pre-creation exit 5, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = isolation_policy_conflict ] \
    || { fail_case "expected isolation_policy_conflict: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^worktree create' "$STUB_LOG" \
    && { fail_case "worktree was created before tracked-policy conflict was detected: $(cat "$STUB_LOG")"; teardown_case; return; }
  grep -q '"recovery"' "$ERR_FILE" \
    && { fail_case "pre-creation refusal emitted an orphan recovery record: $(cat "$ERR_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_f7_stub_absolute_match_also_requires_forbidden_prefix() {
  CURRENT_TEST="f7_stub_absolute_match_also_requires_forbidden_prefix"
  setup_case
  local rules resolved answer
  rules="$SCRATCH/host-only.rules"
  resolved="$(command -v herdr)"
  printf '%s\n' "host_executable(name=\"herdr\", paths=[\"$resolved\"])" >"$rules"
  answer="$(codex execpolicy check --rules "$rules" --resolve-host-executables -- \
    "$resolved" workspace list 2>/dev/null)"
  printf '%s' "$answer" | jq -e '.decision == null and (.matchedRules | length == 0)' >/dev/null 2>&1 \
    || { fail_case "host_executable without a forbidden prefix_rule must not match: $answer"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# Fix round 2 — isolated Codex argv allowlist, lock/signal safety, honest exclusions/argv.
# =========================================================================================

assert_isolation_unsupported() { # assert_isolation_unsupported <label> <offending-token> <args...>
  local label="$1" token="$2"
  shift 2
  setup_case
  run_spawn --name r2-refuse --kind codex --cwd "$REPO_DIR" "$@"
  [ "$CODE" -eq 5 ] \
    || { fail_case "$label: expected exit 5, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return 1; }
  [ "$(stderr_error_code)" = isolation_unsupported_agent_arg ] \
    || { fail_case "$label: wrong error code: $(cat "$ERR_FILE")"; teardown_case; return 1; }
  grep -Fq -- "$token" "$ERR_FILE" \
    || { fail_case "$label: error does not name offending token '$token': $(cat "$ERR_FILE")"; teardown_case; return 1; }
  grep -Fq -- '--no-isolation' "$ERR_FILE" \
    || { fail_case "$label: error does not name the only opt-out: $(cat "$ERR_FILE")"; teardown_case; return 1; }
  teardown_case
  return 0
}

assert_allowed_effective_present() {
  [ "$CODE" -eq 0 ] || { fail_case "allowed form failed: $(cat "$ERR_FILE")"; return 1; }
  jq -e '.effective_agent_args | type == "array"' "$OUT_FILE" >/dev/null 2>&1 \
    || { fail_case "spawn line lacks effective_agent_args: $(cat "$OUT_FILE")"; return 1; }
}

test_r2_allowlist_sandbox_spellings() {
  CURRENT_TEST="r2_allowlist_sandbox_spellings"
  local i=0 form
  local FORMS=('-s read-only' '-sworkspace-write' '-s=read-only' '--sandbox workspace-write' '--sandbox=read-only')
  for form in "${FORMS[@]}"; do
    i=$((i + 1)); setup_case
    run_spawn --name "r2s-$i" --kind codex --cwd "$REPO_DIR" -- $form
    assert_allowed_effective_present || { teardown_case; return; }
    teardown_case
  done
  ok "$CURRENT_TEST"
}

test_r2_allowlist_approval_spellings() {
  CURRENT_TEST="r2_allowlist_approval_spellings"
  local i=0 form
  local FORMS=('-a never' '-anever' '-a=never' '--ask-for-approval never' '--ask-for-approval=never')
  for form in "${FORMS[@]}"; do
    i=$((i + 1)); setup_case
    run_spawn --name "r2a-$i" --kind codex --cwd "$REPO_DIR" -- $form
    assert_allowed_effective_present || { teardown_case; return; }
    teardown_case
  done
  ok "$CURRENT_TEST"
}

test_r2_allowlist_model_spellings() {
  CURRENT_TEST="r2_allowlist_model_spellings"
  local i=0 form
  local FORMS=('-m alpha' '-malpha' '-m=alpha' '--model alpha' '--model=alpha')
  for form in "${FORMS[@]}"; do
    i=$((i + 1)); setup_case
    run_spawn --name "r2m-$i" --kind codex --cwd "$REPO_DIR" -- $form
    assert_allowed_effective_present || { teardown_case; return; }
    teardown_case
  done
  ok "$CURRENT_TEST"
}

test_r2_allowlist_profile_spellings_with_sandbox() {
  CURRENT_TEST="r2_allowlist_profile_spellings_with_sandbox"
  local i=0 form
  local FORMS=('-p review' '-preview' '-p=review' '--profile review' '--profile=review')
  for form in "${FORMS[@]}"; do
    i=$((i + 1)); setup_case
    run_spawn --name "r2p-$i" --kind codex --cwd "$REPO_DIR" -- -s read-only $form
    assert_allowed_effective_present || { teardown_case; return; }
    case "$(stdout_field '.isolation_detail')" in *profile*review*) ;;
      *) fail_case "profile form did not appear in isolation_detail: $(cat "$OUT_FILE")"; teardown_case; return ;;
    esac
    teardown_case
  done
  ok "$CURRENT_TEST"
}

test_r2_allowlist_add_dir_spellings() {
  CURRENT_TEST="r2_allowlist_add_dir_spellings"
  setup_case
  run_spawn --name r2dir-one --kind codex --cwd "$REPO_DIR" -- --add-dir "/path/with spaces"
  assert_allowed_effective_present || { teardown_case; return; }
  teardown_case
  setup_case
  run_spawn --name r2dir-two --kind codex --cwd "$REPO_DIR" -- '--add-dir=/path/with spaces'
  assert_allowed_effective_present || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_r2_allowlist_config_keys_and_spellings() {
  CURRENT_TEST="r2_allowlist_config_keys_and_spellings"
  local i=0 form
  local FORMS=(
    '-c model=o3'
    '-cmodel_reasoning_effort=high'
    '-c=model_reasoning_summary=concise'
    '--config model_verbosity=high'
    '--config="model"=o3'
    "-c 'model'=o4"
  )
  for form in "${FORMS[@]}"; do
    i=$((i + 1)); setup_case
    run_spawn --name "r2c-$i" --kind codex --cwd "$REPO_DIR" -- $form
    assert_allowed_effective_present || { teardown_case; return; }
    teardown_case
  done
  setup_case
  run_spawn --name r2c-space --kind codex --cwd "$REPO_DIR" -- --config ' model_reasoning_effort =high'
  assert_allowed_effective_present || { teardown_case; return; }
  teardown_case
  setup_case
  run_spawn --name r2c-map --kind codex --cwd "$REPO_DIR" -- -c 'model={name="o3"}'
  [ "$CODE" -eq 5 ] && [ "$(stderr_error_code)" = isolation_unsupported_agent_arg ] \
    || { fail_case "config map value was accepted: $(cat "$ERR_FILE")"; teardown_case; return; }
  teardown_case
  setup_case
  run_spawn --name r2c-list --kind codex --cwd "$REPO_DIR" -- -c 'model=["o3"]'
  [ "$CODE" -eq 5 ] && [ "$(stderr_error_code)" = isolation_unsupported_agent_arg ] \
    || { fail_case "config list value was accepted: $(cat "$ERR_FILE")"; teardown_case; return; }
  teardown_case
  setup_case
  run_spawn --name r2c-newline --kind codex --cwd "$REPO_DIR" -- -c $'model=o3\napproval_policy="on-request"'
  [ "$CODE" -eq 5 ] && [ "$(stderr_error_code)" = isolation_unsupported_agent_arg ] \
    || { fail_case "config newline value was accepted: $(cat "$ERR_FILE")"; teardown_case; return; }
  teardown_case
  ok "$CURRENT_TEST"
}

test_r2_allowlist_resume_last_tokens() {
  CURRENT_TEST="r2_allowlist_resume_last_tokens"
  setup_case
  run_spawn --name r2resume-id --kind codex --cwd "$REPO_DIR" -- -s read-only resume session-name
  assert_allowed_effective_present || { teardown_case; return; }
  [ "$(jq -c '.effective_agent_args' "$OUT_FILE")" = '["-s","read-only","-a","never","resume","session-name"]' ] \
    || { fail_case "resume id was not retained as the final tokens: $(cat "$OUT_FILE")"; teardown_case; return; }
  teardown_case
  setup_case
  run_spawn --name r2resume-last --kind codex --cwd "$REPO_DIR" -- resume --last
  assert_allowed_effective_present || { teardown_case; return; }
  [ "$(jq -c '.effective_agent_args' "$OUT_FILE")" = '["-a","never","resume","--last"]' ] \
    || { fail_case "resume --last was not retained as the final tokens: $(cat "$OUT_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_r2_refuses_quoted_unsafe_config_key() {
  CURRENT_TEST="r2_refuses_quoted_unsafe_config_key"
  assert_isolation_unsupported quoted-key sandbox_mode -- -c '"sandbox_mode"="danger-full-access"' \
    && ok "$CURRENT_TEST"
}

test_r2_refuses_config_table_value() {
  CURRENT_TEST="r2_refuses_config_table_value"
  assert_isolation_unsupported table-value profiles.x -- -c 'profiles.x={approval_policy="on-request"}' \
    && ok "$CURRENT_TEST"
}

test_r2_refuses_yolo_even_with_dangerous_override() {
  CURRENT_TEST="r2_refuses_yolo_even_with_dangerous_override"
  assert_isolation_unsupported yolo --yolo --allow-dangerous-agent-flags -- --yolo || return
  setup_case
  run_spawn --name r2-yolo-optout --kind codex --cwd "$REPO_DIR" --no-isolation -- --yolo
  [ "$CODE" -eq 0 ] && [ "$(stdout_field '.outbound_isolation')" = none ] \
    || { fail_case "--no-isolation did not act as the explicit opt-out: $(cat "$ERR_FILE")"; teardown_case; return; }
  jq -e '.effective_agent_args == ["--yolo"]' "$OUT_FILE" >/dev/null 2>&1 \
    || { fail_case "opt-out did not preserve --yolo in effective args: $(cat "$OUT_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_r2_refuses_search() {
  CURRENT_TEST="r2_refuses_search"
  assert_isolation_unsupported search --search -- --search && ok "$CURRENT_TEST"
}

test_r2_refuses_cd() {
  CURRENT_TEST="r2_refuses_cd"
  assert_isolation_unsupported cd -C -- -C /path/to/worktree && ok "$CURRENT_TEST"
}

test_r2_refuses_exec_subcommand() {
  CURRENT_TEST="r2_refuses_exec_subcommand"
  assert_isolation_unsupported exec exec -- exec command && ok "$CURRENT_TEST"
}

test_r2_refuses_bare_prompt() {
  CURRENT_TEST="r2_refuses_bare_prompt"
  assert_isolation_unsupported bare-prompt 'write code' -- 'write code' && ok "$CURRENT_TEST"
}

test_r2_refuses_profile_without_sandbox() {
  CURRENT_TEST="r2_refuses_profile_without_sandbox"
  assert_isolation_unsupported profile-without-sandbox -p -- -p review && ok "$CURRENT_TEST"
}

test_r2_refuses_full_auto() {
  CURRENT_TEST="r2_refuses_full_auto"
  assert_isolation_unsupported full-auto --full-auto -- --full-auto && ok "$CURRENT_TEST"
}

test_r2_effective_args_and_json_argv_boundaries() {
  CURRENT_TEST="r2_effective_args_and_json_argv_boundaries"
  setup_case
  local model='model, "quoted" value' launched
  run_spawn --name r2-effective --kind codex --cwd "$REPO_DIR" -- -m "$model" -s read-only
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  jq -e --arg m "$model" '.agent_args == ["-m",$m,"-s","read-only"]' "$OUT_FILE" >/dev/null 2>&1 \
    || { fail_case "caller agent_args changed: $(cat "$OUT_FILE")"; teardown_case; return; }
  jq -e --arg m "$model" '.effective_agent_args == ["-m",$m,"-s","read-only","-a","never"]' "$OUT_FILE" >/dev/null 2>&1 \
    || { fail_case "effective args do not show injected approval: $(cat "$OUT_FILE")"; teardown_case; return; }
  launched="$(jq -sc 'map(select(.[0:3] == ["agent","start","r2-effective"])) | last | .[((index("--")) + 1):]' "$STUB_HERDR_JSON_LOG" 2>/dev/null)"
  printf '%s' "$launched" | jq -e --arg m "$model" '. == ["-m",$m,"-s","read-only","-a","never"]' >/dev/null 2>&1 \
    || { fail_case "herdr JSON argv log lost boundaries: $launched"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_r2_claude_only_barrier_detail() {
  CURRENT_TEST="r2_claude_only_barrier_detail"
  setup_case
  run_spawn --name r2-claude-auto --kind claude --cwd "$REPO_DIR" -- --permission-mode auto
  [ "$CODE" -eq 0 ] || { fail_case "auto spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in *auto*'ONLY barrier'*) ;;
    *) fail_case "auto detail does not identify the only barrier: $(cat "$OUT_FILE")"; teardown_case; return ;;
  esac
  teardown_case
  setup_case
  run_spawn --name r2-claude-bypass --kind claude --cwd "$REPO_DIR" \
    --allow-dangerous-agent-flags -- --dangerously-skip-permissions
  [ "$CODE" -eq 0 ] || { fail_case "authorized bypass spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in *'ONLY barrier'*) ;;
    *) fail_case "bypass detail does not identify the only barrier: $(cat "$OUT_FILE")"; teardown_case; return ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

wait_for_file() { # wait_for_file <path> [attempts]
  local path="$1" attempts="${2:-60}" i=0
  while [ "$i" -lt "$attempts" ]; do
    [ -e "$path" ] && return 0
    sleep 0.05
    i=$((i + 1))
  done
  return 1
}

test_r2_policy_lock_second_spawn_waits_then_succeeds() {
  CURRENT_TEST="r2_policy_lock_second_spawn_waits_then_succeeds"
  setup_case
  local ready="$SCRATCH/first-ready" release="$SCRATCH/release" out1="$SCRATCH/out1" err1="$SCRATCH/err1"
  local out2="$SCRATCH/out2" err2="$SCRATCH/err2" p1 p2 rc1 rc2
  export STUB_AGENT_START_HOLD_NAME=r2lock-one STUB_AGENT_START_READY="$ready" STUB_AGENT_START_RELEASE="$release"
  export STUB_AGENT_START_ERROR=invalid_arguments STUB_AGENT_START_ERROR_NAME=r2lock-one
  "$SPAWN" --name r2lock-one --kind codex --cwd "$REPO_DIR" >"$out1" 2>"$err1" & p1=$!
  if ! wait_for_file "$ready" 80; then
    wait "$p1" 2>/dev/null || true
    fail_case "first spawn never reached the held agent start"; teardown_case; return
  fi
  "$SPAWN" --name r2lock-two --kind codex --cwd "$REPO_DIR" >"$out2" 2>"$err2" & p2=$!
  sleep 0.2
  kill -0 "$p2" 2>/dev/null \
    || { fail_case "second spawn did not wait for the policy lock: $(cat "$err2")"; : >"$release"; wait "$p1" 2>/dev/null || true; teardown_case; return; }
  jq -se 'any(.[]; .[0:3] == ["agent","start","r2lock-two"]) | not' "$STUB_HERDR_JSON_LOG" >/dev/null 2>&1 \
    || { fail_case "second agent started before the first released the policy lock"; : >"$release"; wait "$p1" 2>/dev/null || true; wait "$p2" 2>/dev/null || true; teardown_case; return; }
  : >"$release"
  wait "$p1"; rc1=$?
  wait "$p2"; rc2=$?
  [ "$rc1" -eq 1 ] && [ "$rc2" -eq 0 ] \
    || { fail_case "waiter did not survive owner rollback: first=$rc1 second=$rc2; $(cat "$err1") $(cat "$err2")"; teardown_case; return; }
  [ -f "$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules" ] \
    || { fail_case "waiting spawn did not reinstall the policy after owner rollback"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.herdr-jutsu-policy.lock" ] \
    || { fail_case "policy lock survived successful starts"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_r2_policy_lock_timeout_is_clear() {
  CURRENT_TEST="r2_policy_lock_timeout_is_clear"
  setup_case
  /bin/mkdir "$REPO_DIR/.herdr-jutsu-policy.lock"
  export JUTSU_POLICY_LOCK_TIMEOUT_MS=150
  run_spawn --name r2lock-timeout --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -ne 0 ] || { fail_case "spawn ignored a contended policy lock"; teardown_case; return; }
  [ "$(stderr_error_code)" = isolation_policy_lock_timeout ] \
    || { fail_case "lock timeout was not clear JSON: $(cat "$ERR_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_r2_interrupt_between_create_and_bookkeeping_rolls_back() {
  CURRENT_TEST="r2_interrupt_between_create_and_bookkeeping_rolls_back"
  setup_case
  local ready="$SCRATCH/mkdir-ready" pid rc
  export STUB_INTERRUPT_MKDIR_TARGET="$REPO_DIR/.codex" STUB_INTERRUPT_MKDIR_READY="$ready"
  "$SPAWN" --name r2-signal --kind codex --cwd "$REPO_DIR" >"$OUT_FILE" 2>"$ERR_FILE" & pid=$!
  if ! wait_for_file "$ready" 80; then
    kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
    fail_case "spawn never entered the create/bookkeeping interrupt window"; teardown_case; return
  fi
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid"; rc=$?
  [ "$rc" -ne 0 ] || { fail_case "TERM unexpectedly produced success"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.codex" ] \
    || { fail_case "signal left the about-to-be-owned .codex path behind"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.herdr-jutsu-policy.lock" ] \
    || { fail_case "signal left the policy lock behind"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_r3_signal_after_successful_start_keeps_member_and_layer() {
  CURRENT_TEST="r3_signal_after_successful_start_keeps_member_and_layer"
  setup_case
  local ready="$SCRATCH/date-ready" pid
  export STUB_INTERRUPT_DATE_READY="$ready"
  "$SPAWN" --name r3-late-signal --kind codex --cwd "$REPO_DIR" >"$OUT_FILE" 2>"$ERR_FILE" & pid=$!
  if ! wait_for_file "$ready" 80; then
    kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
    fail_case "spawn never reached the post-start bookkeeping window"; teardown_case; return
  fi
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  unset STUB_INTERRUPT_DATE_READY
  [ -f "$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules" ] \
    || { fail_case "a signal after a SUCCESSFUL agent start deleted the live member's deny rules"; teardown_case; return; }
  if grep -Eq 'pane close' "$STUB_LOG"; then
    fail_case "a signal after a SUCCESSFUL agent start closed the live member's pane: $(grep -E 'pane close' "$STUB_LOG" | head -n1)"
    teardown_case; return
  fi
  [ ! -e "$REPO_DIR/.herdr-jutsu-policy.lock" ] \
    || { fail_case "policy lock left behind after a late signal"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_r3_stale_policy_lock_from_dead_holder_is_broken() {
  CURRENT_TEST="r3_stale_policy_lock_from_dead_holder_is_broken"
  setup_case
  local dead
  ( : ) & dead=$!
  wait "$dead" 2>/dev/null || true
  /bin/mkdir "$REPO_DIR/.herdr-jutsu-policy.lock"
  printf '%s\n' "$dead" >"$REPO_DIR/.herdr-jutsu-policy.lock/pid"
  export JUTSU_POLICY_LOCK_TIMEOUT_MS=1500
  run_spawn --name r3-stale-lock --kind codex --cwd "$REPO_DIR"
  unset JUTSU_POLICY_LOCK_TIMEOUT_MS
  [ "$CODE" -eq 0 ] \
    || { fail_case "a lock whose recorded holder is dead was not broken: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.herdr-jutsu-policy.lock" ] \
    || { fail_case "lock left behind after breaking a stale one"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_r3_live_policy_lock_is_respected_and_error_says_how_to_recover() {
  CURRENT_TEST="r3_live_policy_lock_is_respected_and_error_says_how_to_recover"
  setup_case
  /bin/mkdir "$REPO_DIR/.herdr-jutsu-policy.lock"
  printf '%s\n' "$$" >"$REPO_DIR/.herdr-jutsu-policy.lock/pid"
  export JUTSU_POLICY_LOCK_TIMEOUT_MS=300
  run_spawn --name r3-live-lock --kind codex --cwd "$REPO_DIR"
  unset JUTSU_POLICY_LOCK_TIMEOUT_MS
  [ "$CODE" -ne 0 ] && [ "$(stderr_error_code)" = isolation_policy_lock_timeout ] \
    || { fail_case "a lock held by a LIVE process was not respected: rc=$CODE $(cat "$ERR_FILE")"; teardown_case; return; }
  [ -d "$REPO_DIR/.herdr-jutsu-policy.lock" ] \
    || { fail_case "a live holder's lock was removed"; teardown_case; return; }
  grep -q 'rmdir\|remove' "$ERR_FILE" \
    || { fail_case "timeout error does not say how to recover: $(cat "$ERR_FILE")"; teardown_case; return; }
  /bin/rm -f "$REPO_DIR/.herdr-jutsu-policy.lock/pid"; /bin/rmdir "$REPO_DIR/.herdr-jutsu-policy.lock"
  ok "$CURRENT_TEST"
  teardown_case
}

test_r2_symlinked_info_dir_is_untouched() {
  CURRENT_TEST="r2_symlinked_info_dir_is_untouched"
  setup_case
  local target="$SCRATCH/info-target" before after
  mv "$REPO_DIR/.git/info" "$target"
  ln -s "$target" "$REPO_DIR/.git/info"
  before="$(cksum <"$target/exclude")"
  run_spawn --name r2-info-link --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  after="$(cksum <"$target/exclude")"
  [ "$before" = "$after" ] || { fail_case "symlinked info directory was written through"; teardown_case; return; }
  [ -L "$REPO_DIR/.git/info" ] || { fail_case "info symlink was replaced"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in *'NOT added'*info*) ;;
    *) fail_case "detail does not disclose skipped exclude entry: $(cat "$OUT_FILE")"; teardown_case; return ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

test_r2_symlinked_exclude_is_untouched() {
  CURRENT_TEST="r2_symlinked_exclude_is_untouched"
  setup_case
  local exclude="$REPO_DIR/.git/info/exclude" target="$SCRATCH/exclude-target" before after
  mv "$exclude" "$target"
  ln -s "$target" "$exclude"
  before="$(cksum <"$target")"
  run_spawn --name r2-exclude-link --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  after="$(cksum <"$target")"
  [ "$before" = "$after" ] || { fail_case "symlinked exclude was written through"; teardown_case; return; }
  [ -L "$exclude" ] || { fail_case "exclude symlink was replaced"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in *'NOT added'*exclude*) ;;
    *) fail_case "detail does not disclose skipped exclude entry: $(cat "$OUT_FILE")"; teardown_case; return ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

test_r2_real_codex_execpolicy_probes() {
  CURRENT_TEST="r2_real_codex_execpolicy_probes"
  local real_codex
  real_codex="$(PATH="$ORIGINAL_PATH" command -v codex 2>/dev/null || true)"
  case "$real_codex" in ""|"$STUB_DIR"/*)
    ok "$CURRENT_TEST # SKIP real codex is not available on the original PATH"
    return ;;
  esac
  setup_case
  run_spawn --name r2-real-policy --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "generator spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  local rules="$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules" resolved output label
  resolved="$(command -v herdr)"
  for label in bare absolute group; do
    case "$label" in
      bare) output="$("$real_codex" execpolicy check --rules "$rules" --resolve-host-executables -- herdr agent prompt x y 2>&1)" ;;
      absolute) output="$("$real_codex" execpolicy check --rules "$rules" --resolve-host-executables -- "$resolved" agent prompt x y 2>&1)" ;;
      group) output="$("$real_codex" execpolicy check --rules "$rules" --resolve-host-executables -- herdr workspace list 2>&1)" ;;
    esac
    printf '%s\n' "$output" | jq -R 'fromjson?' 2>/dev/null \
      | jq -se 'any(.[]; .decision == "forbidden")' >/dev/null 2>&1 \
      || { fail_case "real codex $label probe was not forbidden: $output"; teardown_case; return; }
  done
  [ -s "$STUB_HERDR_JSON_LOG" ] \
    || { fail_case "herdr stub did not produce JSON argv records"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-12 — bash -n under bash 3.2, self-contained sanity check (belt-and-braces; the done-
# check already runs this from the outer harness).
# =========================================================================================

test_ac12_bash_n_under_bash32() {
  CURRENT_TEST="ac12_bash_n_under_bash32"
  if /bin/bash -n "$SPAWN"; then
    ok "$CURRENT_TEST"
  else
    fail_case "/bin/bash -n $SPAWN failed"
  fi
}

# --- driver -------------------------------------------------------------------------------

test_ac12_bash_n_under_bash32
test_ac13_pane_closed_on_failure_after_split
test_ac13_worktree_orphaned_never_removed
test_ac13_in_pane_never_closed_rename_reverted
test_ac14_in_pane_refuses_vim_foreground
test_ac14_in_pane_refuses_agent_occupied
test_ac14_in_pane_refuses_unparseable_process_info
test_ac14_in_pane_accepts_idle_shell
test_ac15_agent_not_ready_retained_exit3
test_ac15_other_start_error_cleaned_up_exit1
test_ac15_missing_value_for_every_option
test_ac15_unknown_option_rejected
test_ac16_claude_dangerous_flags_refused
test_ac16_codex_dangerous_flags_refused
test_ac16_override_accepted_and_recorded
test_ac17_registry_modes_0700_0600
test_ac17_sandbox_readonly_registry_none
test_ac17_sandbox_workspace_write_registry_workspace
test_ac18_agent_args_roundtrip_as_json_array
test_ac18_resume_args_per_kind
test_ac18_redaction_in_output_not_in_real_argv
test_ac18_stream_rejects_path_traversal_and_slash
test_ac18_registry_symlink_refused
test_ac19_preflight_flag_reports_ok
test_ac19_preflight_runs_name_and_parent_checks
test_ac19_preflight_leaves_no_registry_residue
test_ac19_version_too_old_fails_preflight
test_ac19_version_ok_passes_preflight
test_ac19_t4_preflight_reports_herdr_unreachable_on_eperm
test_ac19_t4_preflight_reports_herdr_unreachable_on_non_json
test_ac19_t4_real_spawn_creates_nothing_when_herdr_unreachable
test_ac19_sandbox_hint_reported_both_ok_and_failing
test_ac19_reachable_with_unnamed_parent_still_ok
test_ac19_help_documents_herdr_unreachable
test_t8_record_session_appends_row_claude
test_t8_record_session_appends_row_codex
test_t9_record_session_uses_herdr_when_session_id_omitted
test_t9_record_session_null_herdr_session_no_flag_fails
test_t8_record_session_unknown_member_rejected
test_t8_record_session_symlinked_registry_refused
test_t8_record_session_preflight_conflict_refused
test_t8_record_session_help_documents_contract
test_record_session_status_is_current_never_stale
test_l1_beside_resolves_live_agent_name
test_l1_beside_resolves_registered_shell_name
test_l1_beside_resolves_literal_pane_id
test_l1_beside_unknown_anchor_refused
test_item10_help_documents_new_contract
test_stage0_codex_layer_written_with_resolved_herdr_path
test_stage0_differing_rules_refused_without_overwrite
test_stage0_info_exclude_normal_checkout_idempotent
test_stage0_info_exclude_linked_worktree_idempotent
test_stage0_codex_requires_never_and_injects_when_absent
test_stage0_no_isolation_writes_nothing_and_reports_none
test_stage0_claude_disallowed_tools_merged_once
test_stage0_preflight_reports_isolation_without_writing_layer
test_stage0_failure_cleanup_removes_written_policy_layer
test_stage0_in_pane_uses_actual_pane_cwd
test_f1_three_resolved_execpolicy_checks
test_f1_null_execpolicy_answer_downgrades_with_probe_reason
test_f2_all_sandbox_removal_spellings_refused
test_f3_all_approval_flag_spellings_refused
test_f3_all_approval_config_spellings_refused
test_f3_profiles_require_explicit_safe_sandbox_and_are_reported
test_f3_approve_for_me_refused
test_f4_all_policy_path_symlinks_refused_before_creation
test_f4_identical_preexisting_rules_survive_rollback
test_f4_preexisting_empty_codex_dir_survives_rollback
test_f5_exclude_without_trailing_newline_is_not_glued
test_f5_preexisting_exclude_line_is_not_owned_or_removed
test_f6_tracked_conflict_in_base_refused_before_worktree_creation
test_f7_stub_absolute_match_also_requires_forbidden_prefix
test_r2_allowlist_sandbox_spellings
test_r2_allowlist_approval_spellings
test_r2_allowlist_model_spellings
test_r2_allowlist_profile_spellings_with_sandbox
test_r2_allowlist_add_dir_spellings
test_r2_allowlist_config_keys_and_spellings
test_r2_allowlist_resume_last_tokens
test_r2_refuses_quoted_unsafe_config_key
test_r2_refuses_config_table_value
test_r2_refuses_yolo_even_with_dangerous_override
test_r2_refuses_search
test_r2_refuses_cd
test_r2_refuses_exec_subcommand
test_r2_refuses_bare_prompt
test_r2_refuses_profile_without_sandbox
test_r2_refuses_full_auto
test_r2_effective_args_and_json_argv_boundaries
test_r2_claude_only_barrier_detail
test_r2_policy_lock_second_spawn_waits_then_succeeds
test_r2_policy_lock_timeout_is_clear
test_r2_interrupt_between_create_and_bookkeeping_rolls_back
test_r2_symlinked_info_dir_is_untouched
test_r2_symlinked_exclude_is_untouched
test_r2_real_codex_execpolicy_probes
test_r3_signal_after_successful_start_keeps_member_and_layer
test_r3_stale_policy_lock_from_dead_holder_is_broken
test_r3_live_policy_lock_is_respected_and_error_says_how_to_recover

TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS ($TOTAL tests)"
  exit 0
else
  echo "FAILED ($FAIL of $TOTAL)"
  exit 1
fi
