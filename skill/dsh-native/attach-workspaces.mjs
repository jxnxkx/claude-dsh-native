// Attach dispatched sessions to DeepSeek Harness Desktop workspaces.
//
// Desktop groups sessions by workspace (folder). The list lives in $DSH_HOME/storages/workspace.json, and
// only Desktop/web add a session to it (when they create the session themselves). Headless runs never do,
// so dispatched sessions end up "ungrouped". ds-task.mjs queues each dispatched session in
// $DSH_HOME/dispatch-pending-attach.json; this module moves the queue into workspace.json.
//
// Run it only while Desktop and `dsh web` are closed: they keep the registry in memory and rewrite the
// whole file on their next change, dropping edits made from outside. open-desktop.mjs checks that first.
//
//   node attach-workspaces.mjs   -> {"attached":n,"createdWorkspaces":[...],"kept":n,"errors":[...]}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dshHome } from './session-usage.mjs';

export const pendingPath = (home = dshHome()) => path.join(home, 'dispatch-pending-attach.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

// The rename replaces the file, so carry its permissions over: dsh keeps workspace.json owner-only (0600) on
// macOS/Linux, and a fresh file would get the umask default (usually 0644).
function writeJsonAtomic(p, value) {
  const tmp = `${p}.tmp-${process.pid}`;
  let mode = 0o600;
  try { mode = fs.statSync(p).mode & 0o777; } catch { }
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.chmodSync(tmp, mode); // writeFileSync's mode is still masked by the umask
  fs.renameSync(tmp, p);
}

export function readPending(home = dshHome()) {
  try {
    const v = readJson(pendingPath(home));
    return (Array.isArray(v) ? v : [v]).filter(Boolean);
  } catch {
    return [];
  }
}

// Called by ds-task.mjs after a run that started a turn.
export function queueAttach(sessionId, workDir, home = dshHome()) {
  const list = readPending(home);
  if (list.some((x) => x.sessionId === sessionId)) return;
  list.push({ sessionId, workDir, at: new Date().toISOString() });
  writeJsonAtomic(pendingPath(home), list);
}

// dsh stores workspace paths as fs.realpath canon and matches them by string equality. `dir` is canonical
// (realpathSync.native, which on macOS returns the on-disk letter case); the stored path is re-canonicalized
// too when it still exists, so a folder renamed by case or reached through a symlink still matches its
// workspace instead of getting a duplicate. Windows also folds case.
const canon = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
const sameDir = (stored, dir) => {
  const a = canon(stored);
  return process.platform === 'win32' ? a.toLowerCase() === dir.toLowerCase() : a === dir;
};

function sessionLogExists(sessionsRoot, id) {
  const stack = [sessionsRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === id) return true;
      stack.push(path.join(dir, e.name));
    }
  }
  return false;
}

export function attachPending(home = dshHome()) {
  const result = { attached: 0, createdWorkspaces: [], kept: 0, errors: [] };
  const pending = readPending(home);
  if (!pending.length) return result;

  const registryPath = path.join(home, 'storages', 'workspace.json');
  let registry;
  try { registry = readJson(registryPath); } catch (e) {
    result.errors.push(`workspace.json unreadable: ${e.message}`);
    result.kept = pending.length;
    return result;
  }
  const workspaces = registry.tables?.workspaces;
  if (!workspaces || !Array.isArray(registry.global?.workspaceIds)) {
    result.errors.push('workspace.json has an unexpected shape (dsh version change?)');
    result.kept = pending.length;
    return result;
  }
  fs.copyFileSync(registryPath, `${registryPath}.bak-attach`);

  const owned = new Set(Object.values(workspaces).flatMap((w) => w.sessionIds || []));
  const keep = [];
  const now = new Date().toISOString();
  for (const item of pending) {
    const { sessionId, workDir } = item;
    if (!sessionId || !workDir || owned.has(sessionId)) continue;
    if (!sessionLogExists(path.join(home, 'sessions'), sessionId)) {
      result.errors.push(`${sessionId}: session log not found, dropped`);
      continue;
    }
    let dir;
    try { dir = fs.realpathSync.native(workDir); } catch {
      keep.push(item);
      result.errors.push(`${sessionId}: folder missing (${workDir}), kept for later`);
      continue;
    }
    let [wsId, ws] = Object.entries(workspaces).find(([, w]) => w.path && sameDir(w.path, dir)) || [];
    if (!ws) {
      wsId = crypto.randomUUID();
      ws = { path: dir, title: path.basename(dir) || dir, sessionIds: [], createdAt: now, updatedAt: now };
      workspaces[wsId] = ws;
      registry.global.workspaceIds.unshift(wsId);
      result.createdWorkspaces.push(ws.title);
    }
    ws.sessionIds = [sessionId, ...(ws.sessionIds || [])]; // newest first, like Desktop
    ws.updatedAt = now;
    owned.add(sessionId);
    result.attached += 1;
  }
  if (result.attached) writeJsonAtomic(registryPath, registry);
  writeJsonAtomic(pendingPath(home), keep);
  result.kept = keep.length;
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const r = attachPending();
  console.log(JSON.stringify(r));
  process.exitCode = r.errors.some((e) => e.startsWith('workspace.json')) ? 1 : 0;
}
