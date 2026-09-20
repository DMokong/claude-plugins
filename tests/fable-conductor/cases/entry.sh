# cases/entry.sh — the adapter's CLI surface: option matrix, refusals, engine config, egress,
# isolation config, lock, class registry. Nothing here launches a worker.

# assert_untouched — neither the checkout nor the adapter root gained anything, and no codex
# subprocess ran at all.
assert_untouched() {
  local before="$1"
  local after="$CASE_ROOT/after.txt"
  snapshot_tree "$CHECKOUT" "$after"
  assert_tree_unchanged "$before" "$after" || return 1
  if [ -e "$FC_ADAPTER_ROOT" ]; then
    fail_case "the adapter root was created: $FC_ADAPTER_ROOT"
    return 1
  fi
  assert_codex_calls any 0 || return 1
  assert_herdr_calls 0 || return 1
  return 0
}

entry_usage_case() { # entry_usage_case <reason> <args...>
  local reason="$1" before="$CASE_ROOT/before.txt"
  shift
  mk_fixture
  snapshot_tree "$CHECKOUT" "$before"
  run_adapter "$@"
  assert_eq "$CODE" 2 "exit" || return 1
  assert_channel stderr || return 1
  assert_json "$ERR_FILE" '.class == "usage"' || return 1
  local got; got="$(jq -r '.reason // ""' "$ERR_FILE")"
  assert_eq "$got" "$reason" "usage reason" || return 1
  assert_untouched "$before" || return 1
  return 0
}

base_args() { # prints the canonical run vector, one element per line
  default_run_args
}

run_default() { # run_default [extra args...]
  local args=() line
  while IFS= read -r line; do args+=("$line"); done < <(default_run_args)
  run_adapter "${args[@]}" "$@"
}

# --- L-9 option matrix -----------------------------------------------------------------------

test_entry_l9_unknown_option() {
  setup_case
  mk_fixture
  local before="$CASE_ROOT/before.txt"; snapshot_tree "$CHECKOUT" "$before"
  run_default --bogus x
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  assert_channel stderr || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "unknown_option"' || { teardown_case; return; }
  assert_untouched "$before" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_duplicate_option() {
  setup_case
  mk_fixture
  local before="$CASE_ROOT/before.txt"; snapshot_tree "$CHECKOUT" "$before"
  run_default --task "$TASK"
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "duplicate_option" and .field == "task"' \
    || { teardown_case; return; }
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  assert_untouched "$before" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_missing_value() {
  setup_case
  entry_usage_case missing_value run --stream-dir && ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_positional_rejected() {
  setup_case
  mk_fixture
  local before="$CASE_ROOT/before.txt"; snapshot_tree "$CHECKOUT" "$before"
  run_default stray
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "positional"' || { teardown_case; return; }
  assert_untouched "$before" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_double_dash_rejected() {
  setup_case
  mk_fixture
  run_default --
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "double_dash"' || { teardown_case; return; }
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_missing_required_option() {
  setup_case
  mk_fixture
  run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 1 --checkout "$CHECKOUT" \
    --expected-branch "$BRANCH" --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE"
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "missing_option" and .field == "effort"' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_bad_round_and_timeout() {
  setup_case
  mk_fixture
  run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 0 --checkout "$CHECKOUT" \
    --expected-branch "$BRANCH" --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE" --effort medium
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "bad_value" and .field == "round"' \
    || { teardown_case; return; }
  run_default --timeout 42
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "bad_value" and .field == "timeout"' \
    || { teardown_case; return; }
  run_default --timeout notanumber
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "bad_value" and .field == "timeout"' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_findings_rules() {
  setup_case
  mk_fixture
  local f="$CASE_ROOT/work/findings.md"
  mk_text_file "$f" 200
  run_default --findings "$f"
  assert_json "$ERR_FILE" '.class == "usage" and .field == "findings"' || { teardown_case; return; }
  # round 2 without findings
  run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 2 --checkout "$CHECKOUT" \
    --expected-branch "$BRANCH" --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE" --effort medium
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "missing_option" and .field == "findings"' \
    || { teardown_case; return; }
  # rulings without findings
  run_default --rulings "$f"
  assert_json "$ERR_FILE" '.class == "usage" and .field == "rulings"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_noncanonical_checkout_is_usage() {
  setup_case
  mk_fixture
  run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 1 \
    --checkout "$CASE_ROOT/work/./wt" --expected-branch "$BRANCH" --spec "$SPEC" \
    --base "$BASE" --scope-file "$SCOPE_FILE" --effort medium
  assert_json "$ERR_FILE" '.class == "usage" and .field == "checkout"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_help_lists_fourteen_options() {
  setup_case
  mk_fixture
  run_adapter run --help
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_empty "$ERR_FILE" || { teardown_case; return; }
  assert_eq "$(grep -c '^--' "$OUT_FILE" | tr -d ' ')" "14" "option count" || { teardown_case; return; }
  assert_eq "$(wc -l <"$OUT_FILE" | tr -d ' ')" "14" "line count" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l9_unknown_subcommand() {
  setup_case
  run_adapter frobnicate
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "usage" and .reason == "unknown_subcommand"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-11 engine config ------------------------------------------------------------------------

test_entry_l11_unknown_effort() {
  setup_case
  mk_fixture
  local before="$CASE_ROOT/before.txt"; snapshot_tree "$CHECKOUT" "$before"
  run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 1 --checkout "$CHECKOUT" \
    --expected-branch "$BRANCH" --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE" --effort ludicrous
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "invalid_engine_config" and .reason == "unknown_effort"' \
    || { teardown_case; return; }
  assert_untouched "$before" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l11_bad_model() {
  setup_case
  mk_fixture
  run_default --model 'bad model/name'
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "invalid_engine_config" and .reason == "bad_model"' \
    || { teardown_case; return; }
  assert_codex_calls any 0 || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-10 preflight refusals ---------------------------------------------------------------------

test_entry_l10_main_checkout_refused() {
  setup_case
  mk_fixture
  local main="$CASE_ROOT/work/main" main_canon
  main_canon="$(cd -P -- "$main" && pwd -P)"
  run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 1 --checkout "$main_canon" \
    --expected-branch master --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE" --effort medium
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "refused" and .phase == "preflight" and .reason == "main_checkout"' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l10_not_toplevel_refused() {
  setup_case
  mk_fixture
  run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 1 --checkout "$CHECKOUT/src" \
    --expected-branch "$BRANCH" --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE" --effort medium
  assert_json "$ERR_FILE" '.class == "refused" and .reason == "not_toplevel"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l10_detached_head_refused() {
  setup_case
  mk_fixture
  git -C "$CHECKOUT" checkout -q --detach HEAD
  run_default
  assert_json "$ERR_FILE" '.class == "refused" and .reason == "detached_head"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l10_branch_mismatch_refused() {
  setup_case
  mk_fixture
  run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 1 --checkout "$CHECKOUT" \
    --expected-branch other --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE" --effort medium
  assert_json "$ERR_FILE" '.class == "refused" and .reason == "branch_mismatch"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l10_not_codex_task_refused() {
  setup_case
  mk_fixture claude
  local before="$CASE_ROOT/before.txt"; snapshot_tree "$CHECKOUT" "$before"
  run_default
  assert_json "$ERR_FILE" '.class == "refused" and .reason == "not_codex_task"' || { teardown_case; return; }
  assert_untouched "$before" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-22 egress ---------------------------------------------------------------------------------

test_entry_l22_egress_reject_before_anything_is_created() {
  setup_case
  mk_fixture
  local f="$CASE_ROOT/work/findings.md" before="$CASE_ROOT/before.txt"
  { printf 'Finding 1: the config leaked a credential.\n'; fc_sample openrouter_key; } >"$f"
  snapshot_tree "$CHECKOUT" "$before"
  run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 2 --checkout "$CHECKOUT" \
    --expected-branch "$BRANCH" --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE" \
    --effort medium --findings "$f"
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  assert_channel stderr || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "refused" and .phase == "egress" and .reason == "egress_reject"' \
    || { teardown_case; return; }
  assert_json "$ERR_FILE" '.detail.rule == "openrouter_key" and .field == "findings"' || { teardown_case; return; }
  # the finding never carries the matching text
  if grep -q "$(fc_sample openrouter_key)" "$ERR_FILE"; then
    fail_case "the error object leaked the matching text"; teardown_case; return
  fi
  assert_untouched "$before" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l22_every_rule_rejects_and_near_miss_allows() {
  setup_case
  mk_fixture
  local id f="$CASE_ROOT/work/findings.md" got
  for id in $FC_RULE_IDS; do
    { printf 'Round 1 finding:\n'; fc_sample "$id"; } >"$f"
    run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 2 --checkout "$CHECKOUT" \
      --expected-branch "$BRANCH" --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE" \
      --effort medium --findings "$f"
    got="$(jq -r '.detail.rule // ""' "$ERR_FILE" 2>/dev/null)"
    if [ "$got" != "$id" ]; then
      fail_case "rule $id did not reject its own sample (got '${got:-none}', exit $CODE)"
      teardown_case; return
    fi
    { printf 'Round 1 finding:\n'; fc_nearmiss "$id"; } >"$f"
    run_adapter run --stream-dir "$STREAM_DIR" --task "$TASK" --round 2 --checkout "$CHECKOUT" \
      --expected-branch "$BRANCH" --spec "$SPEC" --base "$BASE" --scope-file "$SCOPE_FILE" \
      --effort medium --findings "$f"
    if jq -e '.class == "refused" and .phase == "egress"' "$ERR_FILE" >/dev/null 2>&1; then
      fail_case "rule $id rejected its near-miss"
      teardown_case; return
    fi
  done
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-13 isolation config, L-14 forbidden flags -------------------------------------------------

test_entry_l13_malformed_mcp_table_name_refuses() {
  setup_case
  mk_fixture
  mk_codex_config --raw-name '"a b"'
  local before="$CASE_ROOT/before.txt"; snapshot_tree "$CHECKOUT" "$before"
  run_default
  assert_eq "$CODE" 4 "exit" || { teardown_case; return; }
  assert_channel stderr || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "policy_unavailable" and .phase == "isolation_config"' \
    || { teardown_case; return; }
  assert_codex_calls exec 0 || { teardown_case; return; }
  if [ -e "$FC_ADAPTER_ROOT/runs" ]; then fail_case "a run directory was created"; teardown_case; return; fi
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l14_forbidden_flags_absent_from_shipped_scripts() {
  setup_case
  local d="${FC_SUT_ROOT:-$REPO_ROOT}/plugins/fable-conductor/skills/conduct/scripts"
  # no forbidden flag is ever appended to the launch array (the guard's own case labels are
  # the only place the literals may appear; the runtime check lives in cases/flow.sh)
  if grep -nE 'FC_ARGV\+?=.*(--ignore-user-config|--dangerously-bypass-approvals-and-sandbox|--full-auto|--add-dir|--profile)' \
      "$d/codex-implementer.sh" >/dev/null 2>&1; then
    fail_case "a forbidden flag is appended to the launch array"
    teardown_case; return
  fi
  # the launch vector itself is built as an array, with no eval
  if grep -nE '\beval\b' "$d/codex-implementer.sh" >/dev/null 2>&1; then
    fail_case "the adapter uses eval"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-17 lock ------------------------------------------------------------------------------------

test_entry_l17_checkout_busy() {
  setup_case
  mk_fixture
  local digest lock
  digest="$(printf '%s' "$CHECKOUT" | shasum -a 256 | cut -d' ' -f1)"
  lock="$FC_ADAPTER_ROOT/locks/$digest"
  mkdir -p "$lock"
  printf '424242\n' >"$lock/pid"
  run_default
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  assert_channel stderr || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "refused" and .phase == "lock" and .reason == "checkout_busy"' \
    || { teardown_case; return; }
  assert_json "$ERR_FILE" '.detail.pid == 424242' || { teardown_case; return; }
  assert_json "$ERR_FILE" '.detail.remove | test("^rm -f .*/pid.; rmdir ")' || { teardown_case; return; }
  if [ ! -d "$lock" ]; then fail_case "the adapter removed a lock it did not take"; teardown_case; return; fi
  assert_codex_calls exec 0 || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_entry_l18_unsafe_root_refused() {
  setup_case
  mk_fixture
  FC_ADAPTER_ROOT="$CHECKOUT/.fc-root" run_default
  assert_eq "$CODE" 2 "exit" || { teardown_case; return; }
  assert_json "$ERR_FILE" '.class == "refused" and .reason == "unsafe_root"' || { teardown_case; return; }
  if [ -e "$CHECKOUT/.fc-root" ]; then fail_case "the unsafe root was created anyway"; teardown_case; return; fi
  ok "$CURRENT_TEST"
  teardown_case
}

# --- L-32 the class registry ------------------------------------------------------------------------

test_entry_l32_classes_matches_the_registry() {
  setup_case
  run_adapter classes
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_channel stdout || { teardown_case; return; }
  assert_json "$OUT_FILE" '.schema == 1 and (.classes | length) == 19' || { teardown_case; return; }
  jq -S . "$OUT_FILE" >"$CASE_ROOT/classes.got"
  jq -S . "$SUITE_DIR/golden/classes.json" >"$CASE_ROOT/classes.want"
  assert_file_eq "$CASE_ROOT/classes.got" "$CASE_ROOT/classes.want" || { teardown_case; return; }
  # exit codes and channels agree with the spec's coarse groups
  assert_json "$OUT_FILE" '
    .classes | all(. as $r |
      ($r.class == "ok" and $r.exit == 0)
      or ((["usage","refused","invalid_engine_config"] | index($r.class)) != null and $r.exit == 2)
      or ((["policy_violation","malformed_result","adapter_timeout","worker_failed"] | index($r.class)) != null and $r.exit == 3)
      or ((["engine_unavailable","policy_unavailable"] | index($r.class)) != null and $r.exit == 4))' \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}
