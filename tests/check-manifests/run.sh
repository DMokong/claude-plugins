#!/usr/bin/env bash
# tests/check-manifests/run.sh — mutation-test suite for scripts/check-manifests.sh.
#
# Plain bash, no framework; stays inside the bash 3.2 subset (indexed-style usage
# only, no bash-4-only builtins). Each case copies the repo's manifest/catalog/
# README surface into its own `mktemp -d` root, mutates exactly one thing (two,
# for the "two simultaneous mutations" case), runs check-manifests.sh against
# that root via its documented root-override first argument, and asserts:
#   - non-zero exit for every mutated case, exit 0 for the unmutated baseline;
#   - the MISMATCH output names the mutated plugin;
#   - the MISMATCH output's field text is consistent with what was mutated
#     (matched loosely — the brief pins the line FORMAT
#     `MISMATCH <name>: <field> is <x>, expected <y>` but not exact field-label
#     strings, so each case accepts any of a small set of reasonable keywords).
#
# Proves that scripts/check-manifests.sh fails on every single-field disagreement.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-manifests.sh"

PASS=0
FAIL=0
CURRENT_TEST=""

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

if [ ! -e "$SCRIPT" ]; then
  echo "NOTE: $SCRIPT does not exist yet — every case below is expected to fail" \
    "until it is implemented (this is the correct pre-implementation state)." >&2
fi

LOCAL_PLUGINS="fable-mode fable-conductor herdr-jutsu"

# --- scratch-case plumbing --------------------------------------------------------------

ROOT=""
OUT_FILE=""
ERR_FILE=""
CODE=0

# Copies exactly the files check-manifests.sh's brief says it reads: the two
# catalogs, README.md, and each local plugin's two manifests.
setup_case() {
  ROOT="$(mktemp -d)"
  mkdir -p "$ROOT/.claude-plugin" "$ROOT/.agents/plugins"
  cp "$REPO_ROOT/.claude-plugin/marketplace.json" "$ROOT/.claude-plugin/marketplace.json"
  cp "$REPO_ROOT/.agents/plugins/marketplace.json" "$ROOT/.agents/plugins/marketplace.json"
  cp "$REPO_ROOT/README.md" "$ROOT/README.md"
  local p
  for p in $LOCAL_PLUGINS; do
    mkdir -p "$ROOT/plugins/$p/.claude-plugin" "$ROOT/plugins/$p/.codex-plugin"
    cp "$REPO_ROOT/plugins/$p/.claude-plugin/plugin.json" "$ROOT/plugins/$p/.claude-plugin/plugin.json"
    cp "$REPO_ROOT/plugins/$p/.codex-plugin/plugin.json" "$ROOT/plugins/$p/.codex-plugin/plugin.json"
  done
  OUT_FILE="$ROOT/.out"
  ERR_FILE="$ROOT/.err"
}

teardown_case() {
  [ -n "$ROOT" ] || return 0
  rm -rf "$ROOT" 2>/dev/null || true
  ROOT=""
}

run_check() {
  : >"$OUT_FILE"
  : >"$ERR_FILE"
  "$SCRIPT" "$ROOT" >"$OUT_FILE" 2>"$ERR_FILE"
  CODE=$?
}

# jq_set_file <file> <jq filter> — in-place jq edit, portable (no reliance on jq -i).
jq_set_file() {
  local f="$1" filt="$2" tmp
  tmp="$(mktemp)"
  if ! jq "$filt" "$f" >"$tmp"; then
    echo "FATAL: jq filter failed: $filt on $f" >&2
    exit 99
  fi
  mv "$tmp" "$f"
}

all_output() {
  cat "$OUT_FILE" "$ERR_FILE" 2>/dev/null
}

# mismatch_lines_for <plugin-name> — every MISMATCH line naming <plugin-name>.
mismatch_lines_for() {
  grep -E '^MISMATCH ' "$OUT_FILE" "$ERR_FILE" 2>/dev/null | grep -F "$1"
}

# assert_named_mismatch <plugin> <keyword...> — fails the current case unless at
# least one MISMATCH line names <plugin> AND at least one of the keywords
# (case-insensitive) appears in that plugin's MISMATCH line(s).
assert_named_mismatch() {
  local plugin="$1"
  shift
  local lines kw
  lines="$(mismatch_lines_for "$plugin")"
  if [ -z "$lines" ]; then
    fail_case "no MISMATCH line names plugin '$plugin'. Full output:$(all_output)"
    return 1
  fi
  for kw in "$@"; do
    if printf '%s\n' "$lines" | grep -qi -- "$kw"; then
      return 0
    fi
  done
  fail_case "MISMATCH line(s) for '$plugin' matched none of the expected field keywords ($*): $lines"
  return 1
}

# --- README mutation helper -------------------------------------------------------------

# mutate_readme_version <plugin> <old-version> <new-version>
mutate_readme_version() {
  local plugin="$1" old="$2" new="$3" tmp
  tmp="$(mktemp)"
  sed -E "/\`$plugin\`/ s/\\| $old \\|/| $new |/" "$ROOT/README.md" >"$tmp"
  mv "$tmp" "$ROOT/README.md"
}

# =========================================================================================
# AC-25 — baseline: unmutated copy exits 0 and reports the clean plugins.
# =========================================================================================

test_ac25_unmutated_copy_exits_zero() {
  CURRENT_TEST="ac25_unmutated_copy_exits_zero"
  setup_case
  run_check
  if [ "$CODE" -ne 0 ]; then
    fail_case "expected exit 0 for an unmutated copy, got $CODE. Output:$(all_output)"
    teardown_case
    return
  fi
  if grep -qE '^MISMATCH ' "$OUT_FILE" "$ERR_FILE" 2>/dev/null; then
    fail_case "an unmutated copy must report zero MISMATCH lines: $(all_output)"
    teardown_case
    return
  fi
  grep -qxF "ok fable-mode 1.1.1" "$OUT_FILE" \
    || { fail_case "expected the line 'ok fable-mode 1.1.1' in stdout: $(cat "$OUT_FILE")"; teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — Claude manifest version mutated (the reference value itself).
# =========================================================================================

test_ac25_claude_manifest_version_mismatch() {
  CURRENT_TEST="ac25_claude_manifest_version_mismatch"
  setup_case
  jq_set_file "$ROOT/plugins/fable-mode/.claude-plugin/plugin.json" '.version = "9.9.9"'
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit when fable-mode's Claude manifest version drifts, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "fable-mode" "version" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — Claude catalog version mutated.
# =========================================================================================

test_ac25_claude_catalog_version_mismatch() {
  CURRENT_TEST="ac25_claude_catalog_version_mismatch"
  setup_case
  jq_set_file "$ROOT/.claude-plugin/marketplace.json" \
    '(.plugins[] | select(.name=="fable-mode") | .version) = "9.9.9"'
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit when fable-mode's Claude catalog version drifts, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "fable-mode" "version" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — Codex manifest version mutated.
# =========================================================================================

test_ac25_codex_manifest_version_mismatch() {
  CURRENT_TEST="ac25_codex_manifest_version_mismatch"
  setup_case
  jq_set_file "$ROOT/plugins/fable-mode/.codex-plugin/plugin.json" '.version = "9.9.9"'
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit when fable-mode's Codex manifest version drifts, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "fable-mode" "version" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — README table row version mutated.
# =========================================================================================

test_ac25_readme_row_version_mismatch() {
  CURRENT_TEST="ac25_readme_row_version_mismatch"
  setup_case
  mutate_readme_version "fable-mode" "1\\.1\\.1" "9.9.9"
  grep -q '9.9.9' "$ROOT/README.md" || { fail_case "harness bug: README mutation did not apply"; teardown_case; return; }
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit when the README row version drifts, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "fable-mode" "version" "readme" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — Codex manifest .name mutated.
# =========================================================================================

test_ac25_codex_manifest_name_mismatch() {
  CURRENT_TEST="ac25_codex_manifest_name_mismatch"
  setup_case
  jq_set_file "$ROOT/plugins/fable-mode/.codex-plugin/plugin.json" '.name = "not-fable-mode"'
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit when fable-mode's Codex manifest .name drifts, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "fable-mode" "name" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — Codex manifest deleted entirely.
# =========================================================================================

test_ac25_codex_manifest_deleted() {
  CURRENT_TEST="ac25_codex_manifest_deleted"
  setup_case
  rm -f "$ROOT/plugins/fable-mode/.codex-plugin/plugin.json"
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit when fable-mode's Codex manifest is missing, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "fable-mode" "exist" "missing" "not found" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — Codex catalog entry removed.
# =========================================================================================

test_ac25_codex_catalog_entry_removed() {
  CURRENT_TEST="ac25_codex_catalog_entry_removed"
  setup_case
  jq_set_file "$ROOT/.agents/plugins/marketplace.json" \
    'del(.plugins[] | select(.name=="fable-mode"))'
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit when fable-mode has no Codex catalog entry, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "fable-mode" "list" "missing" "not found" "exist" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — a `version` key added to a Codex catalog entry (versionless-surface drift).
# =========================================================================================

test_ac25_codex_catalog_version_key_added() {
  CURRENT_TEST="ac25_codex_catalog_version_key_added"
  setup_case
  jq_set_file "$ROOT/.agents/plugins/marketplace.json" \
    '(.plugins[] | select(.name=="fable-mode")) += {version: "1.1.1"}'
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit when a Codex catalog entry carries a version key, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "fable-mode" "version" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — an orphan Codex catalog entry (no matching local plugin in the Claude catalog).
# =========================================================================================

test_ac25_orphan_codex_catalog_entry() {
  CURRENT_TEST="ac25_orphan_codex_catalog_entry"
  setup_case
  jq_set_file "$ROOT/.agents/plugins/marketplace.json" \
    '.plugins += [{"name":"ghost-plugin","source":{"source":"local","path":"./plugins/ghost-plugin"},"policy":{"installation":"AVAILABLE","authentication":"ON_USE"},"category":"Developer Tools"}]'
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit for an orphan Codex catalog entry (ghost-plugin), got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "ghost-plugin" "orphan" "no matching" "not found" "unknown" "correspond" \
    || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — two simultaneous mutations on two different plugins are BOTH reported.
# =========================================================================================

test_ac25_two_simultaneous_mutations_both_reported() {
  CURRENT_TEST="ac25_two_simultaneous_mutations_both_reported"
  setup_case
  jq_set_file "$ROOT/plugins/fable-mode/.claude-plugin/plugin.json" '.version = "9.9.9"'
  jq_set_file "$ROOT/plugins/herdr-jutsu/.codex-plugin/plugin.json" '.name = "not-herdr-jutsu"'
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit for two simultaneous drifts, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "fable-mode" "version" || { teardown_case; return; }
  assert_named_mismatch "herdr-jutsu" "name" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — a URL-sourced plugin's README row (speculator) is checked for agreement too.
# =========================================================================================

test_ac25_url_sourced_readme_row_mismatch() {
  CURRENT_TEST="ac25_url_sourced_readme_row_mismatch"
  setup_case
  mutate_readme_version "speculator" "2\\.21\\.1" "9.9.9"
  grep -q '9.9.9' "$ROOT/README.md" || { fail_case "harness bug: README mutation did not apply"; teardown_case; return; }
  run_check
  if [ "$CODE" -eq 0 ]; then
    fail_case "expected non-zero exit when speculator's README row drifts from its catalog version, got 0"
    teardown_case
    return
  fi
  assert_named_mismatch "speculator" "version" "readme" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# =========================================================================================
# AC-25 — bash -n sanity for the script under test (belt-and-braces; the done-check
# already runs this from the outer harness).
# =========================================================================================

test_ac25_bash_n_under_bash32() {
  CURRENT_TEST="ac25_bash_n_under_bash32"
  if [ ! -e "$SCRIPT" ]; then
    fail_case "$SCRIPT does not exist"
    return
  fi
  if /bin/bash -n "$SCRIPT"; then
    ok "$CURRENT_TEST"
  else
    fail_case "/bin/bash -n $SCRIPT failed"
  fi
}

# --- driver -------------------------------------------------------------------------------

test_ac25_bash_n_under_bash32
test_ac25_unmutated_copy_exits_zero
test_ac25_claude_manifest_version_mismatch
test_ac25_claude_catalog_version_mismatch
test_ac25_codex_manifest_version_mismatch
test_ac25_readme_row_version_mismatch
test_ac25_codex_manifest_name_mismatch
test_ac25_codex_manifest_deleted
test_ac25_codex_catalog_entry_removed
test_ac25_codex_catalog_version_key_added
test_ac25_orphan_codex_catalog_entry
test_ac25_two_simultaneous_mutations_both_reported
test_ac25_url_sourced_readme_row_mismatch

TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS ($TOTAL tests)"
  exit 0
else
  echo "FAILED ($FAIL of $TOTAL)"
  exit 1
fi
