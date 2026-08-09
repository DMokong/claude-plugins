# Releasing a plugin from this marketplace

Two plugins live in this repo: `fable-mode` and `fable-conductor`. The other
marketplace entries (`speculator`, `lego-plan-builder`) are separate GitHub
repos — this document does not govern them.

## The four steps

A release is not an edit. Editing files here changes **nothing** for anyone
running the plugin until a new cache is built — see [The trap](#the-trap).

```bash
# 1. Bump BOTH manifests to the same version. They must agree or step 3 fails.
jq '.version = "X.Y.Z"' plugins/<name>/.claude-plugin/plugin.json   | sponge …
jq '(.plugins[] | select(.name == "<name>") | .version) = "X.Y.Z"' \
   .claude-plugin/marketplace.json | sponge …

claude plugin validate plugins/<name>      # manifest sanity

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

Because the two plugins here release independently, `HEAD` is frequently the
*other* plugin's release commit. Check before tagging.

## Never put non-plugin files under `plugins/<name>/`

The cache is built from the plugin directory, so anything sitting there ships to
every consumer. A 36-file skill-creator eval workspace was found inside
`plugins/fable-mode/skills/` and had been copied into the built cache.

Eval workspaces belong in `.eval-workspaces/` at the repo root — outside every
plugin directory, and gitignored. Run them with `claude plugin eval`.
