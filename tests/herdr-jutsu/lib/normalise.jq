# tests/herdr-jutsu/lib/normalise.jq — mask volatile fields in a jutsu-spawn.sh stdout /
# registry-row JSON object so two runs of the identical scenario, each in its own
# `mktemp -d` scratch tree, normalise to byte-identical JSON. Used both to capture
# tests/herdr-jutsu/fixtures/v0.4.1/*.json and, later, by tests/herdr-jutsu/cases/*.sh to
# re-normalise a fresh run for comparison against those fixtures (AC-1).
#
# Usage: jq -c -f lib/normalise.jq --arg scratch "<absolute scratch dir for this case>" <in.json
#
# Masks:
#   - spawned_at                                -> "<TS>"
#   - pane_id, tab_id, workspace_id, parent_pane -> "<PANE>" / "<TAB>" / "<WS>" / "<PANE>"
#     (an empty string is left alone: an unresolved/absent field is not itself volatile)
#   - any occurrence of $scratch inside any string value, at any depth (cwd, worktree,
#     registry_path, state_dir, registry_path, and any agent/effective arg that happens to
#     embed a scratch-relative path) -> that exact prefix replaced with "<SCRATCH>"
#
# Deliberately NOT masked: session_id / resume_args (the stub's session ids are a
# per-scratch-dir sequence starting at "sess-1", stable across runs as long as each captured
# scenario does exactly one spawn) and the Codex deny-rules file content (AC-28, not this
# fixture set).

def mask_scratch:
  if type != "string" then .
  elif ($scratch // "") == "" then .
  elif (contains($scratch) | not) then .
  else split($scratch) | join("<SCRATCH>")
  end;

def mask_id(placeholder):
  if type == "string" and . != "" then placeholder else . end;

walk(if type == "string" then mask_scratch else . end)
| if type == "object" then
    (if has("spawned_at") then .spawned_at = "<TS>" else . end)
    | (if has("pane_id") then .pane_id |= mask_id("<PANE>") else . end)
    | (if has("tab_id") then .tab_id |= mask_id("<TAB>") else . end)
    | (if has("workspace_id") then .workspace_id |= mask_id("<WS>") else . end)
    | (if has("parent_pane") then .parent_pane |= mask_id("<PANE>") else . end)
  else .
  end
