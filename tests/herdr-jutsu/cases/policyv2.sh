#!/usr/bin/env bash
# AC-28 — policy v2 forbids direct codex queue delivery and migrates only the exact
# herdr-jutsu 0.4.0 launcher output while the existing per-cwd policy lock is held.

policyv2_escape_path() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

policyv2_v040_content() {
  local herdr_path
  herdr_path="$(policyv2_escape_path "$(command -v herdr)")"
  printf '%s\n%s' \
    "host_executable(name=\"herdr\", paths=[\"$herdr_path\"])" \
    'prefix_rule(pattern=["herdr"], decision="forbidden", justification="Crew members do not drive herdr; the parent pulls from this pane.")'
}

policyv2_content() {
  local herdr_path codex_path
  herdr_path="$(policyv2_escape_path "$(command -v herdr)")"
  codex_path="$(policyv2_escape_path "$(command -v codex)")"
  printf '%s\n%s\n%s\n%s' \
    "host_executable(name=\"herdr\", paths=[\"$herdr_path\"])" \
    'prefix_rule(pattern=["herdr"], decision="forbidden", justification="Crew members do not drive herdr; the parent pulls from this pane.")' \
    "host_executable(name=\"codex\", paths=[\"$codex_path\"])" \
    'prefix_rule(pattern=["codex","queue"], decision="forbidden", justification="Crew members use the guarded herdr-jutsu A2A relay; direct Codex queue delivery is forbidden.")'
}

policyv2_assert_exact() {
  local file="$1"
  cmp -s "$file" <(policyv2_content; printf '\n')
}

policyv2_v040_existing_result() { # 0.4.0 comparison result: 0=accepted, 5=differing
  cmp -s "$1" <(policyv2_v040_content; printf '\n') && return 0
  return 5
}

test_policyv2_fresh_isolated_codex_writes_queue_rule() {
  CURRENT_TEST="policyv2_fresh_isolated_codex_writes_queue_rule"
  setup_case
  run_spawn --name pv2-fresh --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] \
    || { fail_case "fresh isolated Codex spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  local rules="$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules"
  policyv2_assert_exact "$rules" \
    || { fail_case "fresh rules are not byte-exact policy v2: $(cat "$rules")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policyv2_exact_v040_is_atomically_upgraded() {
  CURRENT_TEST="policyv2_exact_v040_is_atomically_upgraded"
  setup_case
  local rules="$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules"
  mkdir -p "$(dirname "$rules")"
  { policyv2_v040_content; printf '\n'; } >"$rules"
  run_spawn --name pv2-upgrade --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] \
    || { fail_case "exact 0.4.0 policy was not upgraded: $(cat "$ERR_FILE")"; teardown_case; return; }
  policyv2_assert_exact "$rules" \
    || { fail_case "migration did not leave one exact policy-v2 file: $(cat "$rules")"; teardown_case; return; }
  [ "$(find "$(dirname "$rules")" -maxdepth 1 -name '.herdr-jutsu-deny.rules.*' | wc -l | tr -d ' ')" -eq 0 ] \
    || { fail_case "atomic migration left a temporary rules file"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policyv2_nonexact_v040_content_is_refused() {
  CURRENT_TEST="policyv2_nonexact_v040_content_is_refused"
  setup_case
  local rules="$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules" before after
  mkdir -p "$(dirname "$rules")"
  # The missing final newline makes this byte-different from launcher 0.4.0 output.
  policyv2_v040_content >"$rules"
  before="$(cksum <"$rules")"
  run_spawn --name pv2-nonexact --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 5 ] && [ "$(stderr_error_code)" = isolation_policy_conflict ] \
    || { fail_case "nonexact legacy content was not refused: rc=$CODE $(cat "$ERR_FILE")"; teardown_case; return; }
  after="$(cksum <"$rules")"
  [ "$after" = "$before" ] \
    || { fail_case "refusal overwrote the differing rules file"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policyv2_concurrent_spawns_produce_one_valid_file() {
  CURRENT_TEST="policyv2_concurrent_spawns_produce_one_valid_file"
  setup_case
  local out1="$SCRATCH/pv2-one.out" err1="$SCRATCH/pv2-one.err"
  local out2="$SCRATCH/pv2-two.out" err2="$SCRATCH/pv2-two.err" p1 p2 rc1 rc2
  "$SPAWN" --name pv2-one --kind codex --cwd "$REPO_DIR" >"$out1" 2>"$err1" & p1=$!
  "$SPAWN" --name pv2-two --kind codex --cwd "$REPO_DIR" >"$out2" 2>"$err2" & p2=$!
  wait "$p1"; rc1=$?
  wait "$p2"; rc2=$?
  [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ] \
    || { fail_case "concurrent spawns failed: one=$rc1 two=$rc2; $(cat "$err1") $(cat "$err2")"; teardown_case; return; }
  local rules="$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules"
  policyv2_assert_exact "$rules" \
    || { fail_case "concurrent spawns did not leave exact policy v2: $(cat "$rules")"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.herdr-jutsu-policy.lock" ] \
    || { fail_case "concurrent spawns left the policy lock behind"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_policyv2_rollback_delete_then_respawn_contract() {
  CURRENT_TEST="policyv2_rollback_delete_then_respawn_contract"
  setup_case
  run_spawn --name pv2-before-rollback --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] \
    || { fail_case "policy-v2 setup spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  local rules="$REPO_DIR/.codex/rules/herdr-jutsu-deny.rules" before rollback_rc
  before="$(cksum <"$rules")"
  policyv2_v040_existing_result "$rules"; rollback_rc=$?
  [ "$rollback_rc" -eq 5 ] \
    || { fail_case "0.4.0 comparison did not refuse policy v2 as differing"; teardown_case; return; }
  [ "$(cksum <"$rules")" = "$before" ] \
    || { fail_case "0.4.0 comparison changed the policy-v2 file"; teardown_case; return; }
  rm -f "$rules"
  run_spawn --name pv2-after-rollback --kind codex --cwd "$REPO_DIR"
  [ "$CODE" -eq 0 ] \
    || { fail_case "respawn after documented deletion failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  policyv2_assert_exact "$rules" \
    || { fail_case "respawn after deletion did not write valid policy v2"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

register_test test_policyv2_fresh_isolated_codex_writes_queue_rule
register_test test_policyv2_exact_v040_is_atomically_upgraded
register_test test_policyv2_nonexact_v040_content_is_refused
register_test test_policyv2_concurrent_spawns_produce_one_valid_file
register_test test_policyv2_rollback_delete_then_respawn_contract
