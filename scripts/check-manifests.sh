#!/usr/bin/env bash
# check-manifests.sh — fail on any disagreement across this repo's four
# version-carrying surfaces per plugin: the Claude manifest, the Claude
# catalog, the Codex manifest, and the README table row. Also catches
# malformed/empty catalogs, bad or duplicate names, catalog-name drift in
# either direction, invalid Codex source shapes, URL drift, and a `version`
# key leaking into any Codex catalog entry (entries are versionless by design).
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

# Parse explicitly before any process substitution: jq's status inside
# `< <(...)` is discarded by bash, which could otherwise turn malformed input
# into a false clean result.
jq empty "$claude_catalog" >/dev/null 2>&1 || die "malformed $claude_catalog"
jq empty "$codex_catalog" >/dev/null 2>&1 || die "malformed $codex_catalog"

problems=0
problem_names=""

mismatch() {
  # mismatch <name> <field> <got> <expected>
  printf 'MISMATCH %s: %s is %s, expected %s\n' "$1" "$2" "$3" "$4"
  problems=$((problems + 1))
  problem_names="${problem_names}${1}
"
}

has_named_problem() {
  printf '%s' "$problem_names" | grep -Fqx -- "$1"
}

validate_catalog_shape() {
  # validate_catalog_shape <label> <file>
  if ! jq -e '
    type == "object" and
    (.plugins | type) == "array" and
    (.plugins | length) > 0 and
    all(.plugins[]; (.name | type) == "string" and (.name | length) > 0)
  ' "$2" >/dev/null; then
    mismatch "$1" catalog-shape invalid non-empty-plugins-array-with-non-empty-string-names
  fi
}

# These checks must finish before any catalog iterator is opened.
validate_catalog_shape claude-catalog "$claude_catalog"
validate_catalog_shape codex-catalog "$codex_catalog"
[ "$problems" -eq 0 ] || exit 1

# Sort once and retain multiplicity. Equality here is stricter than a set
# comparison; duplicate reporting below identifies the responsible catalog.
claude_names="$(jq -r '.plugins[].name' "$claude_catalog" | LC_ALL=C sort)"
codex_names="$(jq -r '.plugins[].name' "$codex_catalog" | LC_ALL=C sort)"

while IFS= read -r duplicate_name; do
  [ -n "$duplicate_name" ] \
    && mismatch "$duplicate_name" claude-catalog-duplicate present absent
done < <(printf '%s\n' "$claude_names" | uniq -d)

while IFS= read -r duplicate_name; do
  [ -n "$duplicate_name" ] \
    && mismatch "$duplicate_name" codex-catalog-duplicate present absent
done < <(printf '%s\n' "$codex_names" | uniq -d)

# Catalog parity is strict even for URL-sourced plugins. Codex natively reads
# the Claude catalog when no Codex catalog exists, but when both are present it
# prefers the Codex catalog; omitting a name here would therefore hide it.
if [ "$claude_names" != "$codex_names" ]; then
  while IFS= read -r claude_name; do
    jq -e --arg n "$claude_name" 'any(.plugins[]; .name == $n)' "$codex_catalog" >/dev/null \
      || mismatch "$claude_name" codex-catalog-missing absent present
  done < <(printf '%s\n' "$claude_names")

  while IFS= read -r codex_name; do
    jq -e --arg n "$codex_name" 'any(.plugins[]; .name == $n)' "$claude_catalog" >/dev/null \
      || mismatch "$codex_name" codex-catalog-orphan present absent
  done < <(printf '%s\n' "$codex_names")
fi

# Claude entries are either in-repo plugins with the exact conventional path
# and a real directory, or external plugins with the exact url/url source
# object and an HTTPS Git URL. Validate this before the plugin checks below.
while IFS= read -r claude_entry; do
  claude_name="$(printf '%s' "$claude_entry" | jq -r '.name')"
  claude_source_type="$(printf '%s' "$claude_entry" | jq -r '.source | type')"
  expected_path="./plugins/$claude_name"
  plugin_dir="$root/plugins/$claude_name"

  if [ "$claude_source_type" = "string" ]; then
    claude_path="$(printf '%s' "$claude_entry" | jq -r '.source')"
    [ "$claude_path" = "$expected_path" ] \
      || mismatch "$claude_name" claude-catalog-source "$claude_path" "$expected_path"
    [ -d "$plugin_dir" ] \
      || mismatch "$claude_name" claude-plugin-directory absent present
  elif [ -d "$plugin_dir" ]; then
    mismatch "$claude_name" claude-catalog-source "$claude_source_type" "$expected_path"
  elif ! printf '%s' "$claude_entry" | jq -e '
    .source as $s |
    ($s | type) == "object" and
    ($s | keys) == ["source", "url"] and
    $s.source == "url" and
    ($s.url | type) == "string" and
    ($s.url | test("^https://.+\\.git$"))
  ' >/dev/null; then
    mismatch "$claude_name" claude-catalog-source invalid url/https-git
  fi
done < <(jq -c '.plugins[]' "$claude_catalog")

# Every Codex entry is versionless and has exactly one accepted source object:
# local/path or url/url. In particular, source:git and source:github are not
# aliases — Codex silently drops those entries.
while IFS= read -r codex_entry; do
  codex_name="$(printf '%s' "$codex_entry" | jq -r '.name')"
  if ! printf '%s' "$codex_entry" | jq -e '
    .source as $s |
    ($s | type) == "object" and
    (
      (($s | keys) == ["path", "source"] and
       $s.source == "local" and
       ($s.path | type) == "string" and
       ($s.path | length) > 0)
      or
      (($s | keys) == ["source", "url"] and
       $s.source == "url" and
       ($s.url | type) == "string" and
       ($s.url | length) > 0)
    )
  ' >/dev/null; then
    mismatch "$codex_name" codex-catalog-source invalid local/path-or-url/url
  fi
  has_version="$(printf '%s' "$codex_entry" | jq -r 'has("version")')"
  [ "$has_version" = "false" ] \
    || mismatch "$codex_name" codex-catalog-version present absent
done < <(jq -c '.plugins[]' "$codex_catalog")

# readme_version_for <name> — prints the version cell of the table row whose
# first cell contains the literal `<name>` (backticked), or nothing if no
# such row exists.
readme_version_for() {
  awk -F'|' -v pat="\`$1\`" '
    index($2, pat) > 0 { v = $3; gsub(/^[ \t]+|[ \t]+$/, "", v); print v; exit }
  ' "$readme"
}

check_local_plugin() {
  # check_local_plugin <name> <claude-catalog-version>
  name="$1"
  catalog_version="$2"
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
  fi

  row_version="$(readme_version_for "$name")"
  if [ -z "$row_version" ]; then
    mismatch "$name" readme-row absent present
  else
    [ "$row_version" = "$ref_version" ] \
      || mismatch "$name" readme-version "$row_version" "$ref_version"
  fi

  if [ "$problems" -eq "$before" ] && ! has_named_problem "$name"; then
    printf 'ok %s %s\n' "$name" "$ref_version"
  fi
  return 0
}

check_url_plugin() {
  # check_url_plugin <name> <claude-catalog-version> <claude-catalog-url>
  name="$1"
  ref_version="$2"
  claude_url="$3"
  before="$problems"

  codex_entry="$(jq -c --arg n "$name" '.plugins[] | select(.name == $n)' "$codex_catalog")"
  if [ -z "$codex_entry" ]; then
    mismatch "$name" codex-catalog-missing absent present
  else
    codex_source_type="$(printf '%s' "$codex_entry" | jq -r '.source.source // empty')"
    codex_url="$(printf '%s' "$codex_entry" | jq -r '.source.url // empty')"
    [ "$codex_source_type" = "url" ] \
      || mismatch "$name" codex-catalog-source "$codex_source_type" url
    [ "$codex_url" = "$claude_url" ] \
      || mismatch "$name" codex-catalog-url "$codex_url" "$claude_url"
  fi

  row_version="$(readme_version_for "$name")"
  if [ -z "$row_version" ]; then
    mismatch "$name" readme-row absent present
  else
    [ "$row_version" = "$ref_version" ] \
      || mismatch "$name" readme-version "$row_version" "$ref_version"
  fi

  if [ "$problems" -eq "$before" ] && ! has_named_problem "$name"; then
    printf 'ok %s %s\n' "$name" "$ref_version"
  fi
  return 0
}

# Field separator is \x1f (unit separator), not tab: `read` collapses runs of
# IFS *whitespace* (which includes tab), which would swallow the empty
# source_val field that url-sourced entries produce.
while IFS=$'\x1f' read -r name source_type source_val version; do
  if [ "$source_type" = "string" ]; then
    check_local_plugin "$name" "$version"
  else
    check_url_plugin "$name" "$version" "$source_val"
  fi
done < <(jq -r '.plugins[] | [.name, (.source | type), (if (.source | type) == "string" then .source else (.source.url // "") end), (.version | tostring)] | join("")' "$claude_catalog")

[ "$problems" -eq 0 ] || exit 1
exit 0
