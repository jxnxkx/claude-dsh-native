import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachPending, queueAttach, readPending } from '../skill/dsh-native/attach-workspaces.mjs';
import { desktopSettings } from '../skill/dsh-native/open-desktop.mjs';

function fakeHome({ workspaces = {}, sessions = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-home-'));
  fs.mkdirSync(path.join(home, 'storages'));
  const registry = {
    unit: 'x',
    global: { initialized: true, workspaceIds: Object.keys(workspaces), archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces },
  };
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(registry));
  for (const id of sessions) fs.mkdirSync(path.join(home, 'sessions', 'some', 'nesting', id), { recursive: true });
  return home;
}
const registry = (home) => JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));

test('queueAttach appends once per session', () => {
  const home = fakeHome();
  queueAttach('session-a', 'C:/x', home);
  queueAttach('session-a', 'C:/x', home);
  queueAttach('session-b', 'C:/y', home);
  assert.deepEqual(readPending(home).map((x) => x.sessionId), ['session-a', 'session-b']);
  fs.rmSync(home, { recursive: true });
});

test('creates a workspace for a new folder and puts it first', () => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-proj-')));
  const home = fakeHome({ workspaces: { old: { path: '/elsewhere', title: 'old', sessionIds: ['s0'] } }, sessions: ['session-a'] });
  queueAttach('session-a', work, home);
  const r = attachPending(home);
  assert.equal(r.attached, 1);
  assert.deepEqual(r.createdWorkspaces, [path.basename(work)]);
  const reg = registry(home);
  const newId = reg.global.workspaceIds[0];
  assert.notEqual(newId, 'old');
  assert.equal(reg.tables.workspaces[newId].path, work);
  assert.deepEqual(reg.tables.workspaces[newId].sessionIds, ['session-a']);
  assert.ok(fs.existsSync(path.join(home, 'storages', 'workspace.json.bak-attach')));
  assert.deepEqual(readPending(home), []);
  fs.rmSync(home, { recursive: true });
  fs.rmSync(work, { recursive: true });
});

test('attaches to an existing workspace first, skips owned, keeps missing folders', () => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-proj-')));
  // On Windows the registry may store the same folder with different letter case.
  const stored = process.platform === 'win32' ? work.toUpperCase() : work;
  const home = fakeHome({
    workspaces: { w1: { path: stored, title: 'p', sessionIds: ['s-old'] } },
    sessions: ['session-new', 's-old', 'session-lost'],
  });
  queueAttach('s-old', work, home);
  queueAttach('session-new', work, home);
  queueAttach('session-lost', path.join(work, 'gone'), home);
  queueAttach('session-nolog', work, home);
  const r = attachPending(home);
  assert.equal(r.attached, 1);
  assert.deepEqual(r.createdWorkspaces, []);
  assert.deepEqual(registry(home).tables.workspaces.w1.sessionIds, ['session-new', 's-old']);
  assert.deepEqual(readPending(home).map((x) => x.sessionId), ['session-lost']);
  assert.equal(r.errors.length, 2);
  fs.rmSync(home, { recursive: true });
  fs.rmSync(work, { recursive: true });
});

test('leaves the queue alone when the registry is unreadable', () => {
  const home = fakeHome();
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), '{ broken');
  queueAttach('session-a', os.tmpdir(), home);
  const r = attachPending(home);
  assert.equal(r.attached, 0);
  assert.equal(readPending(home).length, 1);
  fs.rmSync(home, { recursive: true });
});

test('desktop settings: config overrides defaults, nulls keep them', () => {
  const d = desktopSettings({ desktop: { path: null, webPort: 4000 } });
  assert.equal(d.webPort, 4000);
  const custom = desktopSettings({ desktop: { path: '/opt/dsh/DeepSeek Harness' } });
  assert.equal(custom.path, '/opt/dsh/DeepSeek Harness');
});
