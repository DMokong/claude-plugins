import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

export const repoRoot = path.resolve(import.meta.dirname, '../../..');
export const relayPath = path.join(repoRoot, 'plugins/herdr-jutsu/skills/herdr-jutsu/scripts/jutsu-a2a.mjs');
export const stubHerdrPath = path.join(import.meta.dirname, 'stub-herdr.mjs');

export async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jutsu-a2a-'));
  const a2aDir = path.join(root, 'a2a');
  await fs.mkdir(path.join(a2aDir, 'sock'), { recursive: true, mode: 0o700 });
  await fs.chmod(a2aDir, 0o700);
  await fs.chmod(path.join(a2aDir, 'sock'), 0o700);
  const stream = 'test-stream';
  const members = {
    parent: { name: 'parent', pane_id: 'p0', engine: 'claude', socket: path.join(root, 'parent.sock') },
    members: {
      alice: { pane_id: 'p1', engine: 'codex', thread_id: 'thread-alice' },
      bob: { pane_id: 'p2', engine: 'codex', thread_id: 'thread-bob' },
    },
  };
  await writePrivate(path.join(a2aDir, `${stream}.members.json`), JSON.stringify(members));
  return { root, a2aDir, stream, members };
}

export async function writePrivate(file, contents = '') {
  await fs.writeFile(file, contents, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

export async function cleanup(root) {
  await fs.chmod(root, 0o700).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}

export class McpClient {
  constructor(options, env = {}) {
    const args = [relayPath, 'mcp',
      '--self', options.self ?? 'alice', '--stream', options.stream,
      '--a2a-dir', options.a2aDir, '--node', process.execPath,
      '--codex', '/bin/echo', '--herdr', options.herdr ?? stubHerdrPath];
    for (const peer of options.peers ?? ['parent', 'bob']) args.push('--peer', peer);
    this.child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.pending = [];
    this.lines.on('line', (line) => this.pending.shift()?.resolve(JSON.parse(line)));
    this.child.stderr.setEncoding('utf8');
    this.stderr = '';
    this.child.stderr.on('data', (part) => { this.stderr += part; });
  }

  request(method, params = {}) {
    const id = Math.floor(Math.random() * 1_000_000_000);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async close() {
    this.child.stdin.end();
    if (this.child.exitCode === null) await once(this.child, 'exit');
  }
}

export function toolResult(response) {
  return JSON.parse(response.result.content[0].text);
}
