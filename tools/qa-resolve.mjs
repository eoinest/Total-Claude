#!/usr/bin/env node
/**
 * QA: does the battle actually end, does it end exactly once, and does the result tell
 * the truth?
 *
 * `tools/trace.mjs` samples army state but never touches `battleFlow.result`, never counts
 * `battleEnded` emissions and never reconciles the reported casualties against the soldier
 * pool. Two separate systems used to announce the end (`sim/BattleFlow` and the HUD's own
 * `checkVictory` fallback), so the emission count is the load-bearing check.
 *
 * Usage: node tools/qa-resolve.mjs [--port=5225] [--until=1300] [--json=path] [--shot=path]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5225);
const UNTIL = Number(args.get('until') ?? 1300);
const JSON_OUT = args.get('json') ?? null;
const SHOT = args.get('shot') ?? null;

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// HUD stays visible: the results screen is part of what is under test — and the results
// screen is *only* built when `CINEMATIC` is true, which `src/ui/BattleFlow.ts:34` defines
// as `!HARNESS`. So `?harness=1` silently suppresses it, which is why nothing that drives
// the harness has ever seen it. `--cinematic` loads without the flag; `window.__game` is
// installed unconditionally by src/main.ts, so the driver still works.
const CINEMATIC = args.has('cinematic');
const url = CINEMATIC
  ? `${base}/?quality=high`
  : `${base}/?harness=1&quality=high&w=1600&h=900`;
console.log(`• ${url}${CINEMATIC ? '  (no harness flag: results screen enabled)' : ''}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
const booted = await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 })
  .then(() => true).catch(() => false);
if (!booted) {
  // A compile error in someone else's file surfaces here, not as a thrown exception, so
  // report what the page actually said rather than dying with a bare TimeoutError.
  const diag = await page.evaluate(() => ({
    loaderText: document.getElementById('load-text')?.textContent ?? null,
    hasGame: typeof window.__game !== 'undefined',
    ready: window.__game?.ready ?? null,
  })).catch((e) => ({ evalFailed: e.message }));
  console.error('FATAL: game never reached ready.');
  console.error(`  diagnostics: ${JSON.stringify(diag)}`);
  console.error(`  ${consoleErrors.length} console error(s):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.error(`    ${e}`);
  await browser.close();
  if (server) server.kill('SIGTERM');
  process.exit(1);
}

// Tap the bus before advancing a single tick, and stop the rAF loop so the only sim time
// is the sim time we ask for.
await page.evaluate(() => {
  const g = window.__game;
  g.engine.stop();
  window.__ended = [];
  window.__cues = [];
  g.engine.events.on('battleEnded', (p) => window.__ended.push({ at: g.simTime(), ...p }));
  g.engine.events.on('musicCue', (p) => window.__cues.push({ at: g.simTime(), id: p?.id }));
  // Deployment snapshot, before anyone dies.
  window.__initial = g.battle.units.map((u) => ({
    id: u.id, typeId: u.typeId, faction: u.faction, initialStrength: u.initialStrength, members: u.members.length,
  }));
});

const snapshot = () => page.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  const flow = g.engine.context.tryGet('battleFlow');
  // Ground truth from the pool: states 10 and 11 are dying/dead.
  const p = b.pool;
  const poolAlive = [0, 0], poolDead = [0, 0], poolRouting = [0, 0];
  for (let i = 0; i < p.count; i++) {
    const f = p.faction[i], s = p.state[i];
    if (s === 10 || s === 11) poolDead[f]++;
    else { poolAlive[f]++; if (s === 12) poolRouting[f]++; }
  }
  const unitAlive = [0, 0], unitAliveNotDestroyed = [0, 0], destroyedWithMen = [];
  for (const u of b.units) {
    unitAlive[u.faction] += u.alive;
    if (!u.destroyed) unitAliveNotDestroyed[u.faction] += u.alive;
    if (u.destroyed && u.alive > 0) destroyedWithMen.push({ id: u.id, typeId: u.typeId, faction: u.faction, alive: u.alive, initial: u.initialStrength });
  }
  // Are the men in "destroyed" (escaped) units still moving, or frozen mid-field?
  // `BattleSystem.steerSoldiers` skips destroyed units, so they may simply stop existing
  // as far as motion goes while remaining alive and drawn.
  let frozen = 0, moving = 0, maxSpeed = 0, sample = null;
  for (const u of b.units) {
    if (!u.destroyed || u.alive <= 0) continue;
    for (const i of u.members) {
      if (p.state[i] === 10 || p.state[i] === 11) continue;
      const sp = Math.hypot(p.x[i] - p.px[i], p.z[i] - p.pz[i]);
      if (sp > maxSpeed) maxSpeed = sp;
      if (sp < 1e-6) frozen++; else moving++;
      if (!sample) sample = { unit: u.id, i, x: +p.x[i].toFixed(2), z: +p.z[i].toFixed(2), state: p.state[i], stepped: +sp.toFixed(6) };
    }
  }
  const escaped = { frozen, moving, maxStepMetres: +maxSpeed.toFixed(6), sample };
  return {
    t: +g.simTime().toFixed(1),
    isOver: flow?.isOver ?? null,
    result: flow?.result ? JSON.parse(JSON.stringify(flow.result)) : null,
    endedEvents: window.__ended.slice(),
    cues: window.__cues.slice(),
    poolAlive, poolDead, poolRouting, unitAlive, unitAliveNotDestroyed, destroyedWithMen, escaped,
    poolCount: p.count,
    resultsScreenText: (document.querySelector('.rs-panel')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    resultsVisible: !!document.querySelector('.rs-panel'),
    resultsDisplay: (() => { const r = document.querySelector('.results'); return r ? getComputedStyle(r).display : null; })(),
  };
});

console.log('   t   isOver  ROME(pool alive/dead)  GERM(pool alive/dead)  routing  destroyed-with-men  battleEnded');
console.log('-'.repeat(112));

let last = null;
let firstOverAt = null;
for (let t = 30; t <= UNTIL; t += 30) {
  await page.evaluate((target) => {
    const g = window.__game;
    const need = target - g.simTime();
    if (need > 0) g.advance(need);
  }, t);
  const s = await snapshot();
  last = s;
  if (s.isOver && firstOverAt === null) firstOverAt = s.t;
  const dwm = s.destroyedWithMen.reduce((a, u) => a + u.alive, 0);
  console.log(
    `${String(Math.round(s.t)).padStart(4)}  ${String(s.isOver).padStart(6)}  ` +
    `${String(s.poolAlive[0]).padStart(5)}/${String(s.poolDead[0]).padEnd(5)}       ` +
    `${String(s.poolAlive[1]).padStart(5)}/${String(s.poolDead[1]).padEnd(5)}       ` +
    `${String(s.poolRouting[0] + s.poolRouting[1]).padStart(5)}    ` +
    `${String(s.destroyedWithMen.length).padStart(2)} units / ${String(dwm).padStart(4)} men   ` +
    `${s.endedEvents.length}`
  );
  // Once resolved, run a further 120 s: a second emitter would fire in that window.
  if (s.isOver && s.t > firstOverAt + 120) break;
}

let failed = 0;
const fail = (m) => { failed++; console.error(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

console.log('\n--- resolution ---');
if (!last.isOver) fail(`battle did NOT resolve within ${UNTIL} s (battleFlow.isOver=false, result=null)`);
else pass(`resolved: isOver=true first seen at t+${firstOverAt}s`);

console.log(`  battleEnded emissions: ${last.endedEvents.length}` +
  (last.endedEvents.length ? ` → ${JSON.stringify(last.endedEvents)}` : ''));
if (last.endedEvents.length === 1) pass('battleEnded fired exactly once');
else fail(`battleEnded fired ${last.endedEvents.length} time(s), expected exactly 1`);

console.log(`  musicCue emissions: ${JSON.stringify(last.cues)}`);

const r = last.result;
if (!r) fail('battleFlow.result is null');
else {
  const FAC = ['Rome', 'Germanic'];
  console.log(`\n  result: victor=${r.victor === -1 ? 'draw' : FAC[r.victor]} reason=${r.reason} at t+${r.at?.toFixed?.(1)}s`);
  const initial = await page.evaluate(() => {
    const out = [0, 0];
    for (const u of window.__initial) out[u.faction] += u.initialStrength;
    return out;
  });
  for (const f of [0, 1]) {
    const cas = r.casualties[f], sur = r.survivors[f];
    const sum = cas + sur;
    const poolDead = last.poolDead[f], poolAlive = last.poolAlive[f];
    console.log(`  ${FAC[f].padEnd(9)} initial ${initial[f]}  reported casualties ${cas} + survivors ${sur} = ${sum}` +
      `  |  pool truth: ${poolDead} dead, ${poolAlive} still alive`);
    if (sum !== initial[f]) fail(`${FAC[f]}: casualties+survivors ${sum} != initial strength ${initial[f]}`);
    else pass(`${FAC[f]}: casualties+survivors reconciles with initial strength (${sum})`);
    if (cas !== poolDead) {
      fail(`${FAC[f]}: reported casualties ${cas} but only ${poolDead} men are actually dead in the pool ` +
        `(overstated by ${cas - poolDead}); ${poolAlive} men are alive but ${sur} are counted as survivors`);
    }
  }
  // Did the victor actually win?
  const romeFrac = last.unitAliveNotDestroyed[0] / initial[0];
  const germFrac = last.unitAliveNotDestroyed[1] / initial[1];
  console.log(`  formed strength remaining: Rome ${(romeFrac * 100).toFixed(1)}%, Germanic ${(germFrac * 100).toFixed(1)}%`);
  const expected = Math.abs(romeFrac - germFrac) < 0.03 ? -1 : romeFrac > germFrac ? 0 : 1;
  if (r.victor !== expected) fail(`victor=${r.victor} but the stronger surviving force is ${expected}`);
  else pass('victor matches who still has a force on the field');
}

console.log('\n--- destroyed units still holding living men ---');
if (last.destroyedWithMen.length === 0) pass('no unit is flagged destroyed while its men are alive');
else {
  const men = last.destroyedWithMen.reduce((a, u) => a + u.alive, 0);
  fail(`${last.destroyedWithMen.length} units flagged destroyed still hold ${men} living men in the pool`);
  for (const u of last.destroyedWithMen.slice(0, 20)) {
    console.log(`      unit ${String(u.id).padStart(2)} ${u.typeId.padEnd(22)} ${u.faction === 0 ? 'ROME' : 'GERM'} ` +
      `alive ${String(u.alive).padStart(3)}/${u.initial}`);
  }
}

console.log('\n--- men in "escaped" units ---');
console.log(`  ${last.escaped.frozen} frozen (zero movement last tick), ${last.escaped.moving} still moving, ` +
  `largest step ${last.escaped.maxStepMetres} m`);
if (last.escaped.sample) console.log(`  sample: ${JSON.stringify(last.escaped.sample)}`);
if (last.escaped.frozen > 0 && last.escaped.moving === 0) {
  fail(`all ${last.escaped.frozen} men in "escaped" units are frozen in place — alive, drawn, and not moving`);
}

console.log('\n--- results screen ---');
console.log(`  .results display: ${last.resultsDisplay ?? '(element absent)'}`);
if (!last.resultsVisible) fail('no .rs-panel results screen in the DOM after the battle resolved' +
  (CINEMATIC ? '' : ' — note src/ui/BattleFlow.ts:34 gates it behind CINEMATIC = !HARNESS, so re-run with --cinematic'));
else {
  console.log(`  ${last.resultsScreenText.slice(0, 900)}`);
  const suspicious = last.resultsScreenText.match(/\b(0\/0|NaN|undefined|null|—\s*—|TODO|placeholder|\{\{)/gi);
  if (suspicious) fail(`results screen contains placeholder/garbage tokens: ${[...new Set(suspicious)].join(', ')}`);
  else pass('results screen contains no placeholder tokens');
  const nums = last.resultsScreenText.match(/\d[\d,]*/g) ?? [];
  console.log(`  numeric tokens on screen: ${nums.length}`);
  if (nums.length < 8) fail(`only ${nums.length} numbers on the results screen — likely not populated`);
}

if (SHOT) {
  await mkdir(path.dirname(path.resolve(ROOT, SHOT)), { recursive: true });
  await page.screenshot({ path: path.resolve(ROOT, SHOT) });
  console.log(`\n  → results screen screenshot: ${SHOT}`);
}

if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.log(`  ${e}`);
  failed++;
}

if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ last, firstOverAt, consoleErrors: [...new Set(consoleErrors)] }, null, 2));
await browser.close();
if (server) server.kill('SIGTERM');
console.log(failed ? `\n✗ ${failed} failure(s)` : '\n✓ battle resolution clean');
process.exit(failed ? 1 : 0);
