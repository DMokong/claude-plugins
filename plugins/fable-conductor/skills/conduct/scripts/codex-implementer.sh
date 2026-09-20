#!/bin/bash
# codex-implementer.sh — run one implementer task on a Codex worker, under isolation.
#
#   codex-implementer.sh run --stream-dir D --task T --round N --checkout P \
#       --expected-branch B --spec F --base OID --scope-file F --effort E \
#       [--model M] [--timeout S] [--findings F] [--rulings F]
#   codex-implementer.sh run --help
#   codex-implementer.sh classes
#
# Channels: until the run directory exists, exactly one JSON error object on stderr and
# nothing on stdout. From the run directory onward, exactly one JSON result line on stdout and
# nothing on stderr — diagnostics go to <run>/run.log only. `class` (+ `phase`) is the machine
# discriminator; the exit code is a coarse group: 0 ok · 2 usage/refusal before launch ·
# 3 the worker ran (or tried) and it is not ok · 4 environment or policy failure.
#
# A successful run also writes the ready-to-paste report body to <run>/section.md.

umask 077
set -u

FC_SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# --- option globals (set by fc_parse_run, read-only afterwards) ----------------------------
FC_STREAM_DIR=""; FC_STREAM=""; FC_TASK=""; FC_ROUND=""; FC_CHECKOUT=""; FC_BRANCH=""
FC_SPEC=""; FC_BASE=""; FC_SCOPE_FILE=""; FC_MODEL=""; FC_EFFORT=""; FC_TIMEOUT=""
FC_FINDINGS=""; FC_RULINGS=""; FC_BRIEF=""; FC_REPORT=""
# --- run globals ---------------------------------------------------------------------------
FC_ROOT=""; FC_RUN_DIR=""; FC_RUN_ID=""; FC_CODEX_VERSION=""; FC_ARGV_SHA=""
FC_CHILD_EXIT="null"; FC_CHILD_SIGNAL="null"; FC_CHILD_ENDED_BY="not_launched"
FC_GITDIR=""; FC_COMMON_DIR=""; FC_HOOKS_DIR=""; FC_LOCK_DIR=""; FC_LOCK_HELD=0
FC_SCRATCH=""; FC_STARTED=""; FC_RUNDIR_LIVE=0
FC_ENVELOPE_JSON=""; FC_PROMPT=""
FC_OUT_STATUS=""; FC_OUT_JSON="null"; FC_MEMBER_JSON="null"
FC_SIGNATURE=""; FC_TRANSIENT=""; FC_USAGE_JSON="null"; FC_USAGE_ERROR=""
FC_CHANGED_JSON="[]"; FC_VIOLATIONS_JSON="[]"
FC_HEAD_BEFORE=""; FC_HEAD_AFTER=""; FC_BASE_TREE=""; FC_POST_TREE=""
# --- outcome globals -----------------------------------------------------------------------
FC_CLASS=""; FC_PHASE=""; FC_REASON=""; FC_FIELD=""; FC_DETAIL_JSON=""; FC_MESSAGE=""

FC_ARGV=()
FC_SCOPE_LIST=()

FC_DISABLE_FEATURES="apps browser_use browser_use_external browser_use_full_cdp_access \
computer_use image_generation multi_agent plugins remote_plugin plugin_sharing skill_search \
skill_mcp_dependency_install tool_suggest hooks in_app_browser in_app_local_automation"

# =========================================================================================
# Small utilities
# =========================================================================================

fc_now() {
  if [ "${FC_TEST_MODE:-}" = "1" ] && [ -n "${FC_TEST_NOW:-}" ]; then
    printf '%s\n' "$FC_TEST_NOW"
  else
    date +%s
  fi
}

fc_digest_file() { shasum -a 256 "$1" | cut -d' ' -f1; }
fc_digest_stdin() { shasum -a 256 | cut -d' ' -f1; }

# fc_json_array <element...> — a compact JSON array of the arguments, exactly as given.
# Every element travels as a jq `--arg` value, because jq's `--args` positional list would
# mis-parse an element that starts with `-` (a real hazard: `-s`, `--disable`, and a worker
# is free to create a file named `-x`).
fc_json_array() {
  local a i=0 opts=() prog="["
  for a in "$@"; do
    opts+=(--arg "e$i" "$a")
    if [ "$i" = 0 ]; then prog="$prog\$e$i"; else prog="$prog,\$e$i"; fi
    i=$((i + 1))
  done
  prog="$prog]"
  jq -c -n ${opts[@]+"${opts[@]}"} "$prog"
}

fc_log() { # diagnostics; dropped until the run log exists
  [ -n "$FC_RUN_DIR" ] && [ -f "$FC_RUN_DIR/run.log" ] || return 0
  printf '%s %s\n' "$(fc_now)" "$1" >>"$FC_RUN_DIR/run.log"
}

fc_set_outcome() { # <class> <phase> <reason> <field> <detail-json> <message>
  FC_CLASS="$1"; FC_PHASE="$2"; FC_REASON="$3"; FC_FIELD="$4"; FC_DETAIL_JSON="$5"; FC_MESSAGE="$6"
}

fc_exit_for_class() {
  case "$1" in
    ok) echo 0 ;;
    usage|refused|invalid_engine_config) echo 2 ;;
    policy_violation|malformed_result|adapter_timeout|worker_failed) echo 3 ;;
    engine_unavailable|policy_unavailable) echo 4 ;;
    *) echo 3 ;;
  esac
}

fc_usage() { # <reason> <field> <message>
  fc_set_outcome usage "" "$1" "$2" "" "$3"
  fc_finish
}

# =========================================================================================
# The egress rule table (spec Conventions). The decision is REJECT or ALLOW; nothing is
# redacted, and a finding never carries the matching text — only the rule id and the field.
# `placeholders` exempts a match whose LAST capture group equals a listed value.
# =========================================================================================

fc_egress_rules() {
  cat <<'FC_EGRESS_RULES'
[
 {"id":"openrouter_key","expression":"sk-or-v1-[A-Za-z0-9]{16,}","placeholders":[]},
 {"id":"anthropic_key","expression":"sk-ant-[A-Za-z0-9_-]{16,}","placeholders":[]},
 {"id":"slack_bot_token","expression":"xoxb-[A-Za-z0-9-]{10,}","placeholders":[]},
 {"id":"github_pat","expression":"ghp_[A-Za-z0-9]{20,}","placeholders":[]},
 {"id":"google_api_key","expression":"AIza[A-Za-z0-9_-]{30,}","placeholders":[]},
 {"id":"supabase_token","expression":"sbp_[A-Za-z0-9]{20,}","placeholders":[]},
 {"id":"db_url_password","expression":"postgres(ql)?://[^:/@ ]+:([^@ ]+)@","placeholders":["password","PASSWORD","<password>","[YOUR-PASSWORD]","YOUR_PASSWORD","REDACTED","changeme","example"]},
 {"id":"env_assignment","expression":"^(export +)?[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=[^ ]{8,}","placeholders":[]},
 {"id":"mcp_config","expression":"^\\[mcp_servers[.\\]]|mcp_servers *=|\"mcpServers\" *:","placeholders":[]}
]
FC_EGRESS_RULES
}

# =========================================================================================
# The class x phase registry (19 rows, in order)
# =========================================================================================

fc_classes_json() {
  cat <<'FC_CLASSES'
{"schema":1,"classes":[
{"class":"ok","phase":null,"exit":0,"channel":"stdout","retryable":"no"},
{"class":"usage","phase":null,"exit":2,"channel":"stderr","retryable":"no"},
{"class":"invalid_engine_config","phase":null,"exit":2,"channel":"stderr","retryable":"no"},
{"class":"refused","phase":"preflight","exit":2,"channel":"stderr","retryable":"no"},
{"class":"refused","phase":"egress","exit":2,"channel":"stderr","retryable":"no"},
{"class":"refused","phase":"lock","exit":2,"channel":"stderr","retryable":"yes"},
{"class":"policy_unavailable","phase":"probe","exit":4,"channel":"stderr","retryable":"no"},
{"class":"policy_unavailable","phase":"isolation_config","exit":4,"channel":"stderr","retryable":"no"},
{"class":"engine_unavailable","phase":"binary_missing","exit":4,"channel":"stderr","retryable":"no"},
{"class":"engine_unavailable","phase":"signature","exit":4,"channel":"stdout","retryable":"if_transient"},
{"class":"policy_violation","phase":"manifest","exit":3,"channel":"stdout","retryable":"no"},
{"class":"malformed_result","phase":"output_binding","exit":3,"channel":"stdout","retryable":"yes"},
{"class":"malformed_result","phase":"output_schema","exit":3,"channel":"stdout","retryable":"yes"},
{"class":"adapter_timeout","phase":null,"exit":3,"channel":"stdout","retryable":"yes"},
{"class":"worker_failed","phase":"launch","exit":3,"channel":"stdout","retryable":"no"},
{"class":"worker_failed","phase":"baseline","exit":3,"channel":"stdout","retryable":"no"},
{"class":"worker_failed","phase":"manifest","exit":3,"channel":"stdout","retryable":"no"},
{"class":"worker_failed","phase":"worker_exit","exit":3,"channel":"stdout","retryable":"yes"},
{"class":"worker_failed","phase":"signal","exit":3,"channel":"stdout","retryable":"yes"}
]}
FC_CLASSES
}

# =========================================================================================
# Step 1 — fc_parse_run
# =========================================================================================

FC_OPTION_NAMES="--stream-dir --task --round --checkout --expected-branch --spec --base \
--scope-file --effort --model --timeout --findings --rulings --help"

fc_parse_run() {
  local seen_stream="" seen_task="" seen_round="" seen_checkout="" seen_branch="" \
        seen_spec="" seen_base="" seen_scope="" seen_effort="" seen_model="" \
        seen_timeout="" seen_findings="" seen_rulings=""
  local name value canon

  while [ "$#" -gt 0 ]; do
    name="$1"
    case "$name" in
      --help)
        local o
        for o in $FC_OPTION_NAMES; do printf '%s\n' "$o"; done
        exit 0
        ;;
      --) fc_usage double_dash "" "'--' is not accepted; every option is named" ;;
      --*)
        if [ "$#" -lt 2 ]; then
          fc_usage missing_value "${name#--}" "option $name needs a value"
        fi
        value="$2"
        shift 2
        case "$name" in
          --stream-dir)      [ -z "$seen_stream" ]   || fc_usage duplicate_option stream-dir "$name given twice";      seen_stream=1;   FC_STREAM_DIR="$value" ;;
          --task)            [ -z "$seen_task" ]     || fc_usage duplicate_option task "$name given twice";            seen_task=1;     FC_TASK="$value" ;;
          --round)           [ -z "$seen_round" ]    || fc_usage duplicate_option round "$name given twice";           seen_round=1;    FC_ROUND="$value" ;;
          --checkout)        [ -z "$seen_checkout" ] || fc_usage duplicate_option checkout "$name given twice";        seen_checkout=1; FC_CHECKOUT="$value" ;;
          --expected-branch) [ -z "$seen_branch" ]   || fc_usage duplicate_option expected-branch "$name given twice"; seen_branch=1;   FC_BRANCH="$value" ;;
          --spec)            [ -z "$seen_spec" ]     || fc_usage duplicate_option spec "$name given twice";            seen_spec=1;     FC_SPEC="$value" ;;
          --base)            [ -z "$seen_base" ]     || fc_usage duplicate_option base "$name given twice";            seen_base=1;     FC_BASE="$value" ;;
          --scope-file)      [ -z "$seen_scope" ]    || fc_usage duplicate_option scope-file "$name given twice";      seen_scope=1;    FC_SCOPE_FILE="$value" ;;
          --effort)          [ -z "$seen_effort" ]   || fc_usage duplicate_option effort "$name given twice";          seen_effort=1;   FC_EFFORT="$value" ;;
          --model)           [ -z "$seen_model" ]    || fc_usage duplicate_option model "$name given twice";           seen_model=1;    FC_MODEL="$value" ;;
          --timeout)         [ -z "$seen_timeout" ]  || fc_usage duplicate_option timeout "$name given twice";         seen_timeout=1;  FC_TIMEOUT="$value" ;;
          --findings)        [ -z "$seen_findings" ] || fc_usage duplicate_option findings "$name given twice";        seen_findings=1; FC_FINDINGS="$value" ;;
          --rulings)         [ -z "$seen_rulings" ]  || fc_usage duplicate_option rulings "$name given twice";         seen_rulings=1;  FC_RULINGS="$value" ;;
          *) fc_usage unknown_option "${name#--}" "unknown option $name" ;;
        esac
        ;;
      *) fc_usage positional "" "positional arguments are not accepted: $name" ;;
    esac
  done

  [ -n "$seen_stream" ]   || fc_usage missing_option stream-dir      "--stream-dir is required"
  [ -n "$seen_task" ]     || fc_usage missing_option task            "--task is required"
  [ -n "$seen_round" ]    || fc_usage missing_option round           "--round is required"
  [ -n "$seen_checkout" ] || fc_usage missing_option checkout        "--checkout is required"
  [ -n "$seen_branch" ]   || fc_usage missing_option expected-branch "--expected-branch is required"
  [ -n "$seen_spec" ]     || fc_usage missing_option spec            "--spec is required"
  [ -n "$seen_base" ]     || fc_usage missing_option base            "--base is required"
  [ -n "$seen_scope" ]    || fc_usage missing_option scope-file      "--scope-file is required"
  [ -n "$seen_effort" ]   || fc_usage missing_option effort          "--effort is required"

  case "$FC_ROUND" in
    ''|*[!0-9]*) fc_usage bad_value round "--round must be a positive integer" ;;
  esac
  [ "$FC_ROUND" -ge 1 ] || fc_usage bad_value round "--round must be a positive integer"

  if [ -z "$seen_timeout" ]; then
    FC_TIMEOUT=1800
  else
    case "$FC_TIMEOUT" in
      ''|*[!0-9]*) fc_usage bad_value timeout "--timeout must be an integer" ;;
    esac
    if [ "$FC_TIMEOUT" -lt 60 ] || [ "$FC_TIMEOUT" -gt 3600 ]; then
      fc_usage bad_value timeout "--timeout must be between 60 and 3600"
    fi
  fi

  if [ "$FC_ROUND" -ge 2 ]; then
    [ -n "$seen_findings" ] || fc_usage missing_option findings "--findings is required from round 2"
  else
    [ -z "$seen_findings" ] || fc_usage bad_value findings "--findings is forbidden in round 1"
  fi
  if [ -n "$seen_rulings" ] && [ -z "$seen_findings" ]; then
    fc_usage bad_value rulings "--rulings is only valid with --findings"
  fi

  # --checkout must be a canonical directory
  case "$FC_CHECKOUT" in
    /*) ;;
    *) fc_usage bad_value checkout "--checkout must be an absolute canonical directory" ;;
  esac
  [ -d "$FC_CHECKOUT" ] || fc_usage bad_value checkout "--checkout is not an existing directory"
  canon="$(cd -P -- "$FC_CHECKOUT" 2>/dev/null && pwd -P)" || canon=""
  [ "$canon" = "$FC_CHECKOUT" ] || fc_usage bad_value checkout "--checkout is not spelled canonically"

  # stream / task grammar, and the derived brief and report paths
  FC_STREAM="${FC_STREAM_DIR##*/}"
  case "$FC_STREAM" in
    [A-Za-z0-9]*) ;;
    *) fc_usage bad_value stream-dir "the stream name must match ^[A-Za-z0-9][A-Za-z0-9._-]*$" ;;
  esac
  case "$FC_STREAM" in
    *[!A-Za-z0-9._-]*) fc_usage bad_value stream-dir "the stream name must match ^[A-Za-z0-9][A-Za-z0-9._-]*$" ;;
  esac
  case "$FC_TASK" in
    [A-Za-z0-9]*) ;;
    *) fc_usage bad_value task "the task name must match ^[A-Za-z0-9][A-Za-z0-9._-]*$" ;;
  esac
  case "$FC_TASK" in
    *[!A-Za-z0-9._-]*) fc_usage bad_value task "the task name must match ^[A-Za-z0-9][A-Za-z0-9._-]*$" ;;
  esac

  FC_BRIEF="$FC_STREAM_DIR/tasks/$FC_TASK/brief.md"
  FC_REPORT="$FC_STREAM_DIR/tasks/$FC_TASK/report.md"
  return 0
}

# =========================================================================================
# Step 2 — fc_engine_check
# =========================================================================================

fc_engine_check() {
  local table="$FC_SCRIPT_DIR/engine-table.json" known
  if [ ! -f "$table" ]; then
    fc_set_outcome policy_unavailable isolation_config missing_engine_table "" "" "engine-table.json is missing"
    fc_finish
  fi
  known="$(jq -r --arg e "$FC_EFFORT" '.efforts | index($e) // "" | tostring' "$table" 2>/dev/null || true)"
  if [ -z "$known" ] || [ "$known" = "null" ]; then
    fc_set_outcome invalid_engine_config "" unknown_effort effort "" "unknown effort: $FC_EFFORT"
    fc_finish
  fi
  if [ -n "$FC_MODEL" ]; then
    case "$FC_MODEL" in
      [A-Za-z0-9]*) ;;
      *) fc_set_outcome invalid_engine_config "" bad_model model "" "model does not match ^[A-Za-z0-9][A-Za-z0-9._-]*$"; fc_finish ;;
    esac
    case "$FC_MODEL" in
      *[!A-Za-z0-9._-]*) fc_set_outcome invalid_engine_config "" bad_model model "" "model does not match ^[A-Za-z0-9][A-Za-z0-9._-]*$"; fc_finish ;;
    esac
  fi
  return 0
}

# =========================================================================================
# Step 3 — fc_checkout_check
# =========================================================================================

fc_refuse_preflight() { # <reason> <message>
  fc_set_outcome refused preflight "$1" "" "" "$2"
  fc_finish
}

fc_checkout_check() {
  local top gitdir common branch flags

  top="$(git -C "$FC_CHECKOUT" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] || fc_refuse_preflight not_toplevel "the checkout is not inside a git working tree"
  top="$(cd -P -- "$top" 2>/dev/null && pwd -P)" || top=""
  [ "$top" = "$FC_CHECKOUT" ] || fc_refuse_preflight not_toplevel "the checkout is not the top level of its working tree"

  gitdir="$(git -C "$FC_CHECKOUT" rev-parse --absolute-git-dir 2>/dev/null || true)"
  common="$(git -C "$FC_CHECKOUT" rev-parse --git-common-dir 2>/dev/null || true)"
  case "$common" in /*) ;; *) common="$FC_CHECKOUT/$common" ;; esac
  gitdir="$(cd -P -- "$gitdir" 2>/dev/null && pwd -P)" || gitdir=""
  common="$(cd -P -- "$common" 2>/dev/null && pwd -P)" || common=""
  [ -n "$gitdir" ] && [ -n "$common" ] || fc_refuse_preflight not_toplevel "the git directory could not be resolved"
  [ "$gitdir" != "$common" ] || fc_refuse_preflight main_checkout \
    "refusing to run in the main checkout; use a linked worktree"
  FC_GITDIR="$gitdir"
  FC_COMMON_DIR="$common"

  git -C "$FC_CHECKOUT" symbolic-ref -q HEAD >/dev/null 2>&1 \
    || fc_refuse_preflight detached_head "HEAD is detached"
  branch="$(git -C "$FC_CHECKOUT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [ "$branch" = "$FC_BRANCH" ] || fc_refuse_preflight branch_mismatch \
    "the checkout is on '$branch', not the expected '$FC_BRANCH'"

  [ -f "$FC_BRIEF" ] || fc_refuse_preflight not_codex_task "the derived brief does not exist: $FC_BRIEF"
  flags="$(grep -c '^implementer: codex *$' "$FC_BRIEF" 2>/dev/null | tr -d ' ')"
  [ "$flags" = "1" ] || fc_refuse_preflight not_codex_task \
    "the brief must carry exactly one 'implementer: codex' line (found ${flags:-0})"

  FC_HOOKS_DIR="$(git -C "$FC_CHECKOUT" config --get core.hooksPath 2>/dev/null || true)"
  if [ -z "$FC_HOOKS_DIR" ]; then
    FC_HOOKS_DIR="$FC_COMMON_DIR/hooks"
  else
    case "$FC_HOOKS_DIR" in /*) ;; *) FC_HOOKS_DIR="$FC_CHECKOUT/$FC_HOOKS_DIR" ;; esac
  fi
  return 0
}

# =========================================================================================
# Step 4 — fc_envelope_build
# =========================================================================================

fc_usage_field() { # <field> <message>
  fc_set_outcome usage "" bad_value "$1" "" "$2"
  fc_finish
}

fc_canonical_file() { # <path> -> prints the canonical spelling, or fails
  local p="$1" d b
  case "$p" in /*) ;; *) return 1 ;; esac
  [ ! -L "$p" ] || return 1
  [ -f "$p" ] || return 1
  d="${p%/*}"; b="${p##*/}"
  d="$(cd -P -- "$d" 2>/dev/null && pwd -P)" || return 1
  [ "$d/$b" = "$p" ] || return 1
  printf '%s\n' "$p"
}

fc_envelope_build() {
  local rules_file="$FC_SCRIPT_DIR/implementer-envelope.md"
  local schema_file="$FC_SCRIPT_DIR/implementer-output.schema.json"
  local rules line n=0 report_dir findings_bytes rulings_bytes

  [ -f "$rules_file" ] || fc_usage_field rules "the implementer rules template is missing"
  rules="$(cat "$rules_file")"
  [ -n "$rules" ] || fc_usage_field rules "the implementer rules template is empty"
  [ -f "$schema_file" ] || fc_usage_field output_contract "the output schema is missing"
  jq -e . "$schema_file" >/dev/null 2>&1 || fc_usage_field output_contract "the output schema is not valid JSON"

  fc_canonical_file "$FC_BRIEF" >/dev/null || fc_usage_field brief "the derived brief is not a canonical file"
  fc_canonical_file "$FC_SPEC"  >/dev/null || fc_usage_field spec  "--spec is not a canonical file"

  report_dir="${FC_REPORT%/*}"
  [ -d "$report_dir" ] || fc_usage_field report "the report directory does not exist"
  [ "$(cd -P -- "$report_dir" && pwd -P)" = "$report_dir" ] \
    || fc_usage_field report "the report directory is not canonical"

  case "$FC_BASE" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) fc_usage_field base "--base must be a 40-hex commit id" ;;
  esac
  [ "${#FC_BASE}" = "40" ] || fc_usage_field base "--base must be a 40-hex commit id"
  case "$FC_BASE" in *[!0-9a-f]*) fc_usage_field base "--base must be a 40-hex commit id" ;; esac
  git -C "$FC_CHECKOUT" merge-base --is-ancestor "$FC_BASE" HEAD 2>/dev/null \
    || fc_usage_field base "--base is not an ancestor of HEAD"

  [ -f "$FC_SCOPE_FILE" ] || fc_usage_field scope-file "--scope-file is not a readable file"
  FC_SCOPE_LIST=()
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    [ -n "$line" ] || fc_usage_field scope-file "scope line $n is empty"
    case "$line" in
      /*) fc_usage_field scope-file "scope line $n is absolute: $line" ;;
      ..|../*|*/../*|*/..) fc_usage_field scope-file "scope line $n contains a '..' segment" ;;
      *'*'*|*'?'*|*'['*) fc_usage_field scope-file "scope line $n contains a glob character" ;;
    esac
    local e
    for e in ${FC_SCOPE_LIST[@]+"${FC_SCOPE_LIST[@]}"}; do
      [ "$e" != "$line" ] || fc_usage_field scope-file "scope line $n is a duplicate: $line"
    done
    FC_SCOPE_LIST+=("$line")
  done <"$FC_SCOPE_FILE"
  [ "${#FC_SCOPE_LIST[@]}" -gt 0 ] || fc_usage_field scope-file "--scope-file is empty"

  if [ -n "$FC_FINDINGS" ]; then
    fc_canonical_file "$FC_FINDINGS" >/dev/null || fc_usage_field findings "--findings is not a canonical file"
    findings_bytes="$(wc -c <"$FC_FINDINGS" | tr -d ' ')"
    [ "$findings_bytes" -le 131072 ] || fc_usage_field findings "--findings exceeds 131072 bytes"
  fi
  if [ -n "$FC_RULINGS" ]; then
    fc_canonical_file "$FC_RULINGS" >/dev/null || fc_usage_field rulings "--rulings is not a canonical file"
    rulings_bytes="$(wc -c <"$FC_RULINGS" | tr -d ' ')"
    [ "$rulings_bytes" -le 32768 ] || fc_usage_field rulings "--rulings exceeds 32768 bytes"
  fi

  FC_ENVELOPE_JSON="$(
    jq -c -n \
      --rawfile rules "$rules_file" \
      --arg task "$FC_TASK" \
      --argjson round "$FC_ROUND" \
      --arg checkout "$FC_CHECKOUT" \
      --arg branch "$FC_BRANCH" \
      --arg brief "$FC_BRIEF" \
      --arg spec "$FC_SPEC" \
      --arg report "$FC_REPORT" \
      --arg base "$FC_BASE" \
      --argjson scope "$(fc_json_array ${FC_SCOPE_LIST[@]+"${FC_SCOPE_LIST[@]}"})" \
      --rawfile findings "${FC_FINDINGS:-/dev/null}" \
      --rawfile rulings "${FC_RULINGS:-/dev/null}" \
      --argjson has_findings "$( [ -n "$FC_FINDINGS" ] && echo true || echo false )" \
      --argjson has_rulings "$( [ -n "$FC_RULINGS" ] && echo true || echo false )" \
      --slurpfile contract "$schema_file" \
      '{rules:$rules, task:$task, round:$round, checkout:$checkout, branch:$branch,
        brief:$brief, spec:$spec, report:$report, base:$base, scope:$scope}
       + (if $has_findings then {findings:$findings} else {} end)
       + (if $has_rulings then {rulings:$rulings} else {} end)
       + {output_contract:$contract[0]}'
  )" || { fc_usage_field envelope "the envelope could not be built"; }

  fc_render_prompt "$schema_file" || { fc_usage_field prompt "the prompt could not be rendered"; }
  return 0
}

fc_fence_for() { # prints a fence longer than any backtick run in the file
  local longest run c
  longest=0
  run=0
  while IFS= read -r line || [ -n "$line" ]; do
    local i=0 len=${#line}
    run=0
    while [ "$i" -lt "$len" ]; do
      c="${line:$i:1}"
      if [ "$c" = '`' ]; then
        run=$((run + 1))
        [ "$run" -le "$longest" ] || longest="$run"
      else
        run=0
      fi
      i=$((i + 1))
    done
  done <"$1"
  local fence="" j=0
  local want=$((longest + 1))
  [ "$want" -ge 3 ] || want=3
  while [ "$j" -lt "$want" ]; do fence="$fence\`"; j=$((j + 1)); done
  printf '%s\n' "$fence"
}

fc_render_prompt() { # <schema-file>
  local schema_file="$1" body fence e
  body="$(
    cat "$FC_SCRIPT_DIR/implementer-envelope.md"
    printf '\n## Task data\n\n'
    printf 'task: %s\n' "$FC_TASK"
    printf 'round: %s\n' "$FC_ROUND"
    printf 'checkout: %s\n' "$FC_CHECKOUT"
    printf 'branch: %s\n' "$FC_BRANCH"
    printf 'brief: %s\n' "$FC_BRIEF"
    printf 'spec: %s\n' "$FC_SPEC"
    printf 'report: %s\n' "$FC_REPORT"
    printf 'base: %s\n' "$FC_BASE"
    printf '\n## File scope\n\n'
    for e in ${FC_SCOPE_LIST[@]+"${FC_SCOPE_LIST[@]}"}; do printf -- '- %s\n' "$e"; done
    if [ -n "$FC_FINDINGS" ]; then
      fence="$(fc_fence_for "$FC_FINDINGS")"
      printf '\n## Reviewer findings from round %s\n\n' "$((FC_ROUND - 1))"
      printf '%s\n' "$fence"
      cat "$FC_FINDINGS"
      printf '%s\n' "$fence"
    fi
    if [ -n "$FC_RULINGS" ]; then
      fence="$(fc_fence_for "$FC_RULINGS")"
      printf '\n## Conductor rulings\n\n'
      printf '%s\n' "$fence"
      cat "$FC_RULINGS"
      printf '%s\n' "$fence"
    fi
    printf '\n## Output contract\n\n'
    printf '```json\n'
    jq -S . "$schema_file"
    printf '```\n'
  )"
  FC_PROMPT="$body"
  [ -n "$FC_PROMPT" ] || return 1
  return 0
}

# =========================================================================================
# Step 5 — fc_envelope_scan (egress)
# =========================================================================================

fc_envelope_scan() {
  local hit rules
  rules="$(fc_egress_rules)"
  hit="$(
    jq -c -n --argjson env "$FC_ENVELOPE_JSON" --arg prompt "$FC_PROMPT" --argjson rules "$rules" '
      def offends($r; $line):
        [ $line
          | match($r.expression; "g")
          | (if (.captures | length) == 0 then "" else (.captures[-1].string // "") end) as $c
          | select(($r.placeholders | index($c)) == null)
        ] | length > 0;
      [ ($env | to_entries[] | select(.value | type == "string") | {f: .key, t: .value}),
        (($env.scope // [])[] | {f: "scope", t: .}),
        {f: "prompt", t: $prompt} ] as $texts
      | [ $texts[] as $x
          | ($x.t | split("\n"))[] as $line
          | $rules[] as $r
          | select(offends($r; $line))
          | {field: $x.f, rule: $r.id} ]
      | (.[0] // null)
    ' 2>/dev/null
  )" || hit=""

  if [ -z "$hit" ]; then
    fc_set_outcome refused egress rules_unreadable "" "" "the egress rule table could not be evaluated"
    fc_finish
  fi
  if [ "$hit" != "null" ]; then
    local field rule
    field="$(printf '%s' "$hit" | jq -r .field)"
    rule="$(printf '%s' "$hit" | jq -r .rule)"
    fc_set_outcome refused egress egress_reject "$field" \
      "$(jq -c -n --arg rule "$rule" '{rule:$rule}')" \
      "the envelope matched an egress rule; the launch is refused"
    fc_finish
  fi
  return 0
}

# =========================================================================================
# Step 6 — fc_codex_present
# =========================================================================================

fc_codex_present() {
  if ! command -v codex >/dev/null 2>&1; then
    fc_set_outcome engine_unavailable binary_missing codex_missing "" "" "codex is not on PATH"
    fc_finish
  fi
  FC_CODEX_VERSION="$(codex --version 2>/dev/null | head -n 1 || true)"
  [ -n "$FC_CODEX_VERSION" ] || FC_CODEX_VERSION="unknown"
  return 0
}

# =========================================================================================
# Step 7 — paths and argv
# =========================================================================================

fc_paths_derive() {
  FC_ROOT="${FC_ADAPTER_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/fable-conductor/codex}"
  FC_RUN_ID="$(date -u -r "$(fc_now)" +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
  FC_RUN_DIR="$FC_ROOT/runs/$FC_STREAM/$FC_TASK/$FC_RUN_ID"
}

# Server tables of the USER config, in file order. C1 finding 5: the names must come from the
# config file, never from `codex mcp list` — naming a plugin-provided server makes Codex fail
# to load the config. A nested table ([...x.env]) does not match and is ignored.
fc_mcp_names() {
  local cfg="${CODEX_HOME:-$HOME/.codex}/config.toml"
  [ -f "$cfg" ] || return 0
  sed -n 's/^\[mcp_servers\.\([^].]\{1,\}\)\]$/\1/p' "$cfg"
}

fc_argv_build() {
  local f name
  FC_ARGV=(exec -s workspace-write --ephemeral)
  for f in $FC_DISABLE_FEATURES; do
    FC_ARGV+=(--disable "$f")
  done
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      *[!A-Za-z0-9_-]*)
        fc_set_outcome policy_unavailable isolation_config malformed_mcp_table "" "" \
          "a server table name in the Codex config is not a bare name"
        fc_finish
        ;;
    esac
    FC_ARGV+=(-c "mcp_servers.$name.enabled=false")
  done < <(fc_mcp_names)
  FC_ARGV+=(-c 'web_search="disabled"')
  FC_ARGV+=(-c approval_policy=never)
  FC_ARGV+=(--json --color never)
  FC_ARGV+=(--output-schema "$FC_RUN_DIR/schema.json")
  FC_ARGV+=(-o "$FC_RUN_DIR/out.json")
  if [ -n "$FC_MODEL" ]; then
    FC_ARGV+=(-m "$FC_MODEL")
  fi
  FC_ARGV+=(-c "model_reasoning_effort=$FC_EFFORT")
  FC_ARGV+=("$FC_PROMPT")

  local a
  for a in "${FC_ARGV[@]}"; do
    case "$a" in
      --ignore-user-config|--dangerously-bypass-approvals-and-sandbox|--full-auto|--add-dir|--profile|-p)
        fc_set_outcome policy_unavailable isolation_config forbidden_flag "" "" \
          "a forbidden flag reached the launch vector"
        fc_finish
        ;;
    esac
  done

  FC_ARGV_SHA="$(for a in "${FC_ARGV[@]}"; do printf '%s\0' "$a"; done | fc_digest_stdin)"
  return 0
}

# =========================================================================================
# Step 8 — root and lock
# =========================================================================================

fc_is_under() { # <path> <dir>
  case "$1" in
    "$2"|"$2"/*) return 0 ;;
  esac
  return 1
}

fc_root_ensure() {
  local tmp_canon slash_tmp p parent

  case "$FC_ROOT" in
    /*) ;;
    *) fc_refuse_preflight unsafe_root "the adapter root must be an absolute path" ;;
  esac
  ! fc_is_under "$FC_ROOT" "$FC_CHECKOUT" \
    || fc_refuse_preflight unsafe_root "the adapter root must not live inside the checkout"
  slash_tmp="$(cd -P -- /tmp 2>/dev/null && pwd -P)" || slash_tmp=""
  if [ -n "$slash_tmp" ]; then
    ! fc_is_under "$FC_ROOT" "$slash_tmp" \
      || fc_refuse_preflight unsafe_root "the adapter root must not live under /tmp"
  fi
  if [ -n "${TMPDIR:-}" ]; then
    tmp_canon="$(cd -P -- "${TMPDIR%/}" 2>/dev/null && pwd -P)" || tmp_canon=""
    if [ -n "$tmp_canon" ]; then
      ! fc_is_under "$FC_ROOT" "$tmp_canon" \
        || fc_refuse_preflight unsafe_root "the adapter root must not live under TMPDIR"
    fi
  fi

  mkdir -p "$FC_ROOT" 2>/dev/null \
    || fc_refuse_preflight unsafe_root "the adapter root could not be created"
  chmod 700 "$FC_ROOT" 2>/dev/null || true

  # no symlink component anywhere in the root path
  p="$FC_ROOT"
  while [ "$p" != "/" ] && [ -n "$p" ]; do
    if [ -L "$p" ]; then
      fc_refuse_preflight unsafe_root "the adapter root has a symlinked path component: $p"
    fi
    parent="${p%/*}"
    [ -n "$parent" ] || parent="/"
    [ "$parent" != "$p" ] || break
    p="$parent"
  done
  return 0
}

fc_lock_release() {
  [ "$FC_LOCK_HELD" = "1" ] || { [ -z "$FC_SCRATCH" ] || rm -rf "$FC_SCRATCH" 2>/dev/null; return 0; }
  rm -f "$FC_LOCK_DIR/pid" 2>/dev/null
  rmdir "$FC_LOCK_DIR" 2>/dev/null
  FC_LOCK_HELD=0
  [ -z "$FC_SCRATCH" ] || rm -rf "$FC_SCRATCH" 2>/dev/null
  return 0
}

fc_lock_acquire() {
  local holder remove
  mkdir -p "$FC_ROOT/locks" 2>/dev/null || true
  chmod 700 "$FC_ROOT/locks" 2>/dev/null || true
  FC_LOCK_DIR="$FC_ROOT/locks/$(printf '%s' "$FC_CHECKOUT" | fc_digest_stdin)"
  if ! mkdir "$FC_LOCK_DIR" 2>/dev/null; then
    holder="$(head -n 1 "$FC_LOCK_DIR/pid" 2>/dev/null | tr -cd '0-9')"
    remove="rm -f '$FC_LOCK_DIR/pid'; rmdir '$FC_LOCK_DIR'"
    fc_set_outcome refused lock checkout_busy "" \
      "$(jq -c -n --arg lock "$FC_LOCK_DIR" --arg remove "$remove" \
          --argjson pid "${holder:-null}" '{pid:$pid, lock:$lock, remove:$remove}')" \
      "another run holds the lock for this checkout"
    fc_finish
  fi
  FC_LOCK_HELD=1
  printf '%s\n' "$$" >"$FC_LOCK_DIR/pid" 2>/dev/null || true
  trap fc_lock_release EXIT INT TERM HUP
  FC_SCRATCH="$(mktemp -d)"
  return 0
}

# =========================================================================================
# Step 9 — fc_policy_probe
# =========================================================================================

fc_policy_probe() {
  local prober="$FC_SCRIPT_DIR/codex-policy.sh" out err rc=0 cause
  out="$FC_SCRATCH/probe.out"; err="$FC_SCRATCH/probe.err"
  /bin/bash "$prober" "$FC_CHECKOUT" >"$out" 2>"$err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    cause="$(jq -r '.cause // empty' "$err" 2>/dev/null || true)"
    [ -n "$cause" ] || cause=malformed
    fc_set_outcome policy_unavailable probe probe_failed "" \
      "$(jq -c -n --arg cause "$cause" '{cause:$cause}')" \
      "the Codex deny layer could not be proven for this checkout"
    fc_finish
  fi
  if ! jq -e '.ok == true' "$out" >/dev/null 2>&1; then
    fc_set_outcome policy_unavailable probe probe_failed "" \
      "$(jq -c -n --arg cause "malformed" '{cause:$cause}')" \
      "the prober's success line did not parse"
    fc_finish
  fi
  FC_POLICY_CONFIG_SHA="$(jq -r '.config_sha256' "$out")"
  FC_POLICY_RULES_SHA="$(jq -r '.rules_sha256' "$out")"
  return 0
}
FC_POLICY_CONFIG_SHA=""; FC_POLICY_RULES_SHA=""

# =========================================================================================
# Step 10 — run directory, envelope publication, argv.json
# =========================================================================================

fc_fail_launch() { # <reason> <message>
  fc_set_outcome worker_failed launch "$1" "" "" "$2"
  fc_finish
}

fc_rundir_allocate() {
  mkdir -p "$FC_ROOT/runs/$FC_STREAM/$FC_TASK" 2>/dev/null \
    || fc_fail_launch rundir "the run directory parents could not be created"
  mkdir "$FC_RUN_DIR" 2>/dev/null \
    || fc_fail_launch rundir "the run directory already exists or could not be created"
  chmod 700 "$FC_RUN_DIR" 2>/dev/null || true
  : >"$FC_RUN_DIR/run.log"; chmod 600 "$FC_RUN_DIR/run.log" 2>/dev/null || true
  : >"$FC_RUN_DIR/events.jsonl"; chmod 600 "$FC_RUN_DIR/events.jsonl" 2>/dev/null || true
  FC_RUNDIR_LIVE=1
  # From here on nothing may reach the real stderr: diagnostics belong in run.log.
  exec 2>>"$FC_RUN_DIR/run.log"
  return 0
}

fc_envelope_publish() {
  printf '%s\n' "$FC_ENVELOPE_JSON" >"$FC_RUN_DIR/envelope.json" \
    || fc_fail_launch publish "envelope.json could not be written"
  printf '%s' "$FC_PROMPT" >"$FC_RUN_DIR/prompt.md" \
    || fc_fail_launch publish "prompt.md could not be written"
  cat "$FC_SCRIPT_DIR/implementer-output.schema.json" >"$FC_RUN_DIR/schema.json" \
    || fc_fail_launch publish "schema.json could not be written"
  chmod 600 "$FC_RUN_DIR/envelope.json" "$FC_RUN_DIR/prompt.md" "$FC_RUN_DIR/schema.json" 2>/dev/null || true
  return 0
}

fc_argv_publish() {
  local a args=()
  for a in "${FC_ARGV[@]}"; do args+=("$a"); done
  args[$(( ${#args[@]} - 1 ))]="<PROMPT sha256=$(printf '%s' "$FC_PROMPT" | fc_digest_stdin)>"
  fc_json_array "${args[@]}" >"$FC_RUN_DIR/argv.json" \
    || fc_fail_launch publish "argv.json could not be written"
  chmod 600 "$FC_RUN_DIR/argv.json" 2>/dev/null || true
  return 0
}

# =========================================================================================
# Steps 11 and 14 — the mutation manifest
# =========================================================================================

fc_ns_walk() { # <dir> <strip-prefix>
  local e name t d
  for e in "$1"/*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    name="${e#$2/}"
    if [ -L "$e" ]; then
      t=symlink
      d="$(printf '%s' "$(/usr/bin/stat -f %Y "$e")" | fc_digest_stdin)"
    elif [ -d "$e" ]; then
      fc_ns_walk "$e" "$2"
      continue
    elif [ -f "$e" ]; then
      t=file
      d="$(fc_digest_file "$e")"
    else
      t=other
      d=""
    fi
    printf '%s\0%s\0%s\0' "$name" "$t" "$d"
  done
}

fc_ns_json() { # <dir> — a sorted JSON array of {path,type,digest}
  local items=() f
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    while IFS= read -r -d '' f; do items+=("$f"); done \
      < <( shopt -s dotglob nullglob; fc_ns_walk "$1" "$1" )
  fi
  if [ "${#items[@]}" -eq 0 ]; then
    printf '[]\n'
    return 0
  fi
  fc_json_array "${items[@]}" | jq -c '
    . as $a
    | [ range(0; ($a | length); 3) | {path: $a[.], type: $a[. + 1], digest: $a[. + 2]} ]
    | sort_by(.path)'
}

fc_manifest_write() { # <outfile> -> prints the tree oid on success
  local out="$1" idx="$FC_RUN_DIR/index.tmp" tree head branch idx_sha
  rm -f "$idx" 2>/dev/null
  if [ -f "$FC_GITDIR/index" ]; then
    cat "$FC_GITDIR/index" >"$idx" 2>/dev/null || true
  fi
  GIT_INDEX_FILE="$idx" git -C "$FC_CHECKOUT" add -A >/dev/null 2>&1 || { rm -f "$idx"; return 1; }
  tree="$(GIT_INDEX_FILE="$idx" git -C "$FC_CHECKOUT" write-tree 2>/dev/null)" || { rm -f "$idx"; return 1; }
  rm -f "$idx" 2>/dev/null
  [ -n "$tree" ] || return 1

  head="$(git -C "$FC_CHECKOUT" rev-parse HEAD 2>/dev/null || true)"
  branch="$(git -C "$FC_CHECKOUT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  idx_sha="$(git -C "$FC_CHECKOUT" ls-files --stage -z 2>/dev/null | fc_digest_stdin)"

  jq -c -n \
    --arg head "$head" --arg branch "$branch" --arg tree "$tree" --arg index_sha256 "$idx_sha" \
    --argjson codex "$(fc_ns_json "$FC_CHECKOUT/.codex")" \
    --argjson hooks "$(fc_ns_json "$FC_HOOKS_DIR")" \
    --arg hooks_dir "$FC_HOOKS_DIR" \
    --argjson captured_epoch "$(fc_now)" \
    '{head:$head, branch:$branch, tree:$tree, index_sha256:$index_sha256,
      namespaces:{codex:$codex, hooks:$hooks}, hooks_dir:$hooks_dir,
      captured_epoch:$captured_epoch}' >"$out" || return 1
  chmod 600 "$out" 2>/dev/null || true
  printf '%s\n' "$tree"
}

fc_manifest_baseline() {
  FC_BASE_TREE="$(fc_manifest_write "$FC_RUN_DIR/manifest.pre.json")" || {
    fc_set_outcome worker_failed baseline baseline_failed "" "" "the baseline tree could not be built"
    return 1
  }
  FC_HEAD_BEFORE="$(jq -r .head "$FC_RUN_DIR/manifest.pre.json")"
  return 0
}

fc_in_scope() { # <path>
  local p="$1" e
  for e in ${FC_SCOPE_LIST[@]+"${FC_SCOPE_LIST[@]}"}; do
    case "$e" in
      */) case "$p" in "$e"*) return 0 ;; esac ;;
      *) [ "$p" != "$e" ] || return 0 ;;
    esac
  done
  return 1
}

fc_manifest_compare() {
  local st p1 p2 changed=() offenders=() kinds=() ns_bad
  FC_POST_TREE="$(fc_manifest_write "$FC_RUN_DIR/manifest.post.json")" || {
    fc_set_outcome worker_failed manifest compare_failed "" "" "the post-run tree could not be built"
    return 1
  }
  FC_HEAD_AFTER="$(jq -r .head "$FC_RUN_DIR/manifest.post.json")"

  while IFS= read -r -d '' st; do
    case "$st" in
      R*|C*)
        IFS= read -r -d '' p1 || break
        IFS= read -r -d '' p2 || break
        changed+=("$p1" "$p2")
        ;;
      *)
        IFS= read -r -d '' p1 || break
        changed+=("$p1")
        ;;
    esac
  done < <(git -C "$FC_CHECKOUT" diff-tree -r -z -M --name-status "$FC_BASE_TREE" "$FC_POST_TREE" 2>/dev/null)

  local p
  for p in ${changed[@]+"${changed[@]}"}; do
    fc_in_scope "$p" || offenders+=("$p")
  done

  if [ "${#changed[@]}" -eq 0 ]; then
    FC_CHANGED_JSON='[]'
  else
    FC_CHANGED_JSON="$(fc_json_array "${changed[@]}" | jq -c 'unique')"
  fi

  ns_bad="$(jq -c -n \
    --slurpfile pre "$FC_RUN_DIR/manifest.pre.json" \
    --slurpfile post "$FC_RUN_DIR/manifest.post.json" '
      def tomap: map({key: .path, value: (.type + ":" + (.digest // ""))}) | from_entries;
      def delta($a; $b):
        ($a | tomap) as $x | ($b | tomap) as $y
        | (($x | keys) + ($y | keys) | unique) | map(select($x[.] != $y[.]));
      ( delta($pre[0].namespaces.codex; $post[0].namespaces.codex) | map(".codex/" + .) )
      + ( delta($pre[0].namespaces.hooks; $post[0].namespaces.hooks) | map("<hooks>/" + .) )')"

  FC_VIOLATIONS_JSON="$(
    jq -c -n \
      --argjson oos "$( [ "${#offenders[@]}" -eq 0 ] && echo '[]' || fc_json_array "${offenders[@]}" | jq -c 'unique' )" \
      --argjson ns "$ns_bad" \
      --argjson index_changed "$( [ "$(jq -r .index_sha256 "$FC_RUN_DIR/manifest.pre.json")" = "$(jq -r .index_sha256 "$FC_RUN_DIR/manifest.post.json")" ] && echo false || echo true )" \
      --argjson head_changed "$( [ "$FC_HEAD_BEFORE" = "$FC_HEAD_AFTER" ] && echo false || echo true )" \
      --argjson branch_changed "$( [ "$(jq -r .branch "$FC_RUN_DIR/manifest.pre.json")" = "$(jq -r .branch "$FC_RUN_DIR/manifest.post.json")" ] && echo false || echo true )" \
      '[ (if ($oos | length) > 0 then {kind:"out_of_scope", paths:$oos} else empty end),
         (if ($ns  | length) > 0 then {kind:"sensitive_namespace", paths:$ns} else empty end),
         (if $index_changed  then {kind:"index_changed",  paths:[]} else empty end),
         (if $head_changed   then {kind:"head_changed",   paths:[]} else empty end),
         (if $branch_changed then {kind:"branch_changed", paths:[]} else empty end) ]'
  )"
  return 0
}

# =========================================================================================
# Steps 12 and 14 — output binding and schema
# =========================================================================================

fc_output_precheck() {
  if [ -e "$FC_RUN_DIR/out.json" ] || [ -L "$FC_RUN_DIR/out.json" ]; then
    fc_set_outcome malformed_result output_binding stale_output "" "" \
      "out.json existed before the launch"
    return 1
  fi
  return 0
}

fc_member_predicate() {
  cat <<'FC_PREDICATE'
type == "object"
and (([keys_unsorted[]] | sort) == ["blocked_reason","commands_run","commits","files_changed","summary","tracker_note"])
and (.summary | type == "string" and length >= 1 and length <= 4000)
and (.files_changed | type == "array" and length <= 500 and all(.[]; type == "string" and length <= 1024))
and (.commits | type == "array" and length <= 50 and all(.[]; type == "string" and test("^[0-9a-f]{40}$")))
and (.commands_run | type == "array" and length <= 50 and all(.[];
      type == "object"
      and (([keys_unsorted[]] | sort) == ["cmd","exit","tail"])
      and (.cmd | type == "string" and length <= 2000)
      and (.exit | type == "number" and . == floor)
      and (.tail | type == "string" and utf8bytelength <= 8000)))
and ((.tracker_note | type == "null") or (.tracker_note | type == "string" and length <= 2000))
and ((.blocked_reason | type == "null") or (.blocked_reason | type == "string" and length <= 2000))
FC_PREDICATE
}

fc_output_collect() {
  local f="$FC_RUN_DIR/out.json" bytes
  FC_OUT_STATUS=binding
  FC_OUT_JSON=null
  FC_MEMBER_JSON=null
  # type first: a FIFO would block the adapter forever if it were opened
  if [ -L "$f" ]; then fc_log "out.json is a symlink"; return 0; fi
  if [ ! -e "$f" ]; then fc_log "out.json is absent"; return 0; fi
  if [ ! -f "$f" ]; then fc_log "out.json is not a regular file"; return 0; fi

  bytes="$(wc -c <"$f" | tr -d ' ')"
  FC_OUT_JSON="$(jq -c -n --argjson bytes "$bytes" --arg sha256 "$(fc_digest_file "$f")" \
    '{bytes:$bytes, sha256:$sha256}')"

  if ! jq -e . "$f" >/dev/null 2>&1; then
    FC_OUT_STATUS=schema
    fc_log "out.json is not parsable JSON"
    return 0
  fi
  if ! jq -e "$(fc_member_predicate)" "$f" >/dev/null 2>&1; then
    FC_OUT_STATUS=schema
    fc_log "out.json failed the output contract"
    return 0
  fi
  FC_OUT_STATUS=ok
  FC_MEMBER_JSON="$(jq -c . "$f")"
  return 0
}

fc_events_classify() {
  local res
  res="$(jq -R -s --slurpfile tbl "$FC_SCRIPT_DIR/engine-table.json" '
      [ splits("\n") | select(length > 0) | (fromjson? // empty) ] as $ev
      | ($tbl[0].signatures) as $sigs
      | [ $ev[] | select(.type == "error" or .type == "turn.failed")
                | ((.message // .error.message) // "") ] as $msgs
      | ( first( $sigs[] | . as $s | select( any($msgs[]; test($s.expression)) ) ) // null ) as $hit
      | [ $ev[] | select(.type == "turn.completed") ] as $tc
      | [ $tc[] | .usage | (.input_tokens?, .cached_input_tokens?, .output_tokens?)
                | select(. != null) ] as $vals
      | (($vals | map(select(type != "number" or . < 0 or . != floor)) | length) > 0) as $bad
      | { signature: ($hit.id // null),
          transient: ($hit.transient // null),
          usage: ( if ($tc | length) == 0 or $bad then null
                   else { input_tokens:        ([$tc[] | .usage.input_tokens // 0]        | add),
                          cached_input_tokens: ([$tc[] | .usage.cached_input_tokens // 0] | add),
                          output_tokens:       ([$tc[] | .usage.output_tokens // 0]       | add),
                          events:              ($tc | length) } end ),
          usage_error: ( if $bad then "a usage value was malformed or negative" else null end ) }
    ' "$FC_RUN_DIR/events.jsonl" 2>/dev/null)" || res=""
  if [ -z "$res" ]; then
    FC_SIGNATURE=""; FC_TRANSIENT=""; FC_USAGE_JSON=null; FC_USAGE_ERROR=""
    return 0
  fi
  FC_SIGNATURE="$(printf '%s' "$res" | jq -r '.signature // ""')"
  FC_TRANSIENT="$(printf '%s' "$res" | jq -r 'if .transient == null then "" else (.transient|tostring) end')"
  FC_USAGE_JSON="$(printf '%s' "$res" | jq -c '.usage')"
  FC_USAGE_ERROR="$(printf '%s' "$res" | jq -r '.usage_error // ""')"
  return 0
}

# =========================================================================================
# Step 13 — fc_child_run
# =========================================================================================

fc_child_run() {
  local child_pid child_pgid own_pgid rc=0 wd steps i eff_timeout grace
  local marker="$FC_SCRATCH/timed_out" done_marker="$FC_SCRATCH/child_done"

  eff_timeout="$FC_TIMEOUT"
  grace=10
  if [ "${FC_TEST_MODE:-}" = "1" ]; then
    [ -z "${FC_TEST_TIMEOUT_S:-}" ]   || eff_timeout="$FC_TEST_TIMEOUT_S"
    [ -z "${FC_TEST_KILL_GRACE_S:-}" ] || grace="$FC_TEST_KILL_GRACE_S"
  fi

  own_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
  FC_STARTED="$(fc_now)"

  cd "$FC_CHECKOUT" || { fc_set_outcome worker_failed launch spawn_failed "" "" "cannot enter the checkout"; return 1; }

  set -m
  codex "${FC_ARGV[@]}" </dev/null >>"$FC_RUN_DIR/events.jsonl" 2>>"$FC_RUN_DIR/run.log" &
  child_pid=$!
  set +m

  child_pgid="$(ps -o pgid= -p "$child_pid" 2>/dev/null | tr -d ' ')"
  [ -n "$child_pgid" ] || child_pgid="$child_pid"
  if [ "$child_pgid" = "$own_pgid" ]; then
    kill -KILL "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
    fc_set_outcome worker_failed launch same_process_group "" "" \
      "the child did not get its own process group"
    return 1
  fi

  steps=$((eff_timeout * 5))
  (
    i=0
    while [ "$i" -lt "$steps" ]; do
      [ ! -e "$done_marker" ] || exit 0
      sleep 0.2
      i=$((i + 1))
    done
    : >"$marker"
    kill -TERM -- -"$child_pgid" 2>/dev/null
    i=0
    while [ "$i" -lt $((grace * 5)) ]; do
      [ ! -e "$done_marker" ] || break
      sleep 0.2
      i=$((i + 1))
    done
    kill -KILL -- -"$child_pgid" 2>/dev/null
  ) &
  wd=$!

  wait "$child_pid"
  rc=$?
  : >"$done_marker"

  # A timeout is only real when the watchdog's signal is what ENDED the child.
  # The marker alone cannot decide that: the child can exit on its own in the window
  # between `wait` returning and `done_marker` being written, and the watchdog's last
  # poll can fall inside that window — it then declares a timeout against a process
  # that had already finished, and a successful run would be reported as
  # adapter_timeout (the conductor would re-run work that actually succeeded).
  # A child killed by our TERM/KILL is reaped as signalled ($rc > 128); a child that
  # exited by itself carries its own status. Require both facts.
  if [ -e "$marker" ] && [ "$rc" -gt 128 ]; then
    # the watchdog fired: let it finish escalating TERM -> KILL, then reap the group
    wait "$wd" 2>/dev/null
    kill -KILL -- -"$child_pgid" 2>/dev/null
    FC_CHILD_ENDED_BY=timeout
    FC_CHILD_EXIT=null
    FC_CHILD_SIGNAL=$((rc - 128))
  else
    if [ -e "$marker" ]; then
      # the watchdog lost the race: the child had already exited on its own.
      wait "$wd" 2>/dev/null
    fi
    kill -TERM "$wd" 2>/dev/null
    wait "$wd" 2>/dev/null
    if [ "$rc" -gt 128 ]; then
      FC_CHILD_ENDED_BY=signaled
      FC_CHILD_SIGNAL=$((rc - 128))
      FC_CHILD_EXIT=null
    else
      FC_CHILD_ENDED_BY=exited
      FC_CHILD_EXIT="$rc"
      FC_CHILD_SIGNAL=null
    fi
  fi
  cd "$FC_SCRIPT_DIR" 2>/dev/null || true
  return 0
}

# =========================================================================================
# Step 15 — class decision, result, section
# =========================================================================================

fc_class_decide() {
  [ -z "$FC_CLASS" ] || return 0

  if [ "$FC_CHILD_ENDED_BY" = timeout ]; then
    fc_set_outcome adapter_timeout "" watchdog_fired "" "" "the watchdog stopped the worker"
    return 0
  fi
  if [ "$FC_CHILD_ENDED_BY" = signaled ]; then
    fc_set_outcome worker_failed signal "killed_by_signal" "" "" "the worker was killed by signal $FC_CHILD_SIGNAL"
    return 0
  fi
  if [ "$FC_CHILD_EXIT" != "null" ] && [ "$FC_CHILD_EXIT" != "0" ]; then
    if [ -n "$FC_SIGNATURE" ]; then
      fc_set_outcome engine_unavailable signature "$FC_SIGNATURE" "" "" \
        "the engine reported a known failure: $FC_SIGNATURE"
      return 0
    fi
    fc_set_outcome worker_failed worker_exit nonzero_exit "" "" \
      "the worker exited $FC_CHILD_EXIT"
    return 0
  fi
  if [ "$FC_OUT_STATUS" = binding ]; then
    fc_set_outcome malformed_result output_binding no_regular_output "" "" \
      "out.json is absent or is not a regular file"
    return 0
  fi
  if [ "$FC_OUT_STATUS" = schema ]; then
    fc_set_outcome malformed_result output_schema contract_violation "" "" \
      "out.json did not satisfy the output contract"
    return 0
  fi
  if [ "$FC_VIOLATIONS_JSON" != "[]" ]; then
    fc_set_outcome policy_violation manifest scope_breach "" "" \
      "the worker changed paths outside the declared scope"
    return 0
  fi
  fc_set_outcome ok "" "" "" "" "the task ran and the result is well formed"
  return 0
}

fc_result_write() {
  local tmp="$FC_RUN_DIR/.result.tmp" blocked tracker_note blocked_reason
  blocked=false
  tracker_note=null
  blocked_reason=null
  if [ "$FC_MEMBER_JSON" != "null" ]; then
    tracker_note="$(printf '%s' "$FC_MEMBER_JSON" | jq -c '.tracker_note')"
    blocked_reason="$(printf '%s' "$FC_MEMBER_JSON" | jq -c '.blocked_reason')"
    [ "$blocked_reason" = "null" ] || blocked=true
  fi
  FC_BLOCKED="$blocked"

  jq -n \
    --argjson schema 1 \
    --arg stream "$FC_STREAM" --arg task "$FC_TASK" --argjson round "$FC_ROUND" \
    --arg run_id "$FC_RUN_ID" --arg run_dir "$FC_RUN_DIR" \
    --arg class "$FC_CLASS" \
    --arg phase "$FC_PHASE" --arg reason "$FC_REASON" \
    --argjson blocked "$blocked" \
    --arg codex_version "$FC_CODEX_VERSION" --arg argv_sha256 "$FC_ARGV_SHA" \
    --arg model "$FC_MODEL" --arg effort "$FC_EFFORT" --argjson timeout_s "$FC_TIMEOUT" \
    --arg base "$FC_BASE" --arg branch "$FC_BRANCH" \
    --arg head_before "$FC_HEAD_BEFORE" --arg head_after "$FC_HEAD_AFTER" \
    --arg base_tree "$FC_BASE_TREE" --arg post_tree "$FC_POST_TREE" \
    --argjson changed_paths "$FC_CHANGED_JSON" \
    --argjson violations "$FC_VIOLATIONS_JSON" \
    --argjson out "$FC_OUT_JSON" \
    --arg config_sha256 "$FC_POLICY_CONFIG_SHA" --arg rules_sha256 "$FC_POLICY_RULES_SHA" \
    --argjson member "$FC_MEMBER_JSON" \
    --argjson tracker_note "$tracker_note" \
    --argjson blocked_reason "$blocked_reason" \
    --arg signature "$FC_SIGNATURE" \
    --arg transient "$FC_TRANSIENT" \
    --argjson usage "$FC_USAGE_JSON" \
    --arg usage_error "$FC_USAGE_ERROR" \
    --argjson child_exit "$FC_CHILD_EXIT" \
    --argjson child_signal "$FC_CHILD_SIGNAL" \
    --arg ended_by "$FC_CHILD_ENDED_BY" \
    --arg run_log "$FC_RUN_DIR/run.log" --arg events "$FC_RUN_DIR/events.jsonl" \
    --argjson started_epoch "${FC_STARTED:-$(fc_now)}" \
    --argjson finished_epoch "$(fc_now)" \
    '
    def orn($s): if $s == "" then null else $s end;
    {schema:$schema, stream:$stream, task:$task, round:$round, run_id:$run_id, run_dir:$run_dir,
     class:$class, phase:orn($phase), reason:orn($reason), blocked:$blocked,
     codex_version:$codex_version, argv_sha256:$argv_sha256, model:orn($model), effort:$effort,
     timeout_s:$timeout_s, base:$base, branch:$branch,
     head_before:orn($head_before), head_after:orn($head_after),
     base_tree:orn($base_tree), post_tree:orn($post_tree),
     changed_paths:$changed_paths, violations:$violations, out:$out,
     policy:{config_sha256:$config_sha256, rules_sha256:$rules_sha256},
     member:$member, tracker_note:$tracker_note, blocked_reason:$blocked_reason,
     signature:orn($signature),
     transient:(if $transient == "" then null else ($transient == "true") end),
     usage:$usage, usage_error:orn($usage_error),
     child:{exit:$child_exit, signal:$child_signal, ended_by:$ended_by},
     log:{run_log:$run_log, events:$events},
     started_epoch:$started_epoch, finished_epoch:$finished_epoch}
    ' >"$tmp" || return 1
  mv "$tmp" "$FC_RUN_DIR/result.json" || return 1
  chmod 600 "$FC_RUN_DIR/result.json" 2>/dev/null || true
  return 0
}
FC_BLOCKED=false

# The ready-to-paste report body. It BEGINS with the H2 line and ends with one LF, so the
# conductor appends it verbatim. Every member-supplied line is emitted behind "> ", which is
# what stops a member forging a heading or breaking out of the section.
fc_section_render() { # <run-dir>
  local rj="$1/result.json"
  jq -r '
    def q: "`" + (. | tojson) + "`";
    def quoted: (. // "") | split("\n") | map("> " + .) | .[];
    "## implementer — round " + (.round | tostring),
    "",
    ("**Engine:** codex · **Model:** " + (.model // "(configured default)")
      + " (" + .effort + ") · **Codex:** " + .codex_version
      + " · **Class:** " + .class + " · **Blocked:** " + (if .blocked then "yes" else "no" end)),
    "",
    "### Changed paths (adapter-observed)",
    (if (.changed_paths | length) == 0 then "_none_" else (.changed_paths[] | "- " + q) end),
    "",
    "### Summary (member)",
    (.member.summary | quoted),
    "",
    "### Commands (member-reported)",
    ( if ((.member.commands_run // []) | length) == 0 then "_none_"
      else ( .member.commands_run[]
             | ("#### exit " + (.exit | tostring)),
               ("> cmd: " + (.cmd | tojson)),
               ((.tail // "") | split("\n") | (if length > 30 then .[length-30:] else . end) | map("> " + .) | .[]) )
      end ),
    "",
    "### Tracker note (member request — data only)",
    (if (.member.tracker_note // null) == null then "_none_" else (.member.tracker_note | quoted) end),
    "",
    "### Blocked reason",
    (if (.member.blocked_reason // null) == null then "_none_" else (.member.blocked_reason | quoted) end),
    "",
    "### Usage",
    (if .usage == null then "_none_"
     else ("- input " + (.usage.input_tokens|tostring) + " · cached " + (.usage.cached_input_tokens|tostring)
           + " · output " + (.usage.output_tokens|tostring) + " · events " + (.usage.events|tostring)) end),
    "",
    "### Run",
    ("- result: `" + .run_dir + "/result.json`"),
    ("- log: `" + .log.run_log + "`")
  ' "$rj"
}

fc_finish() {
  local code
  code="$(fc_exit_for_class "$FC_CLASS")"

  if [ "$FC_RUNDIR_LIVE" = "1" ]; then
    fc_result_write || fc_log "result.json could not be written"
    if [ "$FC_CLASS" = ok ]; then
      fc_section_render "$FC_RUN_DIR" >"$FC_RUN_DIR/section.md" 2>>"$FC_RUN_DIR/run.log" || true
      chmod 600 "$FC_RUN_DIR/section.md" 2>/dev/null || true
    fi
    jq -c -n \
      --arg class "$FC_CLASS" --arg phase "$FC_PHASE" --arg reason "$FC_REASON" \
      --argjson exit "$code" --argjson blocked "$FC_BLOCKED" --arg transient "$FC_TRANSIENT" \
      --arg stream "$FC_STREAM" --arg task "$FC_TASK" --argjson round "$FC_ROUND" \
      --arg run_id "$FC_RUN_ID" --arg run_dir "$FC_RUN_DIR" \
      --arg result "$FC_RUN_DIR/result.json" '
      def orn($s): if $s == "" then null else $s end;
      {class:$class, phase:orn($phase), reason:orn($reason), exit:$exit, blocked:$blocked,
       transient:(if $transient == "" then null else ($transient == "true") end),
       stream:$stream, task:$task, round:$round, run_id:$run_id, run_dir:$run_dir,
       result:$result}'
  else
    jq -c -n \
      --arg class "$FC_CLASS" --arg phase "$FC_PHASE" --arg reason "$FC_REASON" \
      --arg field "$FC_FIELD" --argjson detail "${FC_DETAIL_JSON:-null}" \
      --arg message "$FC_MESSAGE" --argjson exit "$code" '
      def orn($s): if $s == "" then null else $s end;
      {class:$class, phase:orn($phase), reason:orn($reason), field:orn($field),
       detail:$detail, message:$message, exit:$exit}' >&2
  fi
  exit "$code"
}

# =========================================================================================
# main
# =========================================================================================

fc_run() {
  fc_parse_run "$@"                       # 1
  fc_engine_check                         # 2
  fc_checkout_check                       # 3
  fc_envelope_build                       # 4
  fc_envelope_scan                        # 5
  fc_codex_present                        # 6
  fc_paths_derive
  fc_argv_build                           # 7
  fc_root_ensure                          # 8
  fc_lock_acquire
  fc_policy_probe                         # 9

  fc_rundir_allocate                      # 10
  fc_envelope_publish
  fc_argv_publish

  if fc_manifest_baseline; then           # 11
    if fc_output_precheck; then           # 12
      fc_child_run                        # 13
      fc_output_collect                   # 14
      fc_events_classify
      fc_manifest_compare || true
    fi
  fi

  fc_class_decide                         # 15
  fc_finish
}

case "${1:-}" in
  run)
    shift
    fc_run "$@"
    ;;
  classes)
    shift
    if [ "$#" -ne 0 ]; then
      fc_usage positional "" "classes takes no arguments"
    fi
    fc_classes_json | jq -c .
    exit 0
    ;;
  "")
    fc_usage unknown_subcommand "" "a subcommand is required: run or classes"
    ;;
  *)
    fc_usage unknown_subcommand "" "unknown subcommand: $1"
    ;;
esac
