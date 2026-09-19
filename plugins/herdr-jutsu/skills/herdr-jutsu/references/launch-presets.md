# Launch presets

Everything after `--` in `jutsu-spawn.sh` goes to the agent binary verbatim. These are
starting points — the installed binary is the authority: check `claude --help` /
`codex --help` when a flag is rejected, and honour whatever the user asked for over any
row here.

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
- **If the brief tells the child to report with `herdr agent prompt`, launch it with exactly
  that command allowed** — `--allowedTools "Bash(herdr agent prompt:*)"` (`claude --help`:
  `--allowedTools, --allowed-tools <tools...>`). That is the least privilege that lets the
  reply push run without a prompt, and it is the profile that worked live; prefer it to
  asking the user for a broader `--permission-mode`. Without it the child blocks on its own
  reply and never reaches the parent.
- Useful extras: `--append-system-prompt "<crew brief>"` to pin role, parent name and
  reporting rule for the whole session; `--add-dir <path>` when a worktree child must read
  the main checkout; `--resume <session-id>` to bring a registry member back in a new pane.
- Do not pass `--worktree`: the script/herdr owns worktree placement via `--cwd`.

## Codex (`--kind codex`)

| Role | Args after `--` | Why |
|---|---|---|
| reviewer / second opinion | `-s read-only -a never` | Cannot write, never stalls on approval |
| implementer in a worktree | `-s workspace-write -a on-request` | Writes only inside its cwd |
| unattended implementer | `-s workspace-write -a never` | Failures return to the model, no prompts |

- `-s/--sandbox`: `read-only | workspace-write | danger-full-access`.
- `-a/--ask-for-approval`: `on-request | never` (run `codex --help` for the full list).
- **Sandbox flags decide file access; they do not decide whether that member can reach
  herdr.** That is settled separately, by the allow rules in the member's *user's* Codex
  rules: without a rule matching `herdr agent …`, a Codex session cannot run a herdr command
  at all, whatever `-s` says — so it cannot push a `[crew:…]` line back. Pull its result
  instead, and see `references/parent-codex.md` § 1 for what a user would have to allow.
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
  member's own worktree. `-a never` removes the human from the loop — fine with
  `read-only`; with `workspace-write` use it only when the user asked for an unattended
  member. No CLI reports your own permission mode; it is in your session context. If you
  cannot tell, ask rather than assume the broad reading.
- Codex reads `AGENTS.md`, not `CLAUDE.md` — the brief must carry anything it needs that
  lives only in Claude-side instructions.

## Enforced: dangerous flags are refused, not just discouraged

`jutsu-spawn.sh` scans everything after `--` and exits **5** with
`{"error":{"code":"dangerous_agent_flag",...}}` — nothing is created — for:

| Kind | Refused forms |
|---|---|
| claude | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--permission-mode dontAsk`, `--permission-mode=bypassPermissions`, `--permission-mode=dontAsk` |
| codex | `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `-s danger-full-access`, `--sandbox danger-full-access`, `-s=danger-full-access`, `--sandbox=danger-full-access`, and any `-c`/`--config` value setting `sandbox_mode` to `danger-full-access` (both the separate-value and `=` forms) |

The only way past it is `--allow-dangerous-agent-flags`, passed **before** `--`; the spawn
then records `"dangerous_override":true`. That flag is **user-only**: pass it because the
user told you to for this member, never because it would be convenient. Do not route around
the refusal by putting the same setting in a config file instead.

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
