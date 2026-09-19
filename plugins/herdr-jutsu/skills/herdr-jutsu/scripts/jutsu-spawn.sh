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
                               permit dangerous Claude flags after `--` (user-only decision;
                               recorded as "dangerous_override":true). Does not widen the
                               isolated Codex allowlist. Must appear before `--`.
  --no-isolation               do not install outbound isolation for a nested parent that
                               must drive herdr (user-only decision; recorded as
                               "outbound_isolation":"none"). Must appear before `--`.
  --strict-isolation           kind=claude: also deny SendMessage, for a member that handles
                               untrusted content and must not message any session. No
                               effect on kind=codex (it has no SendMessage); refused with
                               --no-isolation or kind=shell (conflicting_options). Must
                               appear before `--`.
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
  5  refused before placement (dangerous_agent_flag, isolation_unsupported_agent_arg,
     isolation_policy_conflict, pane_not_idle_shell, unsafe_registry_path); nothing was created
  1  anything else, including an isolation failure discovered after placement (e.g.
     agent_start_failed, no_session_id, a failed herdr call). A created worktree is orphaned.

All error output is a single JSON line on stderr: {"error":{"code":...,"message":...}}.
Warnings use {"warning":{...}} and recovery records {"recovery":{...}}, same one-line shape.

Preflight (every check below runs before anything is created; --preflight runs the same
list, prints its result JSON line and exits — the only herdr call it makes is read-only):
  HERDR_ENV=1 · jq, git, herdr on PATH · herdr --version >= 0.8.2 (numeric compare) ·
  --name/--kind/--where/--stream valid · isolated Codex agent args match the allowlist ·
  no dangerous Claude agent flags without the override ·
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
Unless --no-isolation is passed, kind=claude also merges `Bash(*herdr*)` and `ListAgents`
into one --disallowedTools flag: the member cannot drive herdr or discover sessions, but
keeps SendMessage, so it can message the sessions its brief names (its parent, for a
blocking question or an early warning). --strict-isolation adds `SendMessage` to that
flag; isolation_detail says which applies. kind=codex installs a project policy in
the target cwd, requires `-a never` (and adds it when absent), applies the allowlist below
even with --allow-dangerous-agent-flags, and reports
"outbound_isolation":"enforced_if_trusted" because Codex only loads a project policy
from a trusted repository. Three resolved-host `codex execpolicy check` probes are required
when codex is on PATH. kind=shell and --no-isolation report "outbound_isolation":"none".
For Claude and --no-isolation, everything after `--` goes to the agent binary verbatim
apart from the documented Claude name/deny merge. Isolated Codex args must match the
allowlist: safe -s/--sandbox; -a/--ask-for-approval never; -m/--model; --add-dir;
-p/--profile with an explicit safe sandbox; -c/--config only for model,
model_reasoning_effort, model_reasoning_summary or model_verbosity scalar values; and a
final `resume <id-or-name>` or `resume --last` pair. The launcher may inject `-a never`
before that final pair. Any other token is isolation_unsupported_agent_arg; only the
user-selected --no-isolation opts out.
`agent_args` records what the caller passed and `effective_agent_args` what was launched,
both as JSON arrays (boundaries, spaces and empty strings preserved);
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
ALLOW_DANGEROUS=0 NO_ISOLATION=0 STRICT_ISOLATION=0 PREFLIGHT_ONLY=0 RECORD_SESSION=0 SESSION_ID_ARG=""
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
    --no-isolation) NO_ISOLATION=1; shift ;;
    --strict-isolation) STRICT_ISOLATION=1; shift ;;
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

# --strict-isolation tightens an isolation layer, so it cannot be combined with having none:
# refuse instead of printing a label the member does not have.
if [ "$STRICT_ISOLATION" -eq 1 ] && [ "$NO_ISOLATION" -eq 1 ]; then
  fail conflicting_options \
    "--strict-isolation and --no-isolation cannot be combined: one tightens outbound isolation, the other removes it" 2
fi
if [ "$STRICT_ISOLATION" -eq 1 ] && [ "$KIND" = shell ]; then
  fail conflicting_options \
    "--strict-isolation cannot be combined with --kind shell: shell members are not isolated" 2
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
      codex) ;;
    esac
    i=$((i + 1))
  done
}
scan_dangerous_flags

# --- outbound-isolation plan ------------------------------------------------------------
# This validation and argv shaping happens before any resource is created. The Codex
# policy itself is written later, once placement has resolved the member's actual cwd.
OUTBOUND_ISOLATION="none"
ISOLATION_DETAIL=""
CODEX_PROFILE_NOTE=""
CODEX_EXCLUDE_NOTE=""
LAUNCH_ARGS=(${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"})

array_has() { # array_has <needle> <values...>
  local needle="$1" value
  shift
  for value in "$@"; do [ "$value" = "$needle" ] && return 0; done
  return 1
}

unsupported_agent_arg() { # unsupported_agent_arg <token>
  fail isolation_unsupported_agent_arg \
    "Codex outbound isolation does not support agent argument token '$1'; --no-isolation is the only way to pass it, and that is the user's decision" 5
}

codex_config_allowed() { # codex_config_allowed <key=value>
  local setting="$1" key value
  case "$setting" in *=*) ;; *) return 1 ;; esac
  key="${setting%%=*}"
  value="${setting#*=}"
  key="$(printf '%s' "$key" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  case "$key" in
    \"*\") key="${key#\"}"; key="${key%\"}" ;;
    \'*\') key="${key#\'}"; key="${key%\'}" ;;
  esac
  case "$key" in
    model|model_reasoning_effort|model_reasoning_summary|model_verbosity) ;;
    *) return 1 ;;
  esac
  case "$value" in *'{'*|*'['*|*$'\n'*) return 1 ;; esac
  return 0
}

prepare_isolation() {
  local n=${#AGENT_ARGS[@]} i=0 a next approval_seen=0 approval_value=""
  local sandbox_seen=0 sandbox_value="" profile_seen=0 profile_value="" profile_token=""
  local config_value="" value="" permission_mode="default" claude_only_barrier=0 claude_skip_permissions=0
  local rebuilt=() denied=() codex_flags=() resume_tail=()

  if [ "$NO_ISOLATION" -eq 1 ]; then
    OUTBOUND_ISOLATION="none"
    ISOLATION_DETAIL="disabled by --no-isolation; the member may drive herdr"
    return 0
  fi

  case "$KIND" in
    codex)
      while [ "$i" -lt "$n" ]; do
        a="${AGENT_ARGS[$i]}"
        next=""
        if [ $((i + 1)) -lt "$n" ]; then next="${AGENT_ARGS[$((i + 1))]}"; fi
        case "$a" in
          -a|--ask-for-approval)
            [ $((i + 1)) -lt "$n" ] || unsupported_agent_arg "$a"
            approval_seen=1
            approval_value="$next"
            [ "$approval_value" = never ] || unsupported_agent_arg "$a"
            codex_flags+=("$a" "$next")
            i=$((i + 1))
            ;;
          -a?*|--ask-for-approval=*)
            approval_seen=1
            case "$a" in
              -a?*) approval_value="${a#-a}" ;;
              *) approval_value="${a#*=}" ;;
            esac
            approval_value="${approval_value#=}"
            [ "$approval_value" = never ] || unsupported_agent_arg "$a"
            codex_flags+=("$a")
            ;;
          -s|--sandbox)
            [ $((i + 1)) -lt "$n" ] || unsupported_agent_arg "$a"
            sandbox_seen=1
            sandbox_value="$next"
            case "$sandbox_value" in
              read-only|workspace-write) ;;
              *) unsupported_agent_arg "$a" ;;
            esac
            codex_flags+=("$a" "$next")
            i=$((i + 1))
            ;;
          -s?*|--sandbox=*)
            sandbox_seen=1
            case "$a" in
              -s?*) sandbox_value="${a#-s}" ;;
              *) sandbox_value="${a#*=}" ;;
            esac
            sandbox_value="${sandbox_value#=}"
            case "$sandbox_value" in
              read-only|workspace-write) ;;
              *) unsupported_agent_arg "$a" ;;
            esac
            codex_flags+=("$a")
            ;;
          -m|--model|--add-dir)
            [ $((i + 1)) -lt "$n" ] || unsupported_agent_arg "$a"
            codex_flags+=("$a" "$next")
            i=$((i + 1))
            ;;
          -m?*|--model=*|--add-dir=*)
            case "$a" in
              -m?*) value="${a#-m}"; value="${value#=}" ;;
              *) value="${a#*=}" ;;
            esac
            [ -n "$value" ] || unsupported_agent_arg "$a"
            codex_flags+=("$a")
            ;;
          -c|--config)
            [ $((i + 1)) -lt "$n" ] || unsupported_agent_arg "$a"
            config_value="$next"
            codex_config_allowed "$config_value" || unsupported_agent_arg "$config_value"
            codex_flags+=("$a" "$next")
            i=$((i + 1))
            ;;
          -c?*|--config=*)
            case "$a" in
              -c?*) config_value="${a#-c}" ;;
              *) config_value="${a#*=}" ;;
            esac
            config_value="${config_value#=}"
            codex_config_allowed "$config_value" || unsupported_agent_arg "$config_value"
            codex_flags+=("$a")
            ;;
          -p|--profile)
            [ $((i + 1)) -lt "$n" ] || unsupported_agent_arg "$a"
            profile_seen=1
            profile_value="$next"
            profile_token="$a"
            codex_flags+=("$a" "$next")
            i=$((i + 1))
            ;;
          -p?*|--profile=*)
            profile_seen=1
            case "$a" in
              -p?*) profile_value="${a#-p}" ;;
              *) profile_value="${a#*=}" ;;
            esac
            profile_value="${profile_value#=}"
            [ -n "$profile_value" ] || unsupported_agent_arg "$a"
            profile_token="$a"
            codex_flags+=("$a")
            ;;
          resume)
            [ $((i + 1)) -eq $((n - 1)) ] || unsupported_agent_arg "$a"
            [ -n "$next" ] || unsupported_agent_arg "$a"
            case "$next" in --last) ;; -*) unsupported_agent_arg "$next" ;; esac
            resume_tail=(resume "$next")
            i=$((i + 1))
            ;;
          *) unsupported_agent_arg "$a" ;;
        esac
        i=$((i + 1))
      done
      if [ "$profile_seen" -eq 1 ] && [ "$sandbox_seen" -ne 1 ]; then
        unsupported_agent_arg "$profile_token"
      fi
      if [ "$approval_seen" -eq 0 ]; then codex_flags+=(-a never); fi
      LAUNCH_ARGS=(${codex_flags[@]+"${codex_flags[@]}"})
      LAUNCH_ARGS+=(${resume_tail[@]+"${resume_tail[@]}"})
      OUTBOUND_ISOLATION="enforced_if_trusted"
      ISOLATION_DETAIL="Codex project deny policy and -a never; effective only when Codex trusts the target repository"
      if [ "$profile_seen" -eq 1 ]; then
        CODEX_PROFILE_NOTE="; profile '$profile_value' is in play with explicit sandbox '$sandbox_value'"
        ISOLATION_DETAIL="$ISOLATION_DETAIL$CODEX_PROFILE_NOTE"
      fi
      ;;
    claude)
      # Rebuild caller args with exactly one --disallowedTools flag. Claude accepts a
      # sequence of tool patterns after the flag, ending at the next option.
      i=0
      while [ "$i" -lt "$n" ]; do
        a="${AGENT_ARGS[$i]}"
        case "$a" in
          --permission-mode)
            if [ $((i + 1)) -lt "$n" ]; then
              permission_mode="${AGENT_ARGS[$((i + 1))]}"
              if [ "$claude_skip_permissions" -eq 0 ]; then
                case "$permission_mode" in
                  bypassPermissions|dontAsk|auto) claude_only_barrier=1 ;;
                  *) claude_only_barrier=0 ;;
                esac
              fi
            fi
            rebuilt+=("$a")
            ;;
          --permission-mode=*)
            permission_mode="${a#*=}"
            if [ "$claude_skip_permissions" -eq 0 ]; then
              case "$permission_mode" in
                bypassPermissions|dontAsk|auto) claude_only_barrier=1 ;;
                *) claude_only_barrier=0 ;;
              esac
            fi
            rebuilt+=("$a")
            ;;
          --dangerously-skip-permissions)
            permission_mode="dangerously-skip-permissions"
            claude_skip_permissions=1
            claude_only_barrier=1
            rebuilt+=("$a")
            ;;
          --disallowedTools|--disallowed-tools)
            i=$((i + 1))
            while [ "$i" -lt "$n" ]; do
              value="${AGENT_ARGS[$i]}"
              case "$value" in -*) break ;; esac
              array_has "$value" ${denied[@]+"${denied[@]}"} || denied+=("$value")
              i=$((i + 1))
            done
            continue
            ;;
          --disallowedTools=*|--disallowed-tools=*)
            value="${a#*=}"
            array_has "$value" ${denied[@]+"${denied[@]}"} || denied+=("$value")
            ;;
          *) rebuilt+=("$a") ;;
        esac
        i=$((i + 1))
      done
      for value in 'Bash(*herdr*)' ListAgents; do
        array_has "$value" ${denied[@]+"${denied[@]}"} || denied+=("$value")
      done
      if [ "$STRICT_ISOLATION" -eq 1 ]; then
        array_has SendMessage ${denied[@]+"${denied[@]}"} || denied+=(SendMessage)
      fi
      rebuilt+=(--disallowedTools)
      rebuilt+=(${denied[@]+"${denied[@]}"})
      LAUNCH_ARGS=(${rebuilt[@]+"${rebuilt[@]}"})
      OUTBOUND_ISOLATION="partial"
      # Read the label off the final deny list, so a caller-supplied SendMessage deny is
      # reported as denied too.
      if array_has SendMessage ${denied[@]+"${denied[@]}"}; then
        ISOLATION_DETAIL="Claude string-pattern deny for herdr, plus ListAgents and SendMessage denied; effective permission mode: $permission_mode"
      else
        ISOLATION_DETAIL="Claude string-pattern deny for herdr, plus ListAgents denied; SendMessage stays available, so the member can message sessions it is given the name of; effective permission mode: $permission_mode"
      fi
      if [ "$claude_only_barrier" -eq 1 ]; then
        ISOLATION_DETAIL="$ISOLATION_DETAIL; the string-pattern deny is the ONLY barrier because this mode does not prompt for Bash"
      fi
      ;;
    shell)
      OUTBOUND_ISOLATION="none"
      ISOLATION_DETAIL="shell members are not isolated"
      ;;
  esac
}
prepare_isolation

# Claude's dangerous-flag override is separate from isolated Codex's closed allowlist.
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
  PREFLIGHT_ISOLATION_DETAIL="$ISOLATION_DETAIL"
  if [ "$KIND" = codex ] && [ "$NO_ISOLATION" -eq 0 ]; then
    PREFLIGHT_ISOLATION_DETAIL="planned: spawn will install the Codex project deny policy and use -a never; effective only when Codex trusts the target repository$CODEX_PROFILE_NOTE"
  elif [ "$KIND" = claude ] && [ "$NO_ISOLATION" -eq 0 ]; then
    PREFLIGHT_ISOLATION_DETAIL="planned: $ISOLATION_DETAIL"
  fi
  jq -cn --arg v "$HERDR_VERSION" --arg sd "$REG_DIR" --arg reg "$REGISTRY_MODE" \
    --arg rp "$REG_FILE" --arg name "$NAME" --arg kind "$KIND" --arg stream "$STREAM" \
    --arg cwd "$CWD" --arg parent "$PARENT" --arg pp "${HERDR_PANE_ID:-}" \
    --arg sb "$SANDBOX" --arg oi "$OUTBOUND_ISOLATION" --arg id "$PREFLIGHT_ISOLATION_DETAIL" \
    '{ok:true, herdr_version:$v, state_dir:$sd, registry:$reg, registry_path:$rp,
      name:$name, kind:$kind, stream:$stream, cwd:$cwd,
      name_in_use:false, parent:$parent, parent_pane:$pp, sandbox:$sb,
      outbound_isolation:$oi, isolation_detail:$id}'
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
EFFECTIVE_ARGS=()
case "$KIND" in
  claude) EFFECTIVE_ARGS=(-n "$NAME"); EFFECTIVE_ARGS+=(${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"}) ;;
  codex) EFFECTIVE_ARGS=(${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"}) ;;
esac
REDACTED_EFFECTIVE_ARGS=()
redact_effective_args() {
  local n=${#EFFECTIVE_ARGS[@]} i=0 a redact_next=0
  REDACTED_EFFECTIVE_ARGS=()
  while [ "$i" -lt "$n" ]; do
    a="${EFFECTIVE_ARGS[$i]}"
    if [ "$redact_next" -eq 1 ]; then
      REDACTED_EFFECTIVE_ARGS+=("<redacted>")
      redact_next=0
    else
      case "$a" in
        --api-key|--token|--password|--secret)
          REDACTED_EFFECTIVE_ARGS+=("$a"); redact_next=1 ;;
        --api-key=*|--token=*|--password=*|--secret=*)
          REDACTED_EFFECTIVE_ARGS+=("${a%%=*}=<redacted>") ;;
        *) REDACTED_EFFECTIVE_ARGS+=("$a") ;;
      esac
    fi
    i=$((i + 1))
  done
}
redact_effective_args
# `--` ends jq's own option parsing so an agent arg like `--append-system-prompt` is
# taken as a positional string rather than an unknown jq option.
ARGS_JSON="$(jq -cn '$ARGS.positional' --args -- ${REDACTED_ARGS[@]+"${REDACTED_ARGS[@]}"})"
EFFECTIVE_ARGS_JSON="$(jq -cn '$ARGS.positional' --args -- ${REDACTED_EFFECTIVE_ARGS[@]+"${REDACTED_EFFECTIVE_ARGS[@]}"})"
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
POLICY_RULE_FILE="" POLICY_CONFIG_FILE="" POLICY_EXCLUDE_FILE=""
POLICY_RULE_CREATED=0 POLICY_CONFIG_CREATED=0
POLICY_CODEX_DIR_CREATED=0 POLICY_RULES_DIR_CREATED=0
POLICY_RULE_INTENT=0 POLICY_CONFIG_INTENT=0
POLICY_CODEX_DIR_INTENT=0 POLICY_RULES_DIR_INTENT=0
POLICY_RULE_EXCLUDE_ADDED=0 POLICY_CONFIG_EXCLUDE_ADDED=0
POLICY_RULE_EXCLUDE_LINE=0 POLICY_CONFIG_EXCLUDE_LINE=0
POLICY_RULE_EXCLUDE_NEWLINE=0 POLICY_CONFIG_EXCLUDE_NEWLINE=0
POLICY_LOCK_DIR="" POLICY_LOCK_HELD=0 POLICY_LOCK_INTENT=0

build_line() { # build_line <status>
  jq -cn \
    --arg name "$NAME" --arg kind "$KIND" --arg stream "$STREAM" --arg issue "$ISSUE" \
    --arg pane "$PANE_ID" --arg tab "$TAB_ID" --arg ws "$WORKSPACE_ID" --arg cwd "$CWD" \
    --arg wt "$WT_PATH" --arg branch "$WT_BRANCH" --arg session "$SESSION_ID" \
    --arg status "$1" --arg parent "$PARENT" --arg parent_pane "${HERDR_PANE_ID:-}" \
    --argjson args "$ARGS_JSON" --argjson effective_args "$EFFECTIVE_ARGS_JSON" \
    --argjson resume "$RESUME_JSON" \
    --argjson danger "$DANGEROUS_JSON" \
    --arg registry "$REGISTRY_MODE" --arg registry_path "$REG_FILE" \
    --arg oi "$OUTBOUND_ISOLATION" --arg id "$ISOLATION_DETAIL" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{name:$name, kind:$kind, stream:$stream, issue:$issue, pane_id:$pane, tab_id:$tab,
      workspace_id:$ws, cwd:$cwd, worktree:$wt, branch:$branch, session_id:$session,
      status:$status, parent:$parent, parent_pane:$parent_pane, agent_args:$args,
      effective_agent_args:$effective_args,
      resume_args:$resume, dangerous_override:$danger, registry:$registry,
      registry_path:$registry_path, outbound_isolation:$oi, isolation_detail:$id,
      spawned_at:$at}'
}

append_registry() { # append_registry <json-line>; never fatal
  [ "$REGISTRY_MODE" != none ] || return 0
  [ -n "$REG_FILE" ] || return 0
  [ ! -L "$REG_FILE" ] || return 0
  ( umask 077; printf '%s\n' "$1" >>"$REG_FILE" ) 2>/dev/null || return 0
  chmod 600 "$REG_FILE" 2>/dev/null || true
  return 0
}

exclude_mode() { # exclude_mode <file> -> portable octal permissions
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || printf '%s' 600
}

remove_owned_line() { # remove_owned_line <file> <line> <line-number> <restore-no-newline>
  local file="$1" line="$2" target="$3" restore_no_newline="$4" tmp="" dir="" mode=""
  [ -f "$file" ] || return 0
  [ "$target" -gt 0 ] 2>/dev/null || return 0
  [ "$(awk -v n="$target" 'NR == n { print; exit }' "$file" 2>/dev/null)" = "$line" ] || return 0
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.jutsu-exclude.XXXXXX" 2>/dev/null || true)"
  [ -n "$tmp" ] || return 0
  mode="$(exclude_mode "$file")"
  if awk -v target="$target" -v no_nl="$restore_no_newline" '
      NR != target { lines[++count] = $0 }
      END {
        for (i = 1; i <= count; i++) {
          printf "%s", lines[i]
          if (i < count || !no_nl) printf "\n"
        }
      }' "$file" >"$tmp" 2>/dev/null; then
    chmod "$mode" "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$file" 2>/dev/null || true
  fi
  rm -f "$tmp" 2>/dev/null || true
}

cleanup_policy_layer() {
  # Reverse creation order, and only remove resources this invocation proved it created.
  if [ "$POLICY_CONFIG_EXCLUDE_ADDED" -eq 1 ]; then
    remove_owned_line "$POLICY_EXCLUDE_FILE" '.codex/config.toml' \
      "$POLICY_CONFIG_EXCLUDE_LINE" "$POLICY_CONFIG_EXCLUDE_NEWLINE"
    POLICY_CONFIG_EXCLUDE_ADDED=0
  fi
  if [ "$POLICY_RULE_EXCLUDE_ADDED" -eq 1 ]; then
    remove_owned_line "$POLICY_EXCLUDE_FILE" '.codex/rules/herdr-jutsu-deny.rules' \
      "$POLICY_RULE_EXCLUDE_LINE" "$POLICY_RULE_EXCLUDE_NEWLINE"
    POLICY_RULE_EXCLUDE_ADDED=0
  fi
  if { [ "$POLICY_RULE_CREATED" -eq 1 ] || [ "$POLICY_RULE_INTENT" -eq 1 ]; } \
    && [ -n "$POLICY_RULE_FILE" ]; then
    rm -f "$POLICY_RULE_FILE" 2>/dev/null || true
    POLICY_RULE_CREATED=0
    POLICY_RULE_INTENT=0
  fi
  if { [ "$POLICY_CONFIG_CREATED" -eq 1 ] || [ "$POLICY_CONFIG_INTENT" -eq 1 ]; } \
    && [ -n "$POLICY_CONFIG_FILE" ]; then
    rm -f "$POLICY_CONFIG_FILE" 2>/dev/null || true
    POLICY_CONFIG_CREATED=0
    POLICY_CONFIG_INTENT=0
  fi
  if { [ "$POLICY_RULES_DIR_CREATED" -eq 1 ] || [ "$POLICY_RULES_DIR_INTENT" -eq 1 ]; } \
    && [ -n "$POLICY_RULE_FILE" ]; then
    rmdir "$(dirname "$POLICY_RULE_FILE")" 2>/dev/null || true
    POLICY_RULES_DIR_CREATED=0
    POLICY_RULES_DIR_INTENT=0
  fi
  if { [ "$POLICY_CODEX_DIR_CREATED" -eq 1 ] || [ "$POLICY_CODEX_DIR_INTENT" -eq 1 ]; } \
    && [ -n "$POLICY_CONFIG_FILE" ]; then
    rmdir "$(dirname "$POLICY_CONFIG_FILE")" 2>/dev/null || true
    POLICY_CODEX_DIR_CREATED=0
    POLICY_CODEX_DIR_INTENT=0
  fi
}

release_policy_lock() {
  if { [ "$POLICY_LOCK_HELD" -eq 1 ] || [ "$POLICY_LOCK_INTENT" -eq 1 ]; } \
    && [ -n "$POLICY_LOCK_DIR" ]; then
    rm -f "$POLICY_LOCK_DIR/pid" 2>/dev/null || true
    rmdir "$POLICY_LOCK_DIR" 2>/dev/null || true
  fi
  POLICY_LOCK_HELD=0
  POLICY_LOCK_INTENT=0
}

on_exit() {
  local rc=$? policy_owned=0
  trap - EXIT INT TERM
  # the trap must never fail the script and never recurse
  set +e
  if [ "$TRAP_ARMED" -eq 1 ] && [ "$rc" -ne 0 ]; then
    if [ "$POLICY_RULE_CREATED" -eq 1 ] || [ "$POLICY_CONFIG_CREATED" -eq 1 ]; then
      policy_owned=1
    fi
    cleanup_policy_layer
    if [ "$policy_owned" -eq 1 ]; then
      OUTBOUND_ISOLATION="none"
      ISOLATION_DETAIL="launcher-created Codex policy layer was removed after spawn failure"
    fi
    release_policy_lock
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
  if [ "$POLICY_LOCK_HELD" -eq 1 ] || [ "$POLICY_LOCK_INTENT" -eq 1 ]; then
    release_policy_lock
  fi
  exit "$rc"
}
trap on_exit EXIT
on_signal() { # on_signal <exit-status>
  FAIL_REASON=interrupted
  exit "$1"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

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

degrade_codex_isolation() { # degrade_codex_isolation <reason>
  cleanup_policy_layer
  OUTBOUND_ISOLATION="none"
  ISOLATION_DETAIL="$1"
  emit_warning outbound_isolation_unavailable "$1"
}

append_exclude_once() { # append_exclude_once <file> <entry> <tracking-variable-name>
  local file="$1" entry="$2" tracking="$3" dir="" tmp="" mode="" last_byte="" added_newline=0 line_number=0
  if grep -Fqx "$entry" "$file" 2>/dev/null; then return 0; fi
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.jutsu-exclude.XXXXXX" 2>/dev/null || true)"
  [ -n "$tmp" ] || return 1
  mode="$(exclude_mode "$file")"
  if ! cat "$file" >"$tmp" 2>/dev/null; then rm -f "$tmp" 2>/dev/null || true; return 1; fi
  if [ -s "$file" ]; then
    last_byte="$(tail -c 1 "$file" 2>/dev/null | od -An -t u1 | tr -d '[:space:]')"
    if [ "$last_byte" != 10 ]; then
      printf '\n' >>"$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 1; }
      added_newline=1
    fi
  fi
  printf '%s\n' "$entry" >>"$tmp" 2>/dev/null \
    || { rm -f "$tmp" 2>/dev/null || true; return 1; }
  line_number="$(awk 'END { print NR }' "$tmp" 2>/dev/null)"
  chmod "$mode" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 1; }
  case "$tracking" in
    rule)
      POLICY_RULE_EXCLUDE_ADDED=1
      POLICY_RULE_EXCLUDE_LINE="$line_number"
      POLICY_RULE_EXCLUDE_NEWLINE="$added_newline"
      ;;
    config)
      POLICY_CONFIG_EXCLUDE_ADDED=1
      POLICY_CONFIG_EXCLUDE_LINE="$line_number"
      POLICY_CONFIG_EXCLUDE_NEWLINE="$added_newline"
      ;;
  esac
  return 0
}

codex_rules_content() { # codex_rules_content <resolved-herdr-path>
  local escaped_path
  escaped_path="$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '%s\n%s' \
    "host_executable(name=\"herdr\", paths=[\"$escaped_path\"])" \
    'prefix_rule(pattern=["herdr"], decision="forbidden", justification="Crew members do not drive herdr; the parent pulls from this pane.")'
}

policy_conflict() { # policy_conflict <message>; post-placement conflicts orphan worktrees
  local status=5
  [ "$TRAP_ARMED" -eq 0 ] || status=1
  fail isolation_policy_conflict "$1" "$status"
}

validate_policy_paths() { # validate_policy_paths <cwd> <expected-rules>
  local root="$1" expected="$2" codex_dir rules_dir rule_file config_file existing=""
  codex_dir="$root/.codex"
  rules_dir="$codex_dir/rules"
  rule_file="$rules_dir/herdr-jutsu-deny.rules"
  config_file="$codex_dir/config.toml"
  [ ! -L "$codex_dir" ] || policy_conflict "refusing symlinked Codex policy directory: $codex_dir"
  [ ! -L "$rules_dir" ] || policy_conflict "refusing symlinked Codex rules directory: $rules_dir"
  [ ! -L "$rule_file" ] || policy_conflict "refusing symlinked Codex isolation policy: $rule_file"
  [ ! -L "$config_file" ] || policy_conflict "refusing symlinked Codex project config: $config_file"
  if [ -e "$codex_dir" ] && [ ! -d "$codex_dir" ]; then
    policy_conflict "Codex policy path is not a directory: $codex_dir"
  fi
  if [ -e "$rules_dir" ] && [ ! -d "$rules_dir" ]; then
    policy_conflict "Codex rules path is not a directory: $rules_dir"
  fi
  if [ -e "$config_file" ] && [ ! -f "$config_file" ]; then
    policy_conflict "Codex project config is not a regular file: $config_file"
  fi
  if [ -e "$rule_file" ]; then
    [ -f "$rule_file" ] || policy_conflict "Codex isolation policy is not a regular file: $rule_file"
    existing="$(cat "$rule_file" 2>/dev/null || true)"
    [ "$existing" = "$expected" ] || policy_conflict \
      "refusing to overwrite a differing Codex isolation policy: $rule_file"
  fi
}

run_execpolicy_probe() { # run_execpolicy_probe <rules-file> <label> <command...>
  local rules="$1" label="$2" check_output="" check_rc=0
  shift 2
  check_output="$(codex execpolicy check --rules "$rules" --resolve-host-executables -- "$@" 2>&1)" || check_rc=$?
  if [ "$check_rc" -ne 0 ] \
    || ! printf '%s' "$check_output" | jq -se 'length == 1 and .[0].decision == "forbidden"' >/dev/null 2>&1; then
    degrade_codex_isolation \
      "Codex execpolicy self-check failed for the $label; expected decision forbidden (exit $check_rc: $(oneline "$check_output"))"
    return 1
  fi
  return 0
}

acquire_policy_lock() {
  local timeout_ms="${JUTSU_POLICY_LOCK_TIMEOUT_MS:-10000}" waited=0 step_ms=50 status=5 holder=""
  case "$timeout_ms" in ''|*[!0-9]*) timeout_ms=10000 ;; esac
  POLICY_LOCK_DIR="$CWD/.herdr-jutsu-policy.lock"
  while [ "$waited" -le "$timeout_ms" ]; do
    if [ ! -e "$POLICY_LOCK_DIR" ] && [ ! -L "$POLICY_LOCK_DIR" ]; then
      POLICY_LOCK_INTENT=1
      if mkdir "$POLICY_LOCK_DIR" 2>/dev/null; then
        POLICY_LOCK_HELD=1
        POLICY_LOCK_INTENT=0
        # record the holder so a later spawn can tell a crashed holder from a live one
        printf '%s\n' "$$" >"$POLICY_LOCK_DIR/pid" 2>/dev/null || true
        return 0
      fi
      POLICY_LOCK_INTENT=0
    elif [ -d "$POLICY_LOCK_DIR" ] && [ ! -L "$POLICY_LOCK_DIR" ]; then
      # Stale-lock recovery: a holder killed with SIGKILL (or a crash) can never run its
      # trap. Break the lock only when the RECORDED holder is provably gone; a lock with no
      # readable pid is left alone (it may be mid-creation) and simply times out.
      holder=""
      [ ! -f "$POLICY_LOCK_DIR/pid" ] || [ -L "$POLICY_LOCK_DIR/pid" ] \
        || holder="$(head -n1 "$POLICY_LOCK_DIR/pid" 2>/dev/null | tr -cd '0-9')"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
        rm -f "$POLICY_LOCK_DIR/pid" 2>/dev/null || true
        rmdir "$POLICY_LOCK_DIR" 2>/dev/null || true
        continue
      fi
    fi
    [ "$waited" -lt "$timeout_ms" ] || break
    sleep 0.05
    waited=$((waited + step_ms))
  done
  [ "$TRAP_ARMED" -eq 0 ] || status=1
  fail isolation_policy_lock_timeout \
    "timed out after ${timeout_ms}ms waiting for the Codex policy lock in target cwd: $POLICY_LOCK_DIR (held by pid ${holder:-unknown}). If no jutsu-spawn is running for that directory, remove it: rm -f '$POLICY_LOCK_DIR/pid'; rmdir '$POLICY_LOCK_DIR'" "$status"
}

install_codex_policy() {
  local herdr_path rules_content existing
  local git_top exclude exclude_dir codex_dir rules_dir

  [ "$KIND" = codex ] || return 0
  [ "$NO_ISOLATION" -eq 0 ] || return 0

  herdr_path="$(command -v herdr 2>/dev/null || true)"
  if [ -z "$herdr_path" ]; then
    degrade_codex_isolation "could not resolve the herdr executable for the Codex deny policy"
    return 0
  fi
  rules_content="$(codex_rules_content "$herdr_path")"

  POLICY_CONFIG_FILE="$CWD/.codex/config.toml"
  POLICY_RULE_FILE="$CWD/.codex/rules/herdr-jutsu-deny.rules"
  codex_dir="$CWD/.codex"
  rules_dir="$codex_dir/rules"
  validate_policy_paths "$CWD" "$rules_content"

  if [ ! -d "$codex_dir" ]; then
    POLICY_CODEX_DIR_INTENT=1
    if mkdir "$codex_dir" 2>/dev/null; then
      POLICY_CODEX_DIR_CREATED=1
      POLICY_CODEX_DIR_INTENT=0
    else
      POLICY_CODEX_DIR_INTENT=0
      validate_policy_paths "$CWD" "$rules_content"
      [ -d "$codex_dir" ] || { degrade_codex_isolation "could not create $codex_dir"; return 0; }
    fi
  fi
  if [ ! -d "$rules_dir" ]; then
    POLICY_RULES_DIR_INTENT=1
    if mkdir "$rules_dir" 2>/dev/null; then
      POLICY_RULES_DIR_CREATED=1
      POLICY_RULES_DIR_INTENT=0
    else
      POLICY_RULES_DIR_INTENT=0
      validate_policy_paths "$CWD" "$rules_content"
      [ -d "$rules_dir" ] || { degrade_codex_isolation "could not create $rules_dir"; return 0; }
    fi
  fi

  if [ ! -e "$POLICY_CONFIG_FILE" ]; then
    POLICY_CONFIG_INTENT=1
    if ( set -o noclobber; umask 077; printf '%s\n' \
      '# Created by herdr-jutsu so Codex discovers the child-only project policy.' \
      >"$POLICY_CONFIG_FILE" ) 2>/dev/null; then
      POLICY_CONFIG_CREATED=1
      POLICY_CONFIG_INTENT=0
    else
      POLICY_CONFIG_INTENT=0
      validate_policy_paths "$CWD" "$rules_content"
      [ -f "$POLICY_CONFIG_FILE" ] \
        || { degrade_codex_isolation "could not create $POLICY_CONFIG_FILE"; return 0; }
    fi
  fi

  if [ -e "$POLICY_RULE_FILE" ]; then
    existing="$(cat "$POLICY_RULE_FILE" 2>/dev/null || true)"
    if [ "$existing" != "$rules_content" ]; then
      fail isolation_policy_conflict \
        "refusing to overwrite a differing Codex isolation policy: $POLICY_RULE_FILE" 5
    fi
  else
    POLICY_RULE_INTENT=1
    if ( set -o noclobber; umask 077; printf '%s\n' "$rules_content" \
      >"$POLICY_RULE_FILE" ) 2>/dev/null; then
      POLICY_RULE_CREATED=1
      POLICY_RULE_INTENT=0
    else
      POLICY_RULE_INTENT=0
      validate_policy_paths "$CWD" "$rules_content"
      [ -f "$POLICY_RULE_FILE" ] \
        || { degrade_codex_isolation "could not create $POLICY_RULE_FILE"; return 0; }
    fi
  fi

  if command -v codex >/dev/null 2>&1; then
    run_execpolicy_probe "$POLICY_RULE_FILE" "bare herdr invocation" \
      herdr agent prompt x y || return 0
    run_execpolicy_probe "$POLICY_RULE_FILE" "absolute herdr invocation" \
      "$herdr_path" agent prompt x y || return 0
    run_execpolicy_probe "$POLICY_RULE_FILE" "different herdr command group" \
      herdr workspace list || return 0
  fi

  git_top="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$git_top" ]; then
    exclude="$(git -C "$CWD" rev-parse --git-path info/exclude 2>/dev/null || true)"
    if [ -n "$exclude" ]; then
      case "$exclude" in /*) ;; *) exclude="$CWD/$exclude" ;; esac
      POLICY_EXCLUDE_FILE="$exclude"
      exclude_dir="$(dirname "$exclude")"
      if [ -L "$exclude_dir" ]; then
        CODEX_EXCLUDE_NOTE="; git exclude entry was NOT added because the info directory is symlinked: $exclude_dir"
      elif [ -L "$exclude" ]; then
        CODEX_EXCLUDE_NOTE="; git exclude entry was NOT added because info/exclude is symlinked: $exclude"
      elif [ ! -d "$exclude_dir" ]; then
        degrade_codex_isolation "could not add the child policy to git info/exclude because the info directory is missing: $exclude_dir"
        return 0
      elif [ ! -f "$exclude" ]; then
        degrade_codex_isolation "could not add the child policy to git info/exclude because the file is missing: $exclude"
        return 0
      elif ! append_exclude_once "$exclude" '.codex/rules/herdr-jutsu-deny.rules' rule; then
        degrade_codex_isolation "could not add the child policy to git info/exclude: $exclude"
        return 0
      elif [ "$POLICY_CONFIG_CREATED" -eq 1 ]; then
        if ! append_exclude_once "$exclude" '.codex/config.toml' config; then
          degrade_codex_isolation "could not add the launcher-created config to git info/exclude: $exclude"
          return 0
        fi
      fi
    fi
  fi

  OUTBOUND_ISOLATION="enforced_if_trusted"
  if command -v codex >/dev/null 2>&1; then
    ISOLATION_DETAIL="Codex project deny policy passed three resolved-host execpolicy self-checks and -a never is active; the policy loads only when Codex trusts the target repository$CODEX_PROFILE_NOTE$CODEX_EXCLUDE_NOTE"
  else
    ISOLATION_DETAIL="Codex project deny policy and -a never are active; codex was not on PATH for a static check, and the policy loads only when Codex trusts the target repository$CODEX_PROFILE_NOTE$CODEX_EXCLUDE_NOTE"
  fi
}

# ---------------------------------------------------------------------------------------
# placement
# ---------------------------------------------------------------------------------------
if [ "$KIND" = codex ] && [ "$NO_ISOLATION" -eq 0 ] \
  && [ -z "$WORKTREE" ] && [ -z "$IN_PANE" ]; then
  POLICY_HERDR_PATH="$(command -v herdr 2>/dev/null || true)"
  if [ -n "$POLICY_HERDR_PATH" ]; then
    validate_policy_paths "$CWD" "$(codex_rules_content "$POLICY_HERDR_PATH")"
  fi
fi

if [ -n "$WORKTREE" ]; then
  # Pin the base explicitly so the branch point is the caller's HEAD, not whatever herdr defaults to.
  if [ -z "$BASE" ]; then
    BASE="$(git -C "$CWD" rev-parse HEAD 2>/dev/null || true)"
    [ -n "$BASE" ] || fail base_ref_unresolved "could not resolve HEAD in $CWD for --worktree" 1
  fi
  if [ "$KIND" = codex ] && [ "$NO_ISOLATION" -eq 0 ]; then
    POLICY_HERDR_PATH="$(command -v herdr 2>/dev/null || true)"
    if [ -n "$POLICY_HERDR_PATH" ] \
      && git -C "$CWD" cat-file -e "$BASE:.codex/rules/herdr-jutsu-deny.rules" 2>/dev/null; then
      BASE_POLICY="$(git -C "$CWD" show "$BASE:.codex/rules/herdr-jutsu-deny.rules" 2>/dev/null || true)"
      EXPECTED_POLICY="$(codex_rules_content "$POLICY_HERDR_PATH")"
      [ "$BASE_POLICY" = "$EXPECTED_POLICY" ] || policy_conflict \
        "base ref $BASE tracks a differing Codex isolation policy; refusing to create the worktree"
    fi
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
  PANE_CWD="$(jq -r '.result.pane.cwd // empty' <<<"$R")"
  [ -n "$PANE_ID" ] || fail unknown_anchor "--in-pane $IN_PANE: no pane id in herdr's response" 2
  [ -n "$PANE_CWD" ] || fail pane_cwd_unresolved \
    "--in-pane $IN_PANE: herdr pane get returned no cwd; refusing to install policy in the caller's cwd" 1
  CWD="$PANE_CWD"
  if [ "$KIND" = codex ] && [ "$NO_ISOLATION" -eq 0 ]; then
    POLICY_HERDR_PATH="$(command -v herdr 2>/dev/null || true)"
    if [ -n "$POLICY_HERDR_PATH" ]; then
      validate_policy_paths "$CWD" "$(codex_rules_content "$POLICY_HERDR_PATH")"
    fi
  fi
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

# Install child-only outbound isolation only after placement has resolved the target cwd,
# and before the agent process starts. With --in-pane this is the cwd reported by herdr,
# not the launcher's own $PWD or a caller-supplied --cwd.
if [ "$KIND" = codex ] && [ "$NO_ISOLATION" -eq 0 ]; then acquire_policy_lock; fi
install_codex_policy

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
  ARGS+=(${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"})
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

# The member now EXISTS (started, or retained as agent_not_ready). Disarm the rollback
# BEFORE any further bookkeeping: from here on a signal or a failing jq/registry write must
# never delete the policy layer a live member depends on, nor close its pane. The trap still
# releases the lock (release is independent of TRAP_ARMED).
TRAP_ARMED=0

# A Codex policy lock covers installation, agent start, and failure rollback. Successful
# and retained starts release it here; other failures exit through the trap, which rolls
# back first and releases second.
release_policy_lock

# resume_args: the kind-specific argv that would revive this member.
if [ -n "$SESSION_ID" ] && [ "$KIND" = claude ]; then
  RESUME_JSON="$(jq -cn --arg s "$SESSION_ID" '["--resume", $s]')"
elif [ -n "$SESSION_ID" ] && [ "$KIND" = codex ]; then
  RESUME_JSON="$(jq -cn --arg s "$SESSION_ID" '["resume", $s]')"
fi

LINE="$(build_line "$STATUS")"
append_registry "$LINE"
printf '%s\n' "$LINE"

if [ "$STATUS" = agent_not_ready ]; then
  # exit 3: the member is retained and registered, but is not ready (startup dialog).
  emit_error agent_not_ready \
    "$NAME was created and registered but is not ready (startup dialog); handle it as a blocked member"
  exit 3
fi
exit 0
