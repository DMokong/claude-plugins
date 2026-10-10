#!/usr/bin/env bash
# tests/herdr-jutsu/cases/baseline.sh — AC-1: freezes 0.4.1 normalised effective-argv /
# registry-row fixtures for jutsu-spawn.sh's non-`--a2a` spawn scenarios (0.4.1 has no
# `--a2a` at all; this file is the regression net every later task in this stream diffs
# against). Sourced by tests/herdr-jutsu/run.sh's case-discovery loop, which sets
# CASE_GROUP="baseline" (this file's stem) before sourcing it and provides every helper used
# below (setup_case, teardown_case, run_spawn, ok, fail_case, register_test, ...) plus
# $HERE/$REPO_DIR/$SCRATCH/$OUT_FILE/$ERR_FILE/$CODE. Test bodies here follow the same
# convention as the "core" tests in run.sh: CURRENT_TEST is the function name minus the
# "test_" prefix.
#
# Fixtures and normalisation:
#   - tests/herdr-jutsu/fixtures/v0.4.1/manifest.txt lists every captured scenario with its
#     invocation, one line each: "<name>: <one-line description>".
#   - tests/herdr-jutsu/fixtures/v0.4.1/<name>.json is that scenario's normalised stdout line
#     (== the registry row jutsu-spawn.sh appends, per build_line() in jutsu-spawn.sh) with
#     spawned_at, pane/tab/workspace ids and any scratch-dir path masked by
#     tests/herdr-jutsu/lib/normalise.jq.
#   - The Codex deny-rules FILE content is deliberately not captured here — AC-28 covers it.
#
# NORMALISE_JQ / FIXTURES_DIR default relative to $HERE (set by run.sh); resolved here too so
# this file stays runnable if ever sourced standalone.
NORMALISE_JQ="${NORMALISE_JQ:-$HERE/lib/normalise.jq}"
FIXTURES_DIR="${FIXTURES_DIR:-$HERE/fixtures/v0.4.1}"

# assert_baseline_fixture <fixture-name>
# Call AFTER setup_case + run_spawn have produced $CODE/$OUT_FILE/$SCRATCH for the scenario
# named <fixture-name> in fixtures/v0.4.1/manifest.txt. Normalises $OUT_FILE and diffs it
# byte-exact (as parsed JSON, via jq -c on both sides) against the checked-in fixture. Always
# tears the case down before returning.
assert_baseline_fixture() {
  local fixture_name="$1"
  if [ "$CODE" -ne 0 ]; then
    fail_case "scenario $fixture_name: expected exit 0, got $CODE: $(cat "$ERR_FILE")"
    teardown_case
    return
  fi
  local fixture_file="$FIXTURES_DIR/$fixture_name.json"
  if [ ! -f "$fixture_file" ]; then
    fail_case "scenario $fixture_name: no checked-in fixture at $fixture_file"
    teardown_case
    return
  fi
  local normalized expected
  normalized="$(jq -c -f "$NORMALISE_JQ" --arg scratch "$SCRATCH" "$OUT_FILE" 2>/dev/null)"
  if [ -z "$normalized" ]; then
    fail_case "scenario $fixture_name: normalise.jq produced no output for: $(cat "$OUT_FILE")"
    teardown_case
    return
  fi
  expected="$(jq -c . "$fixture_file" 2>/dev/null)"
  if [ "$normalized" != "$expected" ]; then
    fail_case "scenario $fixture_name: normalised 0.4.1 output changed -- got: $normalized -- expected: $expected"
    teardown_case
    return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

test_baseline_shell_default() {
  CURRENT_TEST="baseline_shell_default"
  setup_case
  run_spawn --name b-shell --kind shell --cwd "$REPO_DIR"
  assert_baseline_fixture shell_default
}

test_baseline_claude_default() {
  CURRENT_TEST="baseline_claude_default"
  setup_case
  run_spawn --name b-claude --kind claude --cwd "$REPO_DIR"
  assert_baseline_fixture claude_default
}

test_baseline_codex_default() {
  CURRENT_TEST="baseline_codex_default"
  setup_case
  run_spawn --name b-codex --kind codex --cwd "$REPO_DIR"
  assert_baseline_fixture codex_default
}

test_baseline_shell_where_workspace() {
  CURRENT_TEST="baseline_shell_where_workspace"
  setup_case
  run_spawn --name b-ws --kind shell --cwd "$REPO_DIR" --where workspace --stream bstream
  assert_baseline_fixture shell_where_workspace
}

test_baseline_shell_where_tab() {
  CURRENT_TEST="baseline_shell_where_tab"
  setup_case
  run_spawn --name b-tab --kind shell --cwd "$REPO_DIR" --where tab
  assert_baseline_fixture shell_where_tab
}

test_baseline_shell_worktree() {
  CURRENT_TEST="baseline_shell_worktree"
  setup_case
  run_spawn --name b-wt-role --kind shell --cwd "$REPO_DIR" --worktree baseline-branch
  assert_baseline_fixture shell_worktree
}

test_baseline_shell_in_pane() {
  CURRENT_TEST="baseline_shell_in_pane"
  setup_case
  run_spawn --name b-inpane --kind shell --cwd "$REPO_DIR" --in-pane w0:p9
  assert_baseline_fixture shell_in_pane
}

test_baseline_claude_agent_args_redacted() {
  CURRENT_TEST="baseline_claude_agent_args_redacted"
  setup_case
  run_spawn --name b-redact --kind claude --cwd "$REPO_DIR" -- --api-key SECRET123
  assert_baseline_fixture claude_agent_args_redacted
}

test_baseline_claude_dangerous_override() {
  CURRENT_TEST="baseline_claude_dangerous_override"
  setup_case
  run_spawn --name b-danger --kind claude --cwd "$REPO_DIR" --allow-dangerous-agent-flags -- --dangerously-skip-permissions
  assert_baseline_fixture claude_dangerous_override
}

test_baseline_shell_cmd_and_issue() {
  CURRENT_TEST="baseline_shell_cmd_and_issue"
  setup_case
  run_spawn --name b-cmd --kind shell --cwd "$REPO_DIR" --cmd "echo hi" --issue baseline-issue-1
  assert_baseline_fixture shell_cmd_and_issue
}

test_baseline_codex_stream() {
  CURRENT_TEST="baseline_codex_stream"
  setup_case
  run_spawn --name b-codex-stream --kind codex --cwd "$REPO_DIR" --stream bstream2
  assert_baseline_fixture codex_stream
}

# Cross-checks the two artifacts against each other (no setup_case/teardown_case: pure
# filesystem/text checks, same convention as e.g. test_ac19_help_documents_herdr_unreachable
# in run.sh, which also runs without a scratch case).
test_baseline_manifest_matches_fixture_files() {
  CURRENT_TEST="baseline_manifest_matches_fixture_files"
  local manifest="$FIXTURES_DIR/manifest.txt" f stem line
  if [ ! -f "$manifest" ]; then
    fail_case "missing $manifest"
    return
  fi
  for f in "$FIXTURES_DIR"/*.json; do
    [ -e "$f" ] || continue
    stem="$(basename "$f" .json)"
    grep -q "^$stem:" "$manifest" || {
      fail_case "fixture $f has no matching '$stem:' line in $manifest"
      return
    }
  done
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    stem="${line%%:*}"
    [ -f "$FIXTURES_DIR/$stem.json" ] || {
      fail_case "manifest scenario '$stem' in $manifest has no fixture file $FIXTURES_DIR/$stem.json"
      return
    }
  done <"$manifest"
  ok "$CURRENT_TEST"
}

# --- registration (group "baseline", set by run.sh before sourcing this file) -------------

register_test test_baseline_shell_default
register_test test_baseline_claude_default
register_test test_baseline_codex_default
register_test test_baseline_shell_where_workspace
register_test test_baseline_shell_where_tab
register_test test_baseline_shell_worktree
register_test test_baseline_shell_in_pane
register_test test_baseline_claude_agent_args_redacted
register_test test_baseline_claude_dangerous_override
register_test test_baseline_shell_cmd_and_issue
register_test test_baseline_codex_stream
register_test test_baseline_manifest_matches_fixture_files
