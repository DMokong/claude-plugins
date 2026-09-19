# Launch presets

For Claude and `--no-isolation`, caller arguments stay verbatim apart from the documented
Claude name/deny merge. Isolated Codex arguments are parsed through the allowlist below,
and the launcher may inject `-a never` before a final `resume` pair. The spawn line records
both `agent_args` (caller input) and `effective_agent_args` (launched argv).

## Claude (`--kind claude`; `-n <name>` is added for you)

| Role | Args after `--` | Why |
|---|---|---|
| scout / researcher | `--model haiku --effort low --permission-mode plan` | Cheap, read-only, cannot edit |
| implementer | `--model sonnet --effort medium --permission-mode acceptEdits` | Edits freely, still asks before shell |
| hard implementer / debugger | `--model opus --effort high --permission-mode acceptEdits` | Judgment-heavy work |
| architect / final reviewer | `--model fable --effort high --permission-mode plan` | Thinks, does not touch files |
| handoff successor | same args as the member it replaces | Behaviour continuity |

- `--effort`: `low | medium | high | xhigh | max`.
- `--permission-mode`: `plan | manual | acceptEdits | auto | dontAsk | bypassPermissions`.
- **Permission ceiling:** never launch a child in a broader mode than the parent's own
  unless the user said so for this crew. `bypassPermissions` / `dontAsk` are user-only
  decisions — ask, do not infer. This half is **enforced**, not advisory (below).
- A child blocks on the first shell command its own permission settings do not already allow
  — in `manual` mode that is nearly every one (seen live on an `echo`), and `acceptEdits`
  still asks before shell. A command the profile *does* allow runs unprompted in `manual`
  mode, which is the lever below.
- Outbound isolation is added automatically: the launcher merges `Bash(*herdr*)` and
  `ListAgents` into one `--disallowedTools` flag, and `--strict-isolation` (before `--`)
  adds `SendMessage`. This is a string-pattern deny, not a process sandbox, so the spawn
  reports `outbound_isolation: partial`, and `isolation_detail` says whether SendMessage
  stays available and which permission mode the launch args set. The launcher cannot see the
  member's settings: with no `--permission-mode` arg it says the settings decide and warns
  that the deny may be the only barrier — pass the mode explicitly to get a definite label.
- Useful extras: `--append-system-prompt "<crew brief>"` to pin role, parent name and
  reporting rule for the whole session; `--add-dir <path>` when a worktree child must read
  the main checkout; `--resume <session-id>` to bring a registry member back in a new pane.
- Do not pass `--worktree`: the script/herdr owns worktree placement via `--cwd`.

## Codex (`--kind codex`)

| Role | Args after `--` | Why |
|---|---|---|
| reviewer / second opinion | `-s read-only -a never` | Cannot write, never stalls on approval |
| implementer in a worktree | `-s workspace-write -a never` | Writes only inside its cwd; outbound isolation requires never-ask |
| unattended implementer | `-s workspace-write -a never` | Failures return to the model, no prompts |

- `-s/--sandbox`: `read-only | workspace-write | danger-full-access`.
- `-a/--ask-for-approval`: `on-request | never` (run `codex --help` for the full list).
- The launcher installs `.codex/rules/herdr-jutsu-deny.rules` in the member cwd, git-excludes
  it, and requires `-a never`. The broad `herdr` prefix and resolved executable path are
  forbidden. Its static self-check runs bare `herdr`, the resolved absolute path, and a
  second command group, all with `--resolve-host-executables`; use that flag in manual
  absolute-path checks too. Codex loads a project layer only for a trusted repository, so
  the reported state is `enforced_if_trusted`, never an unconditional claim.
- `-m <model>` and `-c model_reasoning_effort=<low|medium|high>` override
  `~/.codex/config.toml`; omit them to inherit the user's defaults.
- **Codex offers its self-update dialog on every launch until the user decides**, so a Codex
  spawn commonly returns **exit 3 / `agent_not_ready`** — the member exists and is
  registered, it is just sitting on that dialog. Expected, not an error: apply the
  blocked-member rule and take only the do-nothing option, then brief it.
- Reviving a Codex member uses the `resume` **subcommand** (`-- resume <session_id>`), not a
  `--resume` flag — see `references/comms-and-handoff.md`.
- **Permission ceiling, Codex terms:** `read-only` is always within bounds.
  `workspace-write` is within bounds only if you yourself may edit files, and only in the
  member's own worktree. Outbound isolation requires `-a never`; any other approval policy
  is refused. No CLI reports your own permission mode; it is in your session context. If
  you cannot tell, ask rather than assume the broad reading.
- **Isolated Codex argv is an allowlist.** Short flags accept separate, compact, and `=`
  forms; long flags accept separate and `=` forms. Allowed: `-s/--sandbox` with exactly
  `read-only` or `workspace-write`; `-a/--ask-for-approval` with exactly `never`;
  `-m/--model`; `--add-dir`; and `-p/--profile` only with an explicit allowed sandbox.
  `-c/--config` accepts only `model`, `model_reasoning_effort`,
  `model_reasoning_summary`, or `model_verbosity` keys after whitespace/one matching quote
  layer is removed, and rejects values containing `{`, `[`, or a newline. A final
  `resume <session-id-or-name>` or `resume --last` pair is allowed. Everything else is
  `isolation_unsupported_agent_arg`; only the user-selected `--no-isolation` opts out.
- Codex reads `AGENTS.md`, not `CLAUDE.md` — the brief must carry anything it needs that
  lives only in Claude-side instructions.

## Enforced: dangerous flags are refused, not just discouraged

`jutsu-spawn.sh` scans everything after `--` and exits **5** with
`{"error":{"code":"dangerous_agent_flag",...}}` — nothing is created — for:

| Kind | Refused forms |
|---|---|
| claude | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--permission-mode dontAsk`, `--permission-mode=bypassPermissions`, `--permission-mode=dontAsk` |
| codex | isolated Codex uses the allowlist above instead; this override does not widen it |

The only way past the Claude dangerous-flag check is `--allow-dangerous-agent-flags`, passed
**before** `--`; the spawn then records `"dangerous_override":true`. That flag is
**user-only**. For isolated Codex it never expands the allowlist; `--no-isolation` is the
separate user-only decision.

## Secrets are never agent arguments

Agent args are recorded in the registry and echoed in the spawn line. The script replaces
the value after `--api-key`, `--token`, `--password`, `--secret` (and their `--flag=value`
forms) with `<redacted>` **in that copy only** — the real value still goes to the agent
process and is visible in its argv to anything that can list processes. Redaction is a
courtesy for those four names, not protection: pass credentials through the agent's config
file or the environment, never after `--`.

## Shell (`--kind shell`)

`--cmd "<command>"` runs it via `herdr pane run`. Good for log tails, watchers, dev
servers, test loops. Read with `herdr pane read <id> --source visible` (fresh output that
has not scrolled is *only* there; use `recent-unwrapped` for history), block on
output with `herdr pane wait-output <id> --match|--regex … --timeout MS`.
