#!/usr/bin/env bash
# AC-3/4/7/13/31: exact launcher argv, private atomic address book, and the
# relay/launcher byte-compatible stream lock.

A2A_RELAY="$REPO_ROOT/plugins/herdr-jutsu/skills/herdr-jutsu/scripts/jutsu-a2a.mjs"
A2A_FIXTURE_DIR="$HERE/fixtures/a2a"

a2aargv_begin() {
  setup_case
  # AC-24 adds prompt/wait calls to successful Codex A2A spawns. Keep this earlier AC-3/4
  # case on the canonical stub and supply only those two newly required commands from a
  # scratch wrapper (E4: AC-24 changes the behaviour this case pins).
  local wrapper_dir="$SCRATCH/herdr-wrapper"
  mkdir -m 700 "$wrapper_dir"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "${1:-} ${2:-}" = "agent prompt" ] || [ "${1:-} ${2:-}" = "agent wait" ]; then' \
    '  printf "%s\n" "$*" >>"$STUB_LOG"' \
    '  jq -cn '\''$ARGS.positional'\'' --args -- "$@" >>"$STUB_HERDR_JSON_LOG"' \
    '  printf "%s\n" '\''{"result":{"ok":true}}'\''' \
    '  exit 0' \
    'fi' \
    'exec "$A2A_ARGV_REAL_HERDR" "$@"' \
    >"$wrapper_dir/herdr"
  chmod 700 "$wrapper_dir/herdr"
  export A2A_ARGV_REAL_HERDR="$STUB_DIR/herdr"
  export PATH="$wrapper_dir:$PATH"
  export JUTSU_STATE_DIR="$SCRATCH/state"
  export STUB_AGENTS='{"result":{"agents":[{"name":"parent","kind":"claude","pane_id":"w0:p1","agent_status":"idle"}]}}'
  export CLAUDE_CODE_MESSAGING_SOCKET="$SCRATCH/p.sock"
  : >"$CLAUDE_CODE_MESSAGING_SOCKET"
  chmod 700 "$SCRATCH"
}

a2aargv_normalized_args() {
  local args="$1" node_path codex_path herdr_path relay_path a2a_path
  node_path="$(realpath "$(command -v node)")"
  codex_path="$(realpath "$(command -v codex)")"
  herdr_path="$(realpath "$(command -v herdr)")"
  relay_path="$(realpath "$A2A_RELAY")"
  a2a_path="$(realpath "$JUTSU_STATE_DIR")/a2a"
  printf '%s' "$args" | jq -c --arg node "$node_path" --arg codex "$codex_path" \
    --arg herdr "$herdr_path" --arg relay "$relay_path" --arg a2a "$a2a_path" '
      map(split($node)|join("<node>") | split($codex)|join("<codex>")
        | split($herdr)|join("<herdr>") | split($relay)|join("<relay>")
        | split($a2a)|join("<a2a>"))'
}

a2aargv_assert_golden() {
  local fixture="$1" actual
  actual="$(a2aargv_normalized_args "$(jq -c '.effective_agent_args' "$OUT_FILE")")"
  if ! diff -u "$fixture" <(printf '%s\n' "$actual") >/dev/null 2>&1; then
    fail_case "argv differs from golden $fixture: $actual"
    teardown_case
    return 1
  fi
  case "$actual" in *A2A_TEST_MODE*|*A2A_NOW_MS*)
    fail_case "test clock controls leaked into argv: $actual"; teardown_case; return 1 ;; esac
  ok "$CURRENT_TEST"
  teardown_case
}

test_a2aargv_claude_exact_golden_and_merged_deny() {
  CURRENT_TEST="a2aargv_claude_exact_golden_and_merged_deny"; a2aargv_begin
  run_spawn --name cw --stream stream --kind claude --cwd "$REPO_DIR" --a2a \
    --peer sibling -- --disallowedTools 'Bash(*custom*)'
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(jq '[.effective_agent_args[] | select(. == "--disallowedTools")] | length' "$OUT_FILE")" -eq 1 ] \
    || { fail_case "Claude deny list was not merged"; teardown_case; return; }
  a2aargv_assert_golden "$A2A_FIXTURE_DIR/claude-argv.json"
}

test_a2aargv_codex_exact_golden_collisions_and_enable_last() {
  CURRENT_TEST="a2aargv_codex_exact_golden_collisions_and_enable_last"; a2aargv_begin
  mkdir -p "$HOME/.codex"
  printf '%s\n' '[mcp_servers.herdr_jutsu_a2a]' '[mcp_servers.a2a]' >"$HOME/.codex/config.toml"
  run_spawn --name cc --stream stream --kind codex --cwd "$REPO_DIR" --a2a --peer sibling
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  local args enabled_index disable_one disable_two
  args="$(jq -c '.effective_agent_args' "$OUT_FILE")"
  enabled_index="$(printf '%s' "$args" | jq 'index("mcp_servers.herdr_jutsu_a2a.enabled=true")')"
  disable_one="$(printf '%s' "$args" | jq 'index("mcp_servers.herdr_jutsu_a2a.enabled=false")')"
  disable_two="$(printf '%s' "$args" | jq 'index("mcp_servers.a2a.enabled=false")')"
  [ "$enabled_index" -gt "$disable_one" ] && [ "$enabled_index" -gt "$disable_two" ] \
    || { fail_case "enabled=true does not follow both collision disables"; teardown_case; return; }
  a2aargv_assert_golden "$A2A_FIXTURE_DIR/codex-argv.json"
}

test_a2aargv_launcher_does_not_generate_test_clock_env() {
  CURRENT_TEST="a2aargv_launcher_does_not_generate_test_clock_env"; a2aargv_begin
  local real_herdr="$STUB_DIR/herdr"
  export A2A_REAL_HERDR="$real_herdr" A2A_ENV_CAPTURE="$SCRATCH/env.json"
  export PATH="$A2A_FIXTURE_DIR/envbin:$PATH"
  export A2A_TEST_MODE=1 A2A_NOW_MS=123456
  run_spawn --name ce --stream stream --kind claude --cwd "$REPO_DIR" --a2a
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  jq -e '.A2A_TEST_MODE == "" and .A2A_NOW_MS == ""' "$A2A_ENV_CAPTURE" >/dev/null \
    || { fail_case "launcher-generated member env contains test clock controls: $(cat "$A2A_ENV_CAPTURE")"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

test_a2aargv_members_parent_additive_atomic_and_private() {
  CURRENT_TEST="a2aargv_members_parent_additive_atomic_and_private"; a2aargv_begin
  run_spawn --name c1 --stream stream --kind claude --cwd "$REPO_DIR" --a2a
  [ "$CODE" -eq 0 ] || { fail_case "first spawn failed"; teardown_case; return; }
  local members="$JUTSU_STATE_DIR/a2a/stream.members.json"
  run_spawn --name c2 --stream stream --kind codex --cwd "$REPO_DIR" --a2a
  [ "$CODE" -eq 0 ] || { fail_case "second spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  jq -e --arg s "$CLAUDE_CODE_MESSAGING_SOCKET" '
    .parent == {name:"parent",pane_id:"w0:p1",engine:"claude",socket:$s}
    and (.members.c1.engine == "claude")
    and (.members.c2.engine == "codex")' "$members" >/dev/null \
    || { fail_case "members address book is wrong: $(cat "$members")"; teardown_case; return; }
  [ "$(stat_mode "$JUTSU_STATE_DIR/a2a")" = 700 ] && [ "$(stat_mode "$members")" = 600 ] \
    || { fail_case "private modes not preserved"; teardown_case; return; }
  find "$JUTSU_STATE_DIR/a2a" -name '.stream.members.*' -print -quit | grep -q . \
    && { fail_case "atomic replacement temp remains"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

test_a2aargv_concurrent_spawns_both_recorded() {
  CURRENT_TEST="a2aargv_concurrent_spawns_both_recorded"; a2aargv_begin
  "$SPAWN" --name cl --stream stream --kind claude --cwd "$REPO_DIR" --a2a >"$SCRATCH/left.out" 2>"$SCRATCH/left.err" & local p1=$!
  "$SPAWN" --name cr --stream stream --kind claude --cwd "$REPO_DIR" --a2a >"$SCRATCH/right.out" 2>"$SCRATCH/right.err" & local p2=$!
  wait "$p1"; local r1=$?; wait "$p2"; local r2=$?
  [ "$r1" -eq 0 ] && [ "$r2" -eq 0 ] && jq -e '.members.cl and .members.cr' \
    "$JUTSU_STATE_DIR/a2a/stream.members.json" >/dev/null \
    || { fail_case "concurrent members were lost"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

a2aargv_wait_file() { local f="$1" n=0; while [ ! -e "$f" ] && [ "$n" -lt 500 ]; do sleep 0.01; n=$((n+1)); done; [ -e "$f" ]; }

test_a2aargv_node_holds_launcher_waits_and_preserves_live_lock() {
  CURRENT_TEST="a2aargv_node_holds_launcher_waits_and_preserves_live_lock"; a2aargv_begin
  local dir="$JUTSU_STATE_DIR/a2a" ready="$SCRATCH/node.ready" release="$SCRATCH/node.release"
  mkdir -p "$dir"; chmod 700 "$dir"
  jq -cn --arg s "$CLAUDE_CODE_MESSAGING_SOCKET" '{parent:{name:"parent",pane_id:"w0:p1",engine:"claude",socket:$s},members:{member:{pane_id:"p2",engine:"codex",thread_id:"t"}}}' >"$dir/stream.members.json"
  chmod 600 "$dir/stream.members.json"
  A2A_RELAY_HOLD_READY="$ready" A2A_RELAY_HOLD_RELEASE="$release" CLAUDE_CODE_MESSAGING_SOCKET="$CLAUDE_CODE_MESSAGING_SOCKET" \
    node "$A2A_RELAY" send --a2a-dir "$dir" --stream stream --from parent --to member --body hi --herdr "$A2A_FIXTURE_DIR/relay-herdr" >"$SCRATCH/relay.out" 2>"$SCRATCH/relay.err" & local relay_pid=$!
  a2aargv_wait_file "$ready" || { fail_case "node relay did not acquire lock"; kill "$relay_pid"; teardown_case; return; }
  "$SPAWN" --name cw --stream stream --kind claude --cwd "$REPO_DIR" --a2a >"$SCRATCH/spawn.out" 2>"$SCRATCH/spawn.err" & local spawn_pid=$!
  sleep 0.15
  kill -0 "$spawn_pid" 2>/dev/null || { fail_case "launcher broke node's live lock"; : >"$release"; wait "$relay_pid"; teardown_case; return; }
  : >"$release"; wait "$relay_pid"; local rr=$?; wait "$spawn_pid"; local sr=$?
  [ "$rr" -eq 0 ] && [ "$sr" -eq 0 ] || { fail_case "waiters failed relay=$rr spawn=$sr"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

test_a2aargv_launcher_holds_relay_waits_and_preserves_live_lock() {
  CURRENT_TEST="a2aargv_launcher_holds_relay_waits_and_preserves_live_lock"; a2aargv_begin
  local ready="$SCRATCH/launcher.ready" release="$SCRATCH/launcher.release" dir="$JUTSU_STATE_DIR/a2a"
  A2A_TEST_MODE=1 A2A_TEST_LAUNCHER_LOCK_READY="$ready" A2A_TEST_LAUNCHER_LOCK_RELEASE="$release" \
    "$SPAWN" --name ch --stream stream --kind claude --cwd "$REPO_DIR" --a2a >"$SCRATCH/spawn.out" 2>"$SCRATCH/spawn.err" & local spawn_pid=$!
  a2aargv_wait_file "$ready" || { fail_case "launcher did not acquire lock"; kill "$spawn_pid"; teardown_case; return; }
  : >"$dir/stream.disabled"; chmod 600 "$dir/stream.disabled"
  node "$A2A_RELAY" send --a2a-dir "$dir" --stream stream --from parent --to nobody --body hi --herdr "$A2A_FIXTURE_DIR/relay-herdr" >"$SCRATCH/relay.out" 2>"$SCRATCH/relay.err" & local relay_pid=$!
  sleep 0.15
  kill -0 "$relay_pid" 2>/dev/null || { fail_case "relay broke launcher's live lock"; : >"$release"; wait "$spawn_pid"; teardown_case; return; }
  : >"$release"; wait "$spawn_pid"; local sr=$?; wait "$relay_pid"; local rr=$?
  [ "$sr" -eq 0 ] && [ "$rr" -ne 0 ] && grep -q a2a_disabled "$SCRATCH/relay.err" \
    || { fail_case "relay did not wait then observe disabled flag"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

a2aargv_make_owner() { # directory pid start nonce
  local dir="$1" pid="$2" start="$3" nonce="$4"
  mkdir "$dir"; chmod 700 "$dir"
  jq -cn --argjson pid "$pid" --arg start "$start" --arg nonce "$nonce" \
    '{pid:$pid,start_time:$start,nonce:$nonce}' >"$dir/owner.json"
  chmod 600 "$dir/owner.json"
}

test_a2aargv_launcher_recovers_relay_dead_reused_and_malformed_locks() {
  CURRENT_TEST="a2aargv_launcher_recovers_relay_dead_reused_and_malformed_locks"; a2aargv_begin
  local dir="$JUTSU_STATE_DIR/a2a" parent_pid="$$" rc
  mkdir -p "$dir"; chmod 700 "$dir"

  a2aargv_make_owner "$dir/dead.lock" 99999999 'Mon Jan 1 00:00:00 2001' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  JUTSU_A2A_LOCK_TIMEOUT_MS=500 run_spawn --name cd --stream dead --kind claude --cwd "$REPO_DIR" --a2a
  [ "$CODE" -eq 0 ] || { fail_case "launcher did not recover relay dead-pid lock: $(cat "$ERR_FILE")"; teardown_case; return; }

  a2aargv_make_owner "$dir/reused.lock" "$parent_pid" 'wrong start time' cccccccccccccccccccccccccccccccc
  mkdir -p "$SCRATCH/psbin"
  ln -s /bin/echo "$SCRATCH/psbin/not-used" 2>/dev/null || true
  # A live pid plus a deliberately different start time exercises PID reuse. In the
  # managed test sandbox ps may be denied, so a narrow fixture supplies the observed
  # lstart while leaving kill -0 as the liveness proof.
  printf '%s\n' '#!/usr/bin/env bash' 'echo "Tue Jan 2 03:04:05 2024"' >"$SCRATCH/psbin/ps"
  chmod 700 "$SCRATCH/psbin/ps"
  PATH="$SCRATCH/psbin:$PATH" JUTSU_A2A_LOCK_TIMEOUT_MS=500 run_spawn --name cr --stream reused --kind claude --cwd "$REPO_DIR" --a2a
  [ "$CODE" -eq 0 ] || { fail_case "launcher did not recover relay reused-pid lock: $(cat "$ERR_FILE")"; teardown_case; return; }

  mkdir "$dir/malformed.lock"; chmod 700 "$dir/malformed.lock"
  printf '%s' broken >"$dir/malformed.lock/owner.json"; chmod 600 "$dir/malformed.lock/owner.json"
  touch -t 200001010000 "$dir/malformed.lock"
  A2A_TEST_MODE=1 A2A_NOW_MS=4102444800000 JUTSU_A2A_LOCK_TIMEOUT_MS=500 \
    run_spawn --name cm --stream malformed --kind claude --cwd "$REPO_DIR" --a2a
  [ "$CODE" -eq 0 ] || { fail_case "launcher did not recover relay malformed lock: $(cat "$ERR_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

a2aargv_relay_disabled_send() { # dir stream [wrapper]
  local dir="$1" stream="$2" wrapper="${3:-}" rc=0
  : >"$dir/$stream.disabled"; chmod 600 "$dir/$stream.disabled"
  if [ -n "$wrapper" ]; then
    "$wrapper" "$dir" "$stream" node "$A2A_RELAY" send --a2a-dir "$dir" --stream "$stream" \
      --from parent --to nobody --body hi --herdr "$A2A_FIXTURE_DIR/relay-herdr" >/dev/null 2>"$SCRATCH/$stream.err" || rc=$?
  else
    node "$A2A_RELAY" send --a2a-dir "$dir" --stream "$stream" --from parent --to nobody \
      --body hi --herdr "$A2A_FIXTURE_DIR/relay-herdr" >/dev/null 2>"$SCRATCH/$stream.err" || rc=$?
  fi
  [ "$rc" -ne 0 ] && grep -q a2a_disabled "$SCRATCH/$stream.err"
}

test_a2aargv_relay_recovers_launcher_dead_reused_and_malformed_locks() {
  CURRENT_TEST="a2aargv_relay_recovers_launcher_dead_reused_and_malformed_locks"; a2aargv_begin
  local dir="$JUTSU_STATE_DIR/a2a"
  mkdir -p "$dir"; chmod 700 "$dir"
  a2aargv_make_owner "$dir/relaydead.lock" 99999999 'Mon Jan 1 00:00:00 2001' dddddddddddddddddddddddddddddddd
  a2aargv_relay_disabled_send "$dir" relaydead \
    || { fail_case "relay did not recover launcher dead-pid lock: $(cat "$SCRATCH/relaydead.err")"; teardown_case; return; }

  a2aargv_relay_disabled_send "$dir" relayreused "$A2A_FIXTURE_DIR/relay-reused-owner" \
    || { fail_case "relay did not recover launcher reused-pid lock: $(cat "$SCRATCH/relayreused.err")"; teardown_case; return; }

  mkdir "$dir/relaymalformed.lock"; chmod 700 "$dir/relaymalformed.lock"
  printf '%s' broken >"$dir/relaymalformed.lock/owner.json"; chmod 600 "$dir/relaymalformed.lock/owner.json"
  touch -t 200001010000 "$dir/relaymalformed.lock"
  A2A_TEST_MODE=1 A2A_NOW_MS=4102444800000 a2aargv_relay_disabled_send "$dir" relaymalformed \
    || { fail_case "relay did not recover launcher malformed lock: $(cat "$SCRATCH/relaymalformed.err")"; teardown_case; return; }
  ok "$CURRENT_TEST"; teardown_case
}

register_test test_a2aargv_claude_exact_golden_and_merged_deny
register_test test_a2aargv_codex_exact_golden_collisions_and_enable_last
register_test test_a2aargv_launcher_does_not_generate_test_clock_env
register_test test_a2aargv_members_parent_additive_atomic_and_private
register_test test_a2aargv_concurrent_spawns_both_recorded
register_test test_a2aargv_node_holds_launcher_waits_and_preserves_live_lock
register_test test_a2aargv_launcher_holds_relay_waits_and_preserves_live_lock
register_test test_a2aargv_launcher_recovers_relay_dead_reused_and_malformed_locks
register_test test_a2aargv_relay_recovers_launcher_dead_reused_and_malformed_locks
