import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, buildPatch, estimateCost, isPeak, loadConfig, readEvents, registryKey } from '../skill/dsh-native/ds-task.mjs';

const pricing = DEFAULT_CONFIG.pricing;

test('peak hours follow Beijing time on weekdays', () => {
  // 2026-10-26 is a Monday. 02:30Z = 10:30 Beijing (peak); 04:30Z = 12:30 (lunch, off-peak).
  assert.equal(isPeak(new Date('2026-10-26T02:30:00Z'), pricing), true);
  assert.equal(isPeak(new Date('2026-10-26T04:30:00Z'), pricing), false);
  assert.equal(isPeak(new Date('2026-10-26T09:59:00Z'), pricing), true); // 17:59
  assert.equal(isPeak(new Date('2026-10-26T10:00:00Z'), pricing), false); // 18:00
  // Sunday 10:30 Beijing
  assert.equal(isPeak(new Date('2026-10-25T02:30:00Z'), pricing), false);
});

test('holidays use off-peak prices', () => {
  const p = { ...pricing, holidays: ['2026-10-26'] };
  assert.equal(isPeak(new Date('2026-10-26T02:30:00Z'), p), false);
});

test('cost estimate uses the selected price table', () => {
  const tokens = { hit: 1_000_000, miss: 1_000_000, out: 1_000_000 };
  const off = estimateCost(tokens, new Date('2026-10-25T02:30:00Z'), pricing);
  assert.equal(off.peak, false);
  assert.ok(Math.abs(off.total - 5.02) < 1e-9);
  const peak = estimateCost(tokens, new Date('2026-10-26T02:30:00Z'), pricing);
  assert.equal(peak.peak, true);
  assert.ok(Math.abs(peak.total - 10.04) < 1e-9);
  assert.equal(peak.local, '10-26 10:30');
});

test('patch overlay reflects the config', () => {
  const patch = buildPatch({ ...DEFAULT_CONFIG, reuseSavedCredentials: true });
  assert.match(patch, /id: agent-default-model/);
  assert.match(patch, /"reasoningEffort":"max"/);
  assert.match(patch, /- id: credentials\n {2}disabled: false/);
  assert.equal(buildPatch({ ...DEFAULT_CONFIG, agent: null }), null);
});

test('config file overrides defaults and keeps unspecified pricing fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-'));
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, '﻿' + JSON.stringify({ permissionMode: 'danger-full-access', pricing: { holidays: ['2026-10-01'] } }));
  const cfg = loadConfig(f);
  assert.equal(cfg.permissionMode, 'danger-full-access');
  assert.deepEqual(cfg.pricing.holidays, ['2026-10-01']);
  assert.deepEqual(cfg.pricing.peak, pricing.peak);
  assert.equal(loadConfig(path.join(dir, 'missing.json')).permissionMode, 'workspace-write');
  fs.rmSync(dir, { recursive: true });
});

test('event stream parsing skips junk lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-'));
  const f = path.join(dir, 'e.jsonl');
  fs.writeFileSync(f, '{"type":"session","sessionId":"session-1"}\nnot json\n\n{"type":"final","text":"中文"}\n');
  assert.deepEqual(readEvents(f).map((e) => e.type), ['session', 'final']);
  assert.equal(readEvents(f)[1].text, '中文');
  fs.rmSync(dir, { recursive: true });
});

test('registry key ignores trailing separators', () => {
  assert.equal(registryKey(path.join(os.tmpdir(), 'x') + path.sep), registryKey(path.join(os.tmpdir(), 'x')));
});
