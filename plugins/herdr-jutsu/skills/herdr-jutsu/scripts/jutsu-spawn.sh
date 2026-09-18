#!/usr/bin/env bash
# jutsu-spawn.sh — create one herdr crew member (shell pane, claude agent, or codex agent)
# and stamp ONE name on every surface: herdr agent name, pane label, Claude session name.
# Prints a single JSON line describing the member and appends it to the stream registry.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: jutsu-spawn.sh --name <stream>-<role> --kind claude|codex|shell [options] [-- <native agent args>]

Placement (pick one; default --where pane):
  --where pane|tab|workspace   sibling pane of the caller (default), new tab, or new workspace
  --worktree BRANCH            new git worktree + its own herdr workspace (implies isolation)
  --base REF                   base ref for --worktree (default: current HEAD)
  --in-pane PANE_ID            reuse an existing idle shell pane instead of creating one
  --beside PANE_ID|NAME        split next to another pane/agent instead of the caller

Options:
  --direction right|down       split direction (default: auto from caller pane geometry)
  --ratio FLOAT                split ratio for the new pane
  --cwd PATH                   working directory (default: $PWD; ignored with --worktree)
  --stream NAME                registry/stream label (default: text before the first '-' in --name)
  --issue ID                   tracker issue id recorded in the registry
  --cmd "COMMAND"              kind=shell only: command to run in the pane
  --timeout MS                 agent start timeout (default 60000)
  --focus                      focus the new location (default: --no-focus)

kind=claude auto-adds `-n <name>` so ListAgents/SendMessage address == herdr agent name.
Everything after `--` goes to the agent binary verbatim (model, effort, permissions...).
Registry: ${JUTSU_STATE_DIR:-~/.local/state/herdr-jutsu}/<stream>.jsonl
EOF
}

die() { printf '{"error":"%s"}\n' "$1" >&2; exit 1; }

[ "${HERDR_ENV:-}" = 1 ] || die "not inside herdr (HERDR_ENV!=1); refusing to drive a session from outside"
command -v jq >/dev/null || die "jq is required"

NAME="" KIND="" WHERE="pane" WORKTREE="" BASE="" IN_PANE="" BESIDE="" DIRECTION="" RATIO=""
CWD="$PWD" STREAM="" ISSUE="" CMD="" TIMEOUT=60000 FOCUS="--no-focus"
AGENT_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --kind) KIND="$2"; shift 2 ;;
    --where) WHERE="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --in-pane) IN_PANE="$2"; shift 2 ;;
    --beside) BESIDE="$2"; shift 2 ;;
    --direction) DIRECTION="$2"; shift 2 ;;
    --ratio) RATIO="$2"; shift 2 ;;
    --cwd) CWD="$2"; shift 2 ;;
    --stream) STREAM="$2"; shift 2 ;;
    --issue) ISSUE="$2"; shift 2 ;;
    --cmd) CMD="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --focus) FOCUS="--focus"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; AGENT_ARGS=("$@"); break ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ "$NAME" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "--name must match [a-z][a-z0-9_-]{0,31} (herdr agent-name rule)"
case "$KIND" in claude|codex|shell) ;; *) die "--kind must be claude, codex, or shell" ;; esac
[ -n "$STREAM" ] || STREAM="${NAME%%-*}"

# A live agent already holding this name would make SendMessage/agent targets ambiguous.
if herdr agent list | jq -e --arg n "$NAME" '.result.agents[] | select(.name == $n)' >/dev/null; then
  die "a live herdr agent is already named $NAME"
fi

WORKSPACE_ID="" TAB_ID="" PANE_ID="" WT_PATH="" WT_BRANCH=""

if [ -n "$WORKTREE" ]; then
  # Pin the base explicitly so the branch point is the caller's HEAD, not whatever herdr defaults to.
  [ -n "$BASE" ] || BASE="$(git -C "$CWD" rev-parse HEAD)"
  R=$(herdr worktree create --cwd "$CWD" --branch "$WORKTREE" --base "$BASE" --label "$STREAM" $FOCUS)
  WORKSPACE_ID=$(jq -r '.result.workspace.workspace_id' <<<"$R")
  TAB_ID=$(jq -r '.result.tab.tab_id' <<<"$R")
  PANE_ID=$(jq -r '.result.root_pane.pane_id' <<<"$R")
  WT_PATH=$(jq -r '.result.worktree.path' <<<"$R")
  WT_BRANCH=$(jq -r '.result.worktree.branch' <<<"$R")
  CWD="$WT_PATH"
  herdr tab rename "$TAB_ID" "$NAME" >/dev/null
elif [ -n "$IN_PANE" ]; then
  R=$(herdr pane get "$IN_PANE")
  PANE_ID=$(jq -r '.result.pane.pane_id' <<<"$R")
  TAB_ID=$(jq -r '.result.pane.tab_id' <<<"$R")
  WORKSPACE_ID=$(jq -r '.result.pane.workspace_id' <<<"$R")
else
  case "$WHERE" in
    workspace)
      R=$(herdr workspace create --cwd "$CWD" --label "$STREAM" $FOCUS)
      WORKSPACE_ID=$(jq -r '.result.workspace.workspace_id' <<<"$R")
      TAB_ID=$(jq -r '.result.tab.tab_id' <<<"$R")
      PANE_ID=$(jq -r '.result.root_pane.pane_id' <<<"$R")
      herdr tab rename "$TAB_ID" "$NAME" >/dev/null
      ;;
    tab)
      R=$(herdr tab create --workspace "${HERDR_WORKSPACE_ID}" --cwd "$CWD" --label "$NAME" $FOCUS)
      TAB_ID=$(jq -r '.result.tab.tab_id' <<<"$R")
      PANE_ID=$(jq -r '.result.root_pane.pane_id' <<<"$R")
      WORKSPACE_ID=$(jq -r '.result.root_pane.workspace_id' <<<"$R")
      ;;
    pane)
      ANCHOR="${HERDR_PANE_ID}"
      if [ -n "$BESIDE" ]; then
        ANCHOR=$(herdr agent get "$BESIDE" 2>/dev/null | jq -r '.result.agent.pane_id // empty')
        [ -n "$ANCHOR" ] || ANCHOR="$BESIDE"
      fi
      if [ -z "$DIRECTION" ]; then
        # Wide pane -> split right; narrow/tall -> split down. Cells are ~2x taller than wide.
        DIRECTION=$(herdr pane layout --pane "$ANCHOR" 2>/dev/null \
          | jq -r --arg p "$ANCHOR" '(.result.layout.panes[] | select(.pane_id == $p) | .rect) as $r
              | if ($r.width >= 2.4 * $r.height and $r.width >= 160) then "right" else "down" end' 2>/dev/null || true)
        [ -n "$DIRECTION" ] || DIRECTION="down"
      fi
      SPLIT=(herdr pane split "$ANCHOR" --direction "$DIRECTION" --cwd "$CWD" $FOCUS)
      [ -z "$RATIO" ] || SPLIT+=(--ratio "$RATIO")
      R=$("${SPLIT[@]}")
      PANE_ID=$(jq -r '.result.pane.pane_id' <<<"$R")
      TAB_ID=$(jq -r '.result.pane.tab_id' <<<"$R")
      WORKSPACE_ID=$(jq -r '.result.pane.workspace_id' <<<"$R")
      ;;
    *) die "--where must be pane, tab, or workspace" ;;
  esac
fi

[ -n "$PANE_ID" ] && [ "$PANE_ID" != null ] || die "could not resolve a pane id from herdr's response"
herdr pane rename "$PANE_ID" "$NAME" >/dev/null

SESSION_ID="" STATUS="" START_ERR=""
if [ "$KIND" = shell ]; then
  [ -z "$CMD" ] || herdr pane run "$PANE_ID" "$CMD" >/dev/null
  STATUS="shell"
else
  ARGS=()
  [ "$KIND" != claude ] || ARGS+=(-n "$NAME")
  ARGS+=(${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"})
  START=(herdr agent start "$NAME" --kind "$KIND" --pane "$PANE_ID" --timeout "$TIMEOUT")
  [ ${#ARGS[@]} -eq 0 ] || START+=(-- "${ARGS[@]}")
  if R=$("${START[@]}" 2>&1); then
    SESSION_ID=$(jq -r '.result.agent.agent_session.value // empty' <<<"$R")
    STATUS=$(jq -r '.result.agent.agent_status // "unknown"' <<<"$R")
  else
    # agent_not_ready keeps the name: the member exists but is blocked at startup (trust/login dialog).
    START_ERR=$(jq -r '.error.code // "agent_start_failed"' <<<"$R" 2>/dev/null || echo agent_start_failed)
    STATUS="$START_ERR"
  fi
fi

PARENT=$(herdr agent list | jq -r --arg p "${HERDR_PANE_ID}" '.result.agents[] | select(.pane_id == $p) | .name // empty')

STATE_DIR="${JUTSU_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-jutsu}"
mkdir -p "$STATE_DIR"
LINE=$(jq -cn \
  --arg name "$NAME" --arg kind "$KIND" --arg stream "$STREAM" --arg issue "$ISSUE" \
  --arg pane "$PANE_ID" --arg tab "$TAB_ID" --arg ws "$WORKSPACE_ID" --arg cwd "$CWD" \
  --arg wt "$WT_PATH" --arg branch "$WT_BRANCH" --arg session "$SESSION_ID" --arg status "$STATUS" \
  --arg parent "$PARENT" --arg parent_pane "${HERDR_PANE_ID}" --arg args "${AGENT_ARGS[*]-}" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{name:$name, kind:$kind, stream:$stream, issue:$issue, pane_id:$pane, tab_id:$tab, workspace_id:$ws,
    cwd:$cwd, worktree:$wt, branch:$branch, session_id:$session, status:$status,
    parent:$parent, parent_pane:$parent_pane, agent_args:$args, spawned_at:$at}')
echo "$LINE" >> "$STATE_DIR/$STREAM.jsonl"
echo "$LINE"
[ -z "$START_ERR" ] || exit 3
