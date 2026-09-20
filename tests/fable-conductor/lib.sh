# tests/fable-conductor/lib.sh — helpers for the offline fable-conductor suite.
#
# Plain bash 3.2, no framework, house style of tests/herdr-jutsu/run.sh: `ok` / `not_ok` /
# `fail_case`, one `mktemp -d` scratch per case. Sourced by run.sh; never run directly.
#
# Every assertion calls fail_case and RETURNS 1, so a test reads:
#     helper ... || { teardown_case; return; }

PASS=0
FAIL=0
CURRENT_TEST=""
CASE_ROOT=""
BG_PIDS=""

ok() {
  PASS=$((PASS + 1))
  echo "ok $1"
}

not_ok() {
  FAIL=$((FAIL + 1))
  echo "not ok $1: $2"
}

fail_case() {
  not_ok "$CURRENT_TEST" "$1"
}

# --- scratch-case plumbing ---------------------------------------------------------------

setup_case() {
  # canonical (…/var → /private/var on macOS): the adapter refuses a root with a symlinked
  # path component, and every fixture path must be canonical for the same reason.
  CASE_ROOT="$(cd -P -- "$(TMPDIR="$ORIG_TMPDIR" mktemp -d)" && pwd -P)"
  mkdir -p "$CASE_ROOT/home" "$CASE_ROOT/tmp" "$CASE_ROOT/state" \
           "$CASE_ROOT/work" "$CASE_ROOT/bin" "$CASE_ROOT/stubstate"

  ln -s "$SUITE_DIR/stub/codex" "$CASE_ROOT/bin/codex"
  ln -s "$SUITE_DIR/stub/herdr" "$CASE_ROOT/bin/herdr"
  [ -z "$REAL_JQ" ]  || ln -s "$REAL_JQ"  "$CASE_ROOT/bin/jq"
  [ -z "$REAL_GIT" ] || ln -s "$REAL_GIT" "$CASE_ROOT/bin/git"

  unset XDG_STATE_HOME HERDR_ENV HERDR_PANE_ID FC_TEST_TIMEOUT_S FC_TEST_KILL_GRACE_S \
        FC_STUB_EXIT FC_STUB_EVENTS FC_STUB_STDERR FC_STUB_OUT FC_STUB_MUTATE \
        FC_STUB_SLEEP FC_STUB_IGNORE_TERM FC_STUB_FORK_GRANDCHILD FC_STUB_SELF_SIGNAL \
        FC_STUB_READ_STDIN FC_STUB_POLICY_DECISION FC_STUB_POLICY_EXIT FC_STUB_POLICY_NTH \
        FC_STUB_VERSION 2>/dev/null

  export HOME="$CASE_ROOT/home"
  export TMPDIR="$CASE_ROOT/tmp"
  export CODEX_HOME="$HOME/.codex"
  export FC_ADAPTER_ROOT="$CASE_ROOT/state/fc"
  export FC_STUB_STATE="$CASE_ROOT/stubstate"
  export FC_TEST_MODE=1
  export FC_TEST_NOW=1790000000
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
  export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
  export PATH="$CASE_ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  OUT_FILE="$CASE_ROOT/out.txt"
  ERR_FILE="$CASE_ROOT/err.txt"
  BG_PIDS=""
  CHECKOUT=""; BRANCH=""; BASE=""; STREAM_DIR=""; SPEC=""
}

teardown_case() {
  local p
  for p in $BG_PIDS; do
    kill -KILL "$p" 2>/dev/null || true
  done
  BG_PIDS=""
  if [ -s "$FC_SENTINEL_FILE" ]; then
    not_ok "$CURRENT_TEST" "sentinel tripped: a stub ran outside a case"
  fi
  # the farm must still be the only codex on PATH (or none at all)
  local resolved
  resolved="$(command -v codex 2>/dev/null || true)"
  case "$resolved" in
    ""|"$CASE_ROOT"/bin/*) ;;
    *) not_ok "$CURRENT_TEST" "codex escaped the case farm: $resolved" ;;
  esac
  [ -n "$CASE_ROOT" ] || return 0
  chmod -R u+rwx "$CASE_ROOT" 2>/dev/null || true
  rm -rf "$CASE_ROOT" 2>/dev/null || true
  CASE_ROOT=""
  export PATH="$SUITE_PATH"
}

drop_from_path() { # drop_from_path <codex|herdr>
  rm -f "$CASE_ROOT/bin/$1"
}

# --- fixture builders ----------------------------------------------------------------------

mk_repo() { # mk_repo <dir>
  local d="$1"
  mkdir -p "$d/src" "$d/docs"
  printf 'a\n' >"$d/src/a.txt"
  printf 'b\n' >"$d/docs/b.txt"
  printf 'readme\n' >"$d/README.md"
  git -C "$d" init -q
  git -C "$d" add -A >/dev/null 2>&1
  git -C "$d" commit -q -m init >/dev/null 2>&1
}

mk_worktree() { # mk_worktree <main-repo> <dir> <branch>  -> CHECKOUT BRANCH BASE
  git -C "$1" worktree add -q -b "$3" "$2" >/dev/null 2>&1
  CHECKOUT="$(cd -P -- "$2" && pwd -P)"
  BRANCH="$3"
  BASE="$(git -C "$CHECKOUT" rev-parse HEAD)"
}

mk_stream() { # mk_stream <dir> <stream> <task> [codex|claude|none] -> STREAM_DIR SPEC
  local d="$1/$2" task="$3" flag="${4:-codex}"
  mkdir -p "$d/tasks/$task"
  printf '# stream\n' >"$d/stream.md"
  printf '# spec\n\n- AC-1 do the thing\n' >"$d/spec.md"
  {
    printf '# %s\n\n' "$task"
    case "$flag" in
      none) : ;;
      *) printf 'implementer: %s\n' "$flag" ;;
    esac
    printf '\n## Goal\n\nDo the thing.\n'
  } >"$d/tasks/$task/brief.md"
  STREAM_DIR="$(cd -P -- "$d" && pwd -P)"
  SPEC="$STREAM_DIR/spec.md"
}

# mk_fixture [brief-flag] [scope-entry...] — the standard valid input every adapter case needs:
# a main repo, a LINKED worktree on branch `feat`, a stream with a codex-flagged brief and a
# scope file. Sets CHECKOUT BRANCH BASE STREAM_DIR SPEC TASK SCOPE_FILE.
mk_fixture() {
  local flag="${1:-codex}"
  shift || true
  mk_repo "$CASE_ROOT/work/main"
  mk_worktree "$CASE_ROOT/work/main" "$CASE_ROOT/work/wt" feat
  mk_stream "$CASE_ROOT/work/streams" s01 t01 "$flag"
  TASK=t01
  SCOPE_FILE="$CASE_ROOT/work/scope.txt"
  if [ "$#" -gt 0 ]; then
    mk_scope_file "$SCOPE_FILE" "$@"
  else
    mk_scope_file "$SCOPE_FILE" "src/"
  fi
}

mk_scope_file() { # mk_scope_file <path> <entry...>
  local p="$1"; shift
  mkdir -p "$(dirname "$p")"
  : >"$p"
  local e
  for e in "$@"; do printf '%s\n' "$e" >>"$p"; done
}

mk_text_file() { # mk_text_file <path> <bytes>
  local p="$1" n="$2" chunk=""
  mkdir -p "$(dirname "$p")"
  while [ "${#chunk}" -lt 64 ]; do chunk="${chunk}findings-text "; done
  : >"$p"
  local have=0
  while [ "$have" -lt "$n" ]; do
    printf '%s\n' "$chunk" >>"$p"
    have=$((have + ${#chunk} + 1))
  done
}

# mk_codex_config [<server>...] [--nested <server> <sub>] [--raw-name <s>]
# Writes $CODEX_HOME/config.toml. The MCP table header is ASSEMBLED at run time so no line
# of this suite's source starts with one.
mk_codex_config() {
  local open="[" ns="mcp_servers."
  mkdir -p "$CODEX_HOME"
  : >"$CODEX_HOME/config.toml"
  printf '%s\n\n' 'model = "gpt-5.6-sol"' >>"$CODEX_HOME/config.toml"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --nested)
        printf '%s%s%s.%s]\n' "$open" "$ns" "$2" "$3" >>"$CODEX_HOME/config.toml"
        printf 'FOO = "bar"\n\n' >>"$CODEX_HOME/config.toml"
        shift 3
        ;;
      --raw-name)
        printf '%s%s%s]\n' "$open" "$ns" "$2" >>"$CODEX_HOME/config.toml"
        printf 'command = "x"\n\n' >>"$CODEX_HOME/config.toml"
        shift 2
        ;;
      *)
        printf '%s%s%s]\n' "$open" "$ns" "$1" >>"$CODEX_HOME/config.toml"
        printf 'command = "x"\n\n' >>"$CODEX_HOME/config.toml"
        shift
        ;;
    esac
  done
}

# fc_sample / fc_nearmiss — strings that match / narrowly miss each egress rule. Every one
# is ASSEMBLED from parts so no source file here contains a contiguous rule prefix.
fc_sample() { # fc_sample <rule-id>
  local a b
  case "$1" in
    openrouter_key)  a="sk-or"; b="-v1-"; printf '%s%s%s\n' "$a" "$b" "AbCdEfGhIjKlMnOpQrSt" ;;
    anthropic_key)   a="sk-";   b="ant-"; printf '%s%s%s\n' "$a" "$b" "AbCdEfGhIjKlMnOpQrSt" ;;
    slack_bot_token) a="xo";    b="xb-";  printf '%s%s%s\n' "$a" "$b" "1234567890abcdef" ;;
    github_pat)      a="gh";    b="p_";   printf '%s%s%s\n' "$a" "$b" "AbCdEfGhIjKlMnOpQrStUvWxY" ;;
    google_api_key)  a="AI";    b="za";   printf '%s%s%s\n' "$a" "$b" "AbCdEfGhIjKlMnOpQrStUvWxYz012345" ;;
    supabase_token)  a="sb";    b="p_";   printf '%s%s%s\n' "$a" "$b" "AbCdEfGhIjKlMnOpQrStUvWxY" ;;
    db_url_password) a="postg"; b="res://"; printf '%s%s%s\n' "$a" "$b" "dbuser:h0tsauce9@db.example.net/app" ;;
    env_assignment)  a="MY_SERVICE_"; b="KEY"; printf '%s%s%s\n' "$a" "$b" "=abcdefgh12345678" ;;
    mcp_config)      a="[";     b="mcp_servers."; printf '%s%s%s\n' "$a" "$b" "alpha]" ;;
    *) return 1 ;;
  esac
}

fc_nearmiss() { # fc_nearmiss <rule-id>
  local a b
  case "$1" in
    openrouter_key)  a="sk-or"; b="-v1-"; printf '%s%s%s\n' "$a" "$b" "short" ;;
    anthropic_key)   a="sk-";   b="ant-"; printf '%s%s%s\n' "$a" "$b" "short" ;;
    slack_bot_token) a="xo";    b="xb-";  printf '%s%s%s\n' "$a" "$b" "abc" ;;
    github_pat)      a="gh";    b="p_";   printf '%s%s%s\n' "$a" "$b" "abc" ;;
    google_api_key)  a="AI";    b="za";   printf '%s%s%s\n' "$a" "$b" "abc" ;;
    supabase_token)  a="sb";    b="p_";   printf '%s%s%s\n' "$a" "$b" "abc" ;;
    db_url_password) a="postg"; b="res://"; printf '%s%s%s\n' "$a" "$b" "dbuser:changeme@db.example.net/app" ;;
    env_assignment)  a="MY_SERVICE_"; b="KEY"; printf '%s%s%s\n' "$a" "$b" "=short" ;;
    mcp_config)      printf 'see the %s section of the docs for details\n' "mcp_servers" ;;
    *) return 1 ;;
  esac
}

FC_RULE_IDS="openrouter_key anthropic_key slack_bot_token github_pat google_api_key supabase_token db_url_password env_assignment mcp_config"

# --- running the systems under test ---------------------------------------------------------

sut_script() { printf '%s/plugins/fable-conductor/skills/conduct/scripts/%s\n' "${FC_SUT_ROOT:-$REPO_ROOT}" "$1"; }

default_run_args() { # prints the canonical `run` option vector, one element per line
  printf '%s\n' run \
    --stream-dir "$STREAM_DIR" \
    --task "$TASK" \
    --round 1 \
    --checkout "$CHECKOUT" \
    --expected-branch "$BRANCH" \
    --spec "$SPEC" \
    --base "$BASE" \
    --scope-file "$SCOPE_FILE" \
    --effort medium
}

run_adapter() { # run_adapter <args...> -> CODE, $OUT_FILE, $ERR_FILE
  : >"$OUT_FILE"; : >"$ERR_FILE"
  "$(sut_script codex-implementer.sh)" "$@" >"$OUT_FILE" 2>"$ERR_FILE"
  CODE=$?
}

run_adapter_default() { # run_adapter_default [extra args...]
  local args=()
  while IFS= read -r line; do args+=("$line"); done < <(default_run_args)
  run_adapter "${args[@]}" "$@"
}

run_prober() { # run_prober <args...> -> CODE, $OUT_FILE, $ERR_FILE
  : >"$OUT_FILE"; : >"$ERR_FILE"
  "$(sut_script codex-policy.sh)" "$@" >"$OUT_FILE" 2>"$ERR_FILE"
  CODE=$?
}

run_adapter_bg() { # run_adapter_bg <args...> -> ADAPTER_PID
  "$(sut_script codex-implementer.sh)" "$@" >"$OUT_FILE" 2>"$ERR_FILE" &
  ADAPTER_PID=$!
  BG_PIDS="$BG_PIDS $ADAPTER_PID"
}

last_run_dir() {
  local d
  for d in "$FC_ADAPTER_ROOT"/runs/*/*/*; do
    [ -d "$d" ] || continue
    printf '%s\n' "$d"
  done | tail -n 1
}

# --- assertions --------------------------------------------------------------------------

assert_eq() { # assert_eq <got> <want> <what>
  if [ "$1" = "$2" ]; then return 0; fi
  fail_case "${3:-value}: got '$1', want '$2'"
  return 1
}

assert_file_eq() { # assert_file_eq <got-file> <golden-file>
  if cmp -s "$1" "$2"; then return 0; fi
  fail_case "file differs from golden: $1 vs $2 -- $(diff "$2" "$1" 2>&1 | head -n 6 | tr '\n' '|')"
  return 1
}

assert_empty() { # assert_empty <file>
  if [ ! -s "$1" ]; then return 0; fi
  fail_case "expected empty: $1 -- $(head -c 300 "$1" | tr '\n' '|')"
  return 1
}

assert_mode() { # assert_mode <path> <octal>
  local got
  got="$(/usr/bin/stat -f %Lp "$1" 2>/dev/null || true)"
  if [ "$got" = "$2" ]; then return 0; fi
  fail_case "mode of $1: got '$got', want '$2'"
  return 1
}

assert_one_json_line() { # assert_one_json_line <file>
  local n
  n="$(wc -l <"$1" | tr -d ' ')"
  if [ "$n" != "1" ]; then
    fail_case "expected exactly one line in $1, got $n"
    return 1
  fi
  if ! jq -e . "$1" >/dev/null 2>&1; then
    fail_case "not parsable JSON: $(head -c 300 "$1")"
    return 1
  fi
  return 0
}

assert_json() { # assert_json <file> <jq-filter>
  local got
  got="$(jq -r "$2" "$1" 2>&1)"
  if [ "$got" = "true" ]; then return 0; fi
  fail_case "jq filter '$2' -> '$got' on $(head -c 400 "$1" | tr '\n' '|')"
  return 1
}

assert_channel() { # assert_channel <stdout|stderr>
  case "$1" in
    stdout)
      assert_empty "$ERR_FILE" || return 1
      assert_one_json_line "$OUT_FILE" || return 1
      ;;
    stderr)
      assert_empty "$OUT_FILE" || return 1
      assert_one_json_line "$ERR_FILE" || return 1
      ;;
  esac
  return 0
}

stub_count() { # stub_count <exec|execpolicy|version|any>
  local f
  if [ "$1" = any ]; then f="$FC_STUB_STATE/codex.count"; else f="$FC_STUB_STATE/codex.$1.count"; fi
  if [ -f "$f" ]; then cat "$f"; else echo 0; fi
}

assert_codex_calls() { # assert_codex_calls <exec|execpolicy|version|any> <n>
  local got; got="$(stub_count "$1")"
  if [ "$got" = "$2" ]; then return 0; fi
  fail_case "codex $1 calls: got $got, want $2"
  return 1
}

assert_herdr_calls() { # assert_herdr_calls <n>
  local got=0
  [ ! -f "$FC_STUB_STATE/herdr.count" ] || got="$(cat "$FC_STUB_STATE/herdr.count")"
  if [ "$got" = "$1" ]; then return 0; fi
  fail_case "herdr calls: got $got, want $1"
  return 1
}

# stub_argv <n> — the argv of the n-th recorded codex call, one element per line.
stub_argv() {
  local f="$FC_STUB_STATE/codex.$1.argv"
  [ -f "$f" ] || return 1
  local a
  while IFS= read -r -d '' a; do printf '%s\n' "$a"; done <"$f"
}

# exec_call_index — the record number of the n-th `exec` call (1-based).
exec_call_index() { # exec_call_index <n>
  local total i seen=0
  total="$(stub_count any)"
  i=1
  while [ "$i" -le "$total" ]; do
    if [ "$(cat "$FC_STUB_STATE/codex.$i.mode" 2>/dev/null)" = exec ]; then
      seen=$((seen + 1))
      if [ "$seen" = "$1" ]; then printf '%s\n' "$i"; return 0; fi
    fi
    i=$((i + 1))
  done
  return 1
}

# assert_argv_golden <exec-call-n> <golden> — compares the recorded argv with the golden after
# checking the prompt element against <RUN>/prompt.md and substituting the §3 placeholders.
# FC_GOLDEN_MODEL / FC_GOLDEN_EFFORT carry the values the caller launched with.
assert_argv_golden() {
  local idx run_dir got want prompt_el
  idx="$(exec_call_index "$1")" || { fail_case "no exec call $1 recorded"; return 1; }
  run_dir="$(last_run_dir)"
  got="$CASE_ROOT/argv.got"
  want="$CASE_ROOT/argv.want"
  prompt_el="$CASE_ROOT/prompt.el"

  fc_split_argv "$FC_STUB_STATE/codex.$idx.argv" "$CASE_ROOT/argv.head" "$prompt_el"
  if ! cmp -s "$prompt_el" "$run_dir/prompt.md"; then
    fail_case "launch prompt element != $run_dir/prompt.md"
    return 1
  fi
  { cat "$CASE_ROOT/argv.head"; printf '<PROMPT>\n'; } >"$got"
  sed -e "s|<RUN>|$run_dir|g" \
      -e "s|<MODEL>|${FC_GOLDEN_MODEL:-}|g" \
      -e "s|<EFFORT>|${FC_GOLDEN_EFFORT:-medium}|g" "$2" >"$want"
  assert_file_eq "$got" "$want"
}

# fc_split_argv <nul-file> <head-out> <last-out> — head gets every element but the last, one
# per line; last gets the final element verbatim (it may contain LF).
fc_split_argv() {
  local src="$1" head="$2" last="$3" prev="" first=1
  : >"$head"; : >"$last"
  local a
  while IFS= read -r -d '' a; do
    if [ "$first" = 1 ]; then first=0; else printf '%s\n' "$prev" >>"$head"; fi
    prev="$a"
  done <"$src"
  printf '%s' "$prev" >"$last"
}

# fc_walk <dir> <strip-prefix> — recursive listing: path, type, mode, digest. bash 3.2 has no
# globstar, so this recurses one glob level at a time; symlinks are recorded, never followed.
fc_walk() {
  local e name
  for e in "$1"/*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    name="${e#$2}"
    if [ -L "$e" ]; then
      printf '%s\tsymlink\t%s\t%s\n' "$name" "$(/usr/bin/stat -f %Lp "$e")" "$(/usr/bin/stat -f %Y "$e")"
    elif [ -d "$e" ]; then
      printf '%s\tdir\t%s\t-\n' "$name" "$(/usr/bin/stat -f %Lp "$e")"
      fc_walk "$e" "$2"
    elif [ -f "$e" ]; then
      printf '%s\tfile\t%s\t%s\n' "$name" "$(/usr/bin/stat -f %Lp "$e")" "$(shasum -a 256 "$e" | cut -d' ' -f1)"
    else
      printf '%s\tother\t-\t-\n' "$name"
    fi
  done
}

snapshot_tree() { # snapshot_tree <dir> <out>
  if [ ! -d "$1" ]; then : >"$2"; return 0; fi
  ( shopt -s dotglob nullglob; fc_walk "$1" "$1" ) | LC_ALL=C sort >"$2"
}

assert_tree_unchanged() { # assert_tree_unchanged <a> <b>
  if cmp -s "$1" "$2"; then return 0; fi
  fail_case "tree changed: $(diff "$1" "$2" 2>&1 | head -n 8 | tr '\n' '|')"
  return 1
}

assert_no_process() { # assert_no_process <pid>
  local i=0
  while [ "$i" -lt 150 ]; do
    if ! ps -p "$1" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  fail_case "process $1 is still alive"
  return 1
}

normalize_result() { # normalize_result <file> — prints the result with volatile values masked
  jq -S . "$1" \
    | sed -e "s|$CASE_ROOT|<ROOT>|g" \
          -e 's|"[0-9a-f]\{40\}"|"<OID>"|g' \
          -e 's|[0-9]\{8\}T[0-9]\{6\}Z-[0-9]*-[0-9]*|<RUN_ID>|g'
}
