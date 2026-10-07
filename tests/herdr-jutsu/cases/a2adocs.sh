#!/usr/bin/env bash
# AC-20 — structural documentation checks. These tests read checked-in prose only; they do
# not start an agent, invoke the launcher, or exercise a live transport.

A2ADOC="$REPO_ROOT/plugins/herdr-jutsu/skills/herdr-jutsu/references/a2a.md"
A2ASKILL="$REPO_ROOT/plugins/herdr-jutsu/skills/herdr-jutsu/SKILL.md"
A2APRESETS="$REPO_ROOT/plugins/herdr-jutsu/skills/herdr-jutsu/references/launch-presets.md"

a2adocs_require() { # file fixed-string [fixed-string ...]
  local file="$1" phrase
  shift
  for phrase in "$@"; do
    grep -Fqi -- "$phrase" "$file" || {
      fail_case "$(basename "$file") is missing required text: $phrase"
      return 1
    }
  done
  return 0
}

test_a2adocs_enable_brief_and_reply_rule() {
  CURRENT_TEST="a2adocs_enable_brief_and_reply_rule"
  a2adocs_require "$A2ADOC" '--a2a' '--peer <name>' \
    'For a mid-task question that blocks progress' \
    'Reply to it with your `send_message` tool, addressed to the sender' \
    'reply with `send_message`, `to` the labelled sender' \
    '`--codex <absolute path>` is required when the recipient is a Codex member' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_guard_table_is_complete() {
  CURRENT_TEST="a2adocs_guard_table_is_complete"
  a2adocs_require "$A2ADOC" 'too_large' 'bad_request' 'forged_envelope' \
    'a2a_disabled' 'not_ready' 'not_a_peer' 'rate_limited' 'recipient_busy' \
    'pair_budget_exhausted' 'stream_budget_exhausted' 'busy_retry' \
    'recipient_unavailable' 'storage_unsafe' 'delivery_failed' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_validation_and_audit_contract() {
  CURRENT_TEST="a2adocs_validation_and_audit_contract"
  a2adocs_require "$A2ADOC" '65,536 bytes' 'strict UTF-8' '8,192 bytes' \
    'cross-session-message' 'begin/end peer-message marker' \
    'message bodies are never written to the audit log' \
    'failed safety check on the audit file itself produces no audit line' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_compatibility_table_is_complete() {
  CURRENT_TEST="a2adocs_compatibility_table_is_complete"
  a2adocs_require "$A2ADOC" 'a2a_required' 'bad_peer_name' 'peer_is_self' \
    'duplicate_peer' 'a2a_kind_unsupported' 'a2a_requires_isolation' \
    'a2a_arg_conflict' 'a2a_registry_unsuitable' 'a2a_parent_unreachable' \
    'a2a_runtime_missing' 'socket_path_too_long' 'a2a_parent_unnamed' \
    'a2a_not_applicable' 'a2a_storage_in_write_root' \
    '`--a2a --strict-isolation` for Claude' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_kill_switch() {
  CURRENT_TEST="a2adocs_kill_switch"
  a2adocs_require "$A2ADOC" 'jutsu-a2a.mjs disable' 'jutsu-a2a.mjs enable' \
    'already running' 'a2a_disabled' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_residual_sender_forgery() {
  CURRENT_TEST="a2adocs_residual_sender_forgery"
  a2adocs_require "$A2ADOC" 'send --from` is caller-asserted' \
    'Claude member that runs Bash unprompted can forge the parent' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_residual_codex_user_turn() {
  CURRENT_TEST="a2adocs_residual_codex_user_turn"
  a2adocs_require "$A2ADOC" 'Codex receives peer prose as a user turn' \
    'preamble is advisory, not a boundary' \
    'unsandboxed same-user process can run `codex queue`' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_residual_claude_platform() {
  CURRENT_TEST="a2adocs_residual_claude_platform"
  a2adocs_require "$A2ADOC" 'Claude inbox accepts unauthenticated local senders on macOS' \
    'cannot mitigate that platform behaviour' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_residual_prompt_injection() {
  CURRENT_TEST="a2adocs_residual_prompt_injection"
  a2adocs_require "$A2ADOC" 'a peer may ask; the recipient acts within its own permissions' \
    'laundering a denied action must be refused' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_residual_storage_and_flood() {
  CURRENT_TEST="a2adocs_residual_storage_and_flood"
  a2adocs_require "$A2ADOC" 'Claude member can edit the launcher-owned files' \
    'budgets are time-based' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_residual_process_and_mcp() {
  CURRENT_TEST="a2adocs_residual_process_and_mcp"
  a2adocs_require "$A2ADOC" 'none expected; tested' \
    'relay process has full host privilege' 'one tool only; no' \
    'hostile same-user process' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_policy_v2_rollback() {
  CURRENT_TEST="a2adocs_policy_v2_rollback"
  a2adocs_require "$A2ADOC" 'Policy v2' '0.4.0 launcher correctly refuses' \
    'delete only the launcher-owned, git-excluded file' \
    '.codex/rules/herdr-jutsu-deny.rules' 'then respawn the member' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_skill_pointer_and_line_budget() {
  CURRENT_TEST="a2adocs_skill_pointer_and_line_budget"
  local lines
  lines="$(wc -l <"$A2ASKILL" | tr -d ' ')"
  # AC-20: the A2A pointer may add at most 6 lines. Released 0.4.1 SKILL.md is 239 lines.
  [ "$lines" -le 245 ] || {
    fail_case "SKILL.md is $lines lines; line budget is 245 (0.4.1's 239 + 6)"
    return
  }
  a2adocs_require "$A2ASKILL" 'references/a2a.md' 'required brief clause' \
    'reply rule' 'kill switch' 'rollback procedure' || return
  ok "$CURRENT_TEST"
}

test_a2adocs_launch_presets_cover_both_engines() {
  CURRENT_TEST="a2adocs_launch_presets_cover_both_engines"
  local rows
  rows="$(grep -Fc '| A2A member | launcher: `--a2a' "$A2APRESETS")"
  [ "$rows" -eq 2 ] || {
    fail_case "launch-presets.md must contain one A2A row per engine; found $rows"
    return
  }
  ok "$CURRENT_TEST"
}

register_test test_a2adocs_enable_brief_and_reply_rule
register_test test_a2adocs_guard_table_is_complete
register_test test_a2adocs_validation_and_audit_contract
register_test test_a2adocs_compatibility_table_is_complete
register_test test_a2adocs_kill_switch
register_test test_a2adocs_residual_sender_forgery
register_test test_a2adocs_residual_codex_user_turn
register_test test_a2adocs_residual_claude_platform
register_test test_a2adocs_residual_prompt_injection
register_test test_a2adocs_residual_storage_and_flood
register_test test_a2adocs_residual_process_and_mcp
register_test test_a2adocs_policy_v2_rollback
register_test test_a2adocs_skill_pointer_and_line_budget
register_test test_a2adocs_launch_presets_cover_both_engines
