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
  decisions — ask, do not infer.
- A child in `manual` mode blocks on its first shell command (seen live on an `echo`).
  Pick the mode deliberately, or expect to service `blocked` states.
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
- `-m <model>` and `-c model_reasoning_effort=<low|medium|high>` override
  `~/.codex/config.toml`; omit them to inherit the user's defaults.
- `danger-full-access` and `--dangerously-bypass-approvals-and-sandbox` are user-only.
- **Permission ceiling, Codex terms:** `read-only` is always within bounds.
  `workspace-write` is within bounds only if you yourself may edit files, and only in the
  member's own worktree. `-a never` removes the human from the loop — fine with
  `read-only`; with `workspace-write` use it only when the user asked for an unattended
  member. No CLI reports your own permission mode; it is in your session context. If you
  cannot tell, ask rather than assume the broad reading.
- Codex reads `AGENTS.md`, not `CLAUDE.md` — the brief must carry anything it needs that
  lives only in Claude-side instructions.

## Shell (`--kind shell`)

`--cmd "<command>"` runs it via `herdr pane run`. Good for log tails, watchers, dev
servers, test loops. Read with `herdr pane read <id> --source visible` (fresh output that
has not scrolled is *only* there; use `recent-unwrapped` for history), block on
output with `herdr pane wait-output <id> --match|--regex … --timeout MS`.
