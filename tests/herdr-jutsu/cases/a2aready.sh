#!/usr/bin/env bash
# An A2A start command exceeds 1024 bytes. Typed into a freshly split pane whose shell has
# not reached its line editor, macOS cuts the line at 1024 bytes and the start times out
# (seen live: the command stopped mid-argument at exactly character 1024). The launcher
# therefore proves the shell runs a command before it starts an A2A member. Reuses the
# a2abootstrap fixture (sourced earlier; tests run after every case file is loaded).

test_a2aready_shell_probe_runs_before_the_agent_start() {
  CURRENT_TEST="a2aready_shell_probe_runs_before_the_agent_start"; a2abootstrap_begin
  export A2A_TEST_GET_SESSION=thread-from-herdr
  a2abootstrap_spawn
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  local run_line wait_line start_line
  run_line="$(grep -n '^pane run w0:p1 printf ' "$STUB_LOG" | head -n1 | cut -d: -f1)"
  wait_line="$(grep -n '^pane wait-output w0:p1 --match jutsu-shell-ready-' "$STUB_LOG" | head -n1 | cut -d: -f1)"
  start_line="$(grep -n '^agent start boot-codex ' "$STUB_LOG" | head -n1 | cut -d: -f1)"
  [ -n "$run_line" ] && [ -n "$wait_line" ] && [ -n "$start_line" ] \
    || { fail_case "probe or start missing: $(cat "$STUB_LOG")"; teardown_case; return; }
  [ "$run_line" -lt "$wait_line" ] && [ "$wait_line" -lt "$start_line" ] \
    || { fail_case "shell probe did not complete before the agent start (run=$run_line wait=$wait_line start=$start_line)"; teardown_case; return; }
  # the awaited token must not appear in the typed command, or the echo alone would match
  local token typed
  token="$(grep '^pane wait-output w0:p1 --match ' "$STUB_LOG" | head -n1 | sed 's/.*--match \([^ ]*\).*/\1/')"
  typed="$(grep '^pane run w0:p1 printf ' "$STUB_LOG" | head -n1)"
  case "$typed" in *"$token"*) fail_case "the typed probe contains its own token: $typed"; teardown_case; return ;; esac
  ok "$CURRENT_TEST"; teardown_case
}

test_a2aready_unresponsive_shell_starts_no_agent() {
  CURRENT_TEST="a2aready_unresponsive_shell_starts_no_agent"; a2abootstrap_begin
  export STUB_WAIT_OUTPUT_FAIL=1
  a2abootstrap_spawn
  unset STUB_WAIT_OUTPUT_FAIL
  [ "$CODE" -eq 1 ] && [ "$(stderr_error_code)" = a2a_shell_not_ready ] \
    || { fail_case "expected exit 1 a2a_shell_not_ready, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '^agent start ' "$STUB_LOG" \
    && { fail_case "an agent was started in a pane whose shell never responded"; teardown_case; return; }
  grep -q '^pane close w0:p1' "$STUB_LOG" \
    || { fail_case "the pane created for the member was not closed: $(cat "$STUB_LOG")"; teardown_case; return; }
  [ ! -e "$JUTSU_STATE_DIR/a2a/boot.members.json" ] \
    || { fail_case "an address-book entry was written for a member that never started"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

test_a2aready_spawn_without_a2a_makes_no_probe() {
  CURRENT_TEST="a2aready_spawn_without_a2a_makes_no_probe"; setup_case
  run_spawn --name plain-codex --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -Eq '^pane (run|wait-output) ' "$STUB_LOG" \
    && { fail_case "a spawn without --a2a made a shell probe: $(grep -E '^pane (run|wait-output) ' "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

register_test test_a2aready_shell_probe_runs_before_the_agent_start
register_test test_a2aready_unresponsive_shell_starts_no_agent
register_test test_a2aready_spawn_without_a2a_makes_no_probe
