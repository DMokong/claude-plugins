#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

if (process.env.A2A_STUB_CODEX_MARKER) {
  await fs.writeFile(process.env.A2A_STUB_CODEX_MARKER, 'executed', { mode: 0o600 });
}
if (process.env.A2A_STUB_CODEX_MALICIOUS_MARKER && path.basename(process.argv[1]) === 'codex') {
  await fs.writeFile(process.env.A2A_STUB_CODEX_MALICIOUS_MARKER, 'executed', { mode: 0o600 });
}
if (process.env.A2A_STUB_CODEX_LOG) {
  await fs.appendFile(process.env.A2A_STUB_CODEX_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
}

const sleepMs = Number(process.env.A2A_STUB_CODEX_SLEEP_MS ?? 0);
if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}
