# cases/policy.sh — codex-policy.sh: fail-closed preflight, managed bytes, probes, idempotency.

FC_MANAGED_CONFIG='# Created by herdr-jutsu so Codex discovers the child-only project policy.'
FC_MANAGED_RULES_2='prefix_rule(pattern=["herdr"], decision="forbidden", justification="Crew members do not drive herdr; the parent pulls from this pane.")'

policy_fixture() {
  mk_repo "$CASE_ROOT/work/main"
  mk_worktree "$CASE_ROOT/work/main" "$CASE_ROOT/work/wt" feat
}

assert_prober_cause() { # assert_prober_cause <cause>
  local got
  assert_eq "$CODE" 1 "exit" || return 1
  assert_channel stderr || return 1
  got="$(jq -r '.cause // ""' "$ERR_FILE")"
  assert_eq "$got" "$1" "cause" || return 1
  assert_json "$ERR_FILE" '.ok == false and (.message | type) == "string"' || return 1
  return 0
}

# policy_preflight_case <cause> <setup-code> [prober-arg]
# Builds the fixture, applies the hostile setup, snapshots the checkout, runs the prober and
# proves: the right cause, exit 1, one error line on stderr, NOTHING written, herdr never
# executed and codex never invoked (the preflight decides before any probe).
policy_preflight_case() {
  local cause="$1" setup="$2" arg="${3:-}"
  local before="$CASE_ROOT/before.txt" after="$CASE_ROOT/after.txt"
  local gbefore="$CASE_ROOT/gbefore.txt" gafter="$CASE_ROOT/gafter.txt"
  policy_fixture
  [ -z "$setup" ] || eval "$setup"
  [ -n "$arg" ] || arg="$CHECKOUT"
  snapshot_tree "$CHECKOUT" "$before"
  snapshot_tree "$CASE_ROOT/work/main/.git" "$gbefore"
  run_prober "$arg"
  snapshot_tree "$CHECKOUT" "$after"
  snapshot_tree "$CASE_ROOT/work/main/.git" "$gafter"
  assert_prober_cause "$cause" || return 1
  assert_tree_unchanged "$before" "$after" || return 1
  assert_tree_unchanged "$gbefore" "$gafter" || return 1
  assert_herdr_calls 0 || return 1
  assert_codex_calls any 0 || return 1
  return 0
}

# --- preflight: every cause decided BEFORE any write --------------------------------------

test_policy_l7_usage_wrong_arity() {
  setup_case
  policy_fixture
  run_prober
  assert_eq "$CODE" 2 "exit with no args" || { teardown_case; return; }
  assert_channel stderr || { teardown_case; return; }
  assert_json "$ERR_FILE" '.cause == "usage"' || { teardown_case; return; }
  run_prober "$CHECKOUT" extra
  assert_eq "$CODE" 2 "exit with two args" || { teardown_case; return; }
  assert_json "$ERR_FILE" '.cause == "usage"' || { teardown_case; return; }
  assert_codex_calls any 0 || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_codex_missing() {
  setup_case
  policy_preflight_case codex_missing 'drop_from_path codex' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_herdr_missing() {
  setup_case
  policy_preflight_case herdr_missing 'drop_from_path herdr' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_path_relative() {
  setup_case
  policy_preflight_case path_relative '' 'work/wt' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_path_absent() {
  setup_case
  policy_preflight_case path_absent '' "/nonexistent-checkout-$$" && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_path_noncanonical() {
  setup_case
  policy_fixture
  local before="$CASE_ROOT/before.txt" after="$CASE_ROOT/after.txt"
  snapshot_tree "$CHECKOUT" "$before"
  run_prober "$CASE_ROOT/work/./wt"
  snapshot_tree "$CHECKOUT" "$after"
  assert_prober_cause path_noncanonical || { teardown_case; return; }
  assert_tree_unchanged "$before" "$after" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_not_toplevel() {
  setup_case
  policy_fixture
  run_prober "$CHECKOUT/src"
  assert_prober_cause not_toplevel || { teardown_case; return; }
  assert_codex_calls any 0 || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_codex_dir_symlink() {
  setup_case
  policy_preflight_case codex_dir_symlink 'ln -s "$CASE_ROOT/work" "$CHECKOUT/.codex"' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_codex_dir_not_directory() {
  setup_case
  policy_preflight_case codex_dir_not_directory 'printf x >"$CHECKOUT/.codex"' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_rules_dir_not_directory() {
  setup_case
  policy_preflight_case rules_dir_not_directory \
    'mkdir -p "$CHECKOUT/.codex"; printf x >"$CHECKOUT/.codex/rules"' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_rules_dir_symlink() {
  setup_case
  policy_preflight_case rules_dir_symlink \
    'mkdir -p "$CHECKOUT/.codex"; ln -s "$CASE_ROOT/work" "$CHECKOUT/.codex/rules"' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_config_not_regular() {
  setup_case
  policy_preflight_case config_not_regular \
    'mkdir -p "$CHECKOUT/.codex/rules"; mkdir "$CHECKOUT/.codex/config.toml"' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_config_symlink() {
  setup_case
  policy_preflight_case config_symlink \
    'mkdir -p "$CHECKOUT/.codex/rules"; ln -s "$CHECKOUT/README.md" "$CHECKOUT/.codex/config.toml"' \
    && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_config_differs() {
  setup_case
  policy_preflight_case config_differs \
    'mkdir -p "$CHECKOUT/.codex/rules"; printf "someone else wrote this\n" >"$CHECKOUT/.codex/config.toml"' \
    && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_rules_differs() {
  setup_case
  policy_preflight_case rules_differs \
    'mkdir -p "$CHECKOUT/.codex/rules"; printf "%s\n" "host_executable(name=\"herdr\", paths=[\"/elsewhere/herdr\"])" >"$CHECKOUT/.codex/rules/herdr-jutsu-deny.rules"' \
    && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_rules_not_regular() {
  setup_case
  policy_preflight_case rules_not_regular \
    'mkdir -p "$CHECKOUT/.codex/rules/herdr-jutsu-deny.rules"' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_git_info_not_directory() {
  setup_case
  policy_preflight_case git_info_not_directory 'rm -rf "$CASE_ROOT/work/main/.git/info"' && ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l7_exclude_symlink() {
  setup_case
  policy_preflight_case exclude_symlink \
    'rm -f "$CASE_ROOT/work/main/.git/info/exclude"; ln -s "$CASE_ROOT/work/main/README.md" "$CASE_ROOT/work/main/.git/info/exclude"' \
    && ok "$CURRENT_TEST"
  teardown_case
}

# --- install, managed bytes, probes ---------------------------------------------------------

test_policy_l6_success_writes_managed_bytes() {
  setup_case
  policy_fixture
  run_prober "$CHECKOUT"
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_channel stdout || { teardown_case; return; }
  assert_json "$OUT_FILE" '.ok == true and .installed.config == true and .installed.rules == true and .installed.exclude_line == true' \
    || { teardown_case; return; }

  local cfg="$CHECKOUT/.codex/config.toml" rules="$CHECKOUT/.codex/rules/herdr-jutsu-deny.rules"
  assert_eq "$(cat "$cfg")" "$FC_MANAGED_CONFIG" "config bytes" || { teardown_case; return; }
  assert_eq "$(wc -l <"$cfg" | tr -d ' ')" "1" "config line count" || { teardown_case; return; }
  assert_eq "$(wc -l <"$rules" | tr -d ' ')" "2" "rules line count" || { teardown_case; return; }
  assert_eq "$(sed -n 1p "$rules")" "host_executable(name=\"herdr\", paths=[\"$CASE_ROOT/bin/herdr\"])" "rules line 1" \
    || { teardown_case; return; }
  assert_eq "$(sed -n 2p "$rules")" "$FC_MANAGED_RULES_2" "rules line 2" || { teardown_case; return; }

  assert_mode "$CHECKOUT/.codex" 700 || { teardown_case; return; }
  assert_mode "$CHECKOUT/.codex/rules" 700 || { teardown_case; return; }
  assert_mode "$cfg" 600 || { teardown_case; return; }
  assert_mode "$rules" 600 || { teardown_case; return; }

  # the exclude line lands in the COMMON git dir's file, shared by every worktree
  assert_eq "$(grep -c '^\.codex/$' "$CASE_ROOT/work/main/.git/info/exclude" | tr -d ' ')" "1" "exclude line" \
    || { teardown_case; return; }
  local declared; declared="$(jq -r .exclude "$OUT_FILE")"
  assert_eq "$declared" "$CASE_ROOT/work/main/.git/info/exclude" "reported exclude path" \
    || { teardown_case; return; }

  assert_codex_calls execpolicy 3 || { teardown_case; return; }
  assert_herdr_calls 0 || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l6_idempotent_second_run() {
  setup_case
  policy_fixture
  run_prober "$CHECKOUT"
  assert_eq "$CODE" 0 "first run" || { teardown_case; return; }
  local before="$CASE_ROOT/before.txt" after="$CASE_ROOT/after.txt" excl_before
  snapshot_tree "$CHECKOUT" "$before"
  excl_before="$(cat "$CASE_ROOT/work/main/.git/info/exclude")"
  run_prober "$CHECKOUT"
  snapshot_tree "$CHECKOUT" "$after"
  assert_eq "$CODE" 0 "second run" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.installed.config == false and .installed.rules == false and .installed.exclude_line == false' \
    || { teardown_case; return; }
  assert_tree_unchanged "$before" "$after" || { teardown_case; return; }
  assert_eq "$(cat "$CASE_ROOT/work/main/.git/info/exclude")" "$excl_before" "exclude file unchanged" \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l8_probe_not_forbidden_leaves_files_then_recovers() {
  setup_case
  policy_fixture
  FC_STUB_POLICY_DECISION=allow run_prober "$CHECKOUT"
  assert_eq "$CODE" 1 "exit" || { teardown_case; return; }
  assert_channel stderr || { teardown_case; return; }
  assert_json "$ERR_FILE" '.cause == "probe_not_forbidden"' || { teardown_case; return; }
  # L-8: no rollback — the managed files stay, with the correct bytes
  assert_eq "$(cat "$CHECKOUT/.codex/config.toml")" "$FC_MANAGED_CONFIG" "config left in place" \
    || { teardown_case; return; }
  if [ ! -f "$CHECKOUT/.codex/rules/herdr-jutsu-deny.rules" ]; then
    fail_case "the rules file was rolled back"; teardown_case; return
  fi
  run_prober "$CHECKOUT"
  assert_eq "$CODE" 0 "recovery run" || { teardown_case; return; }
  assert_json "$OUT_FILE" '.installed.config == false and .installed.rules == false' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l8_probe_malformed_json() {
  setup_case
  policy_fixture
  FC_STUB_POLICY_DECISION=@malformed run_prober "$CHECKOUT"
  assert_eq "$CODE" 1 "exit" || { teardown_case; return; }
  assert_json "$ERR_FILE" '.cause == "probe_malformed"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l8_probe_exit_nonzero() {
  setup_case
  policy_fixture
  FC_STUB_POLICY_EXIT=3 run_prober "$CHECKOUT"
  assert_eq "$CODE" 1 "exit" || { teardown_case; return; }
  assert_json "$ERR_FILE" '.cause == "probe_exit_nonzero"' || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l8_third_probe_is_the_one_that_fails() {
  setup_case
  policy_fixture
  FC_STUB_POLICY_DECISION=allow FC_STUB_POLICY_NTH=3 run_prober "$CHECKOUT"
  assert_eq "$CODE" 1 "exit" || { teardown_case; return; }
  assert_json "$ERR_FILE" '.cause == "probe_not_forbidden"' || { teardown_case; return; }
  assert_codex_calls execpolicy 3 || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policy_l6_exclude_line_appended_after_missing_final_lf() {
  setup_case
  policy_fixture
  printf 'existing-entry' >"$CASE_ROOT/work/main/.git/info/exclude"
  run_prober "$CHECKOUT"
  assert_eq "$CODE" 0 "exit" || { teardown_case; return; }
  assert_eq "$(sed -n 1p "$CASE_ROOT/work/main/.git/info/exclude")" "existing-entry" "first line intact" \
    || { teardown_case; return; }
  assert_eq "$(sed -n 2p "$CASE_ROOT/work/main/.git/info/exclude")" ".codex/" "appended line" \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}
