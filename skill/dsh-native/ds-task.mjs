#!/usr/bin/env node
// Dispatch one task to DeepSeek Harness (`dsh --profile headless --json`), wait for it, and summarize.
// By default the task continues the work directory's "current session", so DeepSeek remembers
// what it already read and did, and the history is served from the provider's prompt cache.
//
//   node ds-task.mjs --workdir <dir> --task-file brief.md      continue the current session (or start one)
//   node ds-task.mjs --workdir <dir> --task-file brief.md --new-session
//   node ds-task.mjs --workdir <dir> --task-file side.md --one-off
//   node ds-task.mjs --workdir <dir> --session-id session-... --task "..."
//
// Run with --help for all options. Exit code: 0 = the turn completed, 1 = failed or aborted, 2 = bad usage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dshHome, sessionUsage } from './session-usage.mjs';
import { queueAttach } from './attach-workspaces.mjs';

export const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

export const DEFAULT_CONFIG = {
  lang: 'zh',
  permissionMode: 'workspace-write',
  // Written into a --patch overlay for each run; set to null to keep whatever the headless profile says.
  agent: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  // dsh 0.2.1+ headless ignores the key saved by Desktop/web unless these plugins are re-enabled.
  reuseSavedCredentials: false,
  maxToolLines: 40,
  // Suggest --new-session once the context passes this many tokens; 0 or null turns the hint off
  // (e.g. with a context-folding plugin installed).
  contextWarnTokens: 200000,
  // Queue dispatched sessions for open-desktop.mjs, which files them under Desktop's workspaces.
  attachToWorkspaces: true,
  // Node used to run dsh; null = this node if new enough, else a newer one from PATH or common locations.
  nodePath: null,
  pricing: {
    currency: 'CNY',
    unit: 'per 1M tokens',
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    checked: '2026-10-24',
    timeZone: 'Asia/Shanghai',
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    peakDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    peakHours: ['09:00-12:00', '14:00-18:00'],
    holidays: [],
  },
};

const MESSAGES = {
  zh: {
    title: '=== DeepSeek 任务结果 ===',
    done: '完成', failed: '失败',
    status: (s, code, sec, reason) => `状态：${s}（exit ${code}，用时 ${sec}s）${reason ? `— ${reason}` : ''}`,
    session: (sid, how) => `会话：${sid}（${how}）`,
    howNew: '新开', howResume: '接续', howPinned: '接续（指定）', howOneOff: '新开（临时，不改当前会话）', howFallback: '新开（接续失败后）',
    note: (n) => `注意：${n}`,
    gone: (sid) => `会话 ${sid} 已不存在，已新开会话并设为当前会话。`,
    locked: (sid, why) => `无法接续 ${sid}（${why}），本次临时新开；当前会话保持不变。`,
    usage: (req, prompt, hit, pct, out, ctx) => `本次用量：${req} 次请求，输入 ${prompt} tokens（缓存命中 ${hit}，${pct}%），输出 ${out}；当前上下文约 ${ctx} tokens`,
    cost: (c) => `费用估算：约 ¥${c.total.toFixed(4)}（${c.peak ? '高峰价' : '闲时价'}，${c.zoneLabel} ${c.local}；命中 ¥${c.hitCost.toFixed(4)} + 未命中 ¥${c.missCost.toFixed(4)} + 输出 ¥${c.outCost.toFixed(4)}；单价核对于 ${c.checked}，以账单为准）`,
    zone: (tz) => (tz === 'Asia/Shanghai' ? '北京时间' : tz),
    dir: (d, m) => `目录：${d}（权限 ${m}）`,
    logs: (d) => `日志：${d}`,
    tools: (n) => `工具调用：${n} 次`,
    moreTools: (n) => `  …其余 ${n} 次见 events.jsonl`,
    stderr: '--- stderr（末尾）---',
    answer: '--- DeepSeek 的回答 ---',
    none: '（无）',
    bigContext: (ctx, limit) => `提示：当前上下文约 ${ctx} tokens，超过 ${limit}。下一个任务如果和之前的工作无关，或者想清空上下文，可以加 --new-session。`,
    keyHint: '提示：dsh 没拿到 API Key。设置 DEEPSEEK_API_KEY 环境变量（或 .env），或在配置里打开 reuseSavedCredentials 复用 Desktop/网页版保存的 Key。见 README。',
  },
  en: {
    title: '=== DeepSeek task result ===',
    done: 'completed', failed: 'failed',
    status: (s, code, sec, reason) => `Status: ${s} (exit ${code}, ${sec}s)${reason ? ` - ${reason}` : ''}`,
    session: (sid, how) => `Session: ${sid} (${how})`,
    howNew: 'new', howResume: 'resumed', howPinned: 'resumed (pinned)', howOneOff: 'new (one-off, current session unchanged)', howFallback: 'new (resume failed)',
    note: (n) => `Note: ${n}`,
    gone: (sid) => `session ${sid} no longer exists; started a new one and made it current.`,
    locked: (sid, why) => `could not resume ${sid} (${why}); ran in a one-off new session, the current session is unchanged.`,
    usage: (req, prompt, hit, pct, out, ctx) => `Usage: ${req} requests, input ${prompt} tokens (cache hit ${hit}, ${pct}%), output ${out}; context now ~${ctx} tokens`,
    cost: (c) => `Cost estimate: ~CNY ${c.total.toFixed(4)} (${c.peak ? 'peak' : 'off-peak'} rate, ${c.zoneLabel} ${c.local}; hit ${c.hitCost.toFixed(4)} + miss ${c.missCost.toFixed(4)} + output ${c.outCost.toFixed(4)}; prices checked ${c.checked}, your bill is authoritative)`,
    zone: (tz) => tz,
    dir: (d, m) => `Workdir: ${d} (permission ${m})`,
    logs: (d) => `Logs: ${d}`,
    tools: (n) => `Tool calls: ${n}`,
    moreTools: (n) => `  ...${n} more in events.jsonl`,
    stderr: '--- stderr (tail) ---',
    answer: "--- DeepSeek's answer ---",
    none: '(none)',
    bigContext: (ctx, limit) => `Hint: the context is now ~${ctx} tokens, over ${limit}. If the next task is unrelated, or you want a clean context, add --new-session.`,
    keyHint: 'Hint: dsh found no API key. Set DEEPSEEK_API_KEY (environment or .env), or enable reuseSavedCredentials in the config to reuse the key saved by Desktop/web. See README.',
  },
};

const HELP = `Usage: node ds-task.mjs --workdir <dir> (--task <text> | --task-file <file>) [options]

  --workdir <dir>        project directory DeepSeek works in (required)
  --task <text>          task text
  --task-file <file>     task brief file (UTF-8)
  --new-session          start a new session and make it the directory's current session
  --one-off              start a new session without changing the current one (parallel tasks)
  --session-id <id>      resume this session (same workdir as before); current session unchanged
  --mode <mode>          read-only | workspace-write | danger-full-access (default: config, else workspace-write)
  --config <file>        config file (default: $DS_DISPATCH_CONFIG, else ~/.dsh/dispatch-config.json)
  --max-tool-lines <n>   tool calls to list in the summary
  -h, --help             show this help

Environment: DSH_BIN (dsh's lib/bin.js), DSH_NODE (Node 22.19+ used to run dsh), DSH_HOME, DS_DISPATCH_CONFIG.`;

// ---------- config ----------

export function configPath(explicit) {
  return explicit || process.env.DS_DISPATCH_CONFIG || path.join(dshHome(), 'dispatch-config.json');
}

export function loadConfig(file) {
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      throw new Error(`config file is not valid JSON: ${file} (${e.message})`);
    }
  }
  const cfg = { ...DEFAULT_CONFIG, ...user };
  cfg.pricing = { ...DEFAULT_CONFIG.pricing, ...(user.pricing || {}) };
  if (user.agent !== undefined) cfg.agent = user.agent;
  return cfg;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// A dsh patch-list overlay (YAML; JSON values are valid YAML) built from the config.
export function buildPatch(cfg) {
  const lines = [];
  const agent = cfg.agent && Object.fromEntries(Object.entries(cfg.agent).filter(([, v]) => v != null && v !== ''));
  if (agent && Object.keys(agent).length) {
    lines.push('- id: agent-default-model', "  name: '@deepseek-ai/dsh-agent-default-model'", `  config: ${JSON.stringify(agent)}`);
  }
  if (cfg.reuseSavedCredentials) {
    for (const id of ['credentials', 'authorization', 'deepseek-account']) lines.push(`- id: ${id}`, '  disabled: false');
  }
  return lines.length ? lines.join('\n') + '\n' : null;
}

// ---------- pricing ----------

export function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'long',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hm: `${parts.hour}:${parts.minute}`,
    label: `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
  };
}

export function isPeak(date, pricing) {
  const t = zonedParts(date, pricing.timeZone || 'Asia/Shanghai');
  if (!(pricing.peakDays || []).includes(t.weekday)) return false;
  if ((pricing.holidays || []).includes(t.date)) return false;
  return (pricing.peakHours || []).some((w) => {
    const [from, to] = w.split('-');
    return t.hm >= from && t.hm < to;
  });
}

// hit = cache-hit input tokens, miss = cache-miss input tokens (incl. cache writes), out = output tokens.
export function estimateCost({ hit, miss, out }, date, pricing) {
  const peak = isPeak(date, pricing);
  const p = peak ? pricing.peak : pricing.offPeak;
  const hitCost = (hit * p.cacheHit) / 1e6;
  const missCost = (miss * p.cacheMiss) / 1e6;
  const outCost = (out * p.output) / 1e6;
  const tz = pricing.timeZone || 'Asia/Shanghai';
  return { peak, hitCost, missCost, outCost, total: hitCost + missCost + outCost, local: zonedParts(date, tz).label, timeZone: tz, checked: pricing.checked };
}

// ---------- dsh location ----------

const BIN_REL = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js');

export function findDshBin() {
  if (process.env.DSH_BIN) {
    if (fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
    throw new Error(`DSH_BIN points to a missing file: ${process.env.DSH_BIN}`);
  }
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.ps1', 'dsh'] : ['dsh'];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const shim = path.join(dir, name);
      if (!fs.existsSync(shim)) continue;
      let real = shim;
      try { real = fs.realpathSync(shim); } catch { }
      if (real.endsWith('.js')) return real;
      // npm prefix layouts: <prefix>/dsh.cmd (Windows) and <prefix>/bin/dsh (Unix)
      for (const c of [path.join(dir, 'node_modules', BIN_REL), path.join(dir, '..', 'lib', 'node_modules', BIN_REL)]) {
        if (fs.existsSync(c)) return path.resolve(c);
      }
    }
  }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    const c = path.join(root, BIN_REL);
    if (fs.existsSync(c)) return c;
  } catch { }
  throw new Error('dsh not found on PATH or under `npm root -g`. Install it: npm install -g @deepseek-ai/dsh (or set DSH_BIN to its lib/bin.js)');
}

// dsh needs Node 22.19+ or 24+; older ones exit 0 without output. Claude Code may run this script with an
// older `node` that comes first on PATH (e.g. /usr/local/bin ahead of Homebrew's keg-only node@24), so pick a
// suitable node for dsh: $DSH_NODE > config nodePath > this node > PATH > common install locations.
export function nodeSupportsDsh(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

const NODE_LOCATIONS = ['/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/bin/node', '/usr/local/opt/node@24/bin/node', '/usr/local/bin/node'];

// Homebrew's versioned Cellar path disappears on `brew upgrade`; prefer its stable opt/ link.
export function stableNodePath(p) {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(p);
  const opt = m && `${m[1]}/opt/${m[2]}/bin/node`;
  return opt && fs.existsSync(opt) ? opt : p;
}

export function findDshNode(cfg = {}) {
  const explicit = process.env.DSH_NODE || cfg.nodePath;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`${process.env.DSH_NODE ? 'DSH_NODE' : 'nodePath'} points to a missing file: ${explicit}`);
  }
  if (nodeSupportsDsh(process.versions.node)) return stableNodePath(process.execPath);
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const fromPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, name));
  const seen = new Set([process.execPath]);
  for (const c of [...fromPath, ...(process.platform === 'win32' ? [] : NODE_LOCATIONS)]) {
    let real;
    try { real = fs.realpathSync(c); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const r = spawnSync(real, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.status === 0 && nodeSupportsDsh(r.stdout.trim())) return stableNodePath(real);
  }
  throw new Error(`Node ${process.versions.node} is too old for dsh (needs 22.19+ or 24+) and no newer node was found. Install one, or set DSH_NODE / "nodePath" in the config to its path`);
}

// ---------- session registry ----------

// workDir is canonical (fs.realpathSync.native), so on macOS it already carries the folder's on-disk letter
// case; only Windows still needs case folding (drive letters, UNC spellings).
export function registryKey(workDir) {
  const k = path.resolve(workDir).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? k.toLowerCase() : k;
}

function registryPath() {
  return path.join(dshHome(), 'dispatch-sessions.json');
}

function readRegistry() {
  try { return JSON.parse(stripBom(fs.readFileSync(registryPath(), 'utf8'))); } catch { return {}; }
}

function saveCurrent(workDir, sid) {
  const reg = readRegistry();
  const key = registryKey(workDir);
  const runs = reg[key]?.sessionId === sid ? (reg[key].runs || 0) + 1 : 1;
  reg[key] = { workDir, sessionId: sid, runs, updated: new Date().toISOString() };
  const tmp = `${registryPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, registryPath());
}

// ---------- running dsh ----------

function runDsh({ node, bin, sid, workDir, text, mode, patchFile, eventsPath, stderrPath }) {
  const args = [bin, '--profile', 'headless'];
  if (patchFile) args.push('--patch', patchFile);
  args.push('--json');
  if (sid) args.push('--session-id', sid);
  args.push('-');
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, {
      cwd: workDir,
      env: { ...process.env, DSH_PERMISSION_MODE: mode },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = fs.createWriteStream(eventsPath);
    const err = fs.createWriteStream(stderrPath);
    const outDone = new Promise((r) => out.on('finish', r));
    const errDone = new Promise((r) => err.on('finish', r));
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    child.stdin.on('error', () => { });
    child.stdin.end(Buffer.from(text, 'utf8'));
    child.on('error', reject);
    child.on('close', async (code) => {
      await Promise.all([outDone, errDone]);
      resolve({ exit: code ?? 1, events: readEvents(eventsPath) });
    });
  });
}

export function readEvents(file) {
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { }
  }
  return events;
}

const turnStarted = (events) => events.some((e) => e.type === 'status' && e.phase === 'turn_start');
const last = (arr) => arr[arr.length - 1];

function tailLines(file, n) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-n); } catch { return []; }
}

// ---------- main ----------

async function main() {
  let opts;
  try {
    ({ values: opts } = parseArgs({
      options: {
        workdir: { type: 'string' }, task: { type: 'string' }, 'task-file': { type: 'string' },
        'session-id': { type: 'string' }, 'new-session': { type: 'boolean' }, 'one-off': { type: 'boolean' },
        mode: { type: 'string' }, config: { type: 'string' }, 'max-tool-lines': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    return usage(e.message);
  }
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.workdir) return usage('--workdir is required');
  if (!opts.task === !opts['task-file']) return usage('give exactly one of --task / --task-file');
  if ([opts['session-id'], opts['new-session'], opts['one-off']].filter(Boolean).length > 1) {
    return usage('--session-id, --new-session and --one-off are mutually exclusive');
  }
  if (opts['session-id'] && !/^[\w-]+$/.test(opts['session-id'])) return usage(`bad session id: ${opts['session-id']}`);

  const cfg = loadConfig(configPath(opts.config));
  const M = MESSAGES[cfg.lang] || MESSAGES.zh;
  const mode = opts.mode || cfg.permissionMode;
  if (!PERMISSION_MODES.includes(mode)) return usage(`--mode must be one of ${PERMISSION_MODES.join(', ')}`);
  const maxToolLines = Number(opts['max-tool-lines'] ?? cfg.maxToolLines);

  // .native resolves to the on-disk letter case on macOS/Windows, the same canon dsh uses for workspaces.
  const workDir = fs.realpathSync.native(path.resolve(opts.workdir));
  if (!fs.statSync(workDir).isDirectory()) return usage(`not a directory: ${workDir}`);
  const text = opts.task ?? stripBom(fs.readFileSync(path.resolve(opts['task-file']), 'utf8'));
  if (!text.trim()) return usage('the task is empty');
  const bin = findDshBin();
  const node = findDshNode(cfg);

  // log directory
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const logDir = path.join(dshHome(), 'dispatch-logs', `${stamp}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(logDir, { recursive: true });
  const eventsPath = path.join(logDir, 'events.jsonl');
  const stderrPath = path.join(logDir, 'stderr.log');
  fs.writeFileSync(path.join(logDir, 'task.md'), text);
  const patch = buildPatch(cfg);
  const patchFile = patch ? path.join(logDir, 'patch.yml') : null;
  if (patch) fs.writeFileSync(patchFile, patch);

  // pick the session: pinned > new > directory's current > new
  let target = null;
  let how = M.howNew;
  let updateCurrent = !opts['one-off'];
  if (opts['session-id']) {
    target = opts['session-id']; how = M.howPinned; updateCurrent = false;
  } else if (opts['one-off']) {
    how = M.howOneOff;
  } else if (!opts['new-session']) {
    const cur = readRegistry()[registryKey(workDir)];
    if (cur?.sessionId) { target = cur.sessionId; how = M.howResume; }
  }

  const started = new Date();
  let before = target ? sessionUsage(target) : null;
  const run = (sid) => runDsh({ node, bin, sid, workDir, text, mode, patchFile, eventsPath, stderrPath });
  let result = await run(target);
  let note = '';

  // A failed resume (session locked by another writer, unknown, or from another directory) never starts a turn:
  // rerun in a new session.
  if (target && result.exit !== 0 && !turnStarted(result.events)) {
    const why = last(result.events.filter((e) => e.type === 'error'))?.message || last(tailLines(stderrPath, 1)) || `exit ${result.exit}`;
    fs.renameSync(eventsPath, path.join(logDir, 'events-attempt1.jsonl'));
    fs.renameSync(stderrPath, path.join(logDir, 'stderr-attempt1.log'));
    const gone = /unknown|not found|no (stored|persisted)|does not exist|no such/i.test(why) && !/write handle/i.test(why);
    if (gone) {
      note = M.gone(target);
    } else {
      note = M.locked(target, why);
      if (how === M.howResume) updateCurrent = false;
    }
    how = M.howFallback;
    before = null;
    result = await run(null);
  }
  const { events } = result;
  // A dsh that exits 0 without a single event did not run the task (e.g. a too-old Node).
  const exit = result.exit === 0 && !events.length ? 1 : result.exit;
  const elapsed = Math.round((Date.now() - started.getTime()) / 1000);

  const sessionEv = events.find((e) => e.type === 'session');
  const final = last(events.filter((e) => e.type === 'final'));
  const turnEnd = last(events.filter((e) => e.type === 'status' && e.phase === 'turn_end'));
  const errorEv = last(events.filter((e) => e.type === 'error'));
  const toolCalls = events.filter((e) => e.type === 'tool_call');
  const answer = final?.text || '';
  fs.writeFileSync(path.join(logDir, 'answer.md'), answer);

  let reason = '';
  if (turnEnd?.reason) {
    reason = turnEnd.reason.kind;
    const er = turnEnd.reason.error;
    if (er) reason += `: ${[er.code, er.message].filter(Boolean).join(' ')}`;
  } else if (errorEv) {
    reason = `error: ${errorEv.message}`;
  } else if (!events.length) {
    reason = `dsh printed no events (node ${node})`;
  }

  const sid = sessionEv?.sessionId || null;
  if (sid && updateCurrent && turnStarted(events)) saveCurrent(workDir, sid);
  if (sid && cfg.attachToWorkspaces && turnStarted(events)) queueAttach(sid, workDir);

  // this run's usage = session totals after - session totals before
  let usageLine = '';
  let costLine = '';
  const after = sid ? sessionUsage(sid) : null;
  if (after?.found) {
    const b = before?.found ? before : { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    const req = after.requests - b.requests;
    const miss = after.inputTokens - b.inputTokens + (after.cacheWriteTokens - b.cacheWriteTokens);
    const hit = after.cacheReadTokens - b.cacheReadTokens;
    const out = after.outputTokens - b.outputTokens;
    const prompt = miss + hit;
    const pct = prompt > 0 ? Math.round((100 * hit) / prompt) : 0;
    usageLine = M.usage(req, prompt, hit, pct, out, after.lastPromptTokens);
    const c = estimateCost({ hit, miss, out }, started, cfg.pricing);
    costLine = M.cost({ ...c, zoneLabel: M.zone(c.timeZone) });
  }

  const lines = [M.title, M.status(exit === 0 ? M.done : M.failed, exit, elapsed, reason)];
  if (sid) lines.push(M.session(sid, how));
  if (note) lines.push(M.note(note));
  if (usageLine) lines.push(usageLine);
  if (costLine) lines.push(costLine);
  if (after?.found && cfg.contextWarnTokens > 0 && after.lastPromptTokens > cfg.contextWarnTokens) {
    lines.push(M.bigContext(after.lastPromptTokens, cfg.contextWarnTokens));
  }
  lines.push(M.dir(workDir, mode), M.logs(logDir), M.tools(toolCalls.length));
  for (const c of toolCalls.slice(0, maxToolLines)) {
    const { type, ...rest } = c;
    let s = JSON.stringify(rest);
    if (s.length > 160) s = s.slice(0, 160) + '…';
    lines.push(`  - ${s}`);
  }
  if (toolCalls.length > maxToolLines) lines.push(M.moreTools(toolCalls.length - maxToolLines));
  if (/no API key|MISSING_CREDENTIAL/i.test(reason)) lines.push(M.keyHint);
  if (exit !== 0) {
    const err = tailLines(stderrPath, 10);
    if (err.length) lines.push(M.stderr, ...err);
  }
  lines.push(M.answer, answer || M.none);
  process.stdout.write(lines.join('\n') + '\n');
  return exit === 0 ? 0 : 1;
}

function usage(msg) {
  process.stderr.write(`ds-task: ${msg}\n\n${HELP}\n`);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`ds-task: ${e.message}\n`); process.exitCode = 1; },
  );
}
