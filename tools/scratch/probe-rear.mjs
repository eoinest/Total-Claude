#!/usr/bin/env node
/**
 * Probe: how often does a horse rear, and what does a charge actually lose?
 *
 * The owner's report is two claims in one — "it looks like the horses flinching" (the
 * `rear` clip, which `src/anim/clips.ts` maps `Clip.Stagger` onto for a mounted man) and
 * "slows down the charges" (velocity). They are separately measurable and this measures
 * them separately.
 *
 * Everything is read off the shipped battle with no teardown, because the question is a
 * frequency and a frequency in a lab of two spawned units is not the frequency the owner
 * saw. Instrumentation is by wrapping two public-at-runtime seams and sampling a third:
 *
 *   `CombatSystem.cavalryImpact`  — every trample: attacker, victim, braced or not, the
 *                                   attacker's speed before and after the call.
 *   `SoldierPool.setState`        — every transition into `Staggered`, which is the one
 *                                   and only thing that puts a horse into `rear`.
 *   `TacticalAISystem.brainOf`    — sampled: cavalry phase per unit per second.
 *
 * Usage:
 *   node tools/scratch/probe-rear.mjs --port=5961 [--json=path] [--label=before]
 *                                     [--until=240] [--battle='map=carthage&scenario=assault']
 */
import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';
import { stopClockOnReady } from '../lib/simclock.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5961);
const JSON_OUT = args.get('json') ?? null;
const LABEL = args.get('label') ?? '';
const UNTIL = Number(args.get('until') ?? 240);
const BATTLE = args.get('battle') ?? '';

let rev = 'unknown';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  if (execSync('git status --porcelain -- src/', { cwd: ROOT }).toString().trim()) rev += '+dirty';
} catch { /* not a checkout */ }

const browser = await launchBrowser({ label: 'probe-rear', port: PORT, root: ROOT });
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'probe-rear', slot: browser.budgetSlot,
});

const INSTALL = String.raw`
window.__rear = (async () => {
  const g = window.__game, b = g.battle, ctx = g.engine.context, p = b.pool;
  const combat = ctx.tryGet('combat');
  const tac = ctx.tryGet('tactical-ai');
  const render = ctx.tryGet('unitRender');
  const clips = await import('/src/anim/clips.ts');
  const REAR = clips.HORSE_CLIP_SET.index('rear');
  const STAGGERED = 9;
  const out = {
    impacts: [],
    staggers: [],
    seconds: [],
    units: {},
  };
  const cavUnits = [];
  for (const u of b.units) {
    const d = b.typeOf(u);
    const cav = d.unitClass === 'heavy-cavalry' || d.unitClass === 'light-cavalry';
    out.units[u.id] = {
      type: d.id, faction: u.faction, cav, size: u.alive,
      mount: (d.appearance && d.appearance.mount) || 'horse',
    };
    if (cav) cavUnits.push(u.id);
  }
  out.cavUnits = cavUnits;

  // --- 1. every trample ---
  const realImpact = combat.cavalryImpact.bind(combat);
  combat.cavalryImpact = function (i, t, u, def, mods, chargeF, speed) {
    const v0 = Math.hypot(p.vx[i], p.vz[i]);
    const tv = b.unitById(p.unitId[t]);
    const beforeState = p.state[t];
    const r = realImpact(i, t, u, def, mods, chargeF, speed);
    const v1 = Math.hypot(p.vx[i], p.vz[i]);
    out.impacts.push({
      time: +g.simTime().toFixed(3),
      atkUnit: u.id, atkMan: i, defUnit: tv ? tv.id : -1, defMan: t,
      defType: tv ? b.typeOf(tv).id : '?', atkType: def.id,
      chargeF: +chargeF.toFixed(3), closing: +speed.toFixed(3),
      v0: +v0.toFixed(3), v1: +v1.toFixed(3),
      defMounted: b.mounted[t] === 1,
      staggered: p.state[t] === STAGGERED && beforeState !== STAGGERED,
      killed: !p.aliveAt(t),
    });
    return r;
  };

  // --- 2. every entry into Staggered ---
  const realSet = p.setState.bind(p);
  let stackProbe = 0;
  p.setState = function (i, s) {
    if (s === STAGGERED && p.state[i] !== STAGGERED) {
      let site = '?';
      if (stackProbe < 60000) {
        stackProbe++;
        const st = new Error().stack || '';
        const line = st.split('\n').find((l) => l.indexOf('Combat.ts') >= 0);
        const m = line ? line.match(/Combat\.ts:(\d+)/) : null;
        site = m ? m[1] : '?';
      }
      const u = b.unitById(p.unitId[i]);
      out.staggers.push({
        time: +g.simTime().toFixed(3), man: i, unit: u ? u.id : -1,
        mounted: b.mounted[i] === 1, site,
      });
    }
    return realSet(i, s);
  };

  // --- 3. per-second census ---
  const census = () => {
    const row = { t: +g.simTime().toFixed(2), cav: {} };
    for (const id of cavUnits) {
      const u = b.unitById(id);
      if (!u || u.destroyed) continue;
      let stag = 0, fighting = 0, alive = 0, sumSpeed = 0, moving = 0;
      let rearing = 0, skating = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        alive++;
        const s = p.state[i];
        if (s === STAGGERED) stag++;
        if (s === 4) fighting++;
        const sp = Math.hypot(p.vx[i], p.vz[i]);
        sumSpeed += sp;
        if (sp > 0.3) moving++;
        // What the eye actually sees: the mount's own current clip, and whether the
        // animal is travelling while playing a clip whose rootSpeed is zero.
        if (render && render.horseCur && render.horseCur[i] === REAR) {
          rearing++;
          if (sp > 1.94) skating++;
        }
      }
      const brain = tac && tac.brainOf ? tac.brainOf(id) : undefined;
      row.cav[id] = {
        alive, stag, fighting, moving, rearing, skating,
        speed: alive ? +(sumSpeed / alive).toFixed(3) : 0,
        phase: brain ? brain.cavPhase : null,
        engaged: !!u.engaged,
        order: u.order,
        x: +u.x.toFixed(1), z: +u.z.toFixed(1),
      };
    }
    out.seconds.push(row);
  };
  return { out, census };
})();
`;

const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await stopClockOnReady(page);
const url = `${base}/?harness=1&quality=high&autoplay=1&w=640&h=360${BATTLE ? '&' + BATTLE : ''}`;
console.log(`source: ${base}   rev ${rev}${LABEL ? '   label ' + LABEL : ''}`);
console.log(`url:    ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.evaluate(() => window.__game.engine.stop());
const head = await page.evaluate(() => ({
  men: window.__game.battle.pool.count,
  t: window.__game.simTime(),
}));
console.log(`headcount ${head.men} at t=${head.t.toFixed(3)}`);

await page.evaluate(INSTALL);
await page.evaluate(async () => { window.__rear = await window.__rear; });
await page.evaluate(() => window.__rear.census());
for (let s = 1; s <= UNTIL; s++) {
  await page.evaluate(() => {
    window.__game.advanceTicks(30);
    window.__rear.census();
  });
  if (s % 60 === 0) process.stdout.write(`  t+${s}s\n`);
}

const data = await page.evaluate(() => window.__rear.out);
await page.close();
await closeServer();
await browser.close();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const cavIds = data.cavUnits;
const minutes = UNTIL / 60;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const stagMounted = data.staggers.filter((s) => s.mounted);
const stagFoot = data.staggers.filter((s) => !s.mounted);
const bySite = {};
for (const s of data.staggers) bySite[s.site] = (bySite[s.site] || 0) + 1;
const bySiteMounted = {};
for (const s of stagMounted) bySiteMounted[s.site] = (bySiteMounted[s.site] || 0) + 1;

console.log('');
console.log('=== rear clips (mounted men entering Staggered) ===');
console.log(`total staggers      ${data.staggers.length}   (mounted ${stagMounted.length}, foot ${stagFoot.length})`);
console.log(`Combat.ts line      all ${JSON.stringify(bySite)}   mounted ${JSON.stringify(bySiteMounted)}`);
const perUnit = {};
for (const s of stagMounted) perUnit[s.unit] = (perUnit[s.unit] || 0) + 1;
for (const id of cavIds) {
  const u = data.units[id];
  const n = perUnit[id] || 0;
  console.log(`  unit ${String(id).padStart(3)} ${u.type.padEnd(18)} f${u.faction} size ${String(u.size).padStart(3)}  rears ${String(n).padStart(5)} = ${(n / minutes).toFixed(1)}/min = ${(n / minutes / Math.max(1, u.size)).toFixed(2)}/horse/min`);
}

let stagManSec = 0, aliveManSec = 0, fightManSec = 0, rearSec = 0, skateSec = 0;
let engStag = 0, engAlive = 0, engRear = 0, engSkate = 0, engUnitSec = 0;
for (const row of data.seconds) {
  for (const id of cavIds) {
    const c = row.cav[id];
    if (!c) continue;
    stagManSec += c.stag; aliveManSec += c.alive; fightManSec += c.fighting;
    rearSec += c.rearing || 0; skateSec += c.skating || 0;
    if (c.engaged) {
      engUnitSec++; engStag += c.stag; engAlive += c.alive;
      engRear += c.rearing || 0; engSkate += c.skating || 0;
    }
  }
}
console.log('');
console.log(`cavalry man-seconds staggered:  ${stagManSec} of ${aliveManSec} = ${(100 * stagManSec / Math.max(1, aliveManSec)).toFixed(2)}%   (Fighting ${(100 * fightManSec / Math.max(1, aliveManSec)).toFixed(2)}%)`);
console.log(`horses rendering 'rear':       ${rearSec} man-s = ${(100 * rearSec / Math.max(1, aliveManSec)).toFixed(2)}% of cavalry man-seconds`);
console.log(`  of which travelling >1.94m/s: ${skateSec} man-s = ${(100 * skateSec / Math.max(1, rearSec)).toFixed(1)}% of rears are a skate`);
console.log(`while the squadron is engaged (${engUnitSec} unit-s): staggered ${(100 * engStag / Math.max(1, engAlive)).toFixed(2)}%, rearing ${(100 * engRear / Math.max(1, engAlive)).toFixed(2)}%, skating ${(100 * engSkate / Math.max(1, engAlive)).toFixed(2)}%`);

console.log('');
console.log('=== cavalryImpact (the trample) ===');
const imp = data.impacts;
const bracedLike = imp.filter((r) => r.v0 > 0.05 && r.v1 / r.v0 < 0.2);
console.log(`calls               ${imp.length} = ${(imp.length / minutes).toFixed(1)}/min`);
console.log(`onto mounted        ${imp.filter((r) => r.defMounted).length}`);
console.log(`staggered target    ${imp.filter((r) => r.staggered).length}   killed ${imp.filter((r) => r.killed).length}`);
const retained = imp.filter((r) => r.v0 > 0.05).map((r) => r.v1 / r.v0);
console.log(`speed retained      mean ${(100 * mean(retained)).toFixed(1)}%   (<20%, i.e. braced branch: ${bracedLike.length} = ${(100 * bracedLike.length / Math.max(1, imp.length)).toFixed(1)}%)`);
console.log(`closing arg         mean ${mean(imp.map((r) => r.closing)).toFixed(2)} m/s;  actual v0 mean ${mean(imp.map((r) => r.v0)).toFixed(2)} m/s`);
const slowImpacts = imp.filter((r) => r.v0 < 3.0).length;
console.log(`impacts by a man actually slower than TRAMPLE_SPEED (3.0): ${slowImpacts} = ${(100 * slowImpacts / Math.max(1, imp.length)).toFixed(1)}%`);
const perMan = {};
for (const r of imp) perMan[r.atkMan] = (perMan[r.atkMan] || 0) + 1;
const counts = Object.values(perMan).sort((a, c) => c - a);
console.log(`distinct chargers   ${counts.length}; impacts per charger max ${counts[0] || 0}, mean ${mean(counts).toFixed(2)}`);
console.log(`repeat share        ${(100 * (imp.length - counts.length) / Math.max(1, imp.length)).toFixed(1)}% of impacts are a repeat by a man who has already trampled`);
const perAtkUnit = {};
for (const r of imp) perAtkUnit[r.atkUnit] = (perAtkUnit[r.atkUnit] || 0) + 1;
for (const id of Object.keys(perAtkUnit).sort((a, c) => perAtkUnit[c] - perAtkUnit[a])) {
  const u = data.units[id];
  console.log(`  unit ${String(id).padStart(3)} ${u ? u.type.padEnd(18) : '?'} impacts ${String(perAtkUnit[id]).padStart(5)} = ${(perAtkUnit[id] / minutes).toFixed(1)}/min`);
}

console.log('');
console.log('=== cavalry AI phase occupancy (unit-seconds) ===');
const phase = {};
const phaseEngaged = {};
for (const row of data.seconds) {
  for (const id of cavIds) {
    const c = row.cav[id];
    if (!c || !c.phase) continue;
    phase[c.phase] = (phase[c.phase] || 0) + 1;
    if (c.engaged) phaseEngaged[c.phase] = (phaseEngaged[c.phase] || 0) + 1;
  }
}
const tot = Object.values(phase).reduce((a, b2) => a + b2, 0) || 1;
for (const k of Object.keys(phase).sort((a, b2) => phase[b2] - phase[a])) {
  console.log(`  ${k.padEnd(10)} ${String(phase[k]).padStart(5)} unit-s (${(100 * phase[k] / tot).toFixed(1)}%)   of which in contact ${phaseEngaged[k] || 0}`);
}

console.log('');
console.log('=== per-cavalry-unit speed ===');
for (const id of cavIds) {
  const rows = data.seconds.map((r) => r.cav[id]).filter(Boolean);
  if (!rows.length) continue;
  const u = data.units[id];
  const peak = Math.max(...rows.map((r) => r.speed));
  const inContact = rows.filter((r) => r.engaged);
  console.log(`  unit ${String(id).padStart(3)} ${u.type.padEnd(18)} peak man-speed ${peak.toFixed(2)} m/s, mean ${mean(rows.map((r) => r.speed)).toFixed(2)}, engaged ${inContact.length}s of ${rows.length}s`);
}

if (errors.length) {
  console.log('');
  console.log('page errors:');
  for (const e of errors.slice(0, 8)) console.log('  ' + e);
}

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({ rev, label: LABEL, until: UNTIL, battle: BATTLE, head, data }, null, 1));
  console.log(`\nwrote ${JSON_OUT}`);
}
