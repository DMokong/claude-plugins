# Dual-surface marketplace: Claude Code + Codex (plan v2)

Status: reviewed twice by Codex (a co-author assessment, then an independent red-team: **GO-WITH-CHANGES**); v2 incorporates every accepted change. Owner goal: "skills need to be capable of being used by both Claude and Codex."

## Facts (checked on the owner's Mac: Claude Code 2.1.276, Codex CLI 0.153.4)

- Codex has `codex plugin marketplace add|list|upgrade|remove` and `codex plugin add|list|remove`. No `install`/`update` verbs.
- Codex catalog: `<repo>/.agents/plugins/marketplace.json`; entries are exactly `{name, source:{source:"local", path:"./plugins/<n>"}, policy:{installation, authentication}, category}`. **Entries carry no version** (0 of 180 in OpenAI's curated catalog).
- Codex plugin manifest: all 16 plugins installed on this machine use `plugins/<n>/.codex-plugin/plugin.json`; none use a root `plugin.json`. Every one carries `name`, semver `version`, `description`, `author.name`, `skills`, and a full `interface` block (`displayName, shortDescription, longDescription, developerName, category, capabilities, defaultPrompt` + optional branding). Two Codex reviewers say current OpenAI guidance prefers a root `plugin.json` with `.codex-plugin/` as compatibility fallback — **unsettled; Phase 0 decides by test.**
- `.claude-plugin/` and `.codex-plugin/` can coexist per plugin and share one `skills/` tree. No fork, no sync script.
- Codex discovers skills from plugin caches, `~/.agents/skills`, and repo-ancestor `.agents/skills`; `name` + `description` drive loading. `${CLAUDE_PLUGIN_ROOT}` is not set for skills; `commands/*.md` is not a Codex surface.
- Codex has no Workflow tool and no AskUserQuestion (`request_user_input` in Plan mode only). Its `spawn_agent/followup_task/wait_agent/send_message/list_agents` are scoped to its own subagent tree. Cross-session: `codex agents` (session browser) and `codex queue --thread <id|name> --message` exist; delivery semantics unverified.
- Version fields that can drift per plugin: **three** (Claude manifest, Claude catalog, Codex manifest) + the README table.

## Design rule (amended)

Skills name actions, not tools; a per-surface reference file translates. **Limit:** where the transport itself carries meaning — sender authentication, busy-session queuing, parent identity, approval handling, tool authority — surfaces offer *different guarantees*, not just different tool names. The shared skill must state the weakest guarantee and the per-surface file may only strengthen it.

## Acceptance principle

Claude-side workers cannot certify Codex behaviour by reading. Every task whose output Codex consumes has a done-check that **runs the Codex CLI** under a disposable `CODEX_HOME` (never the owner's real `~/.codex`): manifest validation, `marketplace add`, `plugin add`, cache inspection, and — where auth allows — `codex exec` to confirm a skill triggers and resolves its relative references.

## Stream A (this stream): packaging + the two portable plugins + release hygiene

### A0 — Codex install spike (blocks everything)
Disposable `CODEX_HOME`. Settle by experiment, recording exact commands and output:
1. Manifest location: root `plugin.json` vs `.codex-plugin/plugin.json` — which does 0.153.4 accept from a local marketplace? Use Codex's own `plugin-creator` system skill / validator if it exposes one.
2. Minimum valid manifest, including the `interface` block.
3. Catalog: name `dmokong-plugins`; behaviour when the same catalog name is registered from a local path and later from Git.
4. Does the presence of `.claude-plugin/` files disturb Codex, or `.agents/` disturb Claude (`claude plugin validate .`)?
5. Two-version test: install, bump manifest version, refresh — what sequence actually updates the cache (`marketplace upgrade` + re-`plugin add` + new thread?). Does `--ref` pin the whole repo?
Output: `docs/codex-packaging-findings.md` + a working `fable-mode` install. **If A0 contradicts a fact above, stop and re-plan.**

### A1 — Packaging for all three plugins
`.agents/plugins/marketplace.json`; a valid Codex manifest per plugin with honest `interface` copy (fable-conductor's must say its orchestration engine is Claude-only until Stream B lands — do not advertise what does not work).

### A2 — fable-mode 1.1.1
`SKILL.md:21` → "AGENTS.md / CLAUDE.md"; `SKILL.md:97` → "invoke the corresponding installed skill" (no slash syntax). Done-check: grep for remaining surface-bound tokens; Codex install + trigger.

### A3 — herdr-jutsu 0.2.0
(a) The 14 findings from the first Codex review: `[crew:name]` is a wake signal only — pull evidence from the pane/report; approve a member's prompt only if the parent's own permissions would run it unprompted, else relay; EXIT trap (auto-close a pane it created, emit a recovery record for a worktree); `--in-pane` must verify an idle shell (`pane process-info` + agent occupancy); branch on `.error.code` from `agent start`; refuse bypass/full-access flags without an explicit override flag; registry dir 0700 / file 0600; `agent_args` as a JSON array; validate `--stream`; Codex resume is `codex resume <id>`; scope the one-name invariant (Codex has no `--name`); `--beside` wording; arg-arity checks and jq-built error JSON.
(b) Red-team additions: registry write fails under Codex sandboxes — fall back to a workspace-local state dir when `~/.local/state` is not writable, and test read-only + workspace-write; add a preflight (herdr ≥ 0.8.2, jq, git, `HERDR_ENV=1`, writable state) with explicit degraded behaviour; a no-write brief variant for read-only reviewers.
(c) Parent-surface branching: `references/parent-claude.md` / `parent-codex.md`. A Codex parent uses the herdr bus both ways and pulls evidence from the child's pane/report.
Done-check: bash 3.2 `bash -n` + shellcheck if available; scripted failure-injection for the EXIT trap; live test of a **Codex parent raising a Claude child**.

### A4 — Release hygiene
`scripts/check-manifests.sh` fails on disagreement across the three version fields + README table. RELEASE.md/README: Codex install + the refresh sequence A0 proved; state that a Codex Git marketplace tracks `main` (per-plugin tags are informational there); document `marketplaces.restrict_to_allowed_sources` for managed machines; declare runtime prerequisites per plugin.

## Stream B (separate, starts at shaping — NOT part of this stream): fable-conductor on Codex

The red-team is right that "run the existing fallback" is one sentence, not a design. Needs its own spec: a bounded state machine for waves; role-prompt extraction from `agents/*.md` (their `tools:`/`model:` frontmatter is unenforced under `spawn_agent` — children inherit the parent's tools and sandbox); a report-file protocol because child finals are free-form; Codex's concurrency cap (reported as 4 agents including the parent — unverified); retries, cancellation, resumption; model-availability fallback. All surface-bound conductor language (`$ARGUMENTS`, `/conduct`, `/sdlc`, `Workflow`, `${CLAUDE_PLUGIN_ROOT}` at `SKILL.md:45-47, 61, 108-124`) moves behind `runtime-claude.md`. Prove execute-wave, test-adversary and final-audit separately.

## Still unverified
End-to-end install of this repo (A0); dual-catalog precedence; bundling Codex agent role files in a plugin; `codex queue` delivery; Git-cache pinning; plugin-bundled Codex hooks; the 4-agent cap.
