#!/bin/bash
# codex-policy.sh <canonical-checkout>
#
# Fail-closed installer/prober of the child-only Codex deny layer for one checkout. It
# reproduces byte-for-byte the managed files the herdr-jutsu launcher writes, adds `.codex/`
# to the checkout's git exclude file, and proves with three `codex execpolicy check` probes
# that invoking `herdr` is FORBIDDEN. There is no degrade path: any failure exits non-zero
# with a cause-coded JSON error object on stderr and nothing on stdout.
#
# NO ROLLBACK: a failure after the first write leaves the managed files in place. They are
# correct bytes, so a later run with a healthy environment simply succeeds; nothing is undone.
#
# Success: exit 0, one JSON line on stdout, stderr empty.
# Failure: exit 2 for `usage`, exit 1 for every other cause; one JSON line on stderr.
#
# This script never reads HERDR_ENV and never EXECUTES herdr — it only resolves its path.

umask 077
set -u

FC_RULES_BASENAME="herdr-jutsu-deny.rules"
FC_CONFIG_LINE='# Created by herdr-jutsu so Codex discovers the child-only project policy.'
FC_EXCLUDE_LINE='.codex/'

fc_die() { # fc_die <cause> <path-or-empty> <message> [exit-code]
  jq -c -n --arg cause "$1" --arg path "$2" --arg message "$3" \
    '{ok:false, cause:$cause}
     + (if $path == "" then {} else {path:$path} end)
     + {message:$message}' >&2
  exit "${4:-1}"
}

fc_digest() { shasum -a 256 "$1" | cut -d' ' -f1; }

# The rules file, byte for byte: two physical lines, LF after each. Ground truth is
# `codex_rules_content` in the herdr-jutsu launcher.
fc_rules_bytes() { # fc_rules_bytes <herdr-path>
  local escaped
  escaped="$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '%s\n' "host_executable(name=\"herdr\", paths=[\"$escaped\"])"
  printf '%s\n' 'prefix_rule(pattern=["herdr"], decision="forbidden", justification="Crew members do not drive herdr; the parent pulls from this pane.")'
}

# ---------------------------------------------------------------------------------------
# Preflight — every cause is decided BEFORE anything is written.
# ---------------------------------------------------------------------------------------

[ "$#" -eq 1 ] || fc_die usage "" "expected exactly one positional argument: the canonical checkout" 2

CHECKOUT_ARG="$1"

command -v codex >/dev/null 2>&1 || fc_die codex_missing "" "codex is not on PATH"

HERDR_PATH="$(command -v herdr 2>/dev/null || true)"
case "$HERDR_PATH" in
  /*) ;;
  *) fc_die herdr_missing "" "herdr is not on PATH as an absolute executable" ;;
esac

case "$CHECKOUT_ARG" in
  /*) ;;
  *) fc_die path_relative "$CHECKOUT_ARG" "the checkout must be an absolute path" ;;
esac
[ -d "$CHECKOUT_ARG" ] || fc_die path_absent "$CHECKOUT_ARG" "the checkout does not exist or is not a directory"

CANON="$(cd -P -- "$CHECKOUT_ARG" 2>/dev/null && pwd -P)" || CANON=""
[ -n "$CANON" ] || fc_die path_absent "$CHECKOUT_ARG" "the checkout could not be resolved"
[ "$CANON" = "$CHECKOUT_ARG" ] || fc_die path_noncanonical "$CHECKOUT_ARG" "the checkout is not spelled canonically (canonical: $CANON)"

CHECKOUT="$CANON"

TOP="$(git -C "$CHECKOUT" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$TOP" ] || fc_die not_toplevel "$CHECKOUT" "not inside a git working tree"
TOP_CANON="$(cd -P -- "$TOP" 2>/dev/null && pwd -P)" || TOP_CANON=""
[ "$TOP_CANON" = "$CHECKOUT" ] || fc_die not_toplevel "$CHECKOUT" "not the top level of its working tree (top level: ${TOP_CANON:-unknown})"

CODEX_DIR="$CHECKOUT/.codex"
RULES_DIR="$CODEX_DIR/rules"
CONFIG_FILE="$CODEX_DIR/config.toml"
RULES_FILE="$RULES_DIR/$FC_RULES_BASENAME"

[ ! -L "$CODEX_DIR" ] || fc_die codex_dir_symlink "$CODEX_DIR" "refusing a symlinked Codex policy directory"
if [ -e "$CODEX_DIR" ] && [ ! -d "$CODEX_DIR" ]; then
  fc_die codex_dir_not_directory "$CODEX_DIR" "the Codex policy path is not a directory"
fi
[ ! -L "$RULES_DIR" ] || fc_die rules_dir_symlink "$RULES_DIR" "refusing a symlinked Codex rules directory"
if [ -e "$RULES_DIR" ] && [ ! -d "$RULES_DIR" ]; then
  fc_die rules_dir_not_directory "$RULES_DIR" "the Codex rules path is not a directory"
fi

# In a linked worktree `--git-path info/exclude` is the COMMON git dir's file, shared by every
# worktree of the repository.
EXCLUDE="$(git -C "$CHECKOUT" rev-parse --git-path info/exclude 2>/dev/null || true)"
[ -n "$EXCLUDE" ] || fc_die git_info_not_directory "$CHECKOUT" "git could not locate info/exclude"
case "$EXCLUDE" in /*) ;; *) EXCLUDE="$CHECKOUT/$EXCLUDE" ;; esac
INFO_DIR="${EXCLUDE%/*}"

[ ! -L "$INFO_DIR" ] || fc_die git_info_symlink "$INFO_DIR" "refusing a symlinked git info directory"
[ -d "$INFO_DIR" ] || fc_die git_info_not_directory "$INFO_DIR" "the git info directory is missing or is not a directory"

[ ! -L "$CONFIG_FILE" ] || fc_die config_symlink "$CONFIG_FILE" "refusing a symlinked Codex project config"
if [ -e "$CONFIG_FILE" ] && [ ! -f "$CONFIG_FILE" ]; then
  fc_die config_not_regular "$CONFIG_FILE" "the Codex project config is not a regular file"
fi
[ ! -L "$RULES_FILE" ] || fc_die rules_symlink "$RULES_FILE" "refusing a symlinked Codex isolation policy"
if [ -e "$RULES_FILE" ] && [ ! -f "$RULES_FILE" ]; then
  fc_die rules_not_regular "$RULES_FILE" "the Codex isolation policy is not a regular file"
fi
[ ! -L "$EXCLUDE" ] || fc_die exclude_symlink "$EXCLUDE" "refusing a symlinked git exclude file"
if [ -e "$EXCLUDE" ] && [ ! -f "$EXCLUDE" ]; then
  fc_die exclude_not_regular "$EXCLUDE" "the git exclude file is not a regular file"
fi

WANT_CONFIG="$FC_CONFIG_LINE"
WANT_RULES="$(fc_rules_bytes "$HERDR_PATH")"

if [ -f "$CONFIG_FILE" ]; then
  [ "$(cat "$CONFIG_FILE")" = "$WANT_CONFIG" ] \
    || fc_die config_differs "$CONFIG_FILE" "refusing to overwrite a differing Codex project config"
fi
if [ -f "$RULES_FILE" ]; then
  [ "$(cat "$RULES_FILE")" = "$WANT_RULES" ] \
    || fc_die rules_differs "$RULES_FILE" "refusing to overwrite a differing Codex isolation policy"
fi

# ---------------------------------------------------------------------------------------
# Install — write order: .codex/ -> .codex/rules/ -> config.toml -> rules -> exclude line.
# ---------------------------------------------------------------------------------------

INSTALLED_CONFIG=false
INSTALLED_RULES=false
INSTALLED_EXCLUDE=false

if [ ! -d "$CODEX_DIR" ]; then
  mkdir "$CODEX_DIR" 2>/dev/null || fc_die write_failed "$CODEX_DIR" "could not create the Codex policy directory"
  chmod 700 "$CODEX_DIR" 2>/dev/null || fc_die write_failed "$CODEX_DIR" "could not set mode 0700"
fi
if [ ! -d "$RULES_DIR" ]; then
  mkdir "$RULES_DIR" 2>/dev/null || fc_die write_failed "$RULES_DIR" "could not create the Codex rules directory"
  chmod 700 "$RULES_DIR" 2>/dev/null || fc_die write_failed "$RULES_DIR" "could not set mode 0700"
fi

if [ ! -f "$CONFIG_FILE" ]; then
  printf '%s\n' "$WANT_CONFIG" >"$CONFIG_FILE" 2>/dev/null \
    || fc_die write_failed "$CONFIG_FILE" "could not write the Codex project config"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || fc_die write_failed "$CONFIG_FILE" "could not set mode 0600"
  INSTALLED_CONFIG=true
fi

if [ ! -f "$RULES_FILE" ]; then
  printf '%s\n' "$WANT_RULES" >"$RULES_FILE" 2>/dev/null \
    || fc_die write_failed "$RULES_FILE" "could not write the Codex isolation policy"
  chmod 600 "$RULES_FILE" 2>/dev/null || fc_die write_failed "$RULES_FILE" "could not set mode 0600"
  INSTALLED_RULES=true
fi

if [ ! -f "$EXCLUDE" ]; then
  : >"$EXCLUDE" 2>/dev/null || fc_die write_failed "$EXCLUDE" "could not create the git exclude file"
  chmod 600 "$EXCLUDE" 2>/dev/null || fc_die write_failed "$EXCLUDE" "could not set mode 0600"
fi
if ! grep -Fxq "$FC_EXCLUDE_LINE" "$EXCLUDE" 2>/dev/null; then
  if [ -s "$EXCLUDE" ]; then
    if [ "$(tail -c 1 "$EXCLUDE"; printf 'X')" != "$(printf '\nX')" ]; then
      printf '\n' >>"$EXCLUDE" 2>/dev/null \
        || fc_die write_failed "$EXCLUDE" "could not terminate the last exclude line"
    fi
  fi
  printf '%s\n' "$FC_EXCLUDE_LINE" >>"$EXCLUDE" 2>/dev/null \
    || fc_die write_failed "$EXCLUDE" "could not append the policy exclude line"
  INSTALLED_EXCLUDE=true
fi

# ---------------------------------------------------------------------------------------
# Probes — each must exit 0 and print exactly one JSON value with decision "forbidden".
# ---------------------------------------------------------------------------------------

fc_probe() { # fc_probe <label> <command...>
  local label="$1" out rc=0
  shift
  out="$(codex execpolicy check --rules "$RULES_FILE" --resolve-host-executables -- "$@" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    fc_die probe_exit_nonzero "$RULES_FILE" "execpolicy probe '$label' exited $rc"
  fi
  if ! printf '%s' "$out" | jq -se 'length == 1' >/dev/null 2>&1; then
    fc_die probe_malformed "$RULES_FILE" "execpolicy probe '$label' did not print exactly one JSON value"
  fi
  if ! printf '%s' "$out" | jq -se 'length == 1 and .[0].decision == "forbidden"' >/dev/null 2>&1; then
    fc_die probe_not_forbidden "$RULES_FILE" "execpolicy probe '$label' did not return decision forbidden"
  fi
}

fc_probe "bare herdr invocation" herdr agent prompt x y
fc_probe "absolute herdr invocation" "$HERDR_PATH" agent prompt x y
fc_probe "different herdr command group" herdr pane run x y

jq -c -n \
  --arg checkout "$CHECKOUT" \
  --arg herdr "$HERDR_PATH" \
  --arg config_sha256 "$(fc_digest "$CONFIG_FILE")" \
  --arg rules_sha256 "$(fc_digest "$RULES_FILE")" \
  --arg exclude "$EXCLUDE" \
  --argjson installed "{\"config\":$INSTALLED_CONFIG,\"rules\":$INSTALLED_RULES,\"exclude_line\":$INSTALLED_EXCLUDE}" \
  '{ok:true, checkout:$checkout, herdr:$herdr, config_sha256:$config_sha256,
    rules_sha256:$rules_sha256, exclude:$exclude, installed:$installed}'
exit 0
