#!/usr/bin/env node

const defaults = {
  p0: { name: 'parent', kind: 'claude' },
  p1: { name: 'alice', kind: 'codex' },
  p2: { name: 'bob', kind: 'codex' },
};

let agents = defaults;
try {
  if (process.env.A2A_STUB_HERDR_AGENTS) agents = JSON.parse(process.env.A2A_STUB_HERDR_AGENTS);
} catch {
  process.stderr.write('invalid A2A_STUB_HERDR_AGENTS\n');
  process.exit(2);
}

const [group, command, paneId] = process.argv.slice(2);
if (group !== 'agent' || command !== 'get' || typeof paneId !== 'string') process.exit(2);
const agent = agents[paneId];
if (!agent) process.exit(1);
// Emit the shape real herdr (0.8.2) returns from `agent get`: the engine is in the `agent`
// field. There is no `kind` or `engine` field; a stub that invents one hides a relay that
// reads the wrong key (found live: every real send was refused recipient_unavailable).
const real = {
  agent: agent.kind ?? agent.agent, agent_status: 'idle', name: agent.name, pane_id: paneId,
};
process.stdout.write(`${JSON.stringify({ result: { agent: real } })}\n`);
