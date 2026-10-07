import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { cleanup, fixture, McpClient, relayPath, toolResult, writePrivate } from './helpers.mjs';

const execFileAsync = promisify(execFile);

async function withFixture(run) {
  const value = await fixture();
  try { await run(value); } finally { await cleanup(value.root); }
}

async function send(client, to = 'bob', body = 'hello from a peer') {
  return client.request('tools/call', { name: 'send_message', arguments: { to, body } });
}

test('AC-8: MCP initialize, exact tool schema, and unknown tools have no side effect', async () => {
  await withFixture(async ({ a2aDir, stream }) => {
    const client = new McpClient({ a2aDir, stream });
    const initialized = await client.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(initialized.result.protocolVersion, '2025-06-18');
    const listed = await client.request('tools/list');
    assert.deepEqual(listed.result.tools, [{
      name: 'send_message',
      inputSchema: {
        type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } },
        required: ['to', 'body'], additionalProperties: false,
      },
    }]);
    const unknown = await client.request('tools/call', { name: 'other_tool', arguments: {} });
    assert.equal(unknown.error.code, -32601);
    await assert.rejects(fs.lstat(path.join(a2aDir, `${stream}.audit.jsonl`)), { code: 'ENOENT' });
    await client.close();
  });
});

test('AC-13: audit contains metadata, never body text, and private modes are retained', async () => {
  await withFixture(async ({ a2aDir, stream }) => {
    const client = new McpClient({ a2aDir, stream });
    const canary = 'canary-' + 'a9'.repeat(32);
    const response = await send(client, 'bob', canary);
    assert.deepEqual(toolResult(response), { outcome: 'queued', transport: 'codex', reason: null });
    await client.close();
    const auditPath = path.join(a2aDir, `${stream}.audit.jsonl`);
    const text = await fs.readFile(auditPath, 'utf8');
    assert.equal(text.includes(canary), false);
    const line = JSON.parse(text.trim());
    assert.deepEqual(Object.keys(line), ['ts', 'stream', 'from', 'to', 'bytes', 'transport', 'outcome', 'reason']);
    assert.equal(line.bytes, Buffer.byteLength(canary));
    assert.equal((await fs.stat(auditPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(a2aDir)).mode & 0o777, 0o700);
  });
});

test('r1-f1 / AC-23: unsafe audit is refused before delivery and receives no audit write', async () => {
  await withFixture(async ({ root, a2aDir, stream }) => {
    const target = path.join(root, 'target');
    await writePrivate(target, 'unchanged');
    await fs.symlink(target, path.join(a2aDir, `${stream}.audit.jsonl`));
    const client = new McpClient({ a2aDir, stream });
    const response = await send(client);
    assert.deepEqual(toolResult(response), { outcome: 'refused', reason: 'storage_unsafe' });
    await client.close();
    assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
    assert.match(client.stderr, /storage_unsafe/);
  });
});

test('r1-f2 / AC-23: replacement between lstat and open is caught by O_NOFOLLOW', async () => {
  await withFixture(async ({ root, a2aDir, stream }) => {
    const membersPath = path.join(a2aDir, `${stream}.members.json`);
    const target = path.join(root, 'race-target');
    await writePrivate(target, 'sensitive');
    const client = new McpClient({ a2aDir, stream }, {
      A2A_TEST_MODE: '1',
      A2A_TEST_REPLACE_AFTER_LSTAT: membersPath,
      A2A_TEST_REPLACE_WITH_SYMLINK_TO: target,
    });
    const response = await send(client);
    assert.deepEqual(toolResult(response), { outcome: 'refused', reason: 'storage_unsafe' });
    await client.close();
    assert.equal(await fs.readFile(target, 'utf8'), 'sensitive');
    const replaced = await fs.lstat(membersPath);
    assert.equal(replaced.isSymbolicLink(), true);
  });
});

test('trk-4sh.16: a lock released while a waiter inspects its owner is retried, never storage_unsafe', async () => {
  await withFixture(async ({ a2aDir, stream }) => {
    const lockDir = path.join(a2aDir, `${stream}.lock`);
    const ownerPath = path.join(lockDir, 'owner.json');
    await fs.mkdir(lockDir, { mode: 0o700 });
    await writePrivate(ownerPath, JSON.stringify({
      pid: process.pid, start_time: 'held by this test', nonce: 'a'.repeat(32),
    }));
    const client = new McpClient({ a2aDir, stream }, {
      A2A_TEST_MODE: '1', A2A_TEST_RELEASE_AFTER_LSTAT: ownerPath,
    });
    const result = toolResult(await send(client));
    await client.close();
    assert.equal(result.reason, null, `expected a delivery after the lock was released; got ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'queued');
  });
});

test('trk-4sh.16: a lock re-acquired by a live holder while a waiter inspects it is never broken', async () => {
  await withFixture(async ({ a2aDir, stream }) => {
    const lockDir = path.join(a2aDir, `${stream}.lock`);
    const ownerPath = path.join(lockDir, 'owner.json');
    await fs.mkdir(lockDir, { mode: 0o700 });
    await writePrivate(ownerPath, JSON.stringify({
      pid: process.pid, start_time: 'previous holder', nonce: 'a'.repeat(32),
    }));
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)]);
    const liveOwner = {
      pid: process.pid, start_time: stdout.trim().replace(/\s+/g, ' '), nonce: 'b'.repeat(32),
    };
    // The injected clock makes the first lock directory look two minutes old, so only the
    // identity re-check can stop the waiter from treating the new holder's lock as stale.
    const client = new McpClient({ a2aDir, stream }, {
      A2A_TEST_MODE: '1', A2A_NOW_MS: String(Date.now() + 120_000),
      A2A_TEST_REACQUIRE_AFTER_LSTAT: ownerPath, A2A_TEST_REACQUIRE_OWNER: JSON.stringify(liveOwner),
    });
    const result = toolResult(await send(client));
    await client.close();
    assert.equal(result.reason, 'busy_retry', `the live holder's lock must be respected; got ${JSON.stringify(result)}`);
    assert.deepEqual(JSON.parse(await fs.readFile(ownerPath, 'utf8')), liveOwner);
  });
});

test('AC-23: group-readable a2a directory is refused', async () => {
  await withFixture(async ({ a2aDir, stream }) => {
    await fs.chmod(a2aDir, 0o750);
    const client = new McpClient({ a2aDir, stream });
    assert.equal(toolResult(await send(client)).reason, 'storage_unsafe');
    await client.close();
  });
});

test('AC-23: FIFO members file is refused', async (t) => {
  if (process.platform === 'win32') return t.skip('mkfifo is unavailable');
  await withFixture(async ({ a2aDir, stream }) => {
    const membersPath = path.join(a2aDir, `${stream}.members.json`);
    await fs.unlink(membersPath);
    await execFileAsync('/usr/bin/mkfifo', [membersPath]);
    await fs.chmod(membersPath, 0o600);
    const client = new McpClient({ a2aDir, stream });
    assert.equal(toolResult(await send(client)).reason, 'storage_unsafe');
    await client.close();
  });
});

test('AC-23: simulated foreign-owned members file is refused', async () => {
  await withFixture(async ({ a2aDir, stream }) => {
    const membersPath = path.join(a2aDir, `${stream}.members.json`);
    const client = new McpClient({ a2aDir, stream }, {
      A2A_TEST_MODE: '1', A2A_TEST_FOREIGN_OWNER_PATH: membersPath,
    });
    assert.equal(toolResult(await send(client)).reason, 'storage_unsafe');
    await client.close();
  });
});

test('AC-23: member socket outside a2a sock directory is refused', async () => {
  await withFixture(async ({ root, a2aDir, stream, members }) => {
    members.members.bob = { pane_id: 'p2', engine: 'claude', socket: path.join(root, 'escaped.sock') };
    await writePrivate(path.join(a2aDir, `${stream}.members.json`), JSON.stringify(members));
    const client = new McpClient({ a2aDir, stream });
    assert.equal(toolResult(await send(client)).reason, 'storage_unsafe');
    await client.close();
  });
});

test('AC-29: running MCP relay observes disable and enable on every send', async () => {
  await withFixture(async ({ a2aDir, stream }) => {
    const client = new McpClient({ a2aDir, stream });
    await execFileAsync(process.execPath, [relayPath, 'disable', '--a2a-dir', a2aDir, '--stream', stream]);
    assert.equal(toolResult(await send(client)).reason, 'a2a_disabled');
    await execFileAsync(process.execPath, [relayPath, 'enable', '--a2a-dir', a2aDir, '--stream', stream]);
    assert.equal(toolResult(await send(client)).outcome, 'queued');
    await client.close();
  });
});

test('stream lock recovers a missing owner only after its 30 second orphan window', async () => {
  await withFixture(async ({ a2aDir, stream }) => {
    const lockDir = path.join(a2aDir, `${stream}.lock`);
    await fs.mkdir(lockDir, { mode: 0o700 });
    const old = new Date(1_000);
    await fs.utimes(lockDir, old, old);
    const client = new McpClient({ a2aDir, stream }, { A2A_TEST_MODE: '1', A2A_NOW_MS: '32001' });
    assert.equal(toolResult(await send(client)).outcome, 'queued');
    await client.close();
  });
});

test('mcp argv rejects unknown flags with exit 2', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [relayPath, 'mcp', '--wat', 'no']),
    (error) => error.code === 2 && /bad_arguments/.test(error.stderr),
  );
});
