#!/usr/bin/env bash
# AC-24: Codex receives a bootstrap turn before its first real brief and only then gains
# a relay-ready thread id. The per-test wrapper is generated in scratch so the repository
# keeps using the suite's single canonical herdr stub.

A2A_BOOTSTRAP_RELAY="$REPO_ROOT/plugins/herdr-jutsu/skills/herdr-jutsu/scripts/jutsu-a2a.mjs"

a2abootstrap_begin() {
  setup_case
  unset A2A_TEST_GET_SESSION A2A_TEST_STRIP_START_SESSION A2A_TEST_REAL_HERDR 2>/dev/null
  export JUTSU_STATE_DIR="$SCRATCH/s"
  export STUB_AGENTS='{"result":{"agents":[{"name":"parent","kind":"claude","pane_id":"w0:p1","agent_status":"idle"}]}}'
  export CLAUDE_CODE_MESSAGING_SOCKET="$SCRATCH/p.sock"
  : >"$CLAUDE_CODE_MESSAGING_SOCKET"
  chmod 700 "$SCRATCH"

  local wrapper_dir="$SCRATCH/herdr-wrapper"
  mkdir -m 700 "$wrapper_dir"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -u' \
    'if [ "${1:-} ${2:-}" = "agent prompt" ] || [ "${1:-} ${2:-}" = "agent wait" ]; then' \
    '  printf "%s\n" "$*" >>"$STUB_LOG"' \
    '  jq -cn '\''$ARGS.positional'\'' --args -- "$@" >>"$STUB_HERDR_JSON_LOG"' \
    '  printf "%s\n" '\''{"result":{"ok":true}}'\''' \
    '  exit 0' \
    'fi' \
    'if [ "${1:-} ${2:-}" = "agent get" ] && [ -n "${A2A_TEST_GET_SESSION:-}" ]; then' \
    '  printf "%s\n" "$*" >>"$STUB_LOG"' \
    '  jq -cn '\''$ARGS.positional'\'' --args -- "$@" >>"$STUB_HERDR_JSON_LOG"' \
    '  jq -cn --arg n "${3:-}" --arg s "$A2A_TEST_GET_SESSION" '\''{result:{agent:{name:$n,agent_session:{value:$s},agent_status:"idle"}}}'\''' \
    '  exit 0' \
    'fi' \
    'if [ "${1:-} ${2:-}" = "agent start" ] && [ "${A2A_TEST_STRIP_START_SESSION:-}" = 1 ]; then' \
    '  "$A2A_TEST_REAL_HERDR" "$@" | jq -c '\''del(.result.agent.agent_session)'\''' \
    '  exit ${PIPESTATUS[0]}' \
    'fi' \
    'exec "$A2A_TEST_REAL_HERDR" "$@"' \
    >"$wrapper_dir/herdr"
  chmod 700 "$wrapper_dir/herdr"
  export A2A_TEST_REAL_HERDR="$STUB_DIR/herdr"
  export PATH="$wrapper_dir:$PATH"
}

a2abootstrap_rollout() { # id
  local id="$1" dir="$HOME/.codex/sessions/2999/01/01"
  mkdir -p "$dir"
  jq -cn --arg id "$id" --arg cwd "$REPO_DIR" \
    '{timestamp:"2999-01-01T00:00:00Z",type:"session_meta",payload:{id:$id,timestamp:"2999-01-01T00:00:00Z",cwd:$cwd,originator:"codex-tui"}}' \
    >"$dir/rollout-$id.jsonl"
}

a2abootstrap_spawn() {
  run_spawn --name boot-codex --stream boot --kind codex --cwd "$REPO_DIR" --a2a
}

test_a2abootstrap_agent_session_recorded_after_fixed_prompt() {
  CURRENT_TEST="a2abootstrap_agent_session_recorded_after_fixed_prompt"; a2abootstrap_begin
  export A2A_TEST_GET_SESSION=thread-from-herdr
  a2abootstrap_spawn
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -Fqx 'agent prompt w0:p1 A2A bootstrap: reply with exactly READY and do nothing else.' "$STUB_LOG" \
    || { fail_case "fixed bootstrap prompt was not sent: $(cat "$STUB_LOG")"; teardown_case; return; }
  grep -q '^agent wait w0:p1 --until idle --timeout 60000$' "$STUB_LOG" \
    || { fail_case "launcher did not wait for bootstrap idle"; teardown_case; return; }
  jq -e '.members["boot-codex"].thread_id == "thread-from-herdr"' \
    "$JUTSU_STATE_DIR/a2a/boot.members.json" >/dev/null \
    || { fail_case "herdr session was not recorded"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

test_a2abootstrap_single_matching_rollout_recorded() {
  CURRENT_TEST="a2abootstrap_single_matching_rollout_recorded"; a2abootstrap_begin
  export A2A_TEST_STRIP_START_SESSION=1
  a2abootstrap_rollout rollout-one
  a2abootstrap_spawn
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  jq -e '.members["boot-codex"].thread_id == "rollout-one"' \
    "$JUTSU_STATE_DIR/a2a/boot.members.json" >/dev/null \
    || { fail_case "single matching rollout was not recorded"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

a2abootstrap_assert_unresolved() {
  [ "$CODE" -eq 1 ] && [ "$(stderr_error_code)" = a2a_thread_unresolved ] \
    || { fail_case "expected exit 1 a2a_thread_unresolved, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return 1; }
  jq -e '.members["boot-codex"] == {pane_id:"w0:p1",engine:"codex",thread_id:""}' \
    "$JUTSU_STATE_DIR/a2a/boot.members.json" >/dev/null \
    || { fail_case "unresolved member was not retained in the address book"; teardown_case; return 1; }
  jq -e '.name == "boot-codex" and .kind == "codex"' "$OUT_FILE" >/dev/null \
    || { fail_case "unresolved member was not reported on stdout"; teardown_case; return 1; }
  grep -q '^pane close ' "$STUB_LOG" \
    && { fail_case "unresolved member pane was closed"; teardown_case; return 1; }
  return 0
}

test_a2abootstrap_zero_rollouts_retains_and_reports_member() {
  CURRENT_TEST="a2abootstrap_zero_rollouts_retains_and_reports_member"; a2abootstrap_begin
  export A2A_TEST_STRIP_START_SESSION=1
  a2abootstrap_spawn
  a2abootstrap_assert_unresolved || return
  ok "$CURRENT_TEST"; teardown_case
}

test_a2abootstrap_two_rollouts_retains_and_reports_member() {
  CURRENT_TEST="a2abootstrap_two_rollouts_retains_and_reports_member"; a2abootstrap_begin
  export A2A_TEST_STRIP_START_SESSION=1
  a2abootstrap_rollout rollout-one
  a2abootstrap_rollout rollout-two
  a2abootstrap_spawn
  a2abootstrap_assert_unresolved || return
  ok "$CURRENT_TEST"; teardown_case
}

test_a2abootstrap_incomplete_member_is_not_ready() {
  CURRENT_TEST="a2abootstrap_incomplete_member_is_not_ready"; a2abootstrap_begin
  export A2A_TEST_STRIP_START_SESSION=1
  a2abootstrap_spawn
  a2abootstrap_assert_unresolved || return
  local relay_out="$SCRATCH/relay.out"
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_message","arguments":{"to":"parent","body":"hello"}}}' \
    | node "$A2A_BOOTSTRAP_RELAY" mcp --self boot-codex --stream boot \
        --a2a-dir "$JUTSU_STATE_DIR/a2a" --node "$(command -v node)" \
        --codex "$(command -v codex)" --herdr "$(command -v herdr)" --peer parent \
        >"$relay_out" 2>/dev/null
  grep -q 'not_ready' "$relay_out" \
    || { fail_case "relay did not return not_ready for the incomplete member: $(cat "$relay_out")"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

register_test test_a2abootstrap_agent_session_recorded_after_fixed_prompt
register_test test_a2abootstrap_single_matching_rollout_recorded
register_test test_a2abootstrap_zero_rollouts_retains_and_reports_member
register_test test_a2abootstrap_two_rollouts_retains_and_reports_member
register_test test_a2abootstrap_incomplete_member_is_not_ready
