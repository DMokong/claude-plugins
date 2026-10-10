#!/usr/bin/env bash
# tests/herdr-jutsu/cases/policylock.sh — trk-4sh.13: a waiter for the Codex policy lock must
# never die silently when the holder's pid file cannot be read. In production that happens
# when the holder releases the lock between the waiter's `-f` test and its read; here an
# unreadable pid file reaches the same code path deterministically.

test_policylock_unreadable_pid_times_out_with_a_clear_error() {
  CURRENT_TEST="policylock_unreadable_pid_times_out_with_a_clear_error"
  setup_case
  /bin/mkdir "$REPO_DIR/.herdr-jutsu-policy.lock"
  printf '%s\n' 1 >"$REPO_DIR/.herdr-jutsu-policy.lock/pid"
  chmod 000 "$REPO_DIR/.herdr-jutsu-policy.lock/pid"
  export JUTSU_POLICY_LOCK_TIMEOUT_MS=150
  run_spawn --name plock-unreadable --kind codex --cwd "$REPO_DIR"
  chmod 600 "$REPO_DIR/.herdr-jutsu-policy.lock/pid"
  [ "$CODE" -ne 0 ] || { fail_case "spawn ignored a held policy lock"; teardown_case; return; }
  [ -s "$ERR_FILE" ] \
    || { fail_case "spawn exited $CODE with no error output (silent failure)"; teardown_case; return; }
  [ "$(stderr_error_code)" = isolation_policy_lock_timeout ] \
    || { fail_case "unreadable holder pid was not reported as a lock timeout: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ -d "$REPO_DIR/.herdr-jutsu-policy.lock" ] \
    || { fail_case "a lock whose holder could not be identified was broken"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policylock_unremovable_stale_lock_times_out_instead_of_spinning() {
  CURRENT_TEST="policylock_unremovable_stale_lock_times_out_instead_of_spinning"
  setup_case
  local dead
  ( : ) & dead=$!
  wait "$dead" 2>/dev/null || true
  /bin/mkdir "$REPO_DIR/.herdr-jutsu-policy.lock"
  printf '%s\n' "$dead" >"$REPO_DIR/.herdr-jutsu-policy.lock/pid"
  # A read-only lock directory: neither the pid file nor the directory can be removed.
  chmod 500 "$REPO_DIR/.herdr-jutsu-policy.lock"
  export JUTSU_POLICY_LOCK_TIMEOUT_MS=150
  run_spawn --name plock-unremovable --kind codex --cwd "$REPO_DIR"
  chmod 700 "$REPO_DIR/.herdr-jutsu-policy.lock"
  [ "$CODE" -ne 0 ] || { fail_case "spawn proceeded past a lock it could not remove"; teardown_case; return; }
  [ "$(stderr_error_code)" = isolation_policy_lock_timeout ] \
    || { fail_case "unremovable stale lock was not reported as a lock timeout: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ -f "$REPO_DIR/.herdr-jutsu-policy.lock/pid" ] \
    || { fail_case "the read-only lock was modified"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

register_test test_policylock_unreadable_pid_times_out_with_a_clear_error
register_test test_policylock_unremovable_stale_lock_times_out_instead_of_spinning
