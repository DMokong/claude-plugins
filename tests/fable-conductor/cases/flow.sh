# cases/flow.sh — the assembled adapter: launch vector, lifecycle, manifest, result classes.

flow_run() { # flow_run [extra args...]
  local args=() line
  while IFS= read -r line; do args+=("$line"); done < <(default_run_args)
  run_adapter "${args[@]}" "$@"
}

flow_mutate() { # flow_mutate <shell-body> -> exports FC_STUB_MUTATE
  local m="$CASE_ROOT/work/mutate.sh"
  printf '#!/bin/bash\n%s\n' "$1" >"$m"
  chmod +x "$m"
  export FC_STUB_MUTATE="$m"
}

flow_violation_paths() { # prints the out_of_scope paths of the last result, one per line
  jq -r '.violations[] | select(.kind == "out_of_scope") | .paths[]' "$(last_run_dir)/result.json"
}

# --- L-12 / L-13 / L-15 the launch vector ---------------------------------------------------

test_flow_l12_argv_matches_the_full_golden() {
  setup_case
  mk_fixture
  mk_codex_config alpha beta-2 --nested alpha env
  FC_GOLDEN_MODEL=gpt-5.6-sol FC_GOLDEN_EFFORT=medium
  flow_run --model gpt-5.6-sol
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_channel stdout || { teardown_case; return; }
  assert_codex_calls exec 1 || { teardown_case; return; }
  assert_argv_golden 1 "$SUITE_DIR/golden/argv.txt" || { teardown_case; return; }
  # cwd of the launch is the checkout
  local idx; idx="$(exec_call_index 1)"
  assert_eq "$(cat "$FC_STUB_STATE/codex.$idx.cwd")" "$CHECKOUT" "launch cwd" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l12_argv_matches_the_minimal_golden() {
  setup_case
  mk_fixture
  # no $CODEX_HOME/config.toml at all and no --model: the two variable segments vanish
  FC_GOLDEN_MODEL="" FC_GOLDEN_EFFORT=medium
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_argv_golden 1 "$SUITE_DIR/golden/argv.min.txt" || { teardown_case; return; }
  assert_eq "$(grep -c . "$CASE_ROOT/argv.got" | tr -d ' ')" "50" "argv element count" \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l14_no_forbidden_flag_in_the_recorded_argv() {
  setup_case
  mk_fixture
  mk_codex_config alpha
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  local idx; idx="$(exec_call_index 1)"
  stub_argv "$idx" >"$CASE_ROOT/argv.lines"
  local bad
  for bad in --ignore-user-config --dangerously-bypass-approvals-and-sandbox --full-auto --add-dir --profile -p; do
    if grep -Fxq -- "$bad" "$CASE_ROOT/argv.lines"; then
      fail_case "forbidden flag reached the launch: $bad"
      teardown_case; return
    fi
  done
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l15_child_stdin_is_closed() {
  setup_case
  mk_fixture
  export FC_STUB_READ_STDIN=1
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  local idx; idx="$(exec_call_index 1)"
  assert_eq "$(cat "$FC_STUB_STATE/codex.$idx.stdin_bytes")" "0" "stdin bytes read by the child" \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-16 the prober gates the launch ---------------------------------------------------------

test_flow_l16_adapter_refuses_without_a_passing_prober() {
  setup_case
  mk_fixture
  export FC_STUB_POLICY_DECISION=allow
  flow_run
  assert_eq "$CODE" 4 "exit" || { teardown_case; return; }
  assert_channel stderr || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "policy_unavailable" and .phase == "probe"' || { teardown_case; return; }
  assert_json "$ERR_FILE" '.detail.cause == "probe_not_forbidden"' || { teardown_case; return; }
  assert_codex_calls exec 0 || { teardown_case; return; }
  if [ -e "$FC_ADAPTER_ROOT/runs" ]; then
    fail_case "a run directory was created despite the refused probe"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l16_probe_runs_before_the_baseline() {
  setup_case
  mk_fixture
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  # the three execpolicy probes are recorded before the exec call
  local first_exec; first_exec="$(exec_call_index 1)"
  assert_eq "$(cat "$FC_STUB_STATE/codex.1.mode")" "version" "call 1 is --version" || { teardown_case; return; }
  assert_eq "$(cat "$FC_STUB_STATE/codex.2.mode")" "execpolicy" "call 2 is a probe" || { teardown_case; return; }
  assert_eq "$first_exec" "5" "the launch is the fifth recorded call" || { teardown_case; return; }
  # the deny layer was installed in the checkout before the baseline was taken, so the
  # manifest records it as pre-existing and never as a mutation
  assert_json "$(last_run_dir)/result.json" \
    '(.violations | map(select(.kind == "sensitive_namespace")) | length) == 0' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-18 run directory and files ----------------------------------------------------------------

test_flow_l18_run_directory_files_and_modes() {
  setup_case
  mk_fixture
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  local rd; rd="$(last_run_dir)"
  assert_mode "$rd" 700 || { teardown_case; return; }
  assert_mode "$FC_ADAPTER_ROOT" 700 || { teardown_case; return; }
  local f
  for f in envelope.json prompt.md schema.json argv.json run.log events.jsonl out.json \
           manifest.pre.json manifest.post.json result.json section.md; do
    if [ ! -f "$rd/$f" ]; then fail_case "missing run-directory file: $f"; teardown_case; return; fi
  done
  assert_mode "$rd/run.log" 600 || { teardown_case; return; }
  assert_mode "$rd/events.jsonl" 600 || { teardown_case; return; }
  if [ -e "$rd/index.tmp" ]; then fail_case "the temporary index survived the run"; teardown_case; return; fi
  # argv.json hides the prompt behind its digest
  assert_json "$rd/argv.json" '(.[-1] | test("^<PROMPT sha256=[0-9a-f]{64}>$"))' || { teardown_case; return; }
  # schema.json is a byte copy of the shipped contract
  assert_file_eq "$rd/schema.json" "$(sut_script implementer-output.schema.json)" || { teardown_case; return; }
  # the EXIT trap released the checkout lock and left no scratch behind
  local digest; digest="$(printf '%s' "$CHECKOUT" | shasum -a 256 | cut -d' ' -f1)"
  if [ -e "$FC_ADAPTER_ROOT/locks/$digest" ]; then
    fail_case "the checkout lock survived the run"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-19 timeout and the process group -------------------------------------------------------------

# A child that ends on its own must never be reported as a timeout, even when the watchdog
# has already declared one: the marker alone cannot establish who ended the child. The
# watchdog fires at ~1s while the child is alive and has already written its output; the
# child ignores the TERM and exits 0 by itself at ~2s. That is the same end state the
# natural race produces (marker set, child reaped with its own status), reached
# deterministically instead of by timing luck. Before the fix this reported
# adapter_timeout and the conductor would have re-run work that had actually succeeded.
test_flow_watchdog_loses_race_to_a_normal_exit() {
  setup_case
  mk_fixture
  export FC_TEST_TIMEOUT_S=1 FC_TEST_KILL_GRACE_S=5
  export FC_STUB_SLEEP=2 FC_STUB_IGNORE_TERM=1
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_channel stdout || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "ok"' || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" \
    '.class == "ok" and .child.ended_by == "exited" and .child.exit == 0' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l19_timeout_kills_the_group_including_a_grandchild() {
  setup_case
  mk_fixture
  export FC_TEST_TIMEOUT_S=2 FC_TEST_KILL_GRACE_S=1
  export FC_STUB_SLEEP=120 FC_STUB_IGNORE_TERM=1 FC_STUB_FORK_GRANDCHILD=1
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_channel stdout || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "adapter_timeout"' || { teardown_case; return; }
  local rd idx leader grand
  rd="$(last_run_dir)"
  assert_json "$rd/result.json" '.class == "adapter_timeout" and .child.ended_by == "timeout"' \
    || { teardown_case; return; }
  idx="$(exec_call_index 1)"
  leader="$(cat "$FC_STUB_STATE/codex.$idx.pid")"
  grand="$(cat "$FC_STUB_STATE/codex.$idx.grandchild" 2>/dev/null || true)"
  if [ -z "$grand" ]; then fail_case "the stub did not record a grandchild pid"; teardown_case; return; fi
  assert_no_process "$leader" || { teardown_case; return; }
  assert_no_process "$grand" || { teardown_case; return; }
  # a timed-out run still reports what it changed
  assert_json "$rd/result.json" '(.changed_paths | type) == "array"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-24 / L-25 output binding and the six-key contract ---------------------------------------------

flow_binding_case() { # flow_binding_case <FC_STUB_OUT value> <expected phase>
  mk_fixture
  export FC_STUB_OUT="$1"
  flow_run
  assert_eq "$CODE" 3 "exit" || return 1
  assert_channel stdout || return 1
  assert_json "$OUT_FILE" '.class == "malformed_result"' || return 1
  local got; got="$(jq -r .phase "$OUT_FILE")"
  assert_eq "$got" "$2" "phase" || return 1
  return 0
}

test_flow_l24_missing_output_is_binding() {
  setup_case
  flow_binding_case '@none' output_binding && ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l24_output_path_is_free_at_launch() {
  setup_case
  mk_fixture
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  local idx; idx="$(exec_call_index 1)"
  assert_eq "$(cat "$FC_STUB_STATE/codex.$idx.out_existed")" "0" \
    "the -o target existed before the launch" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l24_symlinked_output_is_binding() {
  setup_case
  mk_fixture
  printf '{"summary":"x","files_changed":[],"commits":[],"commands_run":[],"tracker_note":null,"blocked_reason":null}\n' \
    >"$CASE_ROOT/work/elsewhere.json"
  export FC_STUB_OUT="@symlink:$CASE_ROOT/work/elsewhere.json"
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "malformed_result" and .phase == "output_binding"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l24_directory_output_is_binding() {
  setup_case
  flow_binding_case '@dir' output_binding && ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l24_fifo_output_is_binding_and_never_opened() {
  setup_case
  flow_binding_case '@fifo' output_binding && ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l25_malformed_json_is_schema() {
  setup_case
  mk_fixture
  printf 'not json at all\n' >"$CASE_ROOT/work/bad.json"
  export FC_STUB_OUT="$CASE_ROOT/work/bad.json"
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "malformed_result" and .phase == "output_schema"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l25_contract_violations_are_schema() {
  setup_case
  mk_fixture
  local f="$CASE_ROOT/work/bad.json" body
  # an extra key at the top level
  printf '%s\n' '{"summary":"x","files_changed":[],"commits":[],"commands_run":[],"tracker_note":null,"blocked_reason":null,"extra":1}' >"$f"
  export FC_STUB_OUT="$f"
  flow_run
  assert_json "$OUT_FILE" '.class == "malformed_result" and .phase == "output_schema"' || { teardown_case; return; }
  # a missing key
  printf '%s\n' '{"summary":"x","files_changed":[],"commits":[],"commands_run":[],"tracker_note":null}' >"$f"
  flow_run
  assert_json "$OUT_FILE" '.class == "malformed_result" and .phase == "output_schema"' || { teardown_case; return; }
  # a wrong type
  printf '%s\n' '{"summary":42,"files_changed":[],"commits":[],"commands_run":[],"tracker_note":null,"blocked_reason":null}' >"$f"
  flow_run
  assert_json "$OUT_FILE" '.class == "malformed_result" and .phase == "output_schema"' || { teardown_case; return; }
  # a bad commit id
  printf '%s\n' '{"summary":"x","files_changed":[],"commits":["nothex"],"commands_run":[],"tracker_note":null,"blocked_reason":null}' >"$f"
  flow_run
  assert_json "$OUT_FILE" '.class == "malformed_result" and .phase == "output_schema"' || { teardown_case; return; }
  # an extra key inside commands_run
  printf '%s\n' '{"summary":"x","files_changed":[],"commits":[],"commands_run":[{"cmd":"true","exit":0,"tail":"","oops":1}],"tracker_note":null,"blocked_reason":null}' >"$f"
  flow_run
  assert_json "$OUT_FILE" '.class == "malformed_result" and .phase == "output_schema"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-27 / L-28 engine signatures, usage, and stderr is never the classifier ----------------------

test_flow_l27_known_signature_is_engine_unavailable() {
  setup_case
  mk_fixture
  local ev="$CASE_ROOT/work/events.jsonl"
  {
    printf '%s\n' '{"type":"thread.started","thread_id":"t"}'
    printf '%s\n' '{"type":"error","message":"Selected model is at capacity. Please try a different model."}'
    printf '%s\n' '{"type":"turn.failed","error":{"message":"Selected model is at capacity."}}'
  } >"$ev"
  export FC_STUB_EVENTS="$ev" FC_STUB_EXIT=1 FC_STUB_OUT=@none
  flow_run
  assert_eq "$CODE" 4 "exit" || { teardown_case; return; }
  assert_channel stdout || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "engine_unavailable" and .phase == "signature" and .transient == true' \
    || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" '.signature == "model_at_capacity" and .transient == true' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l27_unlisted_message_is_worker_failed() {
  setup_case
  mk_fixture
  local ev="$CASE_ROOT/work/events.jsonl"
  printf '%s\n' '{"type":"error","message":"You have exhausted your weekly quota."}' >"$ev"
  export FC_STUB_EVENTS="$ev" FC_STUB_EXIT=1 FC_STUB_OUT=@none
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "worker_failed" and .phase == "worker_exit"' || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" '.signature == null' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l27_stderr_is_never_the_classifier() {
  setup_case
  mk_fixture
  local se="$CASE_ROOT/work/stderr.txt"
  printf 'Selected model is at capacity. Please try a different model.\n' >"$se"
  export FC_STUB_STDERR="$se" FC_STUB_EXIT=1 FC_STUB_OUT=@none
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "worker_failed" and .phase == "worker_exit"' || { teardown_case; return; }
  # the text landed in run.log, never in the classifier
  if ! grep -q 'at capacity' "$(last_run_dir)/run.log"; then
    fail_case "the child's stderr did not reach run.log"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l19_signal_death_is_worker_failed_signal() {
  setup_case
  mk_fixture
  export FC_STUB_SELF_SIGNAL=KILL FC_STUB_OUT=@none
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "worker_failed" and .phase == "signal"' || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" '.child.ended_by == "signaled" and .child.signal == 9' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l28_usage_is_summed_from_turn_completed() {
  setup_case
  mk_fixture
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" \
    '.usage.input_tokens == 100 and .usage.cached_input_tokens == 20 and .usage.output_tokens == 30 and .usage.events == 1 and .usage_error == null' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l28_negative_usage_yields_usage_error() {
  setup_case
  mk_fixture
  local ev="$CASE_ROOT/work/events.jsonl"
  printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":-5,"cached_input_tokens":0,"output_tokens":1}}' >"$ev"
  printf '%s\n' 'this line is not json at all' >>"$ev"
  export FC_STUB_EVENTS="$ev"
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" '.usage == null and (.usage_error | type) == "string" and .class == "ok"' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-29 / L-30 / L-31 the mutation manifest ----------------------------------------------------

test_flow_l31_clean_in_scope_change_passes() {
  setup_case
  mk_fixture
  flow_mutate 'printf "changed\n" > src/a.txt; printf "new\n" > src/new.txt'
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_channel stdout || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "ok" and .blocked == false' || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" \
    '.changed_paths == ["src/a.txt","src/new.txt"] and .violations == []' || { teardown_case; return; }
  # the adapter's own observation, never the member's claim
  assert_json "$(last_run_dir)/result.json" '.member.files_changed == []' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l31_a_run_that_changes_nothing_passes() {
  setup_case
  mk_fixture
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" '.changed_paths == [] and .violations == []' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l29_out_of_scope_edit_is_a_violation() {
  setup_case
  mk_fixture
  flow_mutate 'printf "tampered\n" > docs/b.txt'
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_channel stdout || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "policy_violation" and .phase == "manifest"' || { teardown_case; return; }
  assert_eq "$(flow_violation_paths)" "docs/b.txt" "violating path" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l29_out_of_scope_delete_is_a_violation() {
  setup_case
  mk_fixture
  flow_mutate 'rm -f README.md'
  flow_run
  assert_json "$OUT_FILE" '.class == "policy_violation"' || { teardown_case; return; }
  assert_eq "$(flow_violation_paths)" "README.md" "violating path" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l29_rename_with_one_endpoint_out_of_scope() {
  setup_case
  mk_fixture
  flow_mutate 'mv src/a.txt docs/a.txt'
  flow_run
  assert_json "$OUT_FILE" '.class == "policy_violation"' || { teardown_case; return; }
  # BOTH endpoints are changed paths; only the out-of-scope one is a violation
  assert_json "$(last_run_dir)/result.json" \
    '(.changed_paths | index("src/a.txt")) != null and (.changed_paths | index("docs/a.txt")) != null' \
    || { teardown_case; return; }
  assert_eq "$(flow_violation_paths)" "docs/a.txt" "violating endpoint" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l30_hostile_filenames_are_reported_exactly() {
  setup_case
  mk_fixture
  flow_mutate '
mkdir -p docs
printf x > "docs/has space.txt"
printf x > "$(printf "docs/has\ttab.txt")"
printf x > "$(printf "docs/has\nnewline.txt")"
printf x > "./-leading-dash.txt"
printf x > "docs/glob*?[x].txt"
'
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "policy_violation"' || { teardown_case; return; }
  local rj; rj="$(last_run_dir)/result.json"
  assert_json "$rj" '(.violations[] | select(.kind == "out_of_scope") | .paths | length) == 5' \
    || { teardown_case; return; }
  local want
  for want in 'docs/has space.txt' 'docs/has	tab.txt' '-leading-dash.txt' 'docs/glob*?[x].txt'; do
    if ! jq -e --arg p "$want" '.changed_paths | index($p) != null' "$rj" >/dev/null 2>&1; then
      fail_case "path not reported exactly: $want"
      teardown_case; return
    fi
  done
  if ! jq -e '.changed_paths | map(select(test("\n"))) | length == 1' "$rj" >/dev/null 2>&1; then
    fail_case "the newline-bearing path was not reported as one path"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l29_write_under_dot_codex_is_a_sensitive_violation() {
  setup_case
  mk_fixture
  flow_mutate 'mkdir -p .codex/rules; printf "tampered\n" >> .codex/config.toml'
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "policy_violation" and .phase == "manifest"' || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" \
    '(.violations[] | select(.kind == "sensitive_namespace") | .paths | index("config.toml") // (.[0] | startswith(".codex/"))) != null' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l29_write_under_the_hooks_dir_is_a_sensitive_violation() {
  setup_case
  mk_fixture
  flow_mutate 'printf "#!/bin/sh\nexit 0\n" > "$(git rev-parse --git-common-dir)/hooks/pre-commit"'
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" \
    '(.violations | map(select(.kind == "sensitive_namespace")) | length) == 1' || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" \
    '(.violations[] | select(.kind == "sensitive_namespace") | .paths[0] | startswith("<hooks>/"))' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l29_moved_head_is_a_violation() {
  setup_case
  mk_fixture
  flow_mutate 'git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m sneaky'
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" \
    '(.violations | map(.kind) | index("head_changed")) != null' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l29_staged_index_change_is_a_violation() {
  setup_case
  mk_fixture
  flow_mutate 'printf "changed\n" > src/a.txt; git add src/a.txt'
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" \
    '(.violations | map(.kind) | index("index_changed")) != null' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l31_pre_dirty_out_of_scope_file_left_alone_passes() {
  setup_case
  mk_fixture
  printf 'dirty before the run\n' >"$CHECKOUT/docs/b.txt"
  flow_mutate 'printf "in scope\n" > src/a.txt'
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" '.changed_paths == ["src/a.txt"] and .violations == []' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l31_out_of_scope_file_dirty_before_and_changed_again_is_a_violation() {
  setup_case
  mk_fixture
  printf 'dirty before the run\n' >"$CHECKOUT/docs/b.txt"
  flow_mutate 'printf "dirty again\n" > docs/b.txt'
  flow_run
  assert_eq "$CODE" 3 "exit" || { teardown_case; return; }
  assert_eq "$(flow_violation_paths)" "docs/b.txt" "violating path" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-26 / L-33 member data and the report section ---------------------------------------------

test_flow_l26_blocked_reason_and_tracker_note_are_data() {
  setup_case
  mk_fixture
  local f="$CASE_ROOT/work/out.json"
  printf '%s\n' '{"summary":"could not finish","files_changed":[],"commits":[],"commands_run":[],"tracker_note":"ask the conductor about the schema","blocked_reason":"the brief contradicts the spec"}' >"$f"
  export FC_STUB_OUT="$f"
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.class == "ok" and .blocked == true' || { teardown_case; return; }
  assert_json "$(last_run_dir)/result.json" \
    '.blocked == true and .tracker_note == "ask the conductor about the schema" and .blocked_reason == "the brief contradicts the spec"' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l33_section_quotes_every_member_line() {
  setup_case
  mk_fixture
  local f="$CASE_ROOT/work/out.json"
  jq -c -n '{summary:"line one\n## Forged heading\n```\nfenced\n```",
             files_changed:["src/a.txt"], commits:[],
             commands_run:[{cmd:"/bin/bash -n script.sh",exit:0,tail:"first\nsecond"}],
             tracker_note:null, blocked_reason:null}' >"$f"
  export FC_STUB_OUT="$f"
  flow_mutate 'printf "changed\n" > src/a.txt'
  flow_run
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  local s; s="$(last_run_dir)/section.md"
  assert_eq "$(sed -n 1p "$s")" "## implementer — round 1" "section first line" || { teardown_case; return; }
  # no member line can start at column 0
  if grep -n '^## Forged heading' "$s" >/dev/null 2>&1; then
    fail_case "a member heading escaped the blockquote"
    teardown_case; return
  fi
  if ! grep -q '^> ## Forged heading$' "$s"; then
    fail_case "the member heading was not quoted"
    teardown_case; return
  fi
  if ! grep -q '^- `"src/a.txt"`$' "$s"; then
    fail_case "the adapter-observed path was not rendered as a JSON string in backticks"
    teardown_case; return
  fi
  if ! grep -q '^#### exit 0$' "$s"; then
    fail_case "the command block is missing"
    teardown_case; return
  fi
  # ends with exactly one LF
  assert_eq "$(tail -c 1 "$s" | od -An -c | tr -d ' ')" '\n' "section ends with one LF" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_flow_l46_no_network_client_in_the_shipped_scripts() {
  setup_case
  local d; d="${FC_SUT_ROOT:-$REPO_ROOT}/plugins/fable-conductor/skills/conduct/scripts"
  # the needles are assembled so this file does not itself contain the literals a repo-level
  # scan looks for
  local net="cu""rl|wg""et| n""c |ss""h |git (fet""ch|pu""ll|pu""sh|clo""ne)"
  if grep -rnE "$net" "$d" >/dev/null 2>&1; then
    fail_case "a network client appears in the shipped scripts"
    teardown_case; return
  fi
  local paths="real""path|read""link|\bfi""nd \b"
  if grep -rnE "$paths" "$d" >/dev/null 2>&1; then
    fail_case "a forbidden path tool appears in the shipped scripts"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}
