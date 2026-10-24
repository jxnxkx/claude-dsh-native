#!/usr/bin/env node
// Install the skill into Claude Code and create the config file if it does not exist yet.
//
//   node scripts/install.mjs            -> ~/.claude/skills/dsh-native (user-level skill)
//   node scripts/install.mjs <dir>      -> <dir>/dsh-native, e.g. <project>/.claude/skills
//
// Existing skill files are overwritten; an existing config file is left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(repo, 'skill', 'dsh-native');
const skillsDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.homedir(), '.claude', 'skills');
const dest = path.join(skillsDir, 'dsh-native');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.warn(`warning: Node ${process.versions.node}; dsh needs Node 22.19+ or 24+`);
}

fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dest, f));
console.log(`skill installed: ${dest}`);

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const cfg = process.env.DS_DISPATCH_CONFIG || path.join(dshHome, 'dispatch-config.json');
if (fs.existsSync(cfg)) {
  console.log(`config kept:     ${cfg}`);
} else {
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.copyFileSync(path.join(src, 'dispatch-config.example.json'), cfg);
  console.log(`config created:  ${cfg}`);
}
