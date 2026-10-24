// Token totals for one dsh session, read from its log under $DSH_HOME/sessions (default ~/.dsh).
// Read-only: safe to run while another process holds the session's write lock.
//
//   node session-usage.mjs <sessionId>
//   -> {"found":true,"requests":n,"inputTokens":..,"cacheReadTokens":..,"cacheWriteTokens":..,"outputTokens":..,"lastPromptTokens":..}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function findLog(dir, id) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(dir, e.name);
    if (e.name === id) {
      const logs = fs.readdirSync(f).filter((n) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n)).sort();
      if (logs.length) return path.join(f, logs[logs.length - 1]);
    }
    const hit = findLog(f, id);
    if (hit) return hit;
  }
  return null;
}

// The log is a run of concatenated zstd frames. Split at the frame magic; when a split
// lands inside a frame (the magic bytes can occur in compressed data), widen the segment.
function decompressFrames(raw) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('this Node.js has no zstd support (need 22.15+ / 23.8+)');
  }
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let i = raw.indexOf(magic); i !== -1; i = raw.indexOf(magic, i + 4)) starts.push(i);
  starts.push(raw.length);
  let out = '';
  let k = 0;
  while (k < starts.length - 1) {
    let next = -1;
    for (let j = k + 1; j < starts.length; j++) {
      try {
        out += zlib.zstdDecompressSync(raw.subarray(starts[k], starts[j])).toString('utf8');
        next = j;
        break;
      } catch { }
    }
    k = next === -1 ? k + 1 : next;
  }
  return out;
}

export function sessionUsage(id) {
  const totals = { found: false, requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, lastPromptTokens: 0 };
  const root = path.join(dshHome(), 'sessions');
  const log = id && fs.existsSync(root) ? findLog(root, id) : null;
  if (!log) return totals;
  totals.found = true;
  const raw = fs.readFileSync(log);
  const text = log.endsWith('.zstd') ? decompressFrames(raw) : raw.toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const u = ev.type === 'assistant/message' ? ev.data?.usage : null;
    if (!u) continue;
    totals.requests += 1;
    totals.inputTokens += u.inputTokens || 0;
    totals.cacheReadTokens += u.cacheReadTokens || 0;
    totals.cacheWriteTokens += u.cacheWriteTokens || 0;
    totals.outputTokens += u.outputTokens || 0;
    totals.lastPromptTokens = (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
  }
  return totals;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  console.log(JSON.stringify(sessionUsage(process.argv[2])));
}
