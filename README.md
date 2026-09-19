# dmokong-plugins

A Claude Code plugin marketplace. Four plugins, two of which live in this repo
and two of which are vendored from their own repos by URL.

```bash
claude plugin marketplace add DMokong/claude-plugins
claude plugin install fable-mode@dmokong-plugins
```

## Plugins

| Plugin | Version | Lives in | What it does |
|---|---|---|---|
| [`fable-mode`](plugins/fable-mode) | 1.1.1 | this repo | Fable 5's working discipline as a skill — a five-gate task loop (scope → evidence → adversarial reasoning → verification → calibrated reporting) for complex, multi-step, or uncertain work. |
| [`fable-conductor`](plugins/fable-conductor) | 1.2.1 | this repo | Orchestration of whole work streams — Fable owns shaping, spec, planning, escalations, and final review; autonomous opus/sonnet/haiku adversarial waves run everything mechanical in between, coordinated through durable file contracts. |
| [`herdr-jutsu`](plugins/herdr-jutsu) | 0.2.0 | this repo | Raise and run a crew inside Herdr — spawn Claude/Codex sessions and CLI panes into panes, tabs, workspaces or git worktrees under one name that joins herdr agents to ListAgents/SendMessage; drive Codex over herdr, handle blocked members, hand long jobs to a fresh session. |
| `speculator` | 2.21.1 | [DMokong/speculator](https://github.com/DMokong/speculator) | Spec-quality scoring and a 7-gate pipeline (4 required, 3 opt-in) with LLM-as-judge evaluation, worktree isolation, and beads tracking. Includes `asbuilt-quiz`. |
| `lego-plan-builder` | 0.1.0 | [DMokong/lego-plan-builder](https://github.com/DMokong/lego-plan-builder) | Official-manual-style LEGO build instructions from an idea or image, with a deterministic physics/legality pipeline and a printable booklet. |

`fable-mode` and `fable-conductor` stack: fable-mode disciplines how a *single*
session works, fable-conductor orchestrates *many* across the model ladder.

## Layout

```
.claude-plugin/marketplace.json   registry — every plugin's version lives here too
plugins/<name>/                   in-repo plugins; the cache builder ships
                                  EVERYTHING under here, so keep it clean
.eval-workspaces/                 skill-creator eval fixtures (gitignored)
RELEASE.md                        how to ship a release — read before editing
```

## Releasing

**Editing a plugin here does not ship it.** Running sessions load from a
versioned cache, so an in-place edit is inert until a new cache is built.
[`RELEASE.md`](RELEASE.md) has the four steps, the verification commands, and
the traps.

Tag conventions differ by repo shape, deliberately:

- **In this repo** — `<name>--v<version>` (e.g. `fable-mode--v1.1.0`). The two
  plugins release independently, so tags must name which one shipped.
- **Standalone plugin repos** — plain `vX.Y.Z` (speculator uses this across 15
  releases). One plugin per repo means there is nothing to disambiguate, and
  the prefix would be noise.

Adopted 2026-08-09. Versions before that are untagged in this repo and are not
worth reconstructing.

## Keeping this file honest

The plugin table above duplicates state that lives in
`.claude-plugin/marketplace.json`, which means it can drift and silently become
a lie. **Updating it is step 1 of the release checklist in `RELEASE.md`, not an
afterthought.** When you bump a version, change it here in the same commit.

Check for drift at any time:

```bash
jq -r '.plugins[] | "\(.name) \(.version)"' .claude-plugin/marketplace.json
```

Anything in this README that cannot be checked by a command is a claim someone
has to maintain by hand — prefer adding the command over adding the prose.
