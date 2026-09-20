# cases/docs.sh — static guards on the opt-in Codex implementer's documentation.
#
# Nothing here launches the adapter's `run` path; these cases read the shipped scripts,
# the references and the version surfaces. Every assertion runs its command DIRECTLY and
# checks that command's exit status — never `cmd | grep`, which reports the filter's
# status and hides a failing command.
#
# Baselines come from `git merge-base HEAD origin/main`, so each guard keeps holding
# after the branch lands: on main the merge base IS HEAD and the comparisons are empty.

DOCS_C='plugins/fable-conductor/skills/conduct'
DOCS_RUNTIME="$DOCS_C/references/runtime-codex-implementer.md"
DOCS_SKILL="$DOCS_C/SKILL.md"
DOCS_CONTRACTS="$DOCS_C/references/contracts.md"
DOCS_CLAUDE_MANIFEST='plugins/fable-conductor/.claude-plugin/plugin.json'
DOCS_CODEX_MANIFEST='plugins/fable-conductor/.codex-plugin/plugin.json'
DOCS_CATALOG='.claude-plugin/marketplace.json'

# The closed action vocabulary of the per-round procedure.
DOCS_ACTIONS='dispatch_verifier rerun_attempt claude_round escalate fix_invocation'

# Files this feature must not have touched. The agent definitions are appended at run
# time from the merge base's own listing, so an ADDED or REMOVED agent fails too.
DOCS_FROZEN="$DOCS_C/references/workflows/execute-wave.js
$DOCS_C/references/workflows/test-adversary.js
$DOCS_C/references/workflows/final-audit.js
$DOCS_C/references/escalation.md
$DOCS_C/references/weave.md"

# --- helpers -------------------------------------------------------------------------

# docs_base — the merge base with origin/main, or fails the case.
docs_base() {
  local b
  if ! b="$(git -C "$REPO_ROOT" merge-base HEAD origin/main 2>/dev/null)"; then
    fail_case "cannot resolve the merge base with origin/main"
    return 1
  fi
  [ -n "$b" ] || { fail_case "the merge base with origin/main is empty"; return 1; }
  printf '%s\n' "$b"
}

# docs_show <base> <repo-relative path> <outfile>
docs_show() {
  if ! git -C "$REPO_ROOT" show "$1:$2" >"$3" 2>/dev/null; then
    fail_case "cannot read $2 at the merge base"
    return 1
  fi
  return 0
}

# docs_table <file> <key|action> — one line per action-table row.
#   key    -> "<class>\t<phase>"   (phase of a class that carries none is an em dash)
#   action -> the action cell, whitespace and backticks removed, so a cell naming two
#             actions cannot pass the vocabulary check below.
docs_table() {
  awk -F'|' -v want="$2" '
    /^## Class/ { intab = 1; next }
    intab && /^## /  { intab = 0 }
    intab && /^\|/ && NF == 8 {
      c = $2; p = $3; a = $6
      gsub(/[`\t ]/, "", c); gsub(/[`\t ]/, "", p); gsub(/[`\t ]/, "", a)
      if (c == "Class" || c == "" || c ~ /^-+$/) next
      if (want == "action") print a; else print c "\t" p
    }
  ' "$1"
}

# --- the action table covers `classes` row for row ------------------------------------

test_docs_action_table_matches_classes() {
  setup_case
  local json want got sorted dup
  json="$CASE_ROOT/classes.json"
  if ! /bin/bash "$(sut_script codex-implementer.sh)" classes >"$json" 2>/dev/null; then
    fail_case "codex-implementer.sh classes did not exit 0"
    teardown_case; return
  fi
  want="$CASE_ROOT/classes.keys"
  if ! jq -r '.classes[] | .class + "\t" + (.phase // "—")' "$json" >"$want"; then
    fail_case "the classes output did not parse"
    teardown_case; return
  fi

  got="$CASE_ROOT/table.keys"
  docs_table "$REPO_ROOT/$DOCS_RUNTIME" key >"$got"

  sorted="$CASE_ROOT/table.sorted"
  dup="$CASE_ROOT/table.dup"
  LC_ALL=C sort "$got" >"$sorted"
  uniq -d "$sorted" >"$dup"
  if [ -s "$dup" ]; then
    fail_case "duplicate action-table row(s): $(tr '\n\t' ' /' <"$dup")"
    teardown_case; return
  fi

  # Ordered equality: a missing row, an extra row, or a reordered row all fail here.
  assert_file_eq "$got" "$want" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

test_docs_action_table_rows_carry_exactly_one_known_action() {
  setup_case
  local f a n
  f="$CASE_ROOT/table.actions"
  docs_table "$REPO_ROOT/$DOCS_RUNTIME" action >"$f"
  n="$(wc -l <"$f" | tr -d ' ')"
  if [ "$n" = "0" ]; then
    fail_case "the action table has no rows"
    teardown_case; return
  fi
  while IFS= read -r a; do
    case " $DOCS_ACTIONS " in
      *" $a "*) ;;
      *)
        fail_case "action cell is not exactly one known action: '$a'"
        teardown_case; return
        ;;
    esac
  done <"$f"
  ok "$CURRENT_TEST"
  teardown_case
}

# --- SKILL.md stayed small, and Phase R stayed untouched ------------------------------

# The budget guard above proves the ceiling. This proves the floor: the opt-in wording
# must actually be present, and must forbid offering or probing. Without this a revert
# that deletes the paragraph outright still passes every other guard.
test_docs_skill_states_the_opt_in_contract() {
  setup_case
  local f="$REPO_ROOT/$DOCS_SKILL"
  if ! grep -q 'Codex implementer (opt-in)' "$f"; then
    fail_case "SKILL.md has no Codex implementer opt-in paragraph"; teardown_case; return
  fi
  if ! grep -q 'Never offer this and never probe for it' "$f"; then
    fail_case "the opt-in paragraph does not forbid offering or probing"; teardown_case; return
  fi
  if ! grep -q 'references/runtime-codex-implementer.md' "$f"; then
    fail_case "SKILL.md does not link the runtime procedure"; teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

test_docs_skill_grew_at_most_twelve_lines() {
  setup_case
  local base old new delta
  base="$(docs_base)" || { teardown_case; return; }
  docs_show "$base" "$DOCS_SKILL" "$CASE_ROOT/skill.base" || { teardown_case; return; }
  old="$(wc -l <"$CASE_ROOT/skill.base" | tr -d ' ')"
  new="$(wc -l <"$REPO_ROOT/$DOCS_SKILL" | tr -d ' ')"
  delta=$((new - old))
  if [ "$delta" -gt 12 ]; then
    fail_case "SKILL.md grew by $delta lines since the merge base (budget 12)"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

test_docs_skill_phase_r_probe_list_unchanged() {
  setup_case
  local base b c
  base="$(docs_base)" || { teardown_case; return; }
  docs_show "$base" "$DOCS_SKILL" "$CASE_ROOT/skill.base" || { teardown_case; return; }
  b="$CASE_ROOT/probe.base"; c="$CASE_ROOT/probe.now"
  if ! grep -F 'Then run the capability probes' "$CASE_ROOT/skill.base" >"$b"; then
    fail_case "the Phase R probe list is absent from SKILL.md at the merge base"
    teardown_case; return
  fi
  if ! grep -F 'Then run the capability probes' "$REPO_ROOT/$DOCS_SKILL" >"$c"; then
    fail_case "the Phase R probe list is absent from SKILL.md"
    teardown_case; return
  fi
  assert_file_eq "$c" "$b" || { teardown_case; return; }
  ok "$CURRENT_TEST"
  teardown_case
}

# --- the review machinery is byte-identical to the merge base -------------------------

test_docs_frozen_files_are_byte_identical() {
  setup_case
  local base p list agents_base agents_now
  base="$(docs_base)" || { teardown_case; return; }

  agents_base="$CASE_ROOT/agents.base"
  agents_now="$CASE_ROOT/agents.now"
  if ! git -C "$REPO_ROOT" ls-tree --name-only "$base" -- plugins/fable-conductor/agents/ \
       >"$CASE_ROOT/agents.base.raw"; then
    fail_case "cannot list the agent definitions at the merge base"
    teardown_case; return
  fi
  LC_ALL=C sort "$CASE_ROOT/agents.base.raw" >"$agents_base"
  : >"$CASE_ROOT/agents.now.raw"
  for p in "$REPO_ROOT"/plugins/fable-conductor/agents/*.md; do
    [ -f "$p" ] || continue
    printf '%s\n' "${p#$REPO_ROOT/}" >>"$CASE_ROOT/agents.now.raw"
  done
  LC_ALL=C sort "$CASE_ROOT/agents.now.raw" >"$agents_now"
  assert_file_eq "$agents_now" "$agents_base" || { teardown_case; return; }

  list="$CASE_ROOT/frozen.list"
  printf '%s\n' "$DOCS_FROZEN" >"$list"
  cat "$agents_base" >>"$list"

  while IFS= read -r p; do
    [ -n "$p" ] || continue
    docs_show "$base" "$p" "$CASE_ROOT/frozen.base" || { teardown_case; return; }
    if ! cmp -s "$CASE_ROOT/frozen.base" "$REPO_ROOT/$p"; then
      fail_case "not byte-identical to the merge base: $p"
      teardown_case; return
    fi
  done <"$list"
  ok "$CURRENT_TEST"
  teardown_case
}

# --- the root README still says Codex cannot conduct ----------------------------------

test_docs_root_readme_codex_cell_is_reference_only() {
  setup_case
  local cell
  cell="$(awk -F'|' '
    NF == 5 && index($2, "`fable-conductor`") > 0 {
      c = $4; gsub(/^[ \t]+|[ \t]+$/, "", c); print c; exit
    }' "$REPO_ROOT/README.md")"
  case "$cell" in
    'reference only'*) ;;
    *)
      fail_case "support-matrix Codex cell for fable-conductor reads '$cell'"
      teardown_case; return
      ;;
  esac
  ok "$CURRENT_TEST"
  teardown_case
}

# --- contracts.md gained the flag and nothing else ------------------------------------

test_docs_contracts_documents_the_flag_and_keeps_v1_passages() {
  setup_case
  local base d rc
  if ! grep -Fq 'implementer: claude | codex' "$REPO_ROOT/$DOCS_CONTRACTS"; then
    fail_case "contracts.md does not document the implementer flag"
    teardown_case; return
  fi
  if ! grep -Fq "disclosed in the ledger's \`Notes\` column" "$REPO_ROOT/$DOCS_CONTRACTS"; then
    fail_case "contracts.md does not say the engine is disclosed in the ledger Notes column"
    teardown_case; return
  fi

  base="$(docs_base)" || { teardown_case; return; }
  docs_show "$base" "$DOCS_CONTRACTS" "$CASE_ROOT/contracts.base" || { teardown_case; return; }
  d="$CASE_ROOT/contracts.diff"
  diff "$CASE_ROOT/contracts.base" "$REPO_ROOT/$DOCS_CONTRACTS" >"$d"
  rc=$?
  if [ "$rc" -gt 1 ]; then
    fail_case "diff could not compare contracts.md against the merge base"
    teardown_case; return
  fi
  if grep -q '^<' "$d"; then
    fail_case "contracts.md changed or removed a version-1 line: $(head -n 4 "$d" | tr '\n' '|')"
    teardown_case; return
  fi
  ok "$CURRENT_TEST"
  teardown_case
}

# --- every version surface agrees, and the bump happened ------------------------------

test_docs_version_surfaces_agree() {
  setup_case
  local base ref v row
  if ! ref="$(jq -r '.version // empty' "$REPO_ROOT/$DOCS_CLAUDE_MANIFEST")"; then
    fail_case "the Claude manifest did not parse"
    teardown_case; return
  fi
  case "$ref" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) fail_case "the Claude manifest version is not semver: '$ref'"; teardown_case; return ;;
  esac

  if ! v="$(jq -r '.version // empty' "$REPO_ROOT/$DOCS_CODEX_MANIFEST")"; then
    fail_case "the Codex manifest did not parse"
    teardown_case; return
  fi
  assert_eq "$v" "$ref" "Codex manifest version" || { teardown_case; return; }

  if ! v="$(jq -r '.plugins[] | select(.name == "fable-conductor") | .version // empty' \
            "$REPO_ROOT/$DOCS_CATALOG")"; then
    fail_case "the Claude catalog did not parse"
    teardown_case; return
  fi
  assert_eq "$v" "$ref" "catalog version" || { teardown_case; return; }

  row="$(awk -F'|' '
    index($2, "`fable-conductor`") > 0 {
      v = $3; gsub(/^[ \t]+|[ \t]+$/, "", v); print v; exit
    }' "$REPO_ROOT/README.md")"
  assert_eq "$row" "$ref" "README version row" || { teardown_case; return; }

  # Derived, not hardcoded: any change under the plugin obliges a version change.
  base="$(docs_base)" || { teardown_case; return; }
  if ! git -C "$REPO_ROOT" diff --quiet "$base" -- plugins/fable-conductor; then
    docs_show "$base" "$DOCS_CLAUDE_MANIFEST" "$CASE_ROOT/manifest.base" || { teardown_case; return; }
    if ! v="$(jq -r '.version // empty' "$CASE_ROOT/manifest.base")"; then
      fail_case "the merge base's Claude manifest did not parse"
      teardown_case; return
    fi
    if [ "$v" = "$ref" ]; then
      fail_case "plugins/fable-conductor changed since the merge base but the version is still $ref"
      teardown_case; return
    fi
  fi
  ok "$CURRENT_TEST"
  teardown_case
}
