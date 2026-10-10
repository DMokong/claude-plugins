#!/usr/bin/env bash
# Isolated Codex members lose Codex's built-in sub-agent tools. Feature flags do not remove
# them (the model catalog switches them on per model), so the launcher points the member at
# a copy of the catalog without multi_agent_version and checks what a session is then told.

subagents_catalog() { printf '%s' "$HOME/.cache/herdr-jutsu/codex-models.json"; }

subagents_has_catalog_arg() { # <file with spawn stdout>
  jq -e --arg c "model_catalog_json=$(subagents_catalog | jq -Rs .)" \
    '.effective_agent_args | index($c) != null' "$1" >/dev/null 2>&1
}

test_subagents_catalog_written_private_and_checked() {
  CURRENT_TEST="subagents_catalog_written_private_and_checked"
  setup_case
  run_spawn --name sa-ok --kind codex --cwd "$REPO_DIR" -- -s read-only
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  local catalog mode dir_mode
  catalog="$(subagents_catalog)"
  [ -f "$catalog" ] || { fail_case "catalog was not written: $catalog"; teardown_case; return; }
  jq -e '(.models | length) == 2
      and all(.models[]; (has("multi_agent_version") or has("multi_agent_reasoning_effort")) | not)
      and .models[0].slug == "stub-model" and .models[0].context_window == 1000' "$catalog" >/dev/null 2>&1 \
    || { fail_case "catalog is not the stripped copy of codex debug models: $(cat "$catalog")"; teardown_case; return; }
  mode="$(stat -f '%Lp' "$catalog" 2>/dev/null || stat -c '%a' "$catalog")"
  dir_mode="$(stat -f '%Lp' "$(dirname "$catalog")" 2>/dev/null || stat -c '%a' "$(dirname "$catalog")")"
  [ "$mode" = 600 ] && [ "$dir_mode" = 700 ] \
    || { fail_case "catalog modes are $mode / $dir_mode, want 600 / 700"; teardown_case; return; }
  subagents_has_catalog_arg "$OUT_FILE" \
    || { fail_case "effective args lack the catalog override: $(jq -c .effective_agent_args "$OUT_FILE")"; teardown_case; return; }
  jq -se --arg c "model_catalog_json=$(printf '%s' "$catalog" | jq -Rs .)" \
    'map(select(.[1] == "prompt-input")) | length == 1 and (.[0] | index($c) != null) and (.[0] | index("multi_agent") != null)' \
    "$STUB_CODEX_LOG.debug" >/dev/null 2>&1 \
    || { fail_case "the session-instruction check did not run with the override: $(cat "$STUB_CODEX_LOG.debug")"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in
    *"sub-agent tools are removed (model catalog override, checked against the session instructions)"*) ;;
    *) fail_case "isolation_detail does not report the removal: $(stdout_field '.isolation_detail')"; teardown_case; return ;;
  esac
  grep -q 'codex_subagent_tools' "$ERR_FILE" && { fail_case "unexpected warning: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -qE '^agent start .* -c model_catalog_json="[^ ]*/codex-models\.json"$' "$STUB_LOG" \
    || { fail_case "the member was not started with the override: $(cat "$STUB_LOG")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_subagents_no_catalog_is_reported_not_hidden() {
  CURRENT_TEST="subagents_no_catalog_is_reported_not_hidden"
  local variant
  for variant in fail garbage empty-models; do
    setup_case
    case "$variant" in
      fail) export STUB_CODEX_MODELS_FAIL=1 ;;
      garbage) export STUB_CODEX_MODELS_OUTPUT_SET=1 STUB_CODEX_MODELS_OUTPUT='not json' ;;
      empty-models) export STUB_CODEX_MODELS_OUTPUT_SET=1 STUB_CODEX_MODELS_OUTPUT='{"models":[]}' ;;
    esac
    run_spawn --name "sa-$variant" --kind codex --cwd "$REPO_DIR" -- -s read-only
    unset STUB_CODEX_MODELS_FAIL STUB_CODEX_MODELS_OUTPUT_SET STUB_CODEX_MODELS_OUTPUT
    [ "$CODE" -eq 0 ] || { fail_case "$variant: spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
    jq -e '.effective_agent_args | map(select(startswith("model_catalog_json="))) | length == 0' "$OUT_FILE" >/dev/null 2>&1 \
      || { fail_case "$variant: an override was passed without a catalog: $(jq -c .effective_agent_args "$OUT_FILE")"; teardown_case; return; }
    [ ! -e "$(subagents_catalog)" ] || { fail_case "$variant: a catalog file was written"; teardown_case; return; }
    case "$(stdout_field '.isolation_detail')" in
      *"sub-agent tools were NOT removed (codex debug models gave no usable model catalog); they run inside the same sandbox and rules"*) ;;
      *) fail_case "$variant: isolation_detail hides that the tools remain: $(stdout_field '.isolation_detail')"; teardown_case; return ;;
    esac
    [ "$(stdout_field '.outbound_isolation')" = enforced_if_trusted ] \
      || { fail_case "$variant: the deny policy should still be in force"; teardown_case; return; }
    teardown_case
  done
  ok "$CURRENT_TEST"
}

test_subagents_override_that_does_not_work_warns() {
  CURRENT_TEST="subagents_override_that_does_not_work_warns"
  setup_case
  export STUB_CODEX_PROMPT_INPUT_ROLE=1
  run_spawn --name sa-present --kind codex --cwd "$REPO_DIR" -- -s read-only
  unset STUB_CODEX_PROMPT_INPUT_ROLE
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '"code":"codex_subagent_tools_present"' "$ERR_FILE" \
    || { fail_case "no warning when a session is still told about sub-agents: $(cat "$ERR_FILE")"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in
    *"sub-agent tools were NOT removed (the model catalog override is in place but a session is still told about them)"*) ;;
    *) fail_case "isolation_detail claims a removal that the check contradicts: $(stdout_field '.isolation_detail')"; teardown_case; return ;;
  esac
  teardown_case

  setup_case
  export STUB_CODEX_PROMPT_INPUT_FAIL=1
  run_spawn --name sa-unchecked --kind codex --cwd "$REPO_DIR" -- -s read-only
  unset STUB_CODEX_PROMPT_INPUT_FAIL
  [ "$CODE" -eq 0 ] || { fail_case "spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  grep -q '"code":"codex_subagent_tools_unverified"' "$ERR_FILE" \
    || { fail_case "no warning when the check cannot run: $(cat "$ERR_FILE")"; teardown_case; return; }
  case "$(stdout_field '.isolation_detail')" in
    *"is in place but could not be checked (codex debug prompt-input exit 1)"*) ;;
    *) fail_case "isolation_detail does not say the override is unchecked: $(stdout_field '.isolation_detail')"; teardown_case; return ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

test_subagents_nothing_written_without_a_spawn() {
  CURRENT_TEST="subagents_nothing_written_without_a_spawn"
  setup_case
  run_spawn --preflight --name sa-pre --kind codex --cwd "$REPO_DIR" -- -s read-only
  [ "$CODE" -eq 0 ] || { fail_case "preflight failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ ! -e "$HOME/.cache" ] || { fail_case "--preflight wrote under the cache directory"; teardown_case; return; }
  teardown_case

  setup_case
  run_spawn --name sa-refused --kind codex --cwd "$REPO_DIR" -- --yolo
  [ "$CODE" -eq 5 ] || { fail_case "expected the dangerous flag to be refused, got $CODE"; teardown_case; return; }
  [ ! -e "$HOME/.cache" ] || { fail_case "a refused spawn wrote under the cache directory"; teardown_case; return; }
  teardown_case

  setup_case
  run_spawn --name sa-open --kind codex --cwd "$REPO_DIR" --no-isolation
  [ "$CODE" -eq 0 ] || { fail_case "--no-isolation spawn failed: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ ! -e "$HOME/.cache" ] || { fail_case "--no-isolation wrote a catalog"; teardown_case; return; }
  jq -e '.effective_agent_args == []' "$OUT_FILE" >/dev/null 2>&1 \
    || { fail_case "--no-isolation changed the argv: $(jq -c .effective_agent_args "$OUT_FILE")"; teardown_case; return; }
  [ ! -e "$STUB_CODEX_LOG.debug" ] || { fail_case "--no-isolation queried the model catalog"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_subagents_unwritable_catalog_stops_the_spawn() {
  CURRENT_TEST="subagents_unwritable_catalog_stops_the_spawn"
  setup_case
  # A file where the cache directory must go: the argv names a catalog that cannot exist.
  mkdir -p "$HOME/.cache" && : >"$HOME/.cache/herdr-jutsu"
  run_spawn --name sa-nowrite --kind codex --cwd "$REPO_DIR" -- -s read-only
  [ "$CODE" -eq 1 ] || { fail_case "expected exit 1, got $CODE: $(cat "$ERR_FILE")"; teardown_case; return; }
  [ "$(stderr_error_code)" = codex_catalog_write_failed ] \
    || { fail_case "expected codex_catalog_write_failed, got $(stderr_error_code)"; teardown_case; return; }
  grep -q '^agent start ' "$STUB_LOG" 2>/dev/null && { fail_case "the member was started without its catalog"; teardown_case; return; }
  [ ! -e "$REPO_DIR/.codex" ] || { fail_case "the failed spawn left a policy layer behind"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

register_test test_subagents_catalog_written_private_and_checked
register_test test_subagents_no_catalog_is_reported_not_hidden
register_test test_subagents_override_that_does_not_work_warns
register_test test_subagents_nothing_written_without_a_spawn
register_test test_subagents_unwritable_catalog_stops_the_spawn
