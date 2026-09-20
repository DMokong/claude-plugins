# cases/harness.sh — the suite proving its own instrument (L-46 scaffold half).

test_harness_l46_stub_records_multiline_argv() {
  setup_case
  local weird got
  weird="$(printf 'first line\nsecond  line\twith tab')"
  codex exec --json "$weird" >/dev/null 2>&1
  got="$CASE_ROOT/got.txt"
  stub_argv 1 >"$got"
  assert_eq "$(tail -n 1 "$got")" "second  line	with tab" "last argv line" || { teardown_case; return; }
  assert_eq "$(grep -c . "$got")" "4" "recorded argv line count" || { teardown_case; return; }
  assert_codex_calls exec 1 || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_harness_l46_worktree_is_linked() {
  setup_case
  mk_fixture
  local gd cd_
  gd="$(git -C "$CHECKOUT" rev-parse --absolute-git-dir)"
  cd_="$(git -C "$CHECKOUT" rev-parse --git-common-dir)"
  case "$cd_" in /*) ;; *) cd_="$CHECKOUT/$cd_" ;; esac
  if [ "$gd" = "$(cd -P -- "$cd_" && pwd -P)" ]; then
    fail_case "mk_worktree did not produce a LINKED worktree"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

test_harness_l46_adapter_root_is_sibling_of_tmpdir() {
  setup_case
  case "$FC_ADAPTER_ROOT" in
    "$TMPDIR"|"$TMPDIR"/*) fail_case "FC_ADAPTER_ROOT lives under TMPDIR"; teardown_case; return ;;
  esac
  assert_eq "${FC_ADAPTER_ROOT%/state/fc}" "$CASE_ROOT" "adapter root parent" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_harness_l46_drop_from_path_hides_codex() {
  setup_case
  drop_from_path codex
  if command -v codex >/dev/null 2>&1; then
    fail_case "codex still resolves after drop_from_path"
    teardown_case; return
  fi
  if ! command -v herdr >/dev/null 2>&1; then
    fail_case "drop_from_path codex also removed herdr"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

test_harness_l46_samples_exist_for_every_rule() {
  setup_case
  local id s n
  for id in $FC_RULE_IDS; do
    s="$(fc_sample "$id")"
    n="$(fc_nearmiss "$id")"
    if [ -z "$s" ] || [ -z "$n" ]; then
      fail_case "empty sample or near-miss for rule $id"
      teardown_case; return
    fi
  done
  ok "$CURRENT_TEST"
  teardown_case
}

test_harness_l46_sentinel_trips_outside_a_case() {
  setup_case
  # a stub call with no FC_STUB_STATE is exactly what "the real binary was reached" looks
  # like from the suite's side; prove it lands in a sentinel file.
  local probe="$CASE_ROOT/sentinel.probe"
  : >"$probe"
  ( unset FC_STUB_STATE; FC_SENTINEL_FILE="$probe" "$CASE_ROOT/bin/codex" exec x >/dev/null 2>&1 )
  if [ ! -s "$probe" ]; then
    fail_case "a stub call outside a case did not trip the sentinel file"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}
