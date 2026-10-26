// Where DeepSeek Harness Desktop lives and whether it (or `dsh web`) is running.
//
// Shared by attach-workspaces.mjs and open-desktop.mjs: while either app runs it keeps the workspace list in
// memory and rewrites the whole file on its next change, so attaching must wait until both are closed.
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function desktopDefaults(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return { path: path.join(env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'), processName: 'DeepSeek Harness.exe' };
  }
  // On macOS processName stays null: any process started from inside the bundle counts (see processPattern).
  if (platform === 'darwin') return { path: '/Applications/DeepSeek Harness.app', processName: null };
  return { path: null, processName: null };
}

export function desktopSettings(cfg, platform = process.platform) {
  const set = Object.fromEntries(Object.entries(cfg.desktop || {}).filter(([, v]) => v != null && v !== ''));
  const d = { ...desktopDefaults(platform), webPort: 3080, ...set };
  if (!d.processName && d.path && !isAppBundle(d.path, platform)) d.processName = path.basename(d.path);
  return d;
}

export const isAppBundle = (p, platform = process.platform) => platform === 'darwin' && /\.app\/?$/.test(p || '');

// The `pgrep -f` pattern for "Desktop is running". For a macOS .app it matches every process whose
// executable lives in the bundle: the main app, its Electron helpers, and anything it keeps alive after its
// windows are closed (Dock / menu bar). Desktop has quit fully only when none of them is left.
export function processPattern(d, platform = process.platform) {
  if (d.processName) return d.processName;
  if (!isAppBundle(d.path, platform)) return null;
  return `${d.path.replace(/\/+$/, '')}/Contents/`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function processRunning(d) {
  const name = processPattern(d);
  if (!name) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    return (r.stdout || '').toLowerCase().includes(`"${name.toLowerCase()}"`);
  }
  return spawnSync('pgrep', ['-f', '--', name]).status === 0;
}

export function portListening(port) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(800, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// What is running that would overwrite workspace.json: [] when it is safe to attach, otherwise any of
// {kind: 'desktop'} and {kind: 'web', port}. The probes can be swapped out (tests).
export async function blockingApps(d, probes = {}) {
  const { isProcessRunning = processRunning, isPortListening = portListening } = probes;
  const who = [];
  if (await isProcessRunning(d)) who.push({ kind: 'desktop' });
  if (await isPortListening(d.webPort)) who.push({ kind: 'web', port: d.webPort });
  return who;
}
