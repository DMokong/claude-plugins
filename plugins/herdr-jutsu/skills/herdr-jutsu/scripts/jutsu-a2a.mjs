#!/usr/bin/env node

import crypto from 'node:crypto';
import fs, { constants as C } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const uid = process.getuid?.() ?? -1;
const O_NOFOLLOW = C.O_NOFOLLOW ?? 0;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const ownStartFallback = new Date(Date.now() - process.uptime() * 1000).toString().replace(/\s+/g, ' ');

class RelayError extends Error {
  constructor(reason, message = reason, outcome = 'refused') {
    super(message);
    this.reason = reason;
    this.outcome = outcome;
  }
}

function nowMs() {
  if (process.env.A2A_TEST_MODE === '1' && /^\d+$/.test(process.env.A2A_NOW_MS ?? '')) {
    return Number(process.env.A2A_NOW_MS);
  }
  return Date.now();
}

function storageUnsafe(message) {
  return new RelayError('storage_unsafe', message);
}

function modeIsPrivate(stat, expectedType) {
  const rightType = expectedType === 'file' ? stat.isFile() : stat.isDirectory();
  return rightType && stat.uid === uid && (stat.mode & 0o077) === 0;
}

function maybeForeignOwnerForTest(file, stat) {
  if (process.env.A2A_TEST_MODE === '1' && process.env.A2A_TEST_FOREIGN_OWNER_PATH === file) {
    return { ...stat, uid: uid + 1, isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory() };
  }
  return stat;
}

async function privateLstat(file, expectedType) {
  let stat;
  try {
    stat = maybeForeignOwnerForTest(file, await fsp.lstat(file));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw storageUnsafe(`cannot inspect ${file}`);
  }
  if (!modeIsPrivate(stat, expectedType)) throw storageUnsafe(`unsafe ${expectedType}: ${file}`);
  return stat;
}

async function injectReplaceRace(file) {
  if (process.env.A2A_TEST_MODE !== '1' || process.env.A2A_TEST_REPLACE_AFTER_LSTAT !== file) return;
  delete process.env.A2A_TEST_REPLACE_AFTER_LSTAT;
  const target = process.env.A2A_TEST_REPLACE_WITH_SYMLINK_TO;
  if (!target) return;
  await fsp.rename(file, `${file}.before-race`);
  await fsp.symlink(target, file);
}

async function safeOpenExisting(file, flags = C.O_RDONLY) {
  const before = await privateLstat(file, 'file');
  if (!before) {
    const error = new Error(`missing file: ${file}`);
    error.code = 'ENOENT';
    throw error;
  }
  await injectReplaceRace(file);
  let handle;
  try {
    handle = await fsp.open(file, flags | O_NOFOLLOW);
    const after = await handle.stat();
    if (!modeIsPrivate(after, 'file') || before.dev !== after.dev || before.ino !== after.ino) {
      throw storageUnsafe(`file changed while opening: ${file}`);
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof RelayError) throw error;
    throw storageUnsafe(`cannot safely open ${file}`);
  }
}

async function safeCreate(file, flags = C.O_WRONLY) {
  const existing = await privateLstat(file, 'file');
  if (existing) {
    const error = new Error(`file exists: ${file}`);
    error.code = 'EEXIST';
    throw error;
  }
  try {
    const handle = await fsp.open(file, flags | C.O_CREAT | C.O_EXCL | O_NOFOLLOW, PRIVATE_FILE_MODE);
    const stat = await handle.stat();
    if (!modeIsPrivate(stat, 'file')) {
      await handle.close();
      throw storageUnsafe(`unsafe created file: ${file}`);
    }
    return handle;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    if (error.code === 'EEXIST') throw error;
    throw storageUnsafe(`cannot safely create ${file}`);
  }
}

async function safeReadJson(file) {
  const handle = await safeOpenExisting(file);
  try {
    return JSON.parse(await handle.readFile({ encoding: 'utf8' }));
  } catch (error) {
    if (error instanceof SyntaxError) throw storageUnsafe(`invalid JSON in ${file}`);
    throw error;
  } finally {
    await handle.close();
  }
}

async function ensureA2aDir(dir, create = false) {
  if (create) {
    try {
      await fsp.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch {
      throw storageUnsafe(`cannot create a2a directory: ${dir}`);
    }
  }
  if (!(await privateLstat(dir, 'dir'))) throw storageUnsafe(`missing a2a directory: ${dir}`);
}

async function processStartTime(pid) {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1000,
    });
    const value = stdout.trim().replace(/\s+/g, ' ');
    return value || null;
  } catch {
    // Some sandboxes deny ps even for the calling process. The fallback is
    // stable for this process and is used only when the normative probe is
    // unavailable; other pids remain unverifiable and therefore stale.
    return pid === process.pid ? ownStartFallback : null;
  }
}

async function writeOwner(lockDir) {
  const owner = {
    pid: process.pid,
    start_time: await processStartTime(process.pid),
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  if (!owner.start_time) throw storageUnsafe('cannot determine lock owner start time');
  const ownerPath = path.join(lockDir, 'owner.json');
  const handle = await safeCreate(ownerPath);
  try {
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return owner;
}

async function readOwner(lockDir) {
  try {
    const owner = await safeReadJson(path.join(lockDir, 'owner.json'));
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.start_time !== 'string'
        || !/^[0-9a-f]{32}$/.test(owner.nonce)) return null;
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.reason === 'storage_unsafe' && /invalid JSON/.test(error.message)) return null;
    throw error;
  }
}

async function pidIsSameProcess(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') return false;
  }
  const observedStart = await processStartTime(owner.pid);
  // A successful signal probe proves the process is live. If this sandbox
  // denies ps, its start time cannot be verified, so conservatively retain the
  // lock instead of breaking a potentially live holder.
  return observedStart === null || observedStart === owner.start_time;
}

async function recoverLock(lockDir) {
  const lockStat = await privateLstat(lockDir, 'dir');
  if (!lockStat) return true;
  const owner = await readOwner(lockDir);
  if (!owner) {
    if (nowMs() - lockStat.mtimeMs <= 30_000) return false;
    try {
      await fsp.unlink(path.join(lockDir, 'owner.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
    try {
      await fsp.rmdir(lockDir);
      return true;
    } catch {
      return false;
    }
  }
  if (await pidIsSameProcess(owner)) return false;
  const rechecked = await readOwner(lockDir);
  if (!rechecked || rechecked.nonce !== owner.nonce) return false;
  try {
    await fsp.unlink(path.join(lockDir, 'owner.json'));
    await fsp.rmdir(lockDir);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(a2aDir, stream) {
  const lockDir = path.join(a2aDir, `${stream}.lock`);
  const started = performance.now();
  while (performance.now() - started <= 5_000) {
    try {
      await fsp.mkdir(lockDir, { mode: PRIVATE_DIR_MODE });
      const owner = await writeOwner(lockDir);
      return { lockDir, owner };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (error instanceof RelayError) throw error;
        throw storageUnsafe(`cannot acquire lock: ${lockDir}`);
      }
      if (await recoverLock(lockDir)) continue;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new RelayError('busy_retry');
}

async function releaseLock(lock) {
  try {
    const owner = await readOwner(lock.lockDir);
    if (!owner || owner.nonce !== lock.owner.nonce) return;
    await fsp.unlink(path.join(lock.lockDir, 'owner.json'));
    await fsp.rmdir(lock.lockDir);
  } catch {
    // A lost or externally changed lock is never removed blindly.
  }
}

async function openAudit(a2aDir, stream) {
  const auditPath = path.join(a2aDir, `${stream}.audit.jsonl`);
  try {
    return await safeOpenExisting(auditPath, C.O_RDWR | C.O_APPEND);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      return await safeCreate(auditPath, C.O_RDWR | C.O_APPEND);
    } catch (createError) {
      if (createError.code === 'EEXIST') return safeOpenExisting(auditPath, C.O_RDWR | C.O_APPEND);
      throw createError;
    }
  }
}

async function appendAudit(handle, entry) {
  await handle.write(`${JSON.stringify(entry)}\n`);
  await handle.sync();
}

function auditEntry(config, request, result) {
  return {
    ts: new Date(nowMs()).toISOString(),
    stream: config.stream,
    from: config.self ?? config.from,
    to: request.to,
    bytes: Buffer.byteLength(request.body, 'utf8'),
    transport: result.transport ?? 'none',
    outcome: result.outcome,
    reason: result.reason ?? null,
  };
}

function validateBody(body) {
  if (typeof body !== 'string') throw new RelayError('bad_request');
  if (Buffer.byteLength(body, 'utf8') > 65_536) throw new RelayError('too_large');
  // JavaScript strings can contain lone UTF-16 surrogates. Encoding those
  // would silently insert U+FFFD, which is not a strict UTF-8 decode.
  if (/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body)) {
    throw new RelayError('bad_request');
  }
  const cleaned = body.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  if (cleaned.length === 0) throw new RelayError('bad_request');
  if (Buffer.byteLength(cleaned, 'utf8') > 8_192) throw new RelayError('too_large');
  if (/cross-session-message|--- begin peer message|--- end peer message/i.test(cleaned)) {
    throw new RelayError('forged_envelope');
  }
  return cleaned;
}

async function flagPresent(a2aDir, stream) {
  const flag = path.join(a2aDir, `${stream}.disabled`);
  const stat = await privateLstat(flag, 'file');
  if (!stat) return false;
  const handle = await safeOpenExisting(flag);
  await handle.close();
  return true;
}

async function addressBook(config) {
  return safeReadJson(path.join(config.a2aDir, `${config.stream}.members.json`));
}

async function validateMemberSocket(config, recipient, isParent) {
  if (recipient.engine !== 'claude' || typeof recipient.socket !== 'string') return;
  if (!isParent) {
    const socketRoot = path.resolve(config.a2aDir, 'sock');
    const resolved = path.resolve(recipient.socket);
    if (resolved === socketRoot || !resolved.startsWith(`${socketRoot}${path.sep}`)) {
      throw storageUnsafe('member socket escapes the a2a socket directory');
    }
  }
}

async function resolveSenderAndRecipient(config, request, book) {
  if (config.mode === 'mcp') {
    const sender = book.members?.[config.self];
    if (!sender || (sender.engine === 'codex' && !sender.thread_id)
        || (sender.engine === 'claude' && !sender.socket)) throw new RelayError('not_ready');
    if (!config.peers.includes(request.to)) throw new RelayError('not_a_peer');
  } else {
    if (book.parent?.name !== config.from
        || book.parent?.socket !== process.env.CLAUDE_CODE_MESSAGING_SOCKET) {
      throw new RelayError('not_a_peer');
    }
  }
  if (book.parent?.name === request.to) {
    await validateMemberSocket(config, book.parent, true);
    return book.parent;
  }
  const recipient = book.members?.[request.to];
  if (!recipient) throw new RelayError('recipient_unavailable');
  await validateMemberSocket(config, recipient, false);
  return recipient;
}

async function readAuditEntries(auditHandle) {
  let text;
  try {
    text = await auditHandle.readFile({ encoding: 'utf8' });
  } catch {
    throw storageUnsafe('cannot read audit log');
  }
  if (text.length === 0) return [];
  try {
    return text.trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    throw storageUnsafe('invalid audit log');
  }
}

function isSuccessfulAudit(entry) {
  return entry?.outcome === 'delivered' || entry?.outcome === 'queued';
}

async function budgetCheck(auditHandle, config, request) {
  const now = nowMs();
  const sender = config.self ?? config.from;
  const entries = (await readAuditEntries(auditHandle)).filter((entry) => {
    const timestamp = Date.parse(entry.ts);
    return isSuccessfulAudit(entry) && Number.isFinite(timestamp) && timestamp <= now;
  });
  const within = (milliseconds) => entries.filter((entry) => now - Date.parse(entry.ts) < milliseconds);
  const minute = within(60_000);
  const hour = within(3_600_000);
  if (minute.filter((entry) => entry.from === sender).length >= 6
      || hour.filter((entry) => entry.from === sender).length >= 60) {
    throw new RelayError('rate_limited');
  }
  if (minute.filter((entry) => entry.to === request.to).length >= 12) {
    throw new RelayError('recipient_busy');
  }
  const pairKey = [sender, request.to].sort().join('\0');
  if (within(1_800_000).filter((entry) => [entry.from, entry.to].sort().join('\0') === pairKey).length >= 20) {
    throw new RelayError('pair_budget_exhausted');
  }
  const hourBytes = hour.reduce((total, entry) => total + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0);
  if (hour.length >= 120 || hourBytes + Buffer.byteLength(request.body, 'utf8') > 512 * 1024) {
    throw new RelayError('stream_budget_exhausted');
  }
}

async function livenessCheck(config, recipient) {
  if (!recipient || typeof recipient !== 'object' || typeof recipient.pane_id !== 'string') {
    throw new RelayError('recipient_unavailable');
  }
  if (recipient.engine === 'codex' && !recipient.thread_id) throw new RelayError('recipient_unavailable');
  if (recipient.engine === 'claude') {
    if (typeof recipient.socket !== 'string') throw new RelayError('recipient_unavailable');
    const socketStubbed = process.env.A2A_TEST_MODE === '1'
      && process.env.A2A_TEST_SOCKET_PATH === recipient.socket;
    if (!socketStubbed) {
      try {
        if (!(await fsp.lstat(recipient.socket)).isSocket()) throw new Error('not a socket');
      } catch {
        throw new RelayError('recipient_unavailable');
      }
    }
  }
  try {
    const { stdout } = await execFileAsync(config.herdr, ['agent', 'get', recipient.pane_id], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const agent = parsed?.result?.agent;
    if (!agent || agent.name !== recipient.name || (agent.engine ?? agent.kind) !== recipient.engine) {
      throw new Error('agent mismatch');
    }
  } catch {
    throw new RelayError('recipient_unavailable');
  }
}

async function deliver(recipient) {
  // Task 06 replaces this with the native Claude and Codex adapters.
  return { outcome: recipient.engine === 'codex' ? 'queued' : 'delivered', transport: recipient.engine ?? 'stub' };
}

async function recordEarlyRefusal(config, request, error) {
  let lock;
  let audit;
  try {
    lock = await acquireLock(config.a2aDir, config.stream);
    audit = await openAudit(config.a2aDir, config.stream);
    await appendAudit(audit, auditEntry(config, request, {
      outcome: error.outcome ?? 'refused', reason: error.reason, transport: 'none',
    }));
  } finally {
    await audit?.close().catch(() => {});
    if (lock) await releaseLock(lock);
  }
}

async function relay(config, rawRequest) {
  let request;
  try {
    request = { to: rawRequest.to, body: validateBody(rawRequest.body) };
    if (typeof request.to !== 'string' || request.to.length === 0) throw new RelayError('bad_request');
  } catch (error) {
    const relayError = error instanceof RelayError ? error : new RelayError('bad_request');
    await ensureA2aDir(config.a2aDir);
    await recordEarlyRefusal(config, {
      to: typeof rawRequest.to === 'string' ? rawRequest.to : '',
      body: typeof rawRequest.body === 'string' ? rawRequest.body : '',
    }, relayError);
    throw relayError;
  }
  await ensureA2aDir(config.a2aDir);

  let lock;
  let audit;
  try {
    lock = await acquireLock(config.a2aDir, config.stream);

    // Audit safety is established, and the same descriptor retained, before
    // any budget, liveness, or delivery work. An unsafe audit can therefore
    // never produce a delivered-but-reported-refused result.
    audit = await openAudit(config.a2aDir, config.stream);

    if (await flagPresent(config.a2aDir, config.stream)) throw new RelayError('a2a_disabled');
    const book = await addressBook(config);
    const recipient = await resolveSenderAndRecipient(config, request, book);
    await budgetCheck(audit, config, request);
    await livenessCheck(config, { ...recipient, name: request.to });
    const result = await deliver(recipient, config, request);
    await appendAudit(audit, auditEntry(config, request, { ...result, reason: null }));
    return { ...result, reason: null };
  } catch (error) {
    const relayError = error instanceof RelayError ? error : new RelayError('delivery_failed', error.message, 'failed');
    // If openAudit succeeded, the audit descriptor is known-safe. Storage
    // failures elsewhere are therefore auditable; only an unsafe audit path
    // reaches this block without a descriptor and produces no line.
    if (audit) {
      await appendAudit(audit, auditEntry(config, request, {
        outcome: relayError.outcome, reason: relayError.reason, transport: 'none',
      }));
    }
    throw relayError;
  } finally {
    await audit?.close().catch(() => {});
    if (lock) await releaseLock(lock);
  }
}

function parseOptions(args, definitions) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!Object.hasOwn(definitions, flag) || index + 1 >= args.length) {
      throw new RelayError('bad_arguments', `unknown or incomplete argument: ${flag}`);
    }
    const key = definitions[flag];
    if (key === 'peers') (result.peers ??= []).push(args[index + 1]);
    else {
      if (result[key] !== undefined) throw new RelayError('bad_arguments', `duplicate argument: ${flag}`);
      result[key] = args[index + 1];
    }
  }
  return result;
}

function requireOptions(options, names) {
  for (const name of names) {
    if (!options[name]) throw new RelayError('bad_arguments', `missing argument: ${name}`);
  }
}

const toolSchema = {
  type: 'object',
  properties: { to: { type: 'string' }, body: { type: 'string' } },
  required: ['to', 'body'],
  additionalProperties: false,
};

function writeRpc(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function mcpMode(args) {
  const config = parseOptions(args, {
    '--self': 'self', '--stream': 'stream', '--a2a-dir': 'a2aDir', '--node': 'node',
    '--codex': 'codex', '--herdr': 'herdr', '--peer': 'peers',
  });
  requireOptions(config, ['self', 'stream', 'a2aDir', 'node', 'codex', 'herdr']);
  config.mode = 'mcp';
  config.peers ??= [];

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      writeRpc({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    if (request.method === 'notifications/initialized') continue;
    if (request.method === 'initialize') {
      writeRpc({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'herdr_jutsu_a2a', version: '0.5.0' },
      } });
    } else if (request.method === 'tools/list') {
      writeRpc({ jsonrpc: '2.0', id: request.id, result: { tools: [
        { name: 'send_message', inputSchema: toolSchema },
      ] } });
    } else if (request.method === 'tools/call') {
      if (request.params?.name !== 'send_message') {
        writeRpc({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
        continue;
      }
      try {
        const result = await relay(config, request.params?.arguments ?? {});
        writeRpc({ jsonrpc: '2.0', id: request.id, result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        } });
      } catch (error) {
        const reason = error.reason ?? 'delivery_failed';
        if (reason === 'storage_unsafe') process.stderr.write(`${reason}: ${error.message}\n`);
        writeRpc({ jsonrpc: '2.0', id: request.id, result: {
          content: [{ type: 'text', text: JSON.stringify({ outcome: error.outcome ?? 'refused', reason }) }],
          isError: true,
        } });
      }
    } else {
      writeRpc({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32601, message: 'Method not found' } });
    }
  }
}

async function readBodyFile(file) {
  const handle = await safeOpenExisting(file);
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > 65_536) throw new RelayError('too_large');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('bad_request');
  } finally {
    await handle.close();
  }
}

async function sendMode(args) {
  const config = parseOptions(args, {
    '--a2a-dir': 'a2aDir', '--stream': 'stream', '--from': 'from', '--to': 'to',
    '--body': 'body', '--body-file': 'bodyFile', '--herdr': 'herdr',
  });
  requireOptions(config, ['a2aDir', 'stream', 'from', 'to']);
  if ((config.body === undefined) === (config.bodyFile === undefined)) throw new RelayError('bad_arguments');
  config.mode = 'send';
  // The documented parent CLI deliberately has no executable-path flag. The
  // launcher supplies an absolute path to MCP children; an interactive parent
  // resolves its own trusted herdr command in the normal shell environment.
  config.herdr ??= 'herdr';
  let body;
  try {
    body = config.bodyFile ? await readBodyFile(config.bodyFile) : config.body;
  } catch (error) {
    const relayError = error instanceof RelayError ? error : new RelayError('bad_request');
    await ensureA2aDir(config.a2aDir);
    await recordEarlyRefusal(config, { to: config.to, body: '' }, relayError);
    throw relayError;
  }
  const result = await relay(config, { to: config.to, body });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function setDisabled(mode, args) {
  const config = parseOptions(args, { '--a2a-dir': 'a2aDir', '--stream': 'stream' });
  requireOptions(config, ['a2aDir', 'stream']);
  await ensureA2aDir(config.a2aDir, mode === 'disable');
  const flag = path.join(config.a2aDir, `${config.stream}.disabled`);
  if (mode === 'disable') {
    try {
      const existing = await safeOpenExisting(flag, C.O_WRONLY);
      await existing.close();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const handle = await safeCreate(flag);
      await handle.close();
    }
  } else {
    const stat = await privateLstat(flag, 'file');
    if (!stat) return;
    const handle = await safeOpenExisting(flag);
    await handle.close();
    await fsp.unlink(flag);
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!['mcp', 'send', 'disable', 'enable'].includes(mode)) throw new RelayError('bad_arguments');
  if (mode === 'mcp') await mcpMode(args);
  else if (mode === 'send') await sendMode(args);
  else await setDisabled(mode, args);
}

main().catch(async (error) => {
  const reason = error.reason ?? 'delivery_failed';
  process.stderr.write(`${JSON.stringify({ error: { code: reason, message: error.message } })}\n`);
  process.exitCode = reason === 'bad_arguments' ? 2 : 1;
});
