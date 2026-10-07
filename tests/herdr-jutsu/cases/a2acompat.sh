#!/usr/bin/env bash
# AC-2/5/6/32: launcher A2A compatibility and create-nothing preflight checks.

A2A_LISTENER_PID=""

a2a_parent_fixture() {
  export JUTSU_STATE_DIR="${JUTSU_STATE_DIR:-$SCRATCH/state}"
  export STUB_AGENTS='{"result":{"agents":[{"name":"parent","kind":"claude","pane_id":"w0:p1","agent_status":"idle"}]}}'
  local socket_dir="$SCRATCH"
  chmod 700 "$socket_dir"
  export CLAUDE_CODE_MESSAGING_SOCKET="$socket_dir/p.sock"
  make_unix_socket "$CLAUDE_CODE_MESSAGING_SOCKET"
}

a2a_cleanup() {
  if [ -n "$A2A_LISTENER_PID" ]; then
    kill "$A2A_LISTENER_PID" 2>/dev/null || true
    wait "$A2A_LISTENER_PID" 2>/dev/null || true
    A2A_LISTENER_PID=""
  fi
  teardown_case
}

a2a_assert_refusal() { # status code
  local want_status="$1" want_code="$2" got_code dirty
  got_code="$(stderr_error_code)"
  if [ "$CODE" -ne "$want_status" ] || [ "$got_code" != "$want_code" ]; then
    fail_case "expected exit $want_status $want_code, got $CODE ${got_code:-<none>}: $(cat "$ERR_FILE")"
    a2a_cleanup
    return 1
  fi
  dirty="$(nonreadonly_stub_call)"
  if [ -n "$dirty" ]; then
    fail_case "refusal made a mutating herdr call: $dirty"
    a2a_cleanup
    return 1
  fi
  if find "$SCRATCH" -path '*/a2a/*' -type f -print -quit 2>/dev/null | grep -q .; then
    fail_case "refusal created an A2A file: $(find "$SCRATCH" -path '*/a2a/*' -type f -print)"
    a2a_cleanup
    return 1
  fi
  if find "$SCRATCH" -name '*.jsonl' ! -path '*/herdr.jsonl' -print -quit 2>/dev/null | grep -q .; then
    fail_case "refusal created a registry row/file"
    a2a_cleanup
    return 1
  fi
  ok "$CURRENT_TEST"
  a2a_cleanup
}

a2a_begin() {
  setup_case
  a2a_parent_fixture
}

test_a2acompat_peer_requires_a2a() {
  CURRENT_TEST="a2acompat_peer_requires_a2a"; setup_case
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --peer p
  a2a_assert_refusal 2 a2a_required
}

test_a2acompat_peer_validation_bad() {
  CURRENT_TEST="a2acompat_peer_validation_bad"; setup_case
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a --peer BAD
  a2a_assert_refusal 2 bad_peer_name
}

test_a2acompat_peer_validation_self() {
  CURRENT_TEST="a2acompat_peer_validation_self"; setup_case
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a --peer c
  a2a_assert_refusal 2 peer_is_self
}

test_a2acompat_peer_validation_duplicate() {
  CURRENT_TEST="a2acompat_peer_validation_duplicate"; setup_case
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a --peer p --peer p
  a2a_assert_refusal 2 duplicate_peer
}

test_a2acompat_shell_unsupported() {
  CURRENT_TEST="a2acompat_shell_unsupported"; setup_case
  run_spawn --name c --kind shell --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 2 a2a_kind_unsupported
}

test_a2acompat_requires_isolation() {
  CURRENT_TEST="a2acompat_requires_isolation"; setup_case
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a --no-isolation
  a2a_assert_refusal 5 a2a_requires_isolation
}

test_a2acompat_arg_conflict_mcp() {
  CURRENT_TEST="a2acompat_arg_conflict_mcp"; setup_case
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a -- --mcp-config '{}'
  a2a_assert_refusal 5 a2a_arg_conflict
}

test_a2acompat_arg_conflict_strict() {
  CURRENT_TEST="a2acompat_arg_conflict_strict"; setup_case
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a -- --strict-mcp-config
  a2a_assert_refusal 5 a2a_arg_conflict
}

test_a2acompat_arg_conflict_allowed() {
  CURRENT_TEST="a2acompat_arg_conflict_allowed"; setup_case
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a -- --allowedTools Read
  a2a_assert_refusal 5 a2a_arg_conflict
}

test_a2acompat_arg_conflict_codex() {
  CURRENT_TEST="a2acompat_arg_conflict_codex"; setup_case
  run_spawn --name c --kind codex --cwd "$REPO_DIR" --a2a -- -c mcp_servers.foo.enabled=true
  a2a_assert_refusal 5 a2a_arg_conflict
}

test_a2acompat_registry_workspace_refused() {
  CURRENT_TEST="a2acompat_registry_workspace_refused"; setup_case
  export XDG_STATE_HOME=/dev/null
  a2a_parent_fixture
  unset JUTSU_STATE_DIR
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 4 a2a_registry_unsuitable
}

test_a2acompat_parent_socket_required() {
  CURRENT_TEST="a2acompat_parent_socket_required"; setup_case
  export JUTSU_STATE_DIR="$SCRATCH/state"
  unset CLAUDE_CODE_MESSAGING_SOCKET
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 4 a2a_parent_unreachable
}

test_a2acompat_node_20_required() {
  CURRENT_TEST="a2acompat_node_20_required"; a2a_begin
  mkdir -p "$SCRATCH/oldbin"; chmod 700 "$SCRATCH/oldbin"
  printf '#!/usr/bin/env bash\necho 19.9.0\n' >"$SCRATCH/oldbin/node"; chmod 700 "$SCRATCH/oldbin/node"
  export PATH="$SCRATCH/oldbin:$PATH"
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 4 a2a_runtime_missing
}

test_a2acompat_untrusted_codex_refused() {
  CURRENT_TEST="a2acompat_untrusted_codex_refused"; a2a_begin
  mkdir -p "$SCRATCH/badbin"; chmod 700 "$SCRATCH/badbin"
  cp "$STUB_DIR/codex" "$SCRATCH/badbin/codex"; chmod 770 "$SCRATCH/badbin/codex"
  export PATH="$SCRATCH/badbin:$PATH"
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 5 a2a_untrusted_executable
}

test_a2acompat_untrusted_codex_directory_refused() {
  CURRENT_TEST="a2acompat_untrusted_codex_directory_refused"; a2a_begin
  mkdir -p "$SCRATCH/baddir"
  cp "$STUB_DIR/codex" "$SCRATCH/baddir/codex"; chmod 700 "$SCRATCH/baddir/codex"
  chmod 770 "$SCRATCH/baddir"
  export PATH="$SCRATCH/baddir:$PATH"
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 5 a2a_untrusted_executable
}

test_a2acompat_parent_path_must_be_a_socket() {
  CURRENT_TEST="a2acompat_parent_path_must_be_a_socket"; a2a_begin
  rm -f "$CLAUDE_CODE_MESSAGING_SOCKET"; : >"$CLAUDE_CODE_MESSAGING_SOCKET"
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 4 a2a_parent_unreachable
}

test_a2acompat_socket_path_limit() {
  CURRENT_TEST="a2acompat_socket_path_limit"; a2a_begin
  export JUTSU_STATE_DIR="$SCRATCH/$(printf 'x%.0s' {1..90})"
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 5 socket_path_too_long
}

test_a2acompat_parent_must_be_named() {
  CURRENT_TEST="a2acompat_parent_must_be_named"; a2a_begin
  export STUB_AGENTS='{"result":{"agents":[]}}'
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 4 a2a_parent_unnamed
}

test_a2acompat_record_session_not_applicable() {
  CURRENT_TEST="a2acompat_record_session_not_applicable"; setup_case
  run_spawn --record-session --name c --a2a
  a2a_assert_refusal 2 a2a_not_applicable
}

test_a2acompat_overlap_a2a_under_cwd() {
  CURRENT_TEST="a2acompat_overlap_a2a-under-cwd"; a2a_begin
  export JUTSU_STATE_DIR="$REPO_DIR/state"
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 5 a2a_storage_in_write_root
}

test_a2acompat_overlap_a2a_under_worktree() {
  CURRENT_TEST="a2acompat_overlap_a2a-under-worktree"; a2a_begin
  export JUTSU_STATE_DIR="$REPO_DIR/.jutsu-worktrees/b"
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --worktree b --a2a
  a2a_assert_refusal 5 a2a_storage_in_write_root
}

test_a2acompat_overlap_a2a_under_add_dir() {
  CURRENT_TEST="a2acompat_overlap_a2a-under-add-dir"; a2a_begin
  mkdir -p "$SCRATCH/extra"
  export JUTSU_STATE_DIR="$SCRATCH/extra/state"
  run_spawn --name c --kind codex --cwd "$REPO_DIR" --a2a -- --add-dir "$SCRATCH/extra"
  a2a_assert_refusal 5 a2a_storage_in_write_root
}

test_a2acompat_overlap_write_root_under_a2a() {
  CURRENT_TEST="a2acompat_overlap_write-root-under-a2a"; a2a_begin
  run_spawn --name c --kind codex --cwd "$REPO_DIR" --a2a -- --add-dir "$JUTSU_STATE_DIR/a2a/sock"
  a2a_assert_refusal 5 a2a_storage_in_write_root
}

test_a2acompat_unsafe_parent_directory_refused() {
  CURRENT_TEST="a2acompat_unsafe_parent_directory_refused"; a2a_begin
  chmod 770 "$(dirname "$CLAUDE_CODE_MESSAGING_SOCKET")"
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a
  a2a_assert_refusal 4 a2a_parent_unreachable
}

test_a2acompat_strict_claude_and_safe_external_socket_allowed() {
  CURRENT_TEST="a2acompat_strict_claude_and_safe_external_socket_allowed"; a2a_begin
  run_spawn --name c --kind claude --cwd "$REPO_DIR" --a2a --strict-isolation
  local args; args="$(jq -c '.effective_agent_args' "$OUT_FILE" 2>/dev/null || true)"
  if [ "$CODE" -ne 0 ]; then
    fail_case "expected strict isolated Claude A2A spawn to be allowed, got $CODE: $(cat "$ERR_FILE")"
  elif ! printf '%s' "$args" | jq -e 'index("SendMessage") != null
      and (index("--allowedTools") as $i | $i != null and .[$i + 1] == "mcp__herdr_jutsu_a2a__crew_send")' >/dev/null; then
    fail_case "strict A2A spawn must keep SendMessage denied and allow only crew_send: $args"
  else
    ok "$CURRENT_TEST"
  fi
  a2a_cleanup
}

register_test test_a2acompat_peer_requires_a2a
register_test test_a2acompat_peer_validation_bad
register_test test_a2acompat_peer_validation_self
register_test test_a2acompat_peer_validation_duplicate
register_test test_a2acompat_shell_unsupported
register_test test_a2acompat_requires_isolation
register_test test_a2acompat_arg_conflict_mcp
register_test test_a2acompat_arg_conflict_strict
register_test test_a2acompat_arg_conflict_allowed
register_test test_a2acompat_arg_conflict_codex
register_test test_a2acompat_registry_workspace_refused
register_test test_a2acompat_parent_socket_required
register_test test_a2acompat_node_20_required
register_test test_a2acompat_untrusted_codex_refused
register_test test_a2acompat_untrusted_codex_directory_refused
register_test test_a2acompat_parent_path_must_be_a_socket
register_test test_a2acompat_socket_path_limit
register_test test_a2acompat_parent_must_be_named
register_test test_a2acompat_record_session_not_applicable
register_test test_a2acompat_overlap_a2a_under_cwd
register_test test_a2acompat_overlap_a2a_under_worktree
register_test test_a2acompat_overlap_a2a_under_add_dir
register_test test_a2acompat_overlap_write_root_under_a2a
register_test test_a2acompat_unsafe_parent_directory_refused
register_test test_a2acompat_strict_claude_and_safe_external_socket_allowed
