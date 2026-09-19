#!/usr/bin/env bash
# codex-install-check.sh — prove a plugin in this repo installs into the Codex CLI.
#
# Registers this repo's Codex catalog (.agents/plugins/marketplace.json) as a
# local marketplace inside a throwaway CODEX_HOME, installs each named plugin,
# and checks the installed copy: at least one SKILL.md, and an installed
# manifest version equal to the repo's Claude manifest version.
#
# The owner's real ~/.codex is never written. Every codex call goes through
# scripts/codex-disposable.sh, and the real config.toml is checksummed before
# and after as a tripwire. Bash 3.2 compatible.
#
#   scripts/codex-install-check.sh fable-mode
#   KEEP_CODEX_HOME=1 scripts/codex-install-check.sh fable-mode   # keep the home
set -eu

CATALOG_NAME="dmokong-plugins"

die() { printf 'codex-install-check: %s\n' "$*" >&2; exit 64; }

[ $# -ge 1 ] || die "usage: codex-install-check.sh <plugin> [<plugin> ...]"

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
disposable="$script_dir/codex-disposable.sh"

[ -x "$disposable" ] || die "missing or non-executable $disposable"
[ -f "$repo_root/.agents/plugins/marketplace.json" ] \
  || die "missing $repo_root/.agents/plugins/marketplace.json"
command -v jq >/dev/null 2>&1 || die "jq not found on PATH"

# Tripwire: the real config.toml must be untouched by this run.
real_config="$HOME/.codex/config.toml"
tripwire_before=""
if [ -f "$real_config" ]; then
  tripwire_before="$(shasum "$real_config" | awk '{print $1}')"
fi

CODEX_HOME="$(mktemp -d "${TMPDIR:-/tmp}/codex-install-check.XXXXXX")"
export CODEX_HOME

cleanup() {
  if [ "${KEEP_CODEX_HOME:-0}" = "1" ]; then
    printf 'kept CODEX_HOME=%s\n' "$CODEX_HOME"
  else
    rm -rf "$CODEX_HOME"
  fi
}
trap cleanup EXIT

failures=0

if ! add_out="$("$disposable" plugin marketplace add "$repo_root" 2>&1)"; then
  printf 'FAIL marketplace: %s\n' "$(printf '%s' "$add_out" | tr '\n' ' ')"
  failures=$((failures + 1))
fi

if [ "$failures" -eq 0 ]; then
  for plugin in "$@"; do
    claude_manifest="$repo_root/plugins/$plugin/.claude-plugin/plugin.json"
    if [ ! -f "$claude_manifest" ]; then
      printf 'FAIL %s: no %s\n' "$plugin" "plugins/$plugin/.claude-plugin/plugin.json"
      failures=$((failures + 1))
      continue
    fi
    want_version="$(jq -r '.version // empty' "$claude_manifest")"
    if [ -z "$want_version" ]; then
      printf 'FAIL %s: Claude manifest has no version\n' "$plugin"
      failures=$((failures + 1))
      continue
    fi

    if ! add_out="$("$disposable" plugin add "$plugin@$CATALOG_NAME" 2>&1)"; then
      printf 'FAIL %s: plugin add failed: %s\n' \
        "$plugin" "$(printf '%s' "$add_out" | tr '\n' ' ')"
      failures=$((failures + 1))
      continue
    fi

    installed_root="$CODEX_HOME/plugins/cache/$CATALOG_NAME/$plugin/$want_version"
    if [ ! -d "$installed_root" ]; then
      got="$(ls "$CODEX_HOME/plugins/cache/$CATALOG_NAME/$plugin" 2>/dev/null | tr '\n' ' ')"
      printf 'FAIL %s: expected installed version %s, cache holds: %s\n' \
        "$plugin" "$want_version" "${got:-nothing}"
      failures=$((failures + 1))
      continue
    fi

    skill_count="$(find "$installed_root" -name SKILL.md -type f | wc -l | tr -d ' ')"
    if [ "$skill_count" -lt 1 ]; then
      printf 'FAIL %s: installed copy contains no SKILL.md\n' "$plugin"
      failures=$((failures + 1))
      continue
    fi

    listed_version="$("$disposable" plugin list --json 2>/dev/null \
      | jq -r --arg p "$plugin" '.installed[]? | select(.name == $p) | .version' \
      | head -1)"
    if [ "$listed_version" != "$want_version" ]; then
      printf 'FAIL %s: codex reports version %s, repo says %s\n' \
        "$plugin" "${listed_version:-none}" "$want_version"
      failures=$((failures + 1))
      continue
    fi

    printf 'PASS %s %s\n' "$plugin" "$want_version"
  done
fi

if [ -n "$tripwire_before" ]; then
  tripwire_after="$(shasum "$real_config" | awk '{print $1}')"
  if [ "$tripwire_before" != "$tripwire_after" ]; then
    printf 'FAIL tripwire: real config.toml changed (%s -> %s)\n' \
      "$tripwire_before" "$tripwire_after"
    failures=$((failures + 1))
  fi
fi

[ "$failures" -eq 0 ] || exit 1
exit 0
