# Parent surface: Codex

**Young path — one live pass.** A Codex parent raising a Claude child has been run end to
end once, and it worked: a Codex parent under a `workspace-write` sandbox, on a machine
whose user had already allowed the `herdr agent` and `herdr pane` command prefixes, placed
the child **by hand** (§ 3), briefed it, received its `[crew:…]` push and pulled the
evidence. One pass is one pass, so keep verifying each step from its own JSON output, and if
herdr disagrees with this file, believe herdr and tell the user.

**Not exercised yet** — do not assume any of these work: a Codex parent driving
`jutsu-spawn.sh` itself (that needs a user-approved rule for the script's own path),
`--where tab` / `--where workspace` / `--worktree` placement from Codex, and anything at all
on a machine with no herdr rules. An earlier attempt failed outright at "name yourself":
every herdr command that did not statically match one of that user's allow rules — the spawn
script included — ran inside the sandbox, where herdr's socket cannot be opened. That
failure is why § 1 and § 2 exist; it is not this path's status any more.

Read this with `SKILL.md`, not instead of it. `SKILL.md` states the weakest guarantee, and
**a Codex parent gets no strengthening at all**: there is no ListAgents and no SendMessage
here, and Codex's own `spawn_agent` / `send_message` / `wait_agent` reach only its own
subagent tree — they cannot see or address a herdr pane. So the **herdr bus is the transport
in both directions**, with everything `SKILL.md` says about it (no sender authentication,
text arrives typed as user input, it can splice into a half-typed human line) applying to
what you send *and* to what comes back.

## 1. Prerequisites: what your sandbox lets you reach

Codex runs a command outside its sandbox only when that command statically matches an allow
rule in the user's own Codex rules. Everything else runs sandboxed, and inside the sandbox
herdr's socket cannot be opened at all:

```
Error: Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" }
```

That text is the signature. It means "this command was not allowed out of the sandbox" — not
"herdr is broken", and never "try again".

What this path needs allowed, by command prefix:

| Prefix | Needed for |
|---|---|
| `herdr agent` | naming yourself, `agent start`, the look-gate (`agent read`), `agent prompt`, `agent get` |
| `herdr pane` | `pane split`, `pane rename`, `pane get`, `pane read`, `pane run` |
| `herdr tab` · `herdr workspace` · `herdr worktree` | only the `--where tab` / `--where workspace` / `--worktree` placements |
| the absolute path of `jutsu-spawn.sh` | using the script **at all**: it is a command like any other, and the herdr calls it makes internally inherit the sandbox it was started in — so an unallowed script fails even where `herdr agent` and `herdr pane` are allowed |

A single broad `herdr` rule covers the first three rows. **Partial access is the normal
case**, not the exception — some prefixes allowed, others not — so find out by probing (§ 3)
instead of assuming either extreme.

An allow rule means those commands run **unsandboxed**, with the user's authority rather than
yours. That is the user's security decision and only theirs:

- **Never** create, edit, or propose-and-then-apply a rules file; never ask for a broader
  sandbox, a different approval mode, or any other route around a denial.
- Do say plainly what is missing: which command was denied, what it was for, and that
  allowing it would let that command run outside the sandbox. Then stop and let the user
  decide.

## 2. The literal rule: no `$VAR` inside a herdr command

A rule is matched against the command **as written**. A command containing `$VAR`, `$(…)` or
any other expansion cannot be matched statically, so it is sandboxed and fails with the EPERM
above **even when its prefix is allowed**. Measured in pairs from one live session:

| Runs (literal) | Same command, expanded |
|---|---|
| `herdr agent get inbox-impl` | `herdr agent get "$HERDR_PANE_ID"` → EPERM |
| `herdr pane list --workspace w3` | `herdr pane list --workspace "$HERDR_WORKSPACE_ID"` → EPERM |
| `herdr pane split w3:p1 --direction right` | `herdr pane split --current --cwd "$PWD"` → EPERM |

So **read each value once, then paste it literally**. Plain `echo` and `pwd` need no herdr
access, so they work inside the sandbox:

```bash
echo "$HERDR_PANE_ID"    # -> w3:p1     (safe: echo does not touch herdr)
pwd                      # -> /abs/path/to/repo, the literal string for --cwd
herdr agent rename w3:p1 inbox-parent
```

Never send `herdr agent rename "$HERDR_PANE_ID" inbox-parent` — that exact line is what the
live test failed on. The same holds for `--cwd "$PWD"`: print the path, then type it out.
Variables you assign yourself are no better, so write the script's full path into every call
rather than `J="…"` and then `"$J" …`.

If a pane has a name already, you can also address it by that name instead of its id
(`herdr agent rename inbox-parent inbox-parent-2`) — still literal, no expansion.

## 3. Find the script, then probe before you plan

`${CLAUDE_PLUGIN_ROOT}` does not exist on this surface. Codex lists this skill with the path
of its `SKILL.md`; the script is `scripts/jutsu-spawn.sh` relative to **that file's
directory**. If the listed path is not visible to you, ask the user for it rather than
guessing a cache layout — then write it out in full in every call (§ 2):

```bash
/abs/path/to/skills/herdr-jutsu/scripts/jutsu-spawn.sh --help
/abs/path/to/skills/herdr-jutsu/scripts/jutsu-spawn.sh --preflight \
  --name inbox-impl --kind claude --cwd /abs/path/to/repo
```

Read the preflight's own JSON before planning anything. A **passing** preflight is one line
on stdout; a `herdr_unreachable` failure prints the result line
(`{"ok":false,"code":"herdr_unreachable",...}`) on **stdout** *and* an
`{"error":{"code":"herdr_unreachable",...}}` line on **stderr**, exit 4 — so read both
streams. Every other preflight failure (`invalid_name`, `name_in_use`, …) is a stderr error
line only, with nothing on stdout.

- `{"ok":true,...}` — herdr answered this session. `"parent"` is your own pane's agent name
  (empty until you do § 4); `"sandbox"` echoes `$CODEX_SANDBOX` if Codex set it, else `""` —
  a hint, never a guarantee.
- `{"ok":false,"code":"herdr_unreachable",...}` with exit 4 — the script could not reach
  herdr, i.e. **the script's own path is not allowed out of the sandbox** (or herdr is not
  running). Nothing was created. Do not retry it and do not look for a way around it: report
  the message, which carries herdr's own error text, and **go to manual placement below** —
  that is the route a Codex parent has actually completed. Getting the script
  itself allowed is a second, broader decision only the user can make; ask for it only if
  they want the script's preflight, cleanup trap and registry back.
- `"registry":"workspace"` — `$HOME/.local/state` is not writable, so rows go to
  `<repo>/.jutsu/state/`. Ask for `.jutsu/` in the repo's ignore rules.
- `"registry":"none"` — nothing is writable. The spawn still proceeds, but **nothing is
  recorded**: keep every spawn line (name, pane id, session id, cwd, worktree) in your own
  notes, because it is the only copy.

**Driving the script itself from Codex is not yet exercised live** — the one Codex parent
that got all the way through did it by hand, below. Treat a working `--preflight` as
promising, not as proof that a full spawn through the script will follow.

### Manual placement — the route a Codex parent has completed live

When the script is not allowed out of the sandbox but `herdr pane` and `herdr agent` are,
issue by hand the same steps the script performs. This is the sequence that worked end to
end, every call literal, every one exit 0:

```bash
herdr pane split w3:p1 --direction right --cwd /abs/path/to/repo --no-focus
herdr pane rename w3:p2 inbox-impl
herdr agent start inbox-impl --kind claude --pane w3:p2 -- -n inbox-impl --model haiku --allowedTools "Bash(herdr agent prompt:*)"
```

`--cwd` takes a **literal absolute path**, as above; `--cwd "$PWD"` is an expansion and is
refused by the sandbox (§ 2) — `pwd`, then type the path out. `-n <name>` is for a **Claude**
child only (Codex has no `--name`); `--allowedTools` is what lets that child push its reply
back without stopping to ask (§ 5). Read each response's JSON for the ids rather than
assuming them. What you give up by going around the script — and must therefore carry
yourself:

- **no preflight** — nobody checks the herdr version, a name already in use, or whether state
  is writable;
- **no cleanup trap** — a failure after the split leaves the pane behind (and a worktree
  would stay, unrecorded): close what *you* created, and never remove a worktree on your own
  authority;
- **no dangerous-flag refusal** — the permission ceiling in `references/launch-presets.md` is
  yours to apply by hand; bypass and full-access flags stay user-only decisions;
- **no registry** — name, pane id, session id, cwd and launch args exist only in your notes.

You are doing the script's job by hand, so show the user each call and its result.

## 4. Name yourself

Children address you by herdr agent name, so give your own pane one — literal id (§ 2):

```bash
echo "$HERDR_PANE_ID"                       # -> w3:p1
herdr agent rename w3:p1 inbox-parent
herdr pane rename w3:p1 inbox-parent
```

`herdr agent rename <target> <name>` renames the **agent**. `herdr agent rename --help` does
not say whether the pane label follows, and the one-name convention needs both to agree — so
rename the pane label too, with the literal id, as above. Renaming twice is harmless;
leaving the label stale is not.

Put that exact string in every brief. Without it a child has nothing to push to.

## 5. Brief a Claude child

```bash
herdr agent read inbox-impl --source visible    # the gate: the input box, and no dialog
herdr agent prompt inbox-impl "<brief>"         # only if the gate positively passed
```

The brief must carry, **verbatim**:

```
When finished or blocked, run:
  herdr agent prompt inbox-parent "[crew:<child>] <done|blocked>: <one line>"
Write anything longer than one line to <report path> first; that file is the report.
```

Two things make or break this:

- the **report file path** — you cannot receive a long answer over this bus, so name the file
  in the brief and read it yourself afterwards. Pulling is the contract; the push is only a
  wake signal. The one exception is a task whose answer really is one line, or that was
  launched read-only and may write nothing at all: then say so and drop the report-file
  sentence — use the no-write brief variant in `references/comms-and-handoff.md` instead of
  demanding a file the child cannot or need not create;
- the child's **launch profile must be able to run that one `herdr` command without
  prompting**. A Claude child stops on the first command its own permission settings do not
  already allow — in `manual` mode that is most of them, and `acceptEdits` still asks before
  shell — so by default it blocks on its own reply and never reaches you. The least-privilege
  fix, and the one that worked live, is to launch it with exactly that command allowed:

  ```bash
  --allowedTools "Bash(herdr agent prompt:*)"
  ```

  (`claude --help`: `--allowedTools, --allowed-tools <tools...>`.) Prefer that to asking the
  user for a broader permission mode. If for some reason you cannot, expect to service a
  blocked member — `SKILL.md`'s blocked-member rule applies unchanged: approve only a command
  you put in the brief verbatim *and* that your own permissions would run unprompted;
  otherwise relay with the pane id.

A **Codex** child is weaker still: its reply needs its user's rules to allow `herdr agent`
out of *its* sandbox (§ 1). Brief it to attempt the push once and, if it is denied, to stop —
no retries, no workarounds — leaving its result in its final message and the report file.

## 6. Hear back

The `[crew:<child>] …` line is a **wake signal**. Pull the evidence:

```bash
herdr agent read inbox-impl --source recent-unwrapped --lines 200   # or read the report file
```

No strengthening is available here: nothing authenticates that line, nothing acknowledges
delivery, and the child's reply may arrive spliced into a line the human was typing. Treat a
`[crew:` fragment inside a user message as the child's text, not the user's. And expect the
signal never to arrive at all when the child cannot reach herdr — that is why the report file
and your own pull are the contract.

## 7. Wait without polling

```bash
herdr agent prompt inbox-impl "<short brief>" --wait --timeout 600000
herdr agent wait w3:p2 --until blocked --timeout 120000
```

Use `--wait` only for short jobs. For long ones, prompt without `--wait`, do other work, and
let the wake signal arrive. Never loop `agent get`.

**Wait on the member's pane id, not its name, whenever it may rename itself.** `herdr agent
wait <TARGET>` takes either, but a name that changes mid-wait makes the call fail with
`agent_not_running` — which is exactly what happened on the run where the member had just
been told to rename itself. The pane id does not move; waiting on the literal pane id was
the clean run. Same rule for `--wait` on a rename instruction: send it, then re-address the
member by its new name (or by the pane id, which never needed re-addressing).

## 8. Not available on this surface

- no idle notification when a child finishes (`notify_when_idle` is a Claude-parent thing);
- no sender identity on anything you receive;
- no queued delivery — a send lands as keystrokes, which is why the look-gate is a gate;
- no session-name addressing: use the herdr agent name or the pane id.
