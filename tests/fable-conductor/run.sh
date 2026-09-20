#!/bin/bash
# tests/fable-conductor/run.sh — offline behavioural suite for the Codex implementer adapter.
#
# Plain bash 3.2, no framework. Every case runs in its own `mktemp -d` scratch with its own
# HOME, TMPDIR, CODEX_HOME, adapter root and PATH farm.
#
# SAFETY: the suite must NEVER reach a real `codex` or `herdr`. Before any case runs it builds
# a symlink farm and requires both names to resolve inside it (else exit 99). Each stub records
# its call; a stub invoked with no FC_STUB_STATE appends to $FC_SENTINEL_FILE, and a non-empty
# sentinel file fails the suite at the end.
#
#   /bin/bash tests/fable-conductor/run.sh [--only <group>[,<group>...]] [--list]
#
# Exit: 0 all pass · 1 at least one failure · 99 safety gate.
set -u

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SUITE_DIR/../.." && pwd)"
ORIG_TMPDIR="${TMPDIR:-/tmp}"
SUITE_PATH="$PATH"
REAL_JQ="$(command -v jq 2>/dev/null || true)"
REAL_GIT="$(command -v git 2>/dev/null || true)"

ONLY=""
LIST=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --list) LIST=1; shift ;;
    *) echo "usage: run.sh [--only <group>[,<group>...]] [--list]" >&2; exit 99 ;;
  esac
done

if [ -z "$REAL_JQ" ] || [ -z "$REAL_GIT" ]; then
  echo "FATAL: jq and git are required" >&2
  exit 99
fi

# --- SAFETY gate --------------------------------------------------------------------------
GATE_DIR="$(TMPDIR="$ORIG_TMPDIR" mktemp -d)"
mkdir -p "$GATE_DIR/bin"
ln -s "$SUITE_DIR/stub/codex" "$GATE_DIR/bin/codex"
ln -s "$SUITE_DIR/stub/herdr" "$GATE_DIR/bin/herdr"
gate_check() {
  local name resolved
  for name in codex herdr; do
    resolved="$(PATH="$GATE_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin" command -v "$name" 2>/dev/null || true)"
    case "$resolved" in
      "$GATE_DIR"/bin/*) ;;
      *)
        echo "FATAL: '$name' resolves to '${resolved:-<not found>}', not the suite farm — refusing to run" >&2
        rm -rf "$GATE_DIR"
        exit 99
        ;;
    esac
  done
}
gate_check
rm -rf "$GATE_DIR"

for f in "$SUITE_DIR/stub/codex" "$SUITE_DIR/stub/herdr"; do
  if [ ! -x "$f" ]; then
    echo "FATAL: stub not executable: $f" >&2
    exit 99
  fi
done

FC_SENTINEL_FILE="$(TMPDIR="$ORIG_TMPDIR" mktemp)"
export FC_SENTINEL_FILE
: >"$FC_SENTINEL_FILE"

# --- load ---------------------------------------------------------------------------------
. "$SUITE_DIR/lib.sh"

# A case file that fails to parse must abort the run, never be skipped. Sourcing a broken
# file leaves its tests undefined while the suite still reports ALL PASS on a smaller
# count — silent loss of coverage, which is worse than a red run.
for f in $(ls "$SUITE_DIR/cases"/*.sh 2>/dev/null | LC_ALL=C sort); do
  if ! parse_err="$(bash -n "$f" 2>&1)"; then
    printf 'bail out: %s does not parse\n%s\n' "$f" "$parse_err" >&2
    exit 2
  fi
  if ! . "$f"; then
    printf 'bail out: %s failed to load\n' "$f" >&2
    exit 2
  fi
done

want_group() {
  [ -n "$ONLY" ] || return 0
  local g
  local IFS=,
  for g in $ONLY; do
    [ "$g" != "$1" ] || return 0
  done
  return 1
}

TESTS="$(declare -F | sed -n 's/^declare -f \(test_[A-Za-z0-9_]*\)$/\1/p' | LC_ALL=C sort)"

SELECTED=""
for t in $TESTS; do
  g="${t#test_}"
  g="${g%%_*}"
  if want_group "$g"; then SELECTED="$SELECTED $t"; fi
done

if [ "$LIST" = 1 ]; then
  for t in $SELECTED; do echo "$t"; done
  rm -f "$FC_SENTINEL_FILE"
  exit 0
fi

for t in $SELECTED; do
  CURRENT_TEST="$t"
  "$t"
done

TOTAL=$((PASS + FAIL))
if [ -s "$FC_SENTINEL_FILE" ]; then
  not_ok "sentinel" "a stub was reached outside a case: $(head -n 1 "$FC_SENTINEL_FILE")"
  TOTAL=$((PASS + FAIL))
fi
rm -f "$FC_SENTINEL_FILE"

if [ "$FAIL" = 0 ]; then
  echo "ALL PASS ($TOTAL tests)"
  exit 0
fi
echo "FAILED ($FAIL of $TOTAL)"
exit 1
