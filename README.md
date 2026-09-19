# dmokong-plugins

A plugin marketplace for **Claude Code and Codex**. Five plugins, three of which live in this
repo and two of which are vendored from their own repos by URL.

```bash
claude plugin marketplace add DMokong/claude-plugins
claude plugin install fable-mode@dmokong-plugins
```

```bash
codex plugin marketplace add DMokong/claude-plugins
codex plugin add fable-mode@dmokong-plugins
# then start a new Codex thread — skills are cached per session
```

Codex can install this marketplace directly from `.claude-plugin/marketplace.json`, including
plugins whose source is an external Git URL; neither a Codex catalog nor Codex manifests are
required for installation. This repo still carries both so Codex gets deliberate policy/category
and interface/listing metadata, and so each plugin can describe its real Codex support instead of
implying unsupported features work. When `.agents/plugins/marketplace.json` exists, Codex prefers it
over the Claude catalog, so it **must name every plugin in the Claude catalog**.
External Codex entries must use
`{"source":"url","url":"https://github.com/<owner>/<repo>.git"}`; the tempting
`source: "git"` and `source: "github"` variants are silently dropped. For a Git marketplace,
`--ref <ref>` pins the whole repository snapshot and `codex plugin marketplace upgrade <name>`
updates the registered source.

## Plugins

| Plugin | Version | Lives in | What it does |
|---|---|---|---|
| [`fable-mode`](plugins/fable-mode) | 1.1.1 | this repo | Fable 5's working discipline as a skill — a five-gate task loop (scope → evidence → adversarial reasoning → verification → calibrated reporting) for complex, multi-step, or uncertain work. |
| [`fable-conductor`](plugins/fable-conductor) | 1.2.1 | this repo | Orchestration of whole work streams — Fable owns shaping, spec, planning, escalations, and final review; autonomous opus/sonnet/haiku adversarial waves run everything mechanical in between, coordinated through durable file contracts. |
| [`herdr-jutsu`](plugins/herdr-jutsu) | 0.2.1 | this repo | Raise and run a crew inside Herdr — spawn Claude/Codex sessions and CLI panes into panes, tabs, workspaces or git worktrees under one name that joins herdr agents to ListAgents/SendMessage; drive Codex over herdr, handle blocked members, hand long jobs to a fresh session. |
| `speculator` | 2.21.1 | [DMokong/speculator](https://github.com/DMokong/speculator) | Spec-quality scoring and a 7-gate pipeline (4 required, 3 opt-in) with LLM-as-judge evaluation, worktree isolation, and beads tracking. Includes `asbuilt-quiz`. |
| `lego-plan-builder` | 0.1.0 | [DMokong/lego-plan-builder](https://github.com/DMokong/lego-plan-builder) | Official-manual-style LEGO build instructions from an idea or image, with a deterministic physics/legality pipeline and a printable booklet. |

`fable-mode` and `fable-conductor` stack: fable-mode disciplines how a *single*
session works, fable-conductor orchestrates *many* across the model ladder.

## Surface support

| Plugin | Claude Code | Codex |
|---|---|---|
| `fable-mode` | full | full |
| `fable-conductor` | full | reference only — orchestration engine is Claude Code only |
| `herdr-jutsu` | full — a Claude Code parent additionally gets ListAgents/SendMessage for Claude crew members (`references/parent-claude.md`), and needs nothing extra to spawn, brief and pull Codex members | **one live pass**: a Codex parent has raised, briefed and pulled from a Claude child end to end, by placing it with literal `herdr pane`/`herdr agent` calls. It needs user-approved Codex rules letting those commands run outside the sandbox, and gets no sender authentication, queued delivery or idle notification over the Herdr bus. Driving `jutsu-spawn.sh` from Codex, non-pane placement, and machines with no herdr rules are unexercised — see `references/parent-codex.md` |

`speculator` and `lego-plan-builder` are vendored from their own repos and are not covered by this
table — see their own repos for surface support.

## Runtime prerequisites

| Plugin | Requires |
|---|---|
| `fable-mode` | none — pure working-discipline instructions, no tools, no network, no credentials |
| `fable-conductor` | Claude Code; full orchestration (Phases 4-5) needs the `Workflow` tool, and degrades to Agent-tool parallel batches without it; optional: `superpowers`, `speculator`, `beads` (probed, never assumed) |
| `herdr-jutsu` | running inside a Herdr pane (`HERDR_ENV=1`), Herdr >= 0.8.2, `jq`, `git`, bash 3.2+; from a Codex session also your own Codex rules allowing the `herdr` commands (and the spawn script's path) to run outside the sandbox — the skill says what it needs and never edits a rules file |

## Layout

```
.claude-plugin/marketplace.json   Canonical catalog — read by Claude Code and natively by Codex;
                                  every plugin's version lives here too
.agents/plugins/marketplace.json  Optional Codex override for policy/category metadata; because
                                  it takes precedence, it must list every canonical plugin
plugins/<name>/                   in-repo plugins; the cache builder ships
                                  EVERYTHING under here, so keep it clean
plugins/<name>/.codex-plugin/     Optional Codex listing/interface metadata for that plugin
.eval-workspaces/                 skill-creator eval fixtures (gitignored)
scripts/                          check-manifests.sh, codex-install-check.sh, codex-disposable.sh
tests/                            check-manifests mutation tests, and the herdr-jutsu
                                  behavioral suite (tests/herdr-jutsu/run.sh, stub herdr)
RELEASE.md                        how to ship a release — read before editing
```

## Releasing

**Editing a plugin here does not ship it.** Running sessions load from a
versioned cache, so an in-place edit is inert until a new cache is built.
[`RELEASE.md`](RELEASE.md) has the four steps, the verification commands, and
the traps.

Tag conventions differ by repo shape, deliberately:

- **In this repo** — `<name>--v<version>` (e.g. `fable-mode--v1.1.0`). The three
  plugins release independently, so tags must name which one shipped.
- **Standalone plugin repos** — plain `vX.Y.Z` (speculator uses this across 15
  releases). One plugin per repo means there is nothing to disambiguate, and
  the prefix would be noise.

Adopted 2026-08-09. Versions before that are untagged in this repo and are not
worth reconstructing.

## Keeping this file honest

The plugin table above duplicates state that lives in `.claude-plugin/marketplace.json`,
`.agents/plugins/marketplace.json`, and each in-repo plugin's two manifests, which means it can
drift and silently become a lie. **Updating it is step 1 of the release checklist in
`RELEASE.md`, not an afterthought.** When you bump a version, change it here in the same commit.

Check for drift at any time — this checks catalog name parity plus all four version-carrying
surfaces for in-repo plugins (Claude manifest, Claude catalog, Codex manifest, this table), not
just the one `jq` used to check:

```bash
scripts/check-manifests.sh
```

Anything in this README that cannot be checked by a command is a claim someone
has to maintain by hand — prefer adding the command over adding the prose.
