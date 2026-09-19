# Codex packaging findings (Phase 0 install spike)

This is the recorded result of installing this repo's plugins into the Codex CLI, not a reading of
documentation. Every claim below is followed by the command that produced it. The spike answers the
five Phase 0 questions: where the Codex plugin manifest goes, what it must contain, how the catalog
name behaves on collision, whether the Claude and Codex packaging disturb each other, and what
sequence actually refreshes an installed plugin after a version bump.

Headline: `.codex-plugin/plugin.json` is the location to use — both locations install, but the
Codex-shipped validator only accepts `.codex-plugin/`, and when both exist `.codex-plugin/` wins.
The `interface` block is required by that validator but **not** by `codex plugin add`. A local
marketplace needs no cachebuster: a bare `codex plugin add <plugin>@<catalog>` re-copies the source
every time. `fable-mode` installs from this repo and its skill reaches the model-visible prompt.

Versions tested:

```
$ codex --version
codex-cli 0.153.4
$ claude --version
2.1.276 (Claude Code)
```

Every Codex invocation in this spike ran through `scripts/codex-disposable.sh` with `CODEX_HOME`
pointed at a fresh `mktemp -d`. Throwaway variants (second manifest location, bumped versions, bare
Git clone) were built in copies of the repo outside the checkout. The real Codex config was
checksummed before the first and after the last command and did not change. Absolute scratch paths
in the output below are shortened to `$SCRATCH` and `$CODEX_HOME`.

## Contradictions

None. No plan Fact was contradicted in a way that changes what tasks A1–A4 must build.

Three refinements worth carrying forward, none of which invalidate the plan:

1. The plan recorded the root-vs-`.codex-plugin` manifest question as *unsettled*. It is now
   settled in favour of `.codex-plugin/plugin.json` (Experiment 1).
2. The plan's description of installed OpenAI manifests ("every one carries `name`, semver
   `version`, … and a full `interface` block") describes convention, not enforcement: `codex plugin
   add` accepts a manifest missing all of them, and accepts a plugin with no Codex manifest at all
   (Experiment 2). Because A1/A5 require the Codex manifest version to equal the Claude manifest
   version, the version field must still be present and correct — Codex will not error, it will
   silently name the cache directory `local`.
3. Catalog entries carry no version (plan fact confirmed), but `policy.authentication` is a closed
   enum: only `ON_INSTALL` and `ON_USE` are accepted. `NONE` is rejected at `marketplace add`
   (Experiment 3).

## Facts table

One row per bullet under the plan's "Facts" heading.

| Plan fact | confirmed / contradicted / not tested | evidence (section ref) |
| --- | --- | --- |
| Codex has `plugin marketplace add\|list\|upgrade\|remove` and `plugin add\|list\|remove`; no `install`/`update` verbs | confirmed | Experiment 5, help output |
| Catalog lives at `<repo>/.agents/plugins/marketplace.json`; entries are `{name, source:{source:"local", path}, policy:{installation, authentication}, category}`; entries carry no version | confirmed, with one refinement | Experiment 3 — shape accepted verbatim; `authentication` rejects values outside `ON_INSTALL`/`ON_USE` |
| Codex plugin manifest lives at `plugins/<n>/.codex-plugin/plugin.json`; root `plugin.json` is the unsettled alternative; manifests carry `name`, semver `version`, `description`, `author.name`, `skills`, full `interface` | confirmed as the right choice; the field list is convention, not enforcement | Experiment 1 (location, precedence), Experiment 2 (field removal matrix) |
| `.claude-plugin/` and `.codex-plugin/` can coexist per plugin and share one `skills/` tree; no fork, no sync script | confirmed | Experiment 4 |
| Codex discovers skills from plugin caches, `~/.agents/skills`, and repo-ancestor `.agents/skills`; `name` + `description` drive loading | confirmed, with one refinement | Experiment 4 — the repo-ancestor root is only offered when the ancestor is a Git repository |
| `${CLAUDE_PLUGIN_ROOT}` is not set for skills; `commands/*.md` is not a Codex surface | not tested | needs an authenticated `codex exec`; see Still unverified |
| Codex has no Workflow tool and no AskUserQuestion; its subagent tools are scoped to its own tree; `codex agents` / `codex queue` delivery semantics unverified | not tested | out of scope for a packaging spike; belongs to Stream B |
| Three version fields can drift (Claude manifest, Claude catalog, Codex manifest) plus the README table | confirmed, and the coupling is tighter than assumed | Experiment 2 — with no Codex manifest, Codex reads the version straight out of `.claude-plugin/plugin.json` |

## Experiment 1 — manifest location

Three scratch copies of the repo, each with one `fable-mode` catalog entry: (a) root
`plugins/fable-mode/plugin.json` only, (b) `plugins/fable-mode/.codex-plugin/plugin.json` only,
(c) both, with the root manifest marked `9.9.9`/`ROOT-WINS` and the `.codex-plugin` manifest marked
`1.1.0`/`CODEXDIR-WINS`.

Codex ships its own validator as a system skill — `plugin-creator` — with a runnable, auth-free
`scripts/validate_plugin.py`. It was used throughout this spike.

```
$ python3 <codex-home>/skills/.system/plugin-creator/scripts/validate_plugin.py $SCRATCH/e1a/plugins/fable-mode
Plugin validation failed:
- missing `.codex-plugin/plugin.json`
$ python3 ... $SCRATCH/e1b/plugins/fable-mode
Plugin validation passed: $SCRATCH/e1b/plugins/fable-mode
$ python3 ... $SCRATCH/e1c/plugins/fable-mode
Plugin validation passed: $SCRATCH/e1c/plugins/fable-mode
```

Live install, one fresh `CODEX_HOME` per variant:

```
$ export CODEX_HOME=$(mktemp -d)
$ scripts/codex-disposable.sh plugin marketplace add $SCRATCH/e1a
Added marketplace `dmokong-plugins` from $SCRATCH/e1a.
$ scripts/codex-disposable.sh plugin add fable-mode@dmokong-plugins
Added plugin `fable-mode` from marketplace `dmokong-plugins`.
Installed plugin root: $CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/1.1.0
   (variant b: identical, version 1.1.0)
   (variant c: identical, version 1.1.0 — NOT 9.9.9)
$ scripts/codex-disposable.sh plugin list --json   # variant c
{"installed":[{"pluginId":"fable-mode@dmokong-plugins","name":"fable-mode",
  "marketplaceName":"dmokong-plugins","version":"1.1.0","installed":true,"enabled":true,
  "source":{"source":"local","path":"$SCRATCH/e1c/plugins/fable-mode"},
  "installPolicy":"AVAILABLE","authPolicy":"ON_USE"}],"available":[]}
```

In variant (c) both manifests are copied into the cache, but the cache directory is named `1.1.0`
and `plugin list` reports `1.1.0` — the `.codex-plugin` value.

**Conclusion (verified):** 0.153.4 installs from either location, `.codex-plugin/plugin.json` takes
precedence when both are present, and the shipped validator accepts only `.codex-plugin/`. Use
`plugins/<name>/.codex-plugin/plugin.json`; do not ship a root `plugin.json`.

## Experiment 2 — minimum valid manifest

Starting from the full shape and deleting one field at a time. Each row: a fresh `CODEX_HOME`,
`marketplace add` + `plugin add fable-mode@dmokong-plugins`, then `plugin list --json`.

| removal | `validate_plugin.py` | `codex plugin add` | version Codex reports |
| --- | --- | --- | --- |
| (baseline, full manifest) | passed | rc=0 | 1.1.0 |
| `license` | passed | rc=0 | 1.1.0 |
| `keywords` | passed | rc=0 | 1.1.0 |
| `skills` | passed | rc=0 | 1.1.0 |
| `author` | failed: ``field `author` must be an object`` | rc=0 | 1.1.0 |
| `interface` | failed: ``field `interface` must be an object`` | rc=0 | 1.1.0 |
| `name` | failed: ``field `name` must be a non-empty string`` | rc=0 | 1.1.0 |
| `description` | failed: ``field `description` must be a non-empty string`` | rc=0 | 1.1.0 |
| `version` | failed: ``field `version` must be a non-empty string`` | rc=0 | **`local`** |
| `version` = `"1.1"` | failed: ``field `version` must be strict semver`` | rc=0 | **`1.1`** |
| whole manifest `{}` | failed (5 errors) | rc=0 | **`local`** |
| no `.codex-plugin/plugin.json` at all | n/a | rc=0 | **1.1.0, read from `.claude-plugin/plugin.json`** |
| `name` set to `not-fable-mode` | passed | **rc=1** | not installed |
| manifest is malformed JSON | n/a | **rc=1** | not installed |

The only two install-blocking failures:

```
$ scripts/codex-disposable.sh plugin add fable-mode@dmokong-plugins   # name mismatch
Error: plugin.json name `not-fable-mode` does not match marketplace plugin name `fable-mode`
$ scripts/codex-disposable.sh plugin add fable-mode@dmokong-plugins   # malformed JSON
Error: failed to parse plugin.json: key must be a string at line 1 column 3
```

The `.claude-plugin` fallback, proven by setting the Claude manifest to `7.7.7` with no Codex
manifest present, then re-testing with a `1.1.0` Codex manifest added:

```
$ scripts/codex-disposable.sh plugin add fable-mode@dmokong-plugins   # no .codex-plugin
Installed plugin root: $CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/7.7.7
{"version":"7.7.7"}
$ scripts/codex-disposable.sh plugin add fable-mode@dmokong-plugins   # .codex-plugin added
Installed plugin root: $CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/1.1.0
{"version":"1.1.0"}
```

Skill discovery is independent of the `skills` field. `codex debug prompt-input` renders the
model-visible prompt without auth and lists the loaded skills:

```
$ cd $SCRATCH && scripts/codex-disposable.sh debug prompt-input "hi"
### Skill roots
- `r0` = `<home>/.agents/skills`
- `r1` = `$CODEX_HOME/skills/.system`
- `r2` = `$CODEX_HOME/plugins/cache/dmokong-plugins`
### Available skills
- fable-mode:fable-mode: Use PROACTIVELY the moment you notice a task has many layers …
```

Re-probed across variants:

```
no-skills-field    -> - fable-mode:fable-mode
no-codex-manifest  -> - fable-mode:fable-mode
no-interface       -> - fable-mode:fable-mode
empty-manifest     -> - local:fable-mode
root-plugin-json   -> - fable-mode:fable-mode
```

The skill namespace is the manifest `name`; with an empty manifest the namespace degrades to
`local`, so a skill invoked as `fable-mode:fable-mode` would not resolve.

**Conclusion (verified):** `codex plugin add` enforces only two things — the manifest must be
parseable JSON, and if it carries a `name` that name must equal the catalog entry name. Everything
else is advisory to the CLI. **The `interface` block is NOT required to install.** It *is* required
by the shipped validator, and it is what supplies the plugin's presentation copy, so this repo
carries it. `version` is effectively required for our purposes: without a valid semver the cache
directory and `plugin list` report `local` or the malformed string, which breaks any version
assertion. `author` and `description` are required by the validator; `license`, `keywords` and
`skills` are optional everywhere and affect nothing observable in `plugin list`.

## Experiment 3 — catalog name and collision

Catalog named `dmokong-plugins`, the shape the plan describes, accepted verbatim — except that
`policy.authentication` is a closed enum:

```
$ scripts/codex-disposable.sh plugin marketplace add $SCRATCH/e1a   # authentication: "NONE"
Error: invalid marketplace file `$SCRATCH/e1a/.agents/plugins/marketplace.json`:
unknown variant `NONE`, expected `ON_INSTALL` or `ON_USE` at line 7 column 71
```

With `ON_USE` the same file is accepted. `marketplace add` writes this into `$CODEX_HOME/config.toml`:

```toml
[marketplaces.dmokong-plugins]
source_type = "local"
source = "$SCRATCH/e1a"

[plugins."fable-mode@dmokong-plugins"]
enabled = true
```

The `[marketplaces.…]` table is written by `marketplace add`; the `[plugins."…"]` table is written
by `plugin add` and removed again by `plugin remove`.

Collision, same catalog name from two different local sources:

```
$ scripts/codex-disposable.sh plugin marketplace add $SCRATCH/e3/work
Added marketplace `dmokong-plugins` from $SCRATCH/e3/work.
$ scripts/codex-disposable.sh plugin marketplace add $SCRATCH/e3/work2
Error: marketplace 'dmokong-plugins' is already added from a different source; remove it before adding this source
rc=1
$ scripts/codex-disposable.sh plugin marketplace add $SCRATCH/e3/work   # same source again
Marketplace `dmokong-plugins` is already added from $SCRATCH/e3/work.
rc=0
$ scripts/codex-disposable.sh plugin marketplace remove dmokong-plugins
Removed marketplace `dmokong-plugins`.
$ scripts/codex-disposable.sh plugin marketplace add $SCRATCH/e3/work2
Added marketplace `dmokong-plugins` from $SCRATCH/e3/work2.
```

After swapping the source, `plugin list` still reports the *already installed* `1.1.0` from the old
source — `marketplace remove` + `add` does not touch an installed plugin cache.

The Git-source half of this question could not be run. Codex rejects a local Git URL:

```
$ scripts/codex-disposable.sh plugin marketplace add file://$SCRATCH/e3/bare.git
Error: invalid marketplace source format; expected owner/repo, a git URL, or a local marketplace path
$ scripts/codex-disposable.sh plugin marketplace add git+file://$SCRATCH/e3/bare.git
Error: invalid marketplace source format; …
$ scripts/codex-disposable.sh plugin marketplace add git://localhost$SCRATCH/e3/bare.git
Error: invalid marketplace source format; …
$ scripts/codex-disposable.sh plugin marketplace add ssh://localhost$SCRATCH/e3/bare.git
Error: git clone ssh://localhost… failed with status exit status: 128
$ ssh -o BatchMode=yes -o ConnectTimeout=4 localhost true
ssh: connect to host localhost port 22: Connection refused
```

`ssh://` *is* accepted by the source parser and handed to `git clone`, so a Git source is reachable
in principle, but this machine has Remote Login off and enabling it was out of scope. Nothing was
pushed anywhere.

**Conclusion (verified for local→local; unverified for Git):** the catalog name `dmokong-plugins` is
the identity key. Registering it from a second, different source is refused outright — Codex never
silently repoints a catalog; the operator must `marketplace remove` first. Re-adding the identical
source is idempotent and rc=0. Whether a Git source collides with an existing local source under the
same name is **unverified**; the error text says "from a different source" rather than "a different
path", which suggests the same guard applies, but that is inference, not evidence.

## Experiment 4 — coexistence

Codex side: every install in this spike ran against a plugin directory containing
`.claude-plugin/plugin.json`. It never interfered; the file is simply copied into the cache
alongside the Codex manifest:

```
$CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/1.1.0/.claude-plugin/plugin.json
$CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/1.1.0/.codex-plugin/plugin.json
$CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/1.1.0/skills/fable-mode/SKILL.md
```

One `skills/` tree serves both surfaces — no fork, no sync script.

Claude side, with `.agents/plugins/marketplace.json` and
`plugins/fable-mode/.codex-plugin/plugin.json` both present in the checkout:

```
$ claude plugin validate .
Validating marketplace manifest: <repo>/.claude-plugin/marketplace.json
✔ Validation passed
rc=0
$ claude plugin validate plugins/fable-mode
Validating plugin manifest: <repo>/plugins/fable-mode/.claude-plugin/plugin.json
✔ Validation passed
rc=0
$ python3 <codex-home>/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/fable-mode
Plugin validation passed: <repo>/plugins/fable-mode
rc=0
```

Repo-ancestor skill discovery, tested with a probe skill at `<workdir>/.agents/skills/spike-probe/`:

```
# before `git init` in <workdir>, cwd=<workdir>/sub
- `r0` = `<home>/.agents/skills`
- `r1` = `$CODEX_HOME/skills/.system`
  spike-probe discovered: False
# after `git init` + commit in <workdir>
  cwd=<workdir>       spike-probe discovered: True   r2 = `<workdir>/.agents/skills`
  cwd=<workdir>/sub   spike-probe discovered: True   r2 = `<workdir>/.agents/skills`
```

**Conclusion (verified):** the two packaging trees do not disturb each other in either direction.
Repo-ancestor `.agents/skills` is discovered from the working directory and its subdirectories, but
only once that ancestor is a Git repository — an untracked directory tree is not scanned.

## Experiment 5 — two-version refresh

Install `1.1.0`, edit the source manifest to `1.1.1`, then try each refresh verb in turn against the
same `CODEX_HOME`, inspecting the cache directory after every step.

```
STEP 0 install v1.1.0
Installed plugin root: $CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/1.1.0
   cache dirs: 1.1.0   | list version: 1.1.0
STEP 1 bump source manifest to 1.1.1 (no codex command)
   cache dirs: 1.1.0   | list version: 1.1.0
STEP 2 marketplace upgrade
   rc=0 : No configured Git marketplaces to upgrade.
   cache dirs: 1.1.0   | list version: 1.1.0
STEP 3 marketplace upgrade dmokong-plugins
   rc=1 : Error: marketplace `dmokong-plugins` is not configured as a Git marketplace
   cache dirs: 1.1.0   | list version: 1.1.0
STEP 4 plugin add (re-add, no remove)
   rc=0 : Installed plugin root: $CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/1.1.1
   cache dirs: 1.1.1   | list version: 1.1.1
```

`marketplace upgrade` is a Git-only verb and is a no-op (step 2) or an error (step 3) for a local
marketplace. `plugin add` alone is sufficient, and it replaces rather than accumulates: after step 4
the `1.1.0` directory is gone.

Content changes without a version bump are also picked up — no cachebuster is needed for a local
marketplace:

```
before: source=8b117b396b11 cached=8b117b396b11
after edit (no version bump): source=44db320eff88
re-add rc=0 : Installed plugin root: $CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/1.1.1
cached now: 44db320eff88  marker present: 1
```

`plugin remove` deletes the cache directory and the `config.toml` entry:

```
$ scripts/codex-disposable.sh plugin remove fable-mode@dmokong-plugins
Removed plugin `fable-mode` from marketplace `dmokong-plugins`.
cache after remove: [ls: …/cache/dmokong-plugins/fable-mode: No such file or directory]
config plugins block after remove: 0
```

**Conclusion (verified for a local marketplace; unverified for Git):** the shortest refresh sequence
is one command — `codex plugin add <plugin>@dmokong-plugins` — with no `remove` and no
`marketplace upgrade`. Per the Codex-shipped `plugin-creator` reference, a new thread is still
needed for the session to pick up the refreshed skills. Whether `--ref` pins the whole repo for a
Git marketplace is **unverified**; `codex plugin marketplace add --help` documents `--ref <REF>`
("Git ref to fetch for Git marketplace sources") and `--sparse <PATH>` as repository-level options,
which reads as whole-repo pinning, but no Git source could be exercised (Experiment 3).

## What later tasks should do

Copy-pasteable facts for tasks A1–A4.

**Manifest location.** `plugins/<name>/.codex-plugin/plugin.json`. Do not add a root `plugin.json`.

**Minimum manifest** that both installs and passes the Codex-shipped validator — `name` (must equal
the catalog entry name), strict-semver `version` (must equal `plugins/<name>/.claude-plugin/plugin.json`
version), `description`, `author.name`, and an `interface` block whose `displayName`,
`shortDescription`, `longDescription`, `developerName`, `category` are non-empty strings, whose
`capabilities` is an array of strings, and which has `defaultPrompt` (or `default_prompt`).
`license`, `keywords`, `skills` are optional. Accepted top-level keys are exactly: `id`, `name`,
`version`, `description`, `skills`, `apps`, `mcpServers`, `interface`, `author`, `homepage`,
`repository`, `license`, `keywords` — any other key fails validation.

**Catalog entry shape** in `.agents/plugins/marketplace.json` (catalog `name` is `dmokong-plugins`;
entries carry no version):

```json
{
  "name": "<plugin>",
  "source": { "source": "local", "path": "./plugins/<plugin>" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_USE" },
  "category": "Developer Tools"
}
```

`policy.authentication` must be `ON_USE` or `ON_INSTALL` — nothing else parses.

**Cache path pattern.** `$CODEX_HOME/plugins/cache/<catalog>/<plugin>/<version>/`, holding a verbatim
copy of the plugin directory. For this repo that is
`$CODEX_HOME/plugins/cache/dmokong-plugins/fable-mode/1.1.0/skills/fable-mode/SKILL.md`. The plugin
cache root is offered to the model as a skill root, and skills appear namespaced as
`<plugin>:<skill>`.

**Refresh sequence.** `codex plugin add <plugin>@dmokong-plugins`, then start a new Codex thread.
No `marketplace upgrade` (Git-only), no `plugin remove`, no version cachebuster.

**Validator to run.** `python3 "$CODEX_HOME_OR_REAL/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/<plugin>`
— ships with Codex 0.153.4, needs no auth. Note it is stricter than the CLI: a manifest it rejects
may still install.

**Reusable done-check.** `scripts/codex-install-check.sh <plugin> [<plugin> …]` does the whole loop
in a disposable home and prints `PASS <plugin> <version>`; it also fails if the real Codex
`config.toml` checksum changes during the run.

## Still unverified

- **Git marketplace source of any kind.** Codex rejects `file://`, `git+file://` and `git://`; only
  `owner/repo`, `https://` and `ssh://` reach `git clone`, and Remote Login is off on this machine.
  Closes with: `scripts/codex-disposable.sh plugin marketplace add <owner>/<repo> --ref main` once
  the catalog exists on a reachable remote.
- **Catalog-name collision between a local source and a Git source.** Same command as above, run in
  a `CODEX_HOME` that already has `dmokong-plugins` registered from a local path.
- **Whether `--ref` pins the whole repo for a Git marketplace.** Closes with
  `plugin marketplace add <owner>/<repo> --ref <tag>` followed by `plugin marketplace upgrade` and a
  diff of the cached snapshot.
- **`${CLAUDE_PLUGIN_ROOT}` being unset for Codex skills, and relative reference resolution inside a
  skill.** Needs an authenticated run: `scripts/codex-disposable.sh exec "use the fable-mode skill
  and read its references"` — **unverified — needs auth**, not attempted.
- **That the skill actually triggers on a user prompt** (as opposed to being listed in the prompt,
  which Experiment 2 proves). Same command, same reason — **unverified — needs auth**.
- ~~**`commands/*.md` not being a Codex surface.**~~ **Closed — verified false-not-a-surface, i.e.
  confirmed not a surface, at least at the prompt-rendering layer (0.153.4).** Installed
  `fable-conductor@dmokong-plugins` (which ships `commands/conduct.md` and six `agents/*.md` files)
  into a fresh disposable `CODEX_HOME` and inspected both the cache and the model-visible prompt:

  ```
  $ find $CODEX_HOME/plugins/cache/dmokong-plugins/fable-conductor/1.2.0 | sort
  .../1.2.0/.claude-plugin/plugin.json
  .../1.2.0/.codex-plugin/plugin.json
  .../1.2.0/agents/adversarial-reviewer.md
  .../1.2.0/agents/implementer.md
  .../1.2.0/agents/spec-auditor.md
  .../1.2.0/agents/test-author.md
  .../1.2.0/agents/test-breaker.md
  .../1.2.0/agents/verifier.md
  .../1.2.0/commands/conduct.md
  .../1.2.0/README.md
  .../1.2.0/skills/conduct/SKILL.md
  .../1.2.0/skills/conduct/references/{contracts,escalation,weave}.md
  .../1.2.0/skills/conduct/references/workflows/{execute-wave,final-audit,test-adversary}.js
  ```

  `commands/` and `agents/` are copied into the cache verbatim, same as every other file in the
  plugin directory (Experiment 4's "no fork, no sync script" conclusion extends to these
  directories too — Codex does not filter the copy). But `codex-disposable.sh debug prompt-input
  "hi"` — the auth-free render of the model-visible prompt already used in Experiment 2 — lists
  only one entry sourced from this plugin:

  ```
  ### Available skills
  - fable-conductor:conduct: This skill should be used when the user says "/conduct" … (file:
    r2/fable-conductor/1.2.0/skills/conduct/SKILL.md)
  ```

  `grep -n "commands/conduct\|agents/implementer\|agents/verifier\|agents/adversarial"` against the
  full prompt-input output (102 lines) returns no match (`grep exit=1`). Nothing in the
  `<skills_instructions>` block, the tool list, or anywhere else in the render names `commands/` or
  `agents/`.

  **Conclusion (verified for the prompt-rendering layer only):** `commands/*.md` and `agents/*.md`
  are copied into the Codex cache but are not surfaced to the model through `debug prompt-input` in
  any way — not as a skill, not as a tool, not as text. Whether an authenticated `codex exec` session
  can be told to open and read one of those files off disk as an ordinary file (distinct from Codex
  treating it as a first-class surface the way it treats `SKILL.md`) is a different, weaker claim
  this command cannot settle and was not attempted — no auth was available (S2). This is the basis
  for task 02's `fable-conductor` `interface` copy: a Codex user gets the `conduct` skill as readable
  reference; `/conduct` and the `agents/*.md` role files do not reach Codex as commands or subagents.
