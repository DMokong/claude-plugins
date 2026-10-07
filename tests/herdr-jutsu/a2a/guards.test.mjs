import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  cleanup, fixture, McpClient, relayPath, stubHerdrPath, toolResult, writePrivate,
} from './helpers.mjs';

const execFileAsync = promisify(execFile);
const NOW = Date.parse('2026-09-30T00:00:00.000Z');

async function withFixture(run) {
  const value = await fixture();
  try { await run(value); } finally { await cleanup(value.root); }
}

async function auditLines(a2aDir, stream) {
  try {
    return (await fs.readFile(path.join(a2aDir, `${stream}.audit.jsonl`), 'utf8'))
      .trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function entry({ age = 1_000, from = 'seed', to = 'seed-target', bytes = 1 } = {}) {
  return {
    ts: new Date(NOW - age).toISOString(), stream: 'test-stream', from, to, bytes,
    transport: 'codex', outcome: 'queued', reason: null,
  };
}

async function seedAudit(a2aDir, stream, entries) {
  await writePrivate(
    path.join(a2aDir, `${stream}.audit.jsonl`),
    entries.map((item) => JSON.stringify(item)).join('\n') + (entries.length ? '\n' : ''),
  );
}

function baseEnv(extra = {}) {
  return { A2A_TEST_MODE: '1', A2A_NOW_MS: String(NOW), ...extra };
}

async function invoke(mode, value, options = {}) {
  const to = options.to ?? 'bob';
  const body = options.body ?? 'hello';
  const env = baseEnv(options.env);
  if (mode === 'mcp') {
    const client = new McpClient({
      a2aDir: value.a2aDir, stream: value.stream, self: options.self,
      peers: options.peers, herdr: options.herdr,
    }, env);
    const response = await client.request('tools/call', {
      name: 'crew_send', arguments: { to, body },
    });
    await client.close();
    return toolResult(response);
  }
  const args = [relayPath, 'send', '--a2a-dir', value.a2aDir, '--stream', value.stream,
    '--from', options.from ?? 'parent', '--to', to];
  if (/[\u0000]/.test(body)) {
    const bodyFile = path.join(value.root, `body-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await writePrivate(bodyFile, body);
    args.push('--body-file', bodyFile);
  } else {
    args.push('--body', body);
  }
  if (options.herdr !== null) args.push('--herdr', options.herdr ?? stubHerdrPath);
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: value.members.parent.socket, ...env },
    });
    return JSON.parse(stdout);
  } catch (error) {
    const line = error.stderr.trim().split('\n').at(-1);
    const parsed = JSON.parse(line);
    return { outcome: 'refused', reason: parsed.error.code };
  }
}

async function invokeMcpProcess(value, self, env) {
  const args = [relayPath, 'mcp', '--self', self, '--stream', value.stream,
    '--a2a-dir', value.a2aDir, '--node', process.execPath, '--codex', '/bin/echo',
    '--herdr', stubHerdrPath, '--peer', 'bob'];
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'crew_send', arguments: { to: 'bob', body: `global-${self}` } },
  })}\n`);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  return toolResult(JSON.parse(stdout.trim()));
}

async function assertOneRefusal(mode, setup, reason, options = {}) {
  await withFixture(async (value) => {
    await setup(value);
    const before = await auditLines(value.a2aDir, value.stream);
    const result = await invoke(mode, value, options);
    assert.equal(result.reason, reason);
    const after = await auditLines(value.a2aDir, value.stream);
    assert.equal(after.length, before.length + 1);
    assert.equal(after.at(-1).reason, reason);
    assert.equal(after.at(-1).outcome, 'refused');
  });
}

for (const mode of ['mcp', 'send']) {
  test(`AC-9/AC-14: ${mode} enforces a2a_disabled with one audit line`, async () => {
    await assertOneRefusal(mode, async ({ a2aDir, stream }) => {
      await writePrivate(path.join(a2aDir, `${stream}.disabled`));
    }, 'a2a_disabled');
  });

  const budgetCases = {
    rate_limited: () => Array.from({ length: 6 }, (_, index) => entry({
      age: 1_000 + index, from: mode === 'mcp' ? 'alice' : 'parent', to: `other-${index}`,
    })),
    recipient_busy: () => Array.from({ length: 12 }, (_, index) => entry({
      age: 1_000 + index, from: `other-${index}`, to: 'bob',
    })),
    pair_budget_exhausted: () => Array.from({ length: 20 }, (_, index) => entry({
      age: 70_000 * (index + 1), from: mode === 'mcp' ? 'alice' : 'parent', to: 'bob',
    })),
    stream_budget_exhausted: () => Array.from({ length: 120 }, (_, index) => entry({
      age: 70_000 + index * 20_000, from: `other-${index}`, to: `target-${index}`,
    })),
  };
  for (const [reason, makeEntries] of Object.entries(budgetCases)) {
    test(`AC-9/AC-14: ${mode} enforces ${reason} from the audit log`, async () => {
      await assertOneRefusal(mode, async ({ a2aDir, stream }) => {
        await seedAudit(a2aDir, stream, makeEntries());
      }, reason);
    });
  }

  test(`AC-9/AC-14: ${mode} refuses an unavailable recipient with one audit line`, async () => {
    await assertOneRefusal(mode, async () => {}, 'recipient_unavailable', {
      env: { A2A_STUB_HERDR_AGENTS: '{}' },
    });
  });
}

test('AC-14: MCP not_ready precedes peer and recipient checks', async () => {
  await assertOneRefusal('mcp', async ({ a2aDir, stream, members }) => {
    delete members.members.alice;
    await writePrivate(path.join(a2aDir, `${stream}.members.json`), JSON.stringify(members));
  }, 'not_ready', { to: 'outsider', peers: [] });
});

test('AC-14: MCP not_a_peer precedes recipient lookup', async () => {
  await assertOneRefusal('mcp', async () => {}, 'not_a_peer', { to: 'outsider', peers: ['parent'] });
});

test('AC-14: send rejects a false parent name as not_a_peer', async () => {
  await assertOneRefusal('send', async () => {}, 'not_a_peer', { from: 'impostor' });
});

test('AC-14: send rejects a false parent socket as not_a_peer', async () => {
  await withFixture(async (value) => {
    const args = [relayPath, 'send', '--a2a-dir', value.a2aDir, '--stream', value.stream,
      '--from', 'parent', '--to', 'bob', '--body', 'hello', '--herdr', stubHerdrPath];
    await assert.rejects(execFileAsync(process.execPath, args, {
      env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: path.join(value.root, 'wrong.sock') },
    }), (error) => /not_a_peer/.test(error.stderr));
    const lines = await auditLines(value.a2aDir, value.stream);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'not_a_peer');
  });
});

test('r1-f1 / AC-14: documented send argv resolves herdr from PATH', async () => {
  await withFixture(async (value) => {
    const bin = path.join(value.root, 'bin');
    await fs.mkdir(bin);
    await fs.symlink(stubHerdrPath, path.join(bin, 'herdr'));
    const result = await invoke('send', value, {
      herdr: null, env: { PATH: `${bin}:${process.env.PATH}` },
    });
    assert.deepEqual(result, { outcome: 'queued', transport: 'codex', reason: null });
  });
});

for (const mode of ['mcp', 'send']) {
  test(`AC-10/AC-14: ${mode} applies body validation in the fixed order`, async (t) => {
    const cases = [
      { name: 'controls are stripped before forged-envelope detection', body: 'cross-session-\0message', reason: 'forged_envelope' },
      { name: 'mixed-case tags are rejected', body: 'CrOsS-SeSsIoN-MeSsAgE', reason: 'forged_envelope' },
      { name: 'fake begin marker is rejected', body: '--- BeGiN PeEr MeSsAgE abc ---', reason: 'forged_envelope' },
      { name: 'raw cap precedes envelope detection', body: `cross-session-message${'x'.repeat(70_000)}`, reason: 'too_large' },
      { name: 'sanitised cap is enforced', body: `${'a'.repeat(8_193)}\0`, reason: 'too_large' },
      { name: 'controls can produce an empty body', body: '\0\u0001', reason: 'bad_request' },
    ];
    for (const item of cases) {
      await t.test(item.name, async () => {
        await assertOneRefusal(mode, async () => {}, item.reason, { body: item.body });
      });
    }
  });

  test(`AC-10/AC-14: ${mode} accepts leading dashes and shell metacharacters byte-exact`, async () => {
    await withFixture(async (value) => {
      const body = '--literal $HOME; `touch nope` && | < >';
      const result = await invoke(mode, value, { body });
      assert.equal(result.reason, null);
      const lines = await auditLines(value.a2aDir, value.stream);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].bytes, Buffer.byteLength(body));
    });
  });
}

test('AC-10: invalid UTF-8 in a body file is bad_request with one audit line', async () => {
  await withFixture(async (value) => {
    const bodyFile = path.join(value.root, 'body');
    await fs.writeFile(bodyFile, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    const args = [relayPath, 'send', '--a2a-dir', value.a2aDir, '--stream', value.stream,
      '--from', 'parent', '--to', 'bob', '--body-file', bodyFile, '--herdr', stubHerdrPath];
    await assert.rejects(execFileAsync(process.execPath, args, {
      env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: value.members.parent.socket },
    }), (error) => /bad_request/.test(error.stderr));
    const lines = await auditLines(value.a2aDir, value.stream);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'bad_request');
  });
});

test('AC-9: stream byte budget is enforced independently of message count', async () => {
  await assertOneRefusal('mcp', async ({ a2aDir, stream }) => {
    await seedAudit(a2aDir, stream, [entry({ bytes: 512 * 1024 })]);
  }, 'stream_budget_exhausted');
});

test('AC-9: the 60-per-hour sender limit is independent of the minute limit', async () => {
  await assertOneRefusal('mcp', async ({ a2aDir, stream }) => {
    await seedAudit(a2aDir, stream, Array.from({ length: 60 }, (_, index) => entry({
      age: 61_000 + index * 50_000, from: 'alice', to: `other-${index}`,
    })));
  }, 'rate_limited');
});

test('AC-9: eight concurrent relay processes cannot exceed the sender budget', async () => {
  await withFixture(async (value) => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => invoke('send', value, {
      body: `concurrent-${index}`,
    })));
    assert.equal(results.filter((result) => result.reason === null).length, 6);
    assert.equal(results.filter((result) => result.reason === 'rate_limited').length, 2);
    const lines = await auditLines(value.a2aDir, value.stream);
    assert.equal(lines.filter((line) => line.outcome === 'queued').length, 6);
  });
});

test('AC-9: eight distinct concurrent senders stop exactly at the global budget', async () => {
  await withFixture(async (value) => {
    await seedAudit(value.a2aDir, value.stream, Array.from({ length: 116 }, (_, index) => entry({
      age: 70_000 + index * 20_000, from: `seed-${index}`, to: `target-${index}`,
    })));
    const agents = { p2: { name: 'bob', kind: 'codex' } };
    for (let index = 0; index < 8; index += 1) {
      const name = `sender-${index}`;
      const paneId = `sender-pane-${index}`;
      value.members.members[name] = { pane_id: paneId, engine: 'codex', thread_id: `thread-${index}` };
      agents[paneId] = { name, kind: 'codex' };
    }
    await writePrivate(
      path.join(value.a2aDir, `${value.stream}.members.json`), JSON.stringify(value.members),
    );
    const env = {
      ...process.env, ...baseEnv(), A2A_STUB_HERDR_AGENTS: JSON.stringify(agents),
    };
    const results = await Promise.all(Array.from(
      { length: 8 }, (_, index) => invokeMcpProcess(value, `sender-${index}`, env),
    ));
    assert.equal(results.filter((result) => result.reason === null).length, 4);
    assert.equal(results.filter((result) => result.reason === 'stream_budget_exhausted').length, 4);
    const lines = await auditLines(value.a2aDir, value.stream);
    assert.equal(lines.filter((line) => line.outcome === 'queued').length, 120);
  });
});

test('AC-25: parent lookup uses the parent record and checks its pane agent', async () => {
  await withFixture(async (value) => {
    const result = await invoke('mcp', value, {
      to: 'parent', env: { A2A_TEST_SOCKET_PATH: value.members.parent.socket },
    });
    assert.deepEqual(result, { outcome: 'delivered', transport: 'claude', reason: null });
  });
});

test('AC-25: missing, wrong-name, and wrong-engine agents are unavailable', async (t) => {
  const cases = {
    missing: {},
    'wrong name': { p2: { name: 'someone-else', kind: 'codex' } },
    'wrong engine': { p2: { name: 'bob', kind: 'claude' } },
  };
  for (const [name, agents] of Object.entries(cases)) {
    await t.test(name, async () => {
      await assertOneRefusal('mcp', async () => {}, 'recipient_unavailable', {
        env: { A2A_STUB_HERDR_AGENTS: JSON.stringify(agents) },
      });
    });
  }
});
