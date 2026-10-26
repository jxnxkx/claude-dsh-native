import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachPending, queueAttach, readPending } from '../skill/dsh-native/attach-workspaces.mjs';
import { appleString, appletSource, desktopSettings, processPattern } from '../skill/dsh-native/open-desktop.mjs';

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

// macOS (APFS) and Windows are case-insensitive by default; dsh stores the realpath canon, which there carries
// the on-disk letter case. A stored path that differs only in case, or goes through a symlink, is the same folder.
test('matches a workspace stored with other letter case or through a symlink', (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-Proj-')));
  const upper = path.join(path.dirname(work), path.basename(work).toUpperCase());
  const caseInsensitive = fs.existsSync(upper);
  const link = path.join(os.tmpdir(), `dsd-link-${process.pid}`);
  let linked = false;
  try { fs.symlinkSync(work, link, 'dir'); linked = true; } catch { }
  if (!caseInsensitive && !linked) { t.skip('case-sensitive filesystem and no symlinks'); return; }
  const workspaces = {};
  if (caseInsensitive) workspaces.wCase = { path: upper, title: 'p', sessionIds: [] };
  else workspaces.wLink = { path: link, title: 'p', sessionIds: [] };
  const home = fakeHome({ workspaces, sessions: ['session-a'] });
  // queue the folder in yet another spelling: ds-task canonicalizes, attach does too
  queueAttach('session-a', caseInsensitive ? path.join(path.dirname(work), path.basename(work).toLowerCase()) : work, home);
  const r = attachPending(home);
  assert.equal(r.attached, 1);
  assert.deepEqual(r.createdWorkspaces, []);
  assert.deepEqual(Object.values(registry(home).tables.workspaces)[0].sessionIds, ['session-a']);
  fs.rmSync(home, { recursive: true });
  if (linked) fs.rmSync(link);
  fs.rmSync(work, { recursive: true });
});

test('macOS: Desktop counts as running while any process from its bundle is alive', () => {
  const d = desktopSettings({ desktop: {} }, 'darwin');
  assert.equal(d.path, '/Applications/DeepSeek Harness.app');
  assert.equal(d.processName, null);
  const re = new RegExp(processPattern(d, 'darwin'));
  assert.ok(re.test('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'));
  assert.ok(re.test('/Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper.app/Contents/MacOS/DeepSeek Harness Helper --type=gpu'));
  assert.ok(!re.test('tail -f /Users/x/Library/Logs/DeepSeek Harness/main.log'));
  assert.ok(!re.test('/Applications/DeepSeek HarnessXapp/Contents/MacOS/x'), 'dots are escaped');
  // an explicit processName still wins
  assert.equal(processPattern(desktopSettings({ desktop: { processName: 'dsh-desktop' } }, 'darwin'), 'darwin'), 'dsh-desktop');
  // a non-bundle path falls back to its file name, as on Windows/Linux
  assert.equal(desktopSettings({ desktop: { path: '/opt/dsh/DeepSeek Harness' } }, 'linux').processName, 'DeepSeek Harness');
});

test('macOS launcher applet quotes paths for AppleScript and the shell', () => {
  const src = appletSource('/opt/homebrew/opt/node@24/bin/node', '/Users/a "b"/skills\\x/open-desktop.mjs');
  assert.equal(src, 'do shell script quoted form of "/opt/homebrew/opt/node@24/bin/node" & " " & quoted form of "/Users/a \\"b\\"/skills\\\\x/open-desktop.mjs" & " >/dev/null 2>&1 || true"');
  assert.equal(appleString('中文 路径'), '"中文 路径"');
});

test('rewriting workspace.json keeps its owner-only permissions', { skip: process.platform === 'win32' }, () => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-proj-')));
  const home = fakeHome({ sessions: ['session-a'] });
  const file = path.join(home, 'storages', 'workspace.json');
  fs.chmodSync(file, 0o600);
  queueAttach('session-a', work, home);
  assert.equal(attachPending(home).attached, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, 'dispatch-pending-attach.json')).mode & 0o777, 0o600);
  fs.rmSync(home, { recursive: true });
  fs.rmSync(work, { recursive: true });
});
