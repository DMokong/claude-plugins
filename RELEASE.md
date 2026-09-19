# Releasing a plugin from this marketplace

Three plugins live in this repo: `fable-mode`, `fable-conductor`, and `herdr-jutsu`. Each is
packaged for two catalogs — the Claude catalog (`.claude-plugin/marketplace.json`) and the Codex
catalog (`.agents/plugins/marketplace.json`) — so a release ships to both surfaces at once. The
other marketplace entries (`speculator`, `lego-plan-builder`) are separate GitHub
repos — this document does not govern them.

## The four steps

A release is not an edit. Editing files here changes **nothing** for anyone
running the plugin until a new cache is built — see [The trap](#the-trap).

```bash
# 1. Bump ALL THREE version fields to the same value. They must agree or step 3 fails.
jq '.version = "X.Y.Z"' plugins/<name>/.claude-plugin/plugin.json   | sponge …
jq '(.plugins[] | select(.name == "<name>") | .version) = "X.Y.Z"' \
   .claude-plugin/marketplace.json | sponge …
jq '.version = "X.Y.Z"' plugins/<name>/.codex-plugin/plugin.json    | sponge …

#    Then update the plugin table in README.md — same version, same commit.
#    All three manifests plus the README row duplicate each other and will
#    silently drift otherwise. Drift check (all four surfaces, not just one):
scripts/check-manifests.sh                 # must exit 0 before committing

claude plugin validate plugins/<name>              # Claude manifest sanity
scripts/codex-install-check.sh <name>              # Codex install sanity — installs into a
                                                    # disposable CODEX_HOME and checks the cache
                                                    # holds a matching version + a SKILL.md;
                                                    # never touches the real ~/.codex

# 2. Commit and push.
git add plugins/<name> .claude-plugin/marketplace.json
git commit && git push

# 3. Tag the release commit. Validates plugin.json vs marketplace entry agree.
claude plugin tag plugins/<name> --push    # -> <name>--v<X.Y.Z>, annotated

# 4. Activate: refresh the marketplace, then rebuild the plugin cache.
claude plugin marketplace update dmokong-plugins
claude plugin update <name>@dmokong-plugins   # NOTE: @marketplace suffix required
```

Then **restart any running session** — skills are cached per session, so even a
correctly released plugin does not reach a session that was already open.

### Verify the release actually landed

```bash
ls ~/.claude/plugins/cache/dmokong-plugins/<name>/        # new version dir present?
grep -c "<a string you just added>" \
  ~/.claude/plugins/cache/dmokong-plugins/<name>/<X.Y.Z>/skills/*/SKILL.md
```

## The trap

Running sessions load from the **versioned cache**
(`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`), never from this
working tree. So an in-place edit here is *wired but inactive*: it looks shipped
and is a no-op.

Two consequences that surprise people:

- **Several versions are refcounted at once.** Sessions pin the version they
  started with, and a single session can appear under two. There is no single
  "current" version to reason about.
- **`.in_use` holds lock files, not live sessions.** Stale locks accumulate when
  a process exits without cleanup — a directory showing 25 entries had 6 live
  processes when last measured. Count with `ps`, not `wc -l`, and treat any such
  figure as a snapshot with a reading time.

## Tag convention

`<name>--v<X.Y.Z>`, annotated, pointing at that plugin's own release commit.
Adopted 2026-08-09. Backfilled: `fable-conductor--v1.1.3`, `fable-mode--v1.1.0`.
Earlier versions are untagged and are not worth reconstructing.

Use `claude plugin tag` at release time — it tags `HEAD`, which is correct when
you have just pushed the release commit. To tag a release that is no longer
`HEAD`, tag by hand at the right commit in the same format:

```bash
git tag -a <name>--v<X.Y.Z> -m "<name> <X.Y.Z>" <commit>
git push origin refs/tags/<name>--v<X.Y.Z>
```

Because the plugins here release independently, `HEAD` is frequently the
*other* plugin's release commit. Check before tagging.

## Codex

A Codex user installs from this repo's Codex catalog, `.agents/plugins/marketplace.json`:

```bash
codex plugin marketplace add DMokong/claude-plugins
codex plugin add <name>@dmokong-plugins
# then start a new Codex thread — skills load per-thread, same caching rule as Claude Code
```

Codex has `plugin marketplace add|list|upgrade|remove` and `plugin add|list|remove`; there is no
`install`/`update` verb pair the way Claude Code has one.

**Refreshing an installed plugin.** For the local-marketplace case this was proved directly
(`docs/codex-packaging-findings.md`, Experiment 5): re-running `codex plugin add
<name>@dmokong-plugins` alone is sufficient — it replaces the cached copy rather than
accumulating, no `codex plugin remove` and no `codex plugin marketplace upgrade` needed — then a
new thread picks up the change. `codex plugin marketplace upgrade` is a Git-only verb: against a
local marketplace it is a no-op (`No configured Git marketplaces to upgrade`) or an error
(`marketplace 'dmokong-plugins' is not configured as a Git marketplace`), proved the same
experiment. Once this repo's marketplace is registered as a **Git** source (i.e. once
`.agents/plugins/marketplace.json` is on `main` and reachable over `owner/repo`, `https://`, or
`ssh://`), the expected refresh sequence is `codex plugin marketplace upgrade dmokong-plugins`
followed by a re-`codex plugin add <name>@dmokong-plugins` and a new thread — **this is not yet
verified**; the install spike could not reach a Git marketplace source from this machine (Remote
Login was off). Verify it once the Codex catalog is reachable on `main`:

```bash
codex plugin marketplace add DMokong/claude-plugins --ref main
# bump a version on main, then:
codex plugin marketplace upgrade dmokong-plugins
codex plugin add <name>@dmokong-plugins
# new thread, then check the cache directory holds the bumped version
```

**Git marketplace tracking.** A Codex Git marketplace follows the branch it was added from — the
repo's default branch unless `--ref <ref>` is given at `marketplace add` time. That means the
per-plugin `<name>--v<X.Y.Z>` tags this repo cuts (see [Tag convention](#tag-convention)) are
informational on the Codex side only: nothing in the install path reads them, and re-adding with
`--ref <tag>` is the only way a Codex user would pin to one. Whether `--ref` pins the *whole
repo's* Git marketplace snapshot (not just which tags are visible) is unverified — `codex plugin
marketplace add --help` documents `--ref` as a repository-level option, which reads as whole-repo
pinning, but no Git source could be exercised to confirm it (`docs/codex-packaging-findings.md`,
Experiment 3 / "Still unverified").

**Catalog-name collision.** Registering the catalog name `dmokong-plugins` from a second, different
source is refused outright until the first is removed with `codex plugin marketplace remove
dmokong-plugins` — proved local→local (`docs/codex-packaging-findings.md`, Experiment 3). Relevant
to anyone who already added a local checkout of this repo before this catalog reached `main`: adding
the Git source under the same name will fail until the local one is removed.

**Managed machines.** A managed Codex install can restrict which marketplace sources are allowed
at all, via a policy key spelled `marketplaces.restrict_to_allowed_sources` (paired with
`marketplaces.allowed_sources`) — **reported, not confirmed on 0.153.4**: neither `codex plugin
marketplace add --help` nor the CLI's shipped docs under a disposable `CODEX_HOME` spell out this
key's home file or exact enforcement behaviour (they do note that `config.toml` defaults and a
separate `requirements.toml` / administrator-managed policy are kept apart, which is the likely
home for it, but that inference was not confirmed against a real managed instance). If `codex
plugin marketplace add DMokong/claude-plugins` is refused on a managed machine, ask the admin
whether this repo's source needs adding to that allowlist.

## Never put non-plugin files under `plugins/<name>/`

The cache is built from the plugin directory, so anything sitting there ships to
every consumer. A 36-file skill-creator eval workspace was found inside
`plugins/fable-mode/skills/` and had been copied into the built cache.

Eval workspaces belong in `.eval-workspaces/` at the repo root — outside every
plugin directory, and gitignored. Run them with `claude plugin eval`.

The Codex cache is the same story: it is also a verbatim copy of the plugin directory (proved,
`docs/codex-packaging-findings.md` Experiment 4 / "commands/*.md not a Codex surface" — `commands/`
and `agents/*.md` get copied into the Codex cache same as everything else), so this rule covers
both surfaces, not just Claude Code's.
