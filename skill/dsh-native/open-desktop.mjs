#!/usr/bin/env node
// Open DeepSeek Harness Desktop with dispatched sessions shown under their folders' workspaces.
//
// Before launching Desktop, attaches the sessions queued by ds-task.mjs (see attach-workspaces.mjs).
// If Desktop or `dsh web` is already running, it only warns: they hold the workspace list in memory and
// would overwrite the edit on their next change. Quit them fully (including the tray icon) and rerun.
//
//   node open-desktop.mjs                    attach, then launch Desktop
//   node open-desktop.mjs --dry-run          report what would happen; change nothing
//   node open-desktop.mjs --no-launch        attach only
//   node open-desktop.mjs --create-shortcut  Windows: add desktop and Start-menu shortcuts that run this
//                         [--shortcut-dir <dir>]   (or one shortcut in <dir>)
//
// Desktop's location comes from the config's "desktop" section (see README); the log goes to
// $DSH_HOME/dispatch-logs/open-desktop.log.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dshHome } from './session-usage.mjs';
import { attachPending, readPending } from './attach-workspaces.mjs';
import { configPath, loadConfig } from './ds-task.mjs';

const T = {
  zh: {
    title: 'DeepSeek Harness',
    pending: (n) => `待登记的派发会话：${n} 个`,
    busy: (n, who) => `有 ${n} 个派发的会话还没登记到工作区。\n\n${who}正在运行，现在登记会被它覆盖。请先完全退出（包括托盘图标），再用这个命令或快捷方式打开。`,
    desktop: 'Desktop', web: (p) => `网页版（dsh web，端口 ${p}）`, sep: '、',
    problems: (n, errs) => `登记派发会话时有问题（已登记 ${n} 个）：\n\n${errs.join('\n')}`,
    attached: (r) => `已登记 ${r.attached} 个会话${r.createdWorkspaces.length ? `，新建工作区：${r.createdWorkspaces.join('、')}` : ''}`,
    noExe: (p) => `找不到 Desktop：${p || '（未配置）'}。在配置的 desktop.path 里填它的位置。`,
    launching: (p) => `启动 Desktop：${p}`,
    dry: '（--dry-run：不登记、不启动）',
    running: (who) => `正在运行：${who || '无'}`,
    shortcut: (ps) => `已创建快捷方式：\n${ps.join('\n')}`,
    shortcutName: 'DeepSeek Harness（含派发会话）',
  },
  en: {
    title: 'DeepSeek Harness',
    pending: (n) => `Dispatched sessions waiting to be attached: ${n}`,
    busy: (n, who) => `${n} dispatched session(s) are not in a workspace yet.\n\n${who} is running and would overwrite the change. Quit it fully (including the tray icon), then use this command or shortcut again.`,
    desktop: 'Desktop', web: (p) => `the web UI (dsh web, port ${p})`, sep: ' and ',
    problems: (n, errs) => `Problems while attaching dispatched sessions (${n} attached):\n\n${errs.join('\n')}`,
    attached: (r) => `Attached ${r.attached} session(s)${r.createdWorkspaces.length ? `; new workspaces: ${r.createdWorkspaces.join(', ')}` : ''}`,
    noExe: (p) => `Desktop not found: ${p || '(not configured)'}. Set desktop.path in the config.`,
    launching: (p) => `Launching Desktop: ${p}`,
    dry: '(--dry-run: nothing attached or launched)',
    running: (who) => `Running: ${who || 'none'}`,
    shortcut: (ps) => `Shortcuts created:\n${ps.join('\n')}`,
    shortcutName: 'DeepSeek Harness (with dispatched sessions)',
  },
};

export function desktopDefaults(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return { path: path.join(env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'), processName: 'DeepSeek Harness.exe' };
  }
  if (platform === 'darwin') return { path: '/Applications/DeepSeek Harness.app', processName: 'DeepSeek Harness' };
  return { path: null, processName: null };
}

export function desktopSettings(cfg) {
  const set = Object.fromEntries(Object.entries(cfg.desktop || {}).filter(([, v]) => v != null && v !== ''));
  const d = { ...desktopDefaults(), webPort: 3080, ...set };
  if (!d.processName && d.path) d.processName = path.basename(d.path);
  return d;
}

function processRunning(name) {
  if (!name) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    return (r.stdout || '').toLowerCase().includes(`"${name.toLowerCase()}"`);
  }
  return spawnSync('pgrep', ['-f', name]).status === 0;
}

function portListening(port) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(800, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function log(msg) {
  try {
    const f = path.join(dshHome(), 'dispatch-logs', 'open-desktop.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${new Date().toISOString()}  ${msg}\n`);
  } catch { }
}

// Console always; plus a dialog, since this usually runs from a shortcut with no visible console.
function notify(title, msg, popup) {
  process.stderr.write(`${msg}\n`);
  if (!popup) return;
  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[void](New-Object -ComObject WScript.Shell).Popup($env:DSN_MSG, 20, $env:DSN_TITLE, 48)'],
    { env: { ...process.env, DSN_MSG: msg, DSN_TITLE: title }, windowsHide: true });
  } else if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'on run argv', '-e', 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} giving up after 20', '-e', 'end run', msg, title]);
  } else {
    spawnSync('notify-send', [title, msg]);
  }
}

function launch(exe) {
  const opts = { detached: true, stdio: 'ignore' };
  const child = process.platform === 'darwin' && exe.endsWith('.app') ? spawn('open', ['-a', exe], opts) : spawn(exe, [], opts);
  child.on('error', () => { });
  child.unref();
}

function createShortcuts(exe, name, dir) {
  const script = fileURLToPath(import.meta.url);
  const ps = [
    '$s = New-Object -ComObject WScript.Shell',
    '$out = @()',
    '$dirs = if ($env:DSN_DIR) { @($env:DSN_DIR) } else { @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs")) }',
    'foreach ($dir in $dirs) {',
    '  $p = Join-Path $dir ($env:DSN_NAME + ".lnk")',
    '  $l = $s.CreateShortcut($p)',
    '  $l.TargetPath = $env:DSN_NODE',
    '  $l.Arguments = \'"\' + $env:DSN_SCRIPT + \'"\'',
    '  $l.WorkingDirectory = $env:USERPROFILE',
    '  $l.WindowStyle = 7',
    '  if (Test-Path -LiteralPath $env:DSN_EXE) { $l.IconLocation = $env:DSN_EXE + ",0" }',
    '  $l.Save(); $out += $p',
    '}',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $out -join "`n"',
  ].join('\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, DSN_NAME: name, DSN_NODE: process.execPath, DSN_SCRIPT: script, DSN_EXE: exe || '', DSN_DIR: dir || '' },
  });
  if (r.status !== 0) throw new Error((r.stderr || 'shortcut creation failed').trim());
  return r.stdout.trim().split(/\r?\n/);
}

async function main() {
  const { values: o } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' }, 'no-launch': { type: 'boolean' }, 'no-popup': { type: 'boolean' },
      'create-shortcut': { type: 'boolean' }, 'shortcut-dir': { type: 'string' }, config: { type: 'string' },
    },
  });
  const cfg = loadConfig(configPath(o.config));
  const M = T[cfg.lang] || T.zh;
  const d = desktopSettings(cfg);
  const exeOk = Boolean(d.path && fs.existsSync(d.path));

  if (o['create-shortcut']) {
    if (process.platform !== 'win32') throw new Error('--create-shortcut is Windows-only');
    console.log(M.shortcut(createShortcuts(d.path, M.shortcutName, o['shortcut-dir'] && path.resolve(o['shortcut-dir']))));
    return 0;
  }

  const n = readPending().length;
  const who = [];
  if (n || o['dry-run']) {
    if (processRunning(d.processName)) who.push(M.desktop);
    if (await portListening(d.webPort)) who.push(M.web(d.webPort));
  }
  if (o['dry-run']) {
    console.log([M.pending(n), M.running(who.join(M.sep)), exeOk ? M.launching(d.path) : M.noExe(d.path), M.dry].join('\n'));
    return 0;
  }

  if (n && who.length) {
    log(`skip attach: ${who.join(', ')} running, ${n} pending`);
    notify(M.title, M.busy(n, who.join(M.sep)), !o['no-popup']);
  } else if (n) {
    const r = attachPending();
    log(`attach: ${JSON.stringify(r)}`);
    if (r.errors.length) notify(M.title, M.problems(r.attached, r.errors), !o['no-popup']);
    else console.log(M.attached(r));
  }

  if (o['no-launch']) return 0;
  if (!exeOk) {
    notify(M.title, M.noExe(d.path), !o['no-popup']);
    return 1;
  }
  console.log(M.launching(d.path));
  launch(d.path);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`open-desktop: ${e.message}\n`); log(`error: ${e.message}`); process.exitCode = 1; },
  );
}
