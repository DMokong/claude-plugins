#!/usr/bin/env bash
# jutsu-spawn.sh — create one herdr crew member (shell pane, claude agent, or codex agent)
# and stamp ONE name on every surface: herdr agent name, pane label, Claude session name.
# Prints a single JSON line describing the member and appends it to the stream registry.
#
# Bash 3.2 compatible (macOS /bin/bash): indexed arrays only, no bash-4 builtins or
# case-folding parameter expansions, every array expansion guarded for `set -u`.
set -euo pipefail

# ---------------------------------------------------------------------------------------
# bootstrap: jq builds every JSON line, including the error lines, so it is checked first
# with a hand-written fallback envelope.
# ---------------------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' '{"error":{"code":"missing_dependency","message":"jq (>= 1.6) is required"}}' >&2
  exit 4
fi

usage() {
  cat <<'EOF'
Usage: jutsu-spawn.sh --name <stream>-<role> --kind claude|codex|shell [options] [-- <native agent args>]
       jutsu-spawn.sh --preflight --name <stream>-<role> --kind claude|codex|shell [options]
       jutsu-spawn.sh --record-session --name <member> [--stream S] [--session-id ID]

Placement (pick one; default --where pane):
  --where pane|tab|workspace   sibling pane of the caller (default), new tab, or new workspace
  --worktree BRANCH            new git worktree + its own herdr workspace (implies isolation)
  --base REF                   base ref for --worktree (default: current HEAD)
  --in-pane PANE_ID            reuse an existing idle shell pane instead of creating one
  --beside PANE_ID|AGENT_NAME|REGISTERED_SHELL_NAME
                               split next to another pane/agent/registered shell member

Options:
  --direction right|down       split direction (default: auto from caller pane geometry)
  --ratio FLOAT                split ratio for the new pane
  --cwd PATH                   working directory (default: $PWD; ignored with --worktree)
  --stream NAME                registry/stream label (default: text before the first '-' in --name)
                               must match ^[a-z][a-z0-9_-]{0,31}$
  --issue ID                   tracker issue id recorded in the registry
  --cmd "COMMAND"              kind=shell only: command to run in the pane
  --timeout MS                 agent start timeout (default 60000)
  --focus                      focus the new location (default: --no-focus)
  --allow-dangerous-agent-flags
                               permit bypass/full-access agent flags after `--` (user-only
                               decision; recorded as "dangerous_override":true). Must appear
                               before `--`.
  --preflight                  run the environment checks, print the result JSON line, create
                               nothing (cannot be combined with --record-session:
                               conflicting_options)
  --record-session             record a session id for an existing member (see below)
  --session-id ID              the session id --record-session writes
  -h, --help                   this text

Exit codes:
  0  ok
  2  usage error (missing_argument, unknown_option, conflicting_options, unknown_anchor,
     unknown_member)
  3  member retained but not ready (agent_not_ready) — the row IS registered
  4  preflight failed (not_in_herdr, missing_dependency, herdr_version_too_old,
     herdr_unreachable, invalid_name, invalid_kind, invalid_where, name_in_use)
  5  refused (dangerous_agent_flag, pane_not_idle_shell, unsafe_registry_path)
  1  anything else (e.g. agent_start_failed, no_session_id, a failed herdr call)

All error output is a single JSON line on stderr: {"error":{"code":...,"message":...}}.
Warnings use {"warning":{...}} and recovery records {"recovery":{...}}, same one-line shape.

Preflight (every check below runs before anything is created; --preflight runs the same
list, prints its result JSON line and exits — the only herdr call it makes is read-only):
  HERDR_ENV=1 · jq, git, herdr on PATH · herdr --version >= 0.8.2 (numeric compare) ·
  --name/--kind/--where/--stream valid · no dangerous agent flags without the override ·
  registry location resolved and proven writable · a real herdr round-trip: `herdr agent
  list` must exit 0 AND answer with JSON carrying a .result.agents array, otherwise the
  preflight fails with herdr_unreachable (exit 4) carrying herdr's own error text — its
  failure is never swallowed, so a silently empty agent list can never pass as "ok" ·
  the name is not already live · the parent lookup ("parent"/"parent_pane"; an empty
  parent is not a failure).
--preflight writes its result line to STDOUT: {"ok":true,...} on success, or, when herdr is
unreachable, {"ok":false,"code":"herdr_unreachable","message":...,"sandbox":...} — and that
failing case ALSO writes the matching {"error":{"code":"herdr_unreachable",...}} line to
STDERR before exiting 4, so read both streams. Every other preflight failure (invalid_name,
name_in_use, ...) is a stderr error line only, with nothing on stdout. Both result lines
carry "sandbox": the value of $CODEX_SANDBOX if set, else "" — a best-effort surface hint.
A sandboxed agent reaches herdr only through commands its user has allowed to run outside
the sandbox; this script cannot and must not change that.

--record-session (creates no pane, starts nothing):
  jutsu-spawn.sh --record-session --name <member> [--stream S] [--session-id ID]
Appends ONE new registry row for a member spawned earlier: its latest row plus the
session id, the kind-specific resume_args (["--resume",ID] for claude, ["resume",ID] for
codex, [] for shell), a status that is the member's CURRENT herdr status when `herdr agent
get <name>` returns one and otherwise the literal "recorded" (never the spawn-time status:
a recorded session means the member got past its startup dialog, so repeating a stale
"agent_not_ready" would be wrong), and a fresh "recorded_at". Use it when a member started
behind a startup dialog (its row has session_id "") or was revived by resume. With no
--session-id the id is read from
`herdr agent get <name>` (.result.agent.agent_session.value); herdr reports null there for
a resumed Codex session, which fails with no_session_id and asks for --session-id. A name
with no row in the stream registry is unknown_member.
The registry is append-only: the LATEST row per name wins. Read it that way —
  jq -c --arg n "<member>" 'select(.name == $n)' <registry_path> | tail -n1

Registry resolution order (the output line always carries "registry" and "registry_path"):
  1. $JUTSU_STATE_DIR                                     -> registry "home"
  2. ${XDG_STATE_HOME:-$HOME/.local/state}/herdr-jutsu    -> registry "home"
  3. <git toplevel of --cwd, else --cwd>/.jutsu/state     -> registry "workspace"
  4. none — degraded: the spawn still proceeds so a read-only parent can raise a reader,
     a {"warning":{"code":"registry_unavailable"...}} line goes to stderr and the output
     line carries "registry":"none".
  The state directory is forced to 0700 and the registry file to 0600. A symlinked state
  directory or registry file is refused (unsafe_registry_path) — nothing is written through it.

Failure after creation (EXIT trap, disarmed on success and on the retained agent_not_ready):
  - a pane/tab/workspace this run created (and no worktree) is closed;
  - a worktree this run created is NEVER removed: a {"recovery":{"status":"orphaned",...}}
    line goes to stderr and, when the registry is writable, the row is appended with
    "status":"orphaned". Clean up by hand with `herdr worktree remove --workspace <id>`;
  - an --in-pane pane is never closed; a rename this run applied is reverted.

kind=claude auto-adds `-n <name>` so ListAgents/SendMessage address == herdr agent name.
Everything after `--` goes to the agent binary verbatim (model, effort, permissions...).
`agent_args` is recorded as a JSON array (boundaries, spaces and empty strings preserved);
values following --api-key/--token/--password/--secret (and the --flag=value form) are
replaced with "<redacted>" in the registry/output copy only — never pass secrets as args.
`resume_args` records the kind-specific revival argv: ["--resume","<id>"] for claude,
["resume","<id>"] for codex, [] for shell or when there is no session id.
EOF
}

# ---------------------------------------------------------------------------------------
# JSON output helpers — every machine-readable line is built with jq -cn --arg.
# ---------------------------------------------------------------------------------------
FAIL_REASON=""

emit_error() { jq -cn --arg c "$1" --arg m "$2" '{error:{code:$c,message:$m}}' >&2; }
emit_warning() { jq -cn --arg c "$1" --arg m "$2" '{warning:{code:$c,message:$m}}' >&2; }

fail() { # fail <code> <message> [exit-status]
  FAIL_REASON="$1"
  emit_error "$1" "$2"
  exit "${3:-1}"
}

need_value() { # need_value <option> <remaining-argc>
  [ "$2" -ge 2 ] || fail missing_argument "option $1 requires a value" 2
}

oneline() { # collapse text to one whitespace-squeezed, trimmed line (for error messages)
  printf '%s' "${1:-}" | tr '\n\r\t' '   ' | sed 's/  */ /g; s/^ //; s/ *$//'
}

# ---------------------------------------------------------------------------------------
# herdr_run — every herdr call that must fail LOUDLY goes through this: it keeps herdr's
# own stderr text so the caller can put it in the error message instead of discarding it.
# That text is what tells a sandboxed agent why it failed (e.g. the socket EPERM a Codex
# session gets for any command its user has not allowed to run outside the sandbox).
# ---------------------------------------------------------------------------------------
HERDR_OUT="" HERDR_ERRTEXT="" HERDR_RC=0

herdr_run() { # herdr_run <herdr args...>  -> stdout in $HERDR_OUT, one-line stderr in $HERDR_ERRTEXT
  local ef="" rc=0
  HERDR_OUT="" HERDR_ERRTEXT="" HERDR_RC=0
  ef="$(mktemp "${TMPDIR:-/tmp}/jutsu-herdr.XXXXXX" 2>/dev/null || true)"
  if [ -n "$ef" ]; then
    HERDR_OUT="$(herdr "$@" 2>"$ef")" || rc=$?
    HERDR_ERRTEXT="$(oneline "$(cat "$ef" 2>/dev/null || true)")"
    rm -f "$ef" 2>/dev/null || true
  else
    # no temp file available (fully read-only sandbox): merge, and use it only on failure
    HERDR_OUT="$(herdr "$@" 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then HERDR_ERRTEXT="$(oneline "$HERDR_OUT")"; fi
  fi
  HERDR_RC=$rc
  return $rc
}

# ---------------------------------------------------------------------------------------
# argument parsing (arity checked before every $2 read)
# ---------------------------------------------------------------------------------------
NAME="" KIND="" WHERE="pane" WORKTREE="" BASE="" IN_PANE="" BESIDE="" DIRECTION="" RATIO=""
CWD="$PWD" STREAM="" ISSUE="" CMD="" TIMEOUT=60000
FOCUS_ARG=(--no-focus)
ALLOW_DANGEROUS=0 PREFLIGHT_ONLY=0 RECORD_SESSION=0 SESSION_ID_ARG=""
AGENT_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --name) need_value "$1" $#; NAME="$2"; shift 2 ;;
    --kind) need_value "$1" $#; KIND="$2"; shift 2 ;;
    --where) need_value "$1" $#; WHERE="$2"; shift 2 ;;
    --worktree) need_value "$1" $#; WORKTREE="$2"; shift 2 ;;
    --base) need_value "$1" $#; BASE="$2"; shift 2 ;;
    --in-pane) need_value "$1" $#; IN_PANE="$2"; shift 2 ;;
    --beside) need_value "$1" $#; BESIDE="$2"; shift 2 ;;
    --direction) need_value "$1" $#; DIRECTION="$2"; shift 2 ;;
    --ratio) need_value "$1" $#; RATIO="$2"; shift 2 ;;
    --cwd) need_value "$1" $#; CWD="$2"; shift 2 ;;
    --stream) need_value "$1" $#; STREAM="$2"; shift 2 ;;
    --issue) need_value "$1" $#; ISSUE="$2"; shift 2 ;;
    --cmd) need_value "$1" $#; CMD="$2"; shift 2 ;;
    --timeout) need_value "$1" $#; TIMEOUT="$2"; shift 2 ;;
    --focus) FOCUS_ARG=(--focus); shift ;;
    --allow-dangerous-agent-flags) ALLOW_DANGEROUS=1; shift ;;
    --preflight) PREFLIGHT_ONLY=1; shift ;;
    --record-session) RECORD_SESSION=1; shift ;;
    --session-id) need_value "$1" $#; SESSION_ID_ARG="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; AGENT_ARGS=(${@+"$@"}); break ;;
    *) fail unknown_option "unknown option: $1" 2 ;;
  esac
done

# --preflight and --record-session contradict each other: --preflight promises to create
# nothing, --record-session exists to append a row. Refuse the pair instead of letting one
# silently win.
if [ "$PREFLIGHT_ONLY" -eq 1 ] && [ "$RECORD_SESSION" -eq 1 ]; then
  fail conflicting_options \
    "--preflight and --record-session cannot be combined: --preflight creates nothing, --record-session appends a registry row" 2
fi

# ---------------------------------------------------------------------------------------
# preflight — nothing below this block creates anything
# ---------------------------------------------------------------------------------------
[ "${HERDR_ENV:-}" = 1 ] || fail not_in_herdr \
  "not inside herdr (HERDR_ENV!=1); refusing to drive a session from outside" 4
command -v git >/dev/null 2>&1 || fail missing_dependency "git is required" 4
command -v herdr >/dev/null 2>&1 || fail missing_dependency "herdr is required" 4

HERDR_MIN=0.8.2
herdr_run --version || true
HERDR_VERSION_RAW="$HERDR_OUT"
# a failing `herdr --version` keeps its own error text, so the failure names the cause
[ -n "$HERDR_VERSION_RAW" ] || HERDR_VERSION_RAW="$HERDR_ERRTEXT"
HERDR_VERSION="$(printf '%s\n' "$HERDR_VERSION_RAW" \
  | awk 'match($0, /[0-9]+\.[0-9]+(\.[0-9]+)?/) { print substr($0, RSTART, RLENGTH); exit }')"
[ -n "$HERDR_VERSION" ] || fail herdr_version_too_old \
  "could not read a version number from 'herdr --version' (got: $HERDR_VERSION_RAW)" 4

num() { # strip everything but digits, default 0 — keeps the compare numeric, never string
  local n
  n="$(printf '%s' "${1:-}" | tr -cd '0-9')"
  printf '%s' "${n:-0}"
}

ver_ge() { # ver_ge <have> <want>  -> 0 when have >= want
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1" || true
  IFS=. read -r b1 b2 b3 <<<"$2" || true
  a1="$(num "${a1:-0}")"; a2="$(num "${a2:-0}")"; a3="$(num "${a3:-0}")"
  b1="$(num "${b1:-0}")"; b2="$(num "${b2:-0}")"; b3="$(num "${b3:-0}")"
  if [ "$a1" -ne "$b1" ]; then [ "$a1" -gt "$b1" ]; return $?; fi
  if [ "$a2" -ne "$b2" ]; then [ "$a2" -gt "$b2" ]; return $?; fi
  [ "$a3" -ge "$b3" ]
}

ver_ge "$HERDR_VERSION" "$HERDR_MIN" || fail herdr_version_too_old \
  "herdr $HERDR_VERSION is older than the required $HERDR_MIN" 4

[[ "$NAME" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || fail invalid_name \
  "--name must match ^[a-z][a-z0-9_-]{0,31}$ (herdr agent-name rule)" 4
# --record-session takes the kind from the member's own registry row, so it needs neither
# --kind nor --where; every other mode validates both.
if [ "$RECORD_SESSION" -ne 1 ]; then
  case "$KIND" in claude|codex|shell) ;; *) fail invalid_kind "--kind must be claude, codex, or shell" 4 ;; esac
  case "$WHERE" in pane|tab|workspace) ;; *) fail invalid_where "--where must be pane, tab, or workspace" 4 ;; esac
fi
[ -n "$STREAM" ] || STREAM="${NAME%%-*}"
[[ "$STREAM" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || fail unsafe_registry_path \
  "--stream must match ^[a-z][a-z0-9_-]{0,31}\$ (it becomes a registry filename): $STREAM" 5

# --- dangerous agent flags ---------------------------------------------------------------
DANGEROUS_FLAG=""
scan_dangerous_flags() {
  local n=${#AGENT_ARGS[@]} i=0 a next
  while [ "$i" -lt "$n" ]; do
    a="${AGENT_ARGS[$i]}"
    next=""
    if [ $((i + 1)) -lt "$n" ]; then next="${AGENT_ARGS[$((i + 1))]}"; fi
    case "$KIND" in
      claude)
        case "$a" in
          --dangerously-skip-permissions|--allow-dangerously-skip-permissions)
            DANGEROUS_FLAG="$a" ;;
          --permission-mode)
            case "$next" in bypassPermissions|dontAsk) DANGEROUS_FLAG="$a $next" ;; esac ;;
          --permission-mode=bypassPermissions|--permission-mode=dontAsk)
            DANGEROUS_FLAG="$a" ;;
        esac
        ;;
      codex)
        case "$a" in
          --dangerously-bypass-approvals-and-sandbox|--yolo)
            DANGEROUS_FLAG="$a" ;;
          -s|--sandbox)
            if [ "$next" = danger-full-access ]; then DANGEROUS_FLAG="$a $next"; fi ;;
          -s=danger-full-access|--sandbox=danger-full-access)
            DANGEROUS_FLAG="$a" ;;
          -c|--config)
            case "$next" in *sandbox_mode*danger-full-access*) DANGEROUS_FLAG="$a $next" ;; esac ;;
          -c=*|--config=*)
            case "$a" in *sandbox_mode*danger-full-access*) DANGEROUS_FLAG="$a" ;; esac ;;
        esac
        ;;
    esac
    i=$((i + 1))
  done
}
scan_dangerous_flags
if [ -n "$DANGEROUS_FLAG" ] && [ "$ALLOW_DANGEROUS" -ne 1 ]; then
  fail dangerous_agent_flag \
    "refusing dangerous agent flag: $DANGEROUS_FLAG (pass --allow-dangerous-agent-flags before -- if the user authorized it)" 5
fi

# --- registry location ------------------------------------------------------------------
REGISTRY_MODE=none REG_DIR="" REG_FILE=""
# modes that must not bring a registry file into existence while proving writability:
# --preflight (creates nothing at all) and --record-session (only ever appends to a file
# that already holds the member's row).
NO_CREATE=0
if [ "$PREFLIGHT_ONLY" -eq 1 ] || [ "$RECORD_SESSION" -eq 1 ]; then NO_CREATE=1; fi

try_state_dir() { # try_state_dir <dir> <home|workspace>
  local d="$1" mode="$2" f probe
  [ -n "$d" ] || return 1
  if [ -L "$d" ]; then
    fail unsafe_registry_path "registry state directory is a symlink: $d" 5
  fi
  mkdir -p "$d" 2>/dev/null || return 1
  chmod 700 "$d" 2>/dev/null || true
  f="$d/$STREAM.jsonl"
  if [ -L "$f" ]; then
    fail unsafe_registry_path "registry file is a symlink: $f" 5
  fi
  if [ "$NO_CREATE" -eq 1 ]; then
    # --preflight / --record-session create nothing here: prove the directory is writable
    # with a probe file that is removed again, so a stream that was never spawned gets no
    # registry file and a pre-existing registry file keeps its content and its mode.
    probe="$d/.jutsu-preflight.$$"
    ( umask 077; : >"$probe" ) 2>/dev/null || return 1
    rm -f "$probe" 2>/dev/null || true
  else
    # writability proof: create/append nothing through a restrictive umask
    ( umask 077; : >>"$f" ) 2>/dev/null || return 1
    chmod 600 "$f" 2>/dev/null || true
  fi
  REG_DIR="$d"; REG_FILE="$f"; REGISTRY_MODE="$mode"
  return 0
}

resolve_registry() {
  local top
  if [ -n "${JUTSU_STATE_DIR:-}" ]; then
    try_state_dir "$JUTSU_STATE_DIR" home && return 0
    return 0
  fi
  try_state_dir "${XDG_STATE_HOME:-$HOME/.local/state}/herdr-jutsu" home && return 0
  top="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] || top="$CWD"
  try_state_dir "$top/.jutsu/state" workspace && return 0
  return 0
}
resolve_registry

if [ "$REGISTRY_MODE" = none ]; then
  emit_warning registry_unavailable \
    "no writable registry location (JUTSU_STATE_DIR / XDG state / workspace-local .jutsu/state); spawning anyway, nothing will be recorded"
fi

# --- surface hint -----------------------------------------------------------------------
# Best-effort only: Codex exports CODEX_SANDBOX inside its sandbox. Nothing branches on
# this beyond the hint text — there is no reliable way to guess a sandbox otherwise.
SANDBOX="${CODEX_SANDBOX:-}"

# --- --record-session: record a session id for a member that already exists --------------
# Creates no pane, starts nothing, appends exactly one row to the member's stream registry.
if [ "$RECORD_SESSION" -eq 1 ]; then
  { [ "$REGISTRY_MODE" != none ] && [ -n "$REG_FILE" ] && [ -f "$REG_FILE" ]; } \
    || fail unknown_member \
      "no registry row for $NAME: stream '$STREAM' has no registry file at ${REG_FILE:-<none>}" 2
  ROW="$(jq -c --arg n "$NAME" 'select(.name == $n)' "$REG_FILE" 2>/dev/null | tail -n1 || true)"
  [ -n "$ROW" ] || fail unknown_member \
    "no row named $NAME in $REG_FILE (the latest row per name wins; spawn the member first)" 2
  ROW_KIND="$(printf '%s' "$ROW" | jq -r '.kind // empty' 2>/dev/null || true)"

  # Read-only lookup: herdr supplies the session id when --session-id was not given, and
  # the member's current status when it can be read at all.
  HERDR_SESSION="" LIVE_STATUS=""
  if herdr_run agent get "$NAME"; then
    HERDR_SESSION="$(printf '%s' "$HERDR_OUT" | jq -r '.result.agent.agent_session.value // empty' 2>/dev/null || true)"
    LIVE_STATUS="$(printf '%s' "$HERDR_OUT" | jq -r '.result.agent.agent_status // empty' 2>/dev/null || true)"
  fi

  RECORDED_SESSION="$SESSION_ID_ARG"
  [ -n "$RECORDED_SESSION" ] || RECORDED_SESSION="$HERDR_SESSION"
  [ -n "$RECORDED_SESSION" ] || fail no_session_id \
    "no session id for $NAME: herdr reports none (it reports null for a resumed Codex session, and a member blocked at startup never got one) — pass --session-id <id>; a Codex member can read its own id with /status" 1

  RECORDED_RESUME='[]'
  case "$ROW_KIND" in
    claude) RECORDED_RESUME="$(jq -cn --arg s "$RECORDED_SESSION" '["--resume", $s]')" ;;
    codex) RECORDED_RESUME="$(jq -cn --arg s "$RECORDED_SESSION" '["resume", $s]')" ;;
  esac

  # The new row's status is the member's status NOW, not the one it was spawned with: a
  # recorded session proves the member got past whatever it was sitting on, so carrying a
  # stale agent_not_ready forward would be a lie. When herdr will not tell us, say
  # "recorded" rather than repeat the old row's status.
  RECORDED_STATUS="$LIVE_STATUS"
  [ -n "$RECORDED_STATUS" ] || RECORDED_STATUS="recorded"

  NEW_ROW="$(printf '%s' "$ROW" | jq -c --arg s "$RECORDED_SESSION" --argjson r "$RECORDED_RESUME" \
      --arg st "$RECORDED_STATUS" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '. + {session_id:$s, resume_args:$r, status:$st, recorded_at:$at}')" \
    || fail registry_write_failed "could not build the new registry row for $NAME" 1
  [ ! -L "$REG_FILE" ] || fail unsafe_registry_path "registry file is a symlink: $REG_FILE" 5
  ( umask 077; printf '%s\n' "$NEW_ROW" >>"$REG_FILE" ) \
    || fail registry_write_failed "could not append the new row to $REG_FILE" 1
  chmod 600 "$REG_FILE" 2>/dev/null || true
  printf '%s\n' "$NEW_ROW"
  exit 0
fi

# --- session-state preflight (read-only: `herdr agent list` creates nothing) ------------
# `herdr agent list` is the round-trip that proves herdr is actually REACHABLE. Its
# failure is never swallowed — a sandboxed agent gets EPERM on herdr's socket for every
# command its user has not allowed to run outside the sandbox, and this check used to
# report that state as a passing preflight with a silently empty parent.
herdr_unreachable() { # herdr_unreachable <message>
  local m
  m="$(oneline "$1")"
  if [ -n "$SANDBOX" ]; then
    m="$m — a sandboxed agent reaches herdr only through commands its user has allowed to run outside the sandbox (CODEX_SANDBOX=$SANDBOX)"
  fi
  if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
    FAIL_REASON=herdr_unreachable
    jq -cn --arg m "$m" --arg sb "$SANDBOX" \
      '{ok:false, code:"herdr_unreachable", message:$m, sandbox:$sb}'
    emit_error herdr_unreachable "$m"
    exit 4
  fi
  fail herdr_unreachable "$m" 4
}

AGENTS_JSON=""
if herdr_run agent list; then
  AGENTS_JSON="$HERDR_OUT"
  printf '%s' "$AGENTS_JSON" | jq -e 'has("result") and (.result.agents | type == "array")' >/dev/null 2>&1 \
    || herdr_unreachable "herdr agent list did not answer with JSON carrying a .result.agents array (got: $(oneline "$AGENTS_JSON"))"
else
  herdr_unreachable "herdr agent list failed (exit $HERDR_RC): ${HERDR_ERRTEXT:-no error output}"
fi

if printf '%s' "$AGENTS_JSON" | jq -e --arg n "$NAME" '.result.agents[]? | select(.name == $n)' >/dev/null 2>&1; then
  fail name_in_use "a live herdr agent is already named $NAME" 4
fi

PARENT="$(printf '%s' "$AGENTS_JSON" \
  | jq -r --arg p "${HERDR_PANE_ID:-}" '.result.agents[]? | select(.pane_id == $p) | .name // empty' 2>/dev/null | head -n1)"

# Every preflight check is now done and nothing has been created: --preflight reports here.
if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
  jq -cn --arg v "$HERDR_VERSION" --arg sd "$REG_DIR" --arg reg "$REGISTRY_MODE" \
    --arg rp "$REG_FILE" --arg name "$NAME" --arg kind "$KIND" --arg stream "$STREAM" \
    --arg cwd "$CWD" --arg parent "$PARENT" --arg pp "${HERDR_PANE_ID:-}" \
    --arg sb "$SANDBOX" \
    '{ok:true, herdr_version:$v, state_dir:$sd, registry:$reg, registry_path:$rp,
      name:$name, kind:$kind, stream:$stream, cwd:$cwd,
      name_in_use:false, parent:$parent, parent_pane:$pp, sandbox:$sb}'
  exit 0
fi

# ---------------------------------------------------------------------------------------
# agent_args bookkeeping (including redaction) — done before creation so the recovery record
# and the orphaned row can carry it too.
# ---------------------------------------------------------------------------------------
REDACTED_ARGS=()
redact_args() {
  local n=${#AGENT_ARGS[@]} i=0 a redact_next=0
  REDACTED_ARGS=()
  while [ "$i" -lt "$n" ]; do
    a="${AGENT_ARGS[$i]}"
    if [ "$redact_next" -eq 1 ]; then
      REDACTED_ARGS+=("<redacted>")
      redact_next=0
    else
      case "$a" in
        --api-key|--token|--password|--secret)
          REDACTED_ARGS+=("$a"); redact_next=1 ;;
        --api-key=*|--token=*|--password=*|--secret=*)
          REDACTED_ARGS+=("${a%%=*}=<redacted>") ;;
        *)
          REDACTED_ARGS+=("$a") ;;
      esac
    fi
    i=$((i + 1))
  done
}
redact_args
# `--` ends jq's own option parsing so an agent arg like `--append-system-prompt` is
# taken as a positional string rather than an unknown jq option.
ARGS_JSON="$(jq -cn '$ARGS.positional' --args -- ${REDACTED_ARGS[@]+"${REDACTED_ARGS[@]}"})"
RESUME_JSON='[]'
if [ "$ALLOW_DANGEROUS" -eq 1 ]; then DANGEROUS_JSON=true; else DANGEROUS_JSON=false; fi

# ---------------------------------------------------------------------------------------
# resource tracking + EXIT trap
# ---------------------------------------------------------------------------------------
WORKSPACE_ID="" TAB_ID="" PANE_ID="" WT_PATH="" WT_BRANCH=""
CREATED_PANE=""          # a pane/tab/workspace root THIS run created -> closable
IN_PANE_ID="" IN_PANE_LABEL="" IN_PANE_RENAMED=0
SESSION_ID="" STATUS=""
TRAP_ARMED=0

build_line() { # build_line <status>
  jq -cn \
    --arg name "$NAME" --arg kind "$KIND" --arg stream "$STREAM" --arg issue "$ISSUE" \
    --arg pane "$PANE_ID" --arg tab "$TAB_ID" --arg ws "$WORKSPACE_ID" --arg cwd "$CWD" \
    --arg wt "$WT_PATH" --arg branch "$WT_BRANCH" --arg session "$SESSION_ID" \
    --arg status "$1" --arg parent "$PARENT" --arg parent_pane "${HERDR_PANE_ID:-}" \
    --argjson args "$ARGS_JSON" --argjson resume "$RESUME_JSON" \
    --argjson danger "$DANGEROUS_JSON" \
    --arg registry "$REGISTRY_MODE" --arg registry_path "$REG_FILE" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{name:$name, kind:$kind, stream:$stream, issue:$issue, pane_id:$pane, tab_id:$tab,
      workspace_id:$ws, cwd:$cwd, worktree:$wt, branch:$branch, session_id:$session,
      status:$status, parent:$parent, parent_pane:$parent_pane, agent_args:$args,
      resume_args:$resume, dangerous_override:$danger, registry:$registry,
      registry_path:$registry_path, spawned_at:$at}'
}

append_registry() { # append_registry <json-line>; never fatal
  [ "$REGISTRY_MODE" != none ] || return 0
  [ -n "$REG_FILE" ] || return 0
  [ ! -L "$REG_FILE" ] || return 0
  ( umask 077; printf '%s\n' "$1" >>"$REG_FILE" ) 2>/dev/null || return 0
  chmod 600 "$REG_FILE" 2>/dev/null || true
  return 0
}

on_exit() {
  local rc=$?
  trap - EXIT
  # the trap must never fail the script and never recurse
  set +e
  if [ "$TRAP_ARMED" -eq 1 ] && [ "$rc" -ne 0 ]; then
    if [ -n "$WT_PATH" ]; then
      # NEVER auto-remove a worktree: silently deleting work is the scarier failure.
      jq -cn --arg wt "$WT_PATH" --arg br "$WT_BRANCH" --arg ws "$WORKSPACE_ID" \
        --arg pane "$PANE_ID" --arg reason "${FAIL_REASON:-unknown_failure}" \
        --arg cleanup "herdr worktree remove --workspace $WORKSPACE_ID" \
        '{recovery:{status:"orphaned", worktree:$wt, branch:$br, workspace_id:$ws,
          pane_id:$pane, reason:$reason, cleanup:$cleanup}}' >&2
      append_registry "$(build_line orphaned)"
    elif [ -n "$CREATED_PANE" ]; then
      herdr pane close "$CREATED_PANE" >/dev/null 2>&1
    fi
    if [ "$IN_PANE_RENAMED" -eq 1 ] && [ -n "$IN_PANE_LABEL" ]; then
      herdr pane rename "$IN_PANE_ID" "$IN_PANE_LABEL" >/dev/null 2>&1
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT

# ---------------------------------------------------------------------------------------
# helpers that read the live session
# ---------------------------------------------------------------------------------------
is_interactive_shell() { # is_interactive_shell <name-or-argv0>
  local n="${1:-}"
  n="${n##*/}"      # basename
  n="${n#-}"        # login shells arrive as -zsh
  case "$n" in
    sh|bash|zsh|fish|dash|ksh|tcsh|nu|pwsh) return 0 ;;
    *) return 1 ;;
  esac
}

assert_pane_is_idle_shell() { # assert_pane_is_idle_shell <pane_id>
  local pane="$1" info="" names n found=0 why=""
  if herdr_run pane process-info --pane "$pane"; then
    info="$HERDR_OUT"
  else
    why=" (${HERDR_ERRTEXT:-no error output})"
  fi
  if [ -z "$info" ] || ! printf '%s' "$info" | jq -e . >/dev/null 2>&1; then
    fail pane_not_idle_shell \
      "cannot read/parse 'herdr pane process-info --pane $pane'$why; refusing to type into a pane that is not demonstrably available" 5
  fi
  names="$(printf '%s' "$info" \
    | jq -r '.result.process_info.foreground_processes[]? | (.name // .argv0 // "")' 2>/dev/null || true)"
  if [ -z "$names" ]; then
    fail pane_not_idle_shell \
      "pane $pane reports no foreground process; refusing (the bar is demonstrably available, not probably free)" 5
  fi
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    found=1
    is_interactive_shell "$n" || fail pane_not_idle_shell \
      "pane $pane foreground process '$n' is not an interactive shell" 5
  done <<<"$names"
  [ "$found" -eq 1 ] || fail pane_not_idle_shell "pane $pane has no identifiable foreground process" 5
  if printf '%s' "$AGENTS_JSON" | jq -e --arg p "$pane" '.result.agents[]? | select(.pane_id == $p)' >/dev/null 2>&1; then
    fail pane_not_idle_shell "pane $pane is already occupied by a live herdr agent" 5
  fi
}

resolve_anchor() { # resolve_anchor <value> -> pane id candidate on stdout
  local v="$1" pid=""
  pid="$(printf '%s' "$AGENTS_JSON" \
    | jq -r --arg n "$v" '.result.agents[]? | select(.name == $n) | .pane_id // empty' 2>/dev/null | head -n1)"
  if [ -z "$pid" ] && [ "$REGISTRY_MODE" != none ] && [ -f "$REG_FILE" ]; then
    pid="$(jq -r --arg n "$v" 'select(.name == $n) | .pane_id // empty' "$REG_FILE" 2>/dev/null | tail -n1)"
  fi
  [ -n "$pid" ] || pid="$v"
  printf '%s' "$pid"
}

# ---------------------------------------------------------------------------------------
# placement
# ---------------------------------------------------------------------------------------
if [ -n "$WORKTREE" ]; then
  # Pin the base explicitly so the branch point is the caller's HEAD, not whatever herdr defaults to.
  if [ -z "$BASE" ]; then
    BASE="$(git -C "$CWD" rev-parse HEAD 2>/dev/null || true)"
    [ -n "$BASE" ] || fail base_ref_unresolved "could not resolve HEAD in $CWD for --worktree" 1
  fi
  herdr_run worktree create --cwd "$CWD" --branch "$WORKTREE" --base "$BASE" --label "$STREAM" "${FOCUS_ARG[@]}" \
    || fail worktree_create_failed "herdr worktree create failed for branch $WORKTREE: ${HERDR_ERRTEXT:-no error output}" 1
  R="$HERDR_OUT"
  WORKSPACE_ID="$(jq -r '.result.workspace.workspace_id // empty' <<<"$R")"
  TAB_ID="$(jq -r '.result.tab.tab_id // empty' <<<"$R")"
  PANE_ID="$(jq -r '.result.root_pane.pane_id // empty' <<<"$R")"
  WT_PATH="$(jq -r '.result.worktree.path // empty' <<<"$R")"
  WT_BRANCH="$(jq -r '.result.worktree.branch // empty' <<<"$R")"
  CREATED_PANE="$PANE_ID"
  TRAP_ARMED=1
  [ -n "$WT_PATH" ] || fail worktree_create_failed "herdr worktree create returned no worktree path" 1
  CWD="$WT_PATH"
  herdr_run tab rename "$TAB_ID" "$NAME" \
    || fail tab_rename_failed "herdr tab rename $TAB_ID failed: ${HERDR_ERRTEXT:-no error output}" 1
elif [ -n "$IN_PANE" ]; then
  herdr_run pane get "$IN_PANE" \
    || fail unknown_anchor "--in-pane $IN_PANE: no such pane (${HERDR_ERRTEXT:-no error output})" 2
  R="$HERDR_OUT"
  PANE_ID="$(jq -r '.result.pane.pane_id // empty' <<<"$R")"
  TAB_ID="$(jq -r '.result.pane.tab_id // empty' <<<"$R")"
  WORKSPACE_ID="$(jq -r '.result.pane.workspace_id // empty' <<<"$R")"
  IN_PANE_LABEL="$(jq -r '.result.pane.label // empty' <<<"$R")"
  [ -n "$PANE_ID" ] || fail unknown_anchor "--in-pane $IN_PANE: no pane id in herdr's response" 2
  # refuse unless the pane is demonstrably an idle interactive shell — BEFORE any rename.
  assert_pane_is_idle_shell "$PANE_ID"
  IN_PANE_ID="$PANE_ID"
else
  case "$WHERE" in
    workspace)
      herdr_run workspace create --cwd "$CWD" --label "$STREAM" "${FOCUS_ARG[@]}" \
        || fail workspace_create_failed "herdr workspace create failed: ${HERDR_ERRTEXT:-no error output}" 1
      R="$HERDR_OUT"
      WORKSPACE_ID="$(jq -r '.result.workspace.workspace_id // empty' <<<"$R")"
      TAB_ID="$(jq -r '.result.tab.tab_id // empty' <<<"$R")"
      PANE_ID="$(jq -r '.result.root_pane.pane_id // empty' <<<"$R")"
      CREATED_PANE="$PANE_ID"
      TRAP_ARMED=1
      herdr_run tab rename "$TAB_ID" "$NAME" \
        || fail tab_rename_failed "herdr tab rename $TAB_ID failed: ${HERDR_ERRTEXT:-no error output}" 1
      ;;
    tab)
      [ -n "${HERDR_WORKSPACE_ID:-}" ] || fail missing_dependency \
        "--where tab needs HERDR_WORKSPACE_ID in the environment" 4
      herdr_run tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$CWD" --label "$NAME" "${FOCUS_ARG[@]}" \
        || fail tab_create_failed "herdr tab create failed: ${HERDR_ERRTEXT:-no error output}" 1
      R="$HERDR_OUT"
      TAB_ID="$(jq -r '.result.tab.tab_id // empty' <<<"$R")"
      PANE_ID="$(jq -r '.result.root_pane.pane_id // empty' <<<"$R")"
      WORKSPACE_ID="$(jq -r '.result.root_pane.workspace_id // empty' <<<"$R")"
      CREATED_PANE="$PANE_ID"
      TRAP_ARMED=1
      ;;
    pane)
      ANCHOR="${HERDR_PANE_ID:-}"
      if [ -n "$BESIDE" ]; then
        ANCHOR="$(resolve_anchor "$BESIDE")"
      fi
      [ -n "$ANCHOR" ] || fail unknown_anchor \
        "no anchor pane: pass --beside PANE_ID|AGENT_NAME|REGISTERED_SHELL_NAME (HERDR_PANE_ID is unset)" 2
      # the final anchor must exist before anything is split off it.
      herdr_run pane get "$ANCHOR" \
        || fail unknown_anchor \
          "--beside/anchor '${BESIDE:-$ANCHOR}' does not resolve to a live pane (${HERDR_ERRTEXT:-no error output})" 2
      if [ -z "$DIRECTION" ]; then
        # Wide pane -> split right; narrow/tall -> split down. Cells are ~2x taller than wide.
        DIRECTION="$(herdr pane layout --pane "$ANCHOR" 2>/dev/null \
          | jq -r --arg p "$ANCHOR" '(.result.layout.panes[]? | select(.pane_id == $p) | .rect) as $r
              | if ($r.width >= 2.4 * $r.height and $r.width >= 160) then "right" else "down" end' 2>/dev/null \
          | head -n1 || true)"
        [ -n "$DIRECTION" ] || DIRECTION="down"
      fi
      SPLIT=(pane split "$ANCHOR" --direction "$DIRECTION" --cwd "$CWD" "${FOCUS_ARG[@]}")
      [ -z "$RATIO" ] || SPLIT+=(--ratio "$RATIO")
      herdr_run "${SPLIT[@]}" \
        || fail pane_split_failed "herdr pane split $ANCHOR failed: ${HERDR_ERRTEXT:-no error output}" 1
      R="$HERDR_OUT"
      PANE_ID="$(jq -r '.result.pane.pane_id // empty' <<<"$R")"
      TAB_ID="$(jq -r '.result.pane.tab_id // empty' <<<"$R")"
      WORKSPACE_ID="$(jq -r '.result.pane.workspace_id // empty' <<<"$R")"
      CREATED_PANE="$PANE_ID"
      TRAP_ARMED=1
      ;;
  esac
fi

[ -n "$PANE_ID" ] && [ "$PANE_ID" != null ] \
  || fail pane_unresolved "could not resolve a pane id from herdr's response" 1

herdr_run pane rename "$PANE_ID" "$NAME" \
  || fail pane_rename_failed "herdr pane rename $PANE_ID failed: ${HERDR_ERRTEXT:-no error output}" 1
[ -z "$IN_PANE_ID" ] || IN_PANE_RENAMED=1
TRAP_ARMED=1

# ---------------------------------------------------------------------------------------
# start the member
# ---------------------------------------------------------------------------------------
START_ERR=""
if [ "$KIND" = shell ]; then
  if [ -n "$CMD" ]; then
    herdr_run pane run "$PANE_ID" "$CMD" \
      || fail pane_run_failed "herdr pane run $PANE_ID failed: ${HERDR_ERRTEXT:-no error output}" 1
  fi
  STATUS="shell"
else
  ARGS=()
  [ "$KIND" != claude ] || ARGS+=(-n "$NAME")
  ARGS+=(${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"})
  START=(herdr agent start "$NAME" --kind "$KIND" --pane "$PANE_ID" --timeout "$TIMEOUT")
  [ ${#ARGS[@]} -eq 0 ] || START+=(-- "${ARGS[@]}")
  if R="$("${START[@]}" 2>&1)"; then
    SESSION_ID="$(jq -r '.result.agent.agent_session.value // empty' <<<"$R" 2>/dev/null || true)"
    STATUS="$(jq -r '.result.agent.agent_status // "unknown"' <<<"$R" 2>/dev/null || echo unknown)"
    [ -n "$STATUS" ] || STATUS="unknown"
  else
    # only agent_not_ready guarantees a retained member (blocked at a startup dialog).
    START_ERR="$(jq -r '.error.code // empty' <<<"$R" 2>/dev/null || true)"
    if [ "$START_ERR" != agent_not_ready ]; then
      FAIL_REASON="agent_start_failed"
      emit_error agent_start_failed \
        "herdr agent start failed for $NAME (upstream code: ${START_ERR:-unparseable_response})"
      exit 1
    fi
    STATUS="agent_not_ready"
  fi
fi

# resume_args: the kind-specific argv that would revive this member.
if [ -n "$SESSION_ID" ] && [ "$KIND" = claude ]; then
  RESUME_JSON="$(jq -cn --arg s "$SESSION_ID" '["--resume", $s]')"
elif [ -n "$SESSION_ID" ] && [ "$KIND" = codex ]; then
  RESUME_JSON="$(jq -cn --arg s "$SESSION_ID" '["resume", $s]')"
fi

LINE="$(build_line "$STATUS")"
append_registry "$LINE"
TRAP_ARMED=0
printf '%s\n' "$LINE"

if [ "$STATUS" = agent_not_ready ]; then
  # exit 3: the member is retained and registered, but is not ready (startup dialog).
  emit_error agent_not_ready \
    "$NAME was created and registered but is not ready (startup dialog); handle it as a blocked member"
  exit 3
fi
exit 0
