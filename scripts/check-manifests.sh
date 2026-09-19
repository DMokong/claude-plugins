#!/usr/bin/env bash
# check-manifests.sh — fail on any disagreement across this repo's four
# version-carrying surfaces per plugin: the Claude manifest, the Claude
# catalog, the Codex manifest, and the README table row. Also catches
# Codex-catalog entries that don't correspond to a local plugin (orphans)
# and a `version` key leaking into a Codex catalog entry (Codex entries are
# versionless by design — a version there is a fourth drift surface).
#
# Usage: scripts/check-manifests.sh [repo-root]
#
# With no argument, resolves the repo root from this script's own location.
# The optional argument lets the mutation tests point this at a scratch
# copy of the repo instead. Bash 3.2, `set -eu`, needs only `jq`. No
# network, no `codex`, no `claude`.
#
# Output: one `ok <name> <version>` line per plugin with no problems, one
# `MISMATCH <name>: <field> is <x>, expected <y>` line per problem found —
# every problem is reported, the script never stops at the first one. Exit
# 0 only if zero problems were found.
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
default_root="$(cd "$script_dir/.." && pwd -P)"
root="${1:-$default_root}"

die() { printf 'check-manifests: %s\n' "$*" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || die "jq not found on PATH"

claude_catalog="$root/.claude-plugin/marketplace.json"
codex_catalog="$root/.agents/plugins/marketplace.json"
readme="$root/README.md"

[ -f "$claude_catalog" ] || die "missing $claude_catalog"
[ -f "$codex_catalog" ] || die "missing $codex_catalog"
[ -f "$readme" ] || die "missing $readme"

problems=0

mismatch() {
  # mismatch <name> <field> <got> <expected>
  printf 'MISMATCH %s: %s is %s, expected %s\n' "$1" "$2" "$3" "$4"
  problems=$((problems + 1))
}

# readme_version_for <name> — prints the version cell of the table row whose
# first cell contains the literal `<name>` (backticked), or nothing if no
# such row exists.
readme_version_for() {
  awk -F'|' -v pat="\`$1\`" '
    index($2, pat) > 0 { v = $3; gsub(/^[ \t]+|[ \t]+$/, "", v); print v; exit }
  ' "$readme"
}

local_names=""

check_local_plugin() {
  # check_local_plugin <name> <claude-catalog-version>
  name="$1"
  catalog_version="$2"
  local_names="$local_names $name"
  before="$problems"

  claude_manifest="$root/plugins/$name/.claude-plugin/plugin.json"
  [ -f "$claude_manifest" ] || die "missing $claude_manifest (listed in $claude_catalog)"
  ref_version="$(jq -r '.version // empty' "$claude_manifest")"
  [ -n "$ref_version" ] || die "$claude_manifest has no .version"

  [ "$catalog_version" = "$ref_version" ] \
    || mismatch "$name" claude-catalog-version "$catalog_version" "$ref_version"

  codex_manifest="$root/plugins/$name/.codex-plugin/plugin.json"
  if [ ! -f "$codex_manifest" ]; then
    mismatch "$name" codex-manifest-missing absent present
  else
    codex_version="$(jq -r '.version // empty' "$codex_manifest")"
    codex_name="$(jq -r '.name // empty' "$codex_manifest")"
    [ "$codex_version" = "$ref_version" ] \
      || mismatch "$name" codex-manifest-version "$codex_version" "$ref_version"
    [ "$codex_name" = "$name" ] \
      || mismatch "$name" codex-manifest-name "$codex_name" "$name"
  fi

  codex_entry="$(jq -c --arg n "$name" '.plugins[] | select(.name == $n)' "$codex_catalog")"
  if [ -z "$codex_entry" ]; then
    mismatch "$name" codex-catalog-missing absent present
  else
    codex_path="$(printf '%s' "$codex_entry" | jq -r '.source.path // empty')"
    expected_path="./plugins/$name"
    [ "$codex_path" = "$expected_path" ] \
      || mismatch "$name" codex-catalog-path "$codex_path" "$expected_path"
    has_version="$(printf '%s' "$codex_entry" | jq -r 'has("version")')"
    [ "$has_version" = "false" ] \
      || mismatch "$name" codex-catalog-version present absent
  fi

  row_version="$(readme_version_for "$name")"
  if [ -z "$row_version" ]; then
    mismatch "$name" readme-row absent present
  else
    [ "$row_version" = "$ref_version" ] \
      || mismatch "$name" readme-version "$row_version" "$ref_version"
  fi

  [ "$problems" -eq "$before" ] && printf 'ok %s %s\n' "$name" "$ref_version"
  return 0
}

check_url_plugin() {
  # check_url_plugin <name> <claude-catalog-version> — README-row agreement only.
  name="$1"
  ref_version="$2"
  before="$problems"

  row_version="$(readme_version_for "$name")"
  if [ -z "$row_version" ]; then
    mismatch "$name" readme-row absent present
  else
    [ "$row_version" = "$ref_version" ] \
      || mismatch "$name" readme-version "$row_version" "$ref_version"
  fi

  [ "$problems" -eq "$before" ] && printf 'ok %s %s\n' "$name" "$ref_version"
  return 0
}

# Field separator is \x1f (unit separator), not tab: `read` collapses runs of
# IFS *whitespace* (which includes tab), which would swallow the empty
# source_val field that url-sourced entries produce.
while IFS=$'\x1f' read -r name source_type source_val version; do
  if [ "$source_type" = "string" ]; then
    check_local_plugin "$name" "$version"
  else
    check_url_plugin "$name" "$version"
  fi
done < <(jq -r '.plugins[] | [.name, (.source | type), (if (.source | type) == "string" then .source else "" end), (.version | tostring)] | join("")' "$claude_catalog")

# Orphan check: every Codex catalog entry must correspond to a local plugin
# in the Claude catalog.
while IFS= read -r codex_name; do
  found=0
  for n in $local_names; do
    [ "$n" = "$codex_name" ] && { found=1; break; }
  done
  [ "$found" -eq 1 ] || mismatch "$codex_name" codex-catalog-orphan present absent
done < <(jq -r '.plugins[].name' "$codex_catalog")

[ "$problems" -eq 0 ] || exit 1
exit 0
