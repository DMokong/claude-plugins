#!/usr/bin/env bash
# codex-disposable.sh — run the Codex CLI ONLY under a disposable CODEX_HOME.
#
# Every Codex-facing check in this repo goes through this wrapper. It refuses
# to run unless CODEX_HOME is set, exists, and is provably not the owner's real
# ~/.codex (nor inside it, nor containing it), and refuses a home that holds a
# copy of the real auth.json. Bash 3.2 compatible.
#
#   export CODEX_HOME="$(mktemp -d)"
#   scripts/codex-disposable.sh plugin marketplace add "$PWD"
set -eu

die() { printf 'codex-disposable: %s\n' "$*" >&2; exit 64; }

[ -n "${CODEX_HOME:-}" ] || die "CODEX_HOME is not set — export CODEX_HOME=\"\$(mktemp -d)\" first"
[ -d "$CODEX_HOME" ] || die "CODEX_HOME=$CODEX_HOME is not a directory"

home_real="$(cd "$CODEX_HOME" && pwd -P)"
owner_real=""
if [ -d "$HOME/.codex" ]; then
  owner_real="$(cd "$HOME/.codex" && pwd -P)"
fi

if [ -n "$owner_real" ]; then
  case "$home_real/" in
    "$owner_real/"*) die "CODEX_HOME resolves to or inside the real $owner_real — refusing" ;;
  esac
  case "$owner_real/" in
    "$home_real/"*) die "CODEX_HOME contains the real $owner_real — refusing" ;;
  esac
  if [ -f "$home_real/auth.json" ] && [ -f "$owner_real/auth.json" ] \
     && cmp -s "$home_real/auth.json" "$owner_real/auth.json"; then
    die "CODEX_HOME holds a copy of the real auth.json — refusing (never copy credentials)"
  fi
fi

command -v codex >/dev/null 2>&1 || die "codex CLI not found on PATH"

export CODEX_HOME="$home_real"
exec codex "$@"
