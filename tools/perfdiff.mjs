#!/usr/bin/env node
/**
 * Compare two screenshot passes' `report.json` and flag regressions.
 *
 * With nine agents adding subsystems in parallel, "it still compiles" says nothing
 * about whether the frame budget survived. This turns each pass into a pass/fail
 * against the budgets in docs/ARCHITECTURE.md and against the previous pass.
 *
 * Usage:
 *   node tools/perfdiff.mjs screenshots/report.json screenshots/render/report.json
 *   node tools/perfdiff.mjs --budget screenshots/report.json     # budget check only
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

// From docs/ARCHITECTURE.md. fps and draws are hard: exceeding them is a bug.
const BUDGET = {
  fps: 60,
  draws: 220,
  tris: 16_000_000,
};

// The triangle budget is a PROXY, and this tool used to contradict the architecture doc by
// failing on it. ARCHITECTURE.md is explicit that "frame time is the binding constraint; the
// rest are proxies for it... if a change pushes triangles up while frame time stays inside
// 16.7 ms, that is fine" — and `renderer.info.render.triangles` counts every pass, so the
// figure moves with how much of the scene the shadow cascades happen to cover, not with
// model complexity. The `rout` shot renders 18.3 M with only 6.97 M of unique geometry, at
// 13.65 ms/73 fps: healthy on the binding metric, over the proxy. Hard-failing that would
// have pressured someone into "optimising" a frame with nothing wrong with it.
//
// So an absolute triangle overage warns and is reported, but does not fail the pass. A
// triangle *regression against a baseline* still fails, because a sudden 25% jump means
// something broke — LOD selection, a culling test, a cascade bound — even if frame time
// currently absorbs it. Proxies are useful as derivatives, not as absolutes.
const SOFT = new Set(['tris']);

// Regression thresholds — noise below these is ignored.
const TOL = { fps: 0.88, draws: 1.25, tris: 1.25 };

const args = process.argv.slice(2);
const budgetOnly = args.includes('--budget');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('usage: perfdiff.mjs [--budget] <report.json> [baseline-report.json]');
  process.exit(2);
}

const load = async (p) => JSON.parse(await readFile(p, 'utf8'));

const current = await load(files[0]);
const baseline = files[1] && !budgetOnly ? await load(files[1]) : null;

const byName = (r) => new Map((r.shots ?? []).filter((s) => !s.error).map((s) => [s.name, s]));
const cur = byName(current);
const base = baseline ? byName(baseline) : new Map();

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const pad = (s, n) => String(s).padEnd(n);

let problems = 0;
let softWarnings = 0;
console.log(`\n${pad('shot', 15)}${pad('fps', 14)}${pad('draws', 14)}${pad('tris', 14)}status`);
console.log('-'.repeat(70));

for (const [name, s] of cur) {
  const b = base.get(name);
  const notes = [];
  const warns = [];

  if (s.fps < BUDGET.fps) notes.push(`fps<${BUDGET.fps}`);
  if (s.draws > BUDGET.draws) notes.push(`draws>${BUDGET.draws}`);
  if (s.tris > BUDGET.tris) (SOFT.has('tris') ? warns : notes).push(`tris>${fmt(BUDGET.tris)}`);

  if (b) {
    if (s.fps < b.fps * TOL.fps) notes.push(`fps -${(100 - (s.fps / b.fps) * 100).toFixed(0)}%`);
    if (s.draws > b.draws * TOL.draws) notes.push(`draws +${((s.draws / b.draws - 1) * 100).toFixed(0)}%`);
    // Regressions fail even for soft metrics — see the note on SOFT above.
    if (s.tris > b.tris * TOL.tris) notes.push(`tris +${((s.tris / b.tris - 1) * 100).toFixed(0)}%`);
  }

  const cell = (v, bv, f = String) => (b ? `${f(v)} (${bv > v ? '' : '+'}${f(v - bv)})` : f(v));
  console.log(
    pad(name, 15) +
      pad(cell(Math.round(s.fps), Math.round(b?.fps ?? 0)), 14) +
      pad(cell(s.draws, b?.draws ?? 0), 14) +
      pad(cell(s.tris, b?.tris ?? 0, fmt), 14) +
      (notes.length ? `⚠ ${notes.join(', ')}` : warns.length ? `· ${warns.join(', ')} (proxy; fps ok)` : 'ok')
  );
  if (notes.length) problems++;
  if (warns.length) softWarnings++;
}

const missing = baseline ? [...base.keys()].filter((k) => !cur.has(k)) : [];
if (missing.length) {
  console.log(`\n⚠ shots present in baseline but missing/failed now: ${missing.join(', ')}`);
  problems += missing.length;
}

const errs = current.consoleErrors ?? [];
if (errs.length) {
  console.log(`\n⚠ ${errs.length} console error(s) in the current pass:`);
  for (const e of errs.slice(0, 12)) console.log(`   ${e}`);
  problems++;
}

const soft = softWarnings ? ` (${softWarnings} triangle proxy overage(s), frame time ok)` : '';
console.log(`\n${problems === 0 ? `✓ within budget, no regressions${soft}` : `✗ ${problems} problem(s)${soft}`}`);
process.exit(problems === 0 ? 0 : 1);
